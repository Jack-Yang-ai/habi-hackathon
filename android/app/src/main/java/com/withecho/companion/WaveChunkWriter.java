package com.withecho.companion;

import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.channels.FileLock;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.Instant;

/** File boundaries only: callers retain one continuous microphone stream. */
public final class WaveChunkWriter implements Closeable {
    public static final int SAMPLE_RATE = 16000;
    public interface Listener { void completed(Receipt receipt) throws IOException; }
    public static final class CaptureTiming {
        public final Instant startedAt;
        public final long elapsedRealtimeNs;
        public final String source;
        public CaptureTiming(String utc, long elapsed, String source) {
            startedAt=Instant.parse(utc);
            if(elapsed<0 || !source.matches("[a-z_]{1,60}"))throw new IllegalArgumentException("capture timing");
            elapsedRealtimeNs=elapsed;this.source=source;
        }
        String jsonFields() {
            return "\"capture_started_at\":\""+startedAt+"\",\"capture_started_elapsed_realtime_ns\":"+elapsedRealtimeNs
                +",\"time_source\":\""+source+"\",\"clock\":\"device_wall_clock\"";
        }
    }
    public static final class Receipt {
        public final String captureId, sha256;
        public final int sequence;
        public final long frameOffset, frames, bytes;
        public final File wave;
        public final CaptureTiming timing;
        Receipt(String id, int seq, long offset, long count, File file, String sha, CaptureTiming timing) {
            captureId=id; sequence=seq; frameOffset=offset; frames=count; wave=file; sha256=sha; bytes=44+count*2;
            this.timing=timing;
        }
        public String json() {
            return "{\"schema_version\":2,\"capture_id\":\""+captureId+"\",\"sequence\":"+sequence
                +",\"frame_offset\":"+frameOffset+",\"frames\":"+frames+",\"sample_rate\":16000,\"channels\":1,\"encoding\":\"pcm_s16le\",\"bytes\":"+bytes
                +","+timing.jsonFields()+",\"chunk_started_at\":\""+timing.startedAt.plusNanos(frameOffset*62500)+"\""
                +",\"sha256\":\""+sha256+"\",\"file\":\""+wave.getName()+"\",\"uploaded\":false}";
        }
    }
    private final File directory;
    private final String captureId;
    private final int framesPerChunk;
    private final Listener listener;
    private final CaptureTiming timing;
    private final RandomAccessFile lockFile;
    private final FileLock lock;
    private RandomAccessFile output;
    private File pending;
    private long chunkFrames=0, totalFrames=0;
    private int sequence=0;
    private boolean closed=false;

