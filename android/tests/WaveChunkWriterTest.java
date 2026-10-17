package com.withecho.companion;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Synthetic PCM only; this test never initializes a microphone. */
public final class WaveChunkWriterTest {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args) throws Exception {
        String result=run(args.length==1?new File(args[0]).toPath():Files.createTempDirectory("echo-wave-test-"));
        System.out.println(result);System.out.flush();System.exit(0);
    }
    public static String run(Path base) throws Exception {
        System.out.println("WAVE_TEST_PHASE=start");System.out.flush();
        if(!Files.isDirectory(base))throw new IllegalArgumentException("fixture directory missing");
        Path complete=Files.createDirectory(base.resolve("complete"));
        byte[] pcm=new byte[(16000*25+123)*2];for(int i=0;i<pcm.length;i++)pcm[i]=(byte)(i*31+17);
        WaveChunkWriter.CaptureTiming timing=new WaveChunkWriter.CaptureTiming("2026-10-15T00:00:00Z",1000000000L,"synthetic_fixture");
        List<WaveChunkWriter.Receipt> receipts=new ArrayList<>();
        WaveChunkWriter writer=new WaveChunkWriter(complete.toFile(),"synthetic-capture",10,timing,receipts::add);
        boolean locked=false;try{new WaveChunkWriter(complete.toFile(),"second-writer",10,timing,null);}catch(java.io.IOException expected){locked=true;}
        check(locked,"one writer per capture directory");
        for(int offset=0;offset<pcm.length;){int count=Math.min(4096,pcm.length-offset);writer.write(pcm,offset,count);offset+=count;}
        writer.close();check(receipts.size()==3,"three chunks including the tail");
        System.out.println("WAVE_TEST_PHASE=chunks_published");System.out.flush();
        long frames=0;int position=0;
        for(WaveChunkWriter.Receipt r:receipts){
            check(r.frameOffset==frames,"continuous frame offsets");
            byte[] wave=Files.readAllBytes(r.wave.toPath());
            check(wave.length==44+r.frames*2,"precise WAV byte length");
            ByteBuffer h=ByteBuffer.wrap(wave).order(ByteOrder.LITTLE_ENDIAN);
            check(h.getInt(24)==16000&&h.getShort(22)==1&&h.getShort(34)==16,"PCM16 mono 16k header");
            check(h.getInt(40)==r.frames*2,"data length");
            for(int i=44;i<wave.length;i++)check(wave[i]==pcm[position++],"no dropped or duplicated samples at a boundary");
            check(r.sha256.matches("[a-f0-9]{64}"),"SHA256 receipt");
            check(r.json().contains("\"capture_started_at\":\"2026-10-15T00:00:00Z\"")&&r.json().contains("\"capture_started_elapsed_realtime_ns\":1000000000"),"durable capture start anchors");
            check(r.json().contains("\"chunk_started_at\":\""+timing.startedAt.plusNanos(r.frameOffset*62500)+"\""),"chunk time derives from capture frames");
            byte[] sha=java.security.MessageDigest.getInstance("SHA-256").digest(wave);StringBuilder hash=new StringBuilder();
            for(byte b:sha)hash.append(String.format(java.util.Locale.ROOT,"%02x",b&255));check(hash.toString().equals(r.sha256),"receipt matches complete WAV");
            check(Files.exists(complete.resolve(String.format(java.util.Locale.ROOT,"chunk-%06d.json",r.sequence))),"published metadata");
            frames+=r.frames;
        }
        check(position==pcm.length&&frames==400123,"all synthetic frames preserved");
        check(new String(Files.readAllBytes(complete.resolve("session.json")),java.nio.charset.StandardCharsets.UTF_8).contains("synthetic_fixture"),"persisted session timing provenance");
        Path aborted=Files.createDirectory(base.resolve("abort"));WaveChunkWriter interrupted=new WaveChunkWriter(aborted.toFile(),"interrupted",10,timing,null);
        interrupted.write(pcm,0,4096);interrupted.abort();
        check(Files.exists(aborted.resolve("chunk-000000.pending.wav")),"interrupted tail is retained");
        check(!Files.exists(aborted.resolve("chunk-000000.wav")),"interrupted tail is not complete");
        Path collision=Files.createDirectory(base.resolve("collision"));Path existing=collision.resolve("chunk-000000.wav");Files.write(existing,new byte[]{1,2,3});
        WaveChunkWriter conflicting=new WaveChunkWriter(collision.toFile(),"collision",1,timing,null);
        boolean rejected=false;try{conflicting.write(new byte[32000],0,32000);}catch(java.io.IOException expected){rejected=true;}finally{conflicting.abort();}
        check(rejected&&Arrays.equals(Files.readAllBytes(existing),new byte[]{1,2,3}),"never overwrite a completed file");
        return "WAVE_TEST_OK frames=400123 chunks=3 microphone_started=false";
    }
}