    public WaveChunkWriter(File directory, String id, int seconds, CaptureTiming timing, Listener listener) throws IOException {
        if (!id.matches("[A-Za-z0-9_-]{1,100}") || seconds<1 || seconds>60) throw new IllegalArgumentException("capture identity or chunk length");
        if (!directory.isDirectory()) throw new IOException("recording_directory_unavailable");
        if(timing==null)throw new IllegalArgumentException("capture timing required");
        this.directory=directory; captureId=id; framesPerChunk=seconds*SAMPLE_RATE; this.listener=listener;this.timing=timing;
        lockFile=new RandomAccessFile(new File(directory,"capture.lock"),"rw");
        FileLock acquired=null;
        try {
            acquired=lockFile.getChannel().tryLock();
            if(acquired==null)throw new IOException("capture_writer_already_active");
            lock=acquired;
            publishJson("session", "{\"schema_version\":2,\"capture_id\":\""+id+"\","+timing.jsonFields()+",\"sample_rate\":16000,\"channels\":1,\"encoding\":\"pcm_s16le\"}");
        } catch(Exception failure) {
            if(acquired!=null)acquired.release();lockFile.close();
            if(failure instanceof IOException)throw (IOException)failure;
            throw new IOException("capture_writer_initialization_failed",failure);
        }
    }
    public long getTotalFrames() { return totalFrames; }
    private void begin() throws IOException {
        pending=new File(directory,String.format(java.util.Locale.ROOT,"chunk-%06d.pending.wav",sequence));
        if (!pending.createNewFile()) throw new IOException("pending_chunk_already_exists");
        output=new RandomAccessFile(pending,"rw"); output.write(new byte[44]); chunkFrames=0;
    }
    public void write(byte[] data,int offset,int length) throws IOException {
        if (closed) throw new IOException("writer_closed");
        if (offset<0 || length<0 || offset>data.length-length || length%2!=0) throw new IllegalArgumentException("unaligned_pcm");
        while (length>0) {
            if (output==null) begin();
            int count=(int)Math.min(length,(framesPerChunk-chunkFrames)*2);
            output.write(data,offset,count); chunkFrames+=count/2; totalFrames+=count/2;
            offset+=count; length-=count;
            if (chunkFrames==framesPerChunk) commit();
        }
    }
    private void commit() throws IOException {
        if (output==null) return;
        if (chunkFrames==0) { output.close();output=null;Files.delete(pending.toPath());return; }
        output.seek(0);output.write(header(chunkFrames));
        if (output.length()!=44+chunkFrames*2) throw new IOException("wave_length_mismatch");
        output.getFD().sync();output.close();output=null;
        File wave=new File(directory,String.format(java.util.Locale.ROOT,"chunk-%06d.wav",sequence));
        // Android denies hard links. This app-private directory has one writer under
        // capture.lock; check collisions before a same-filesystem atomic rename.
        publish(pending,wave);
        Receipt receipt=new Receipt(captureId,sequence,totalFrames-chunkFrames,chunkFrames,wave,sha256(wave),timing);
        publishJson(String.format(java.util.Locale.ROOT,"chunk-%06d",sequence),receipt.json());
        sequence++;chunkFrames=0;
        if(listener!=null)listener.completed(receipt);
    }
    private void publishJson(String base,String json) throws IOException {
        File temp=new File(directory,base+".pending.json");
        if (!temp.createNewFile()) throw new IOException("receipt_already_exists");
        try(FileOutputStream stream=new FileOutputStream(temp)){stream.write(json.getBytes(StandardCharsets.UTF_8));stream.getFD().sync();}
        publish(temp,new File(directory,base+".json"));
    }
    private static void publish(File source,File target) throws IOException {
        if(Files.exists(target.toPath()))throw new IOException("completed_file_already_exists");
        Files.move(source.toPath(),target.toPath(),StandardCopyOption.ATOMIC_MOVE);
    }
    private void releaseLock() throws IOException {
        try{if(lock.isValid())lock.release();}finally{lockFile.close();}
    }
    public void abort() throws IOException {
        if(closed)return;closed=true;
        try{if(output!=null){try{output.getFD().sync();}finally{output.close();output=null;}}}finally{releaseLock();}
        // Interrupted tails remain pending, never presented as completed audio.
    }
    @Override public void close() throws IOException {
        if(closed)return;closed=true;
        try{commit();}finally{try{if(output!=null){output.close();output=null;}}finally{releaseLock();}}
    }
    private static byte[] header(long frames) {
        java.nio.ByteBuffer h=java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        h.put(new byte[]{'R','I','F','F'}).putInt((int)(36+frames*2)).put(new byte[]{'W','A','V','E'});
        h.put(new byte[]{'f','m','t',' '}).putInt(16).putShort((short)1).putShort((short)1);
        h.putInt(SAMPLE_RATE).putInt(SAMPLE_RATE*2).putShort((short)2).putShort((short)16);
        h.put(new byte[]{'d','a','t','a'}).putInt((int)(frames*2));return h.array();
    }
    private static String sha256(File file) throws IOException {
        try {
            MessageDigest digest=MessageDigest.getInstance("SHA-256");
            try(FileInputStream input=new FileInputStream(file)){byte[] buf=new byte[16384];int n;while((n=input.read(buf))!=-1)digest.update(buf,0,n);}
            StringBuilder value=new StringBuilder();for(byte b:digest.digest())value.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return value.toString();
        }catch(java.security.NoSuchAlgorithmException impossible){throw new AssertionError(impossible);}
    }
}
