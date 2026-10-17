package com.withecho.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTimestamp
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.system.Os
import android.system.OsConstants
import android.media.ToneGenerator
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID

object RecorderState {
    @Volatile var recording = false
    @Volatile var stopping = false
    @Volatile var startedAt: String? = null
    @Volatile var captureId: String? = null
    @Volatile var segments = 0
    @Volatile var frames = 0L
    @Volatile var audioSessionId: Int? = null
    @Volatile var error: String? = null
    @Volatile var voiceCameraArmed = false
    fun json() = JSONObject().put("recording", recording).put("stopping", stopping)
        .put("capture_id", captureId ?: JSONObject.NULL).put("started_at", startedAt ?: JSONObject.NULL)
        .put("segments", segments).put("frames", frames).put("sample_rate", 16000)
        .put("duration_seconds", frames / 16000.0).put("audio_session_id", audioSessionId ?: JSONObject.NULL)
        .put("error", error ?: JSONObject.NULL).put("storage", "app-private-local").put("uploaded", false)
        .put("chunk_seconds", 10).put("asr_connected", PipelineState.json().optBoolean("models_ready"))
        .put("pipeline", PipelineState.json()).put("phone_camera", PhoneCameraState.json()).put("voice_trigger", RealtimeVoiceState.json())
}

/** Explicit microphone FGS; one AudioRecord session, file-only 10s boundaries. */
class RecordingService : Service() {
    @Volatile private var audio: AudioRecord? = null
    @Volatile private var stopRequested = false
    @Volatile private var lastFrameAt = 0L
    private var worker: Thread? = null
    private var pipeline: LocalAudioPipeline? = null
    private var realtime: RealtimeVoiceController? = null
    private var tone: ToneGenerator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val main = Handler(Looper.getMainLooper())
    private val progress = object : Runnable {
        override fun run() {
            if (!RecorderState.recording || stopRequested) return
            if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) requestStop("recording_notification_unavailable")
            else if (SystemClock.elapsedRealtime() - lastFrameAt > 6000) requestStop("capture_no_progress")
            else { broadcast(); main.postDelayed(this, 1000) }
        }
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { requestStop(null); return START_NOT_STICKY }
        if (worker?.isAlive == true || RecorderState.recording || PipelineState.json().optString("phase") == "stopping"
            || PipelineState.json().optString("remote_pause") == "pending") return START_NOT_STICKY
        try {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "录音状态", NotificationManager.IMPORTANCE_LOW))
            check(nm.areNotificationsEnabled() && nm.getNotificationChannel(CHANNEL).importance != NotificationManager.IMPORTANCE_NONE) { "recording_notification_unavailable" }
            val stop = PendingIntent.getService(this, 1, Intent(this, RecordingService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val open = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val notification = Notification.Builder(this, CHANNEL).setContentTitle("Habi 语音拍照已开启")
                .setContentText("说“哈比记录” · 哈比唤醒，记录拍照 · 停止可关闭")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now).setOngoing(true).setContentIntent(open)
                .addAction(Notification.Action.Builder(null, "停止", stop).build()).build()
            if (Build.VERSION.SDK_INT >= 30) startForeground(100, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
            else if (Build.VERSION.SDK_INT >= 29) startForeground(100, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(100, notification)
            RecorderState.voiceCameraArmed = true
            PhoneCameraState.update { put("voice_armed", true) }
            val manager = getSystemService(AudioManager::class.java)
            check(manager.mode == AudioManager.MODE_NORMAL && !manager.isMicrophoneMute) { "microphone_unavailable" }
            val minimum = AudioRecord.getMinBufferSize(16000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            check(minimum > 0) { "unsupported_audio_format" }
            val recorder = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.MIC)
                .setAudioFormat(AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(maxOf(minimum * 4, 64000)).build()
            audio = recorder
            check(recorder.state == AudioRecord.STATE_INITIALIZED) { "audio_record_initialization_failed" }
            val captureId = UUID.randomUUID().toString()
            val directory = File(filesDir, "recordings/$captureId")
            check(directory.mkdirs()) { "recording_directory_exists" }
            RecorderState.error = null; RecorderState.segments = 0; RecorderState.frames = 0
            RecorderState.captureId = captureId; RecorderState.startedAt = null
            RecorderState.audioSessionId = recorder.audioSessionId; RecorderState.stopping = false
            stopRequested = false
            val startBeforeNs = SystemClock.elapsedRealtimeNanos()
            recorder.startRecording()
            val startAfterNs = SystemClock.elapsedRealtimeNanos()
            check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "audio_record_start_failed" }
            RecorderState.recording = true; lastFrameAt = SystemClock.elapsedRealtime()
            val armed = { !stopRequested && RecorderState.voiceCameraArmed }
            realtime = RealtimeVoiceController(this, captureId, { signalId ->
                val accepted = if (!armed()) false else PhoneCameraController.request(this, signalId, armed)
                if (accepted) commandAcceptedFeedback()
                accepted
            }).also { it.start() }
            pipeline = LocalAudioPipeline(this, captureId, onEngineReady = { realtime?.setEngine(it) }, cameraOwnedByRealtime = true).also { it.start() }
            wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "EchoCompanion:recording").also { it.acquire(MAX_CAPTURE_MS + 10000) }
            worker = Thread({ capture(recorder, manager, directory, captureId, startBeforeNs, startAfterNs) }, "EchoAudioCapture").also { it.start() }
            main.postDelayed(progress, 1000)
            broadcast()
        } catch (failure: Exception) {
            RecorderState.error = failure.javaClass.simpleName + ": " + failure.message
            RecorderState.voiceCameraArmed = false
            PhoneCameraState.update { put("voice_armed", false) }
            PhoneCameraController.cancel(this)
            realtime?.stop(); realtime = null
            releaseAudio(); RecorderState.recording = false; RecorderState.stopping = false
            broadcast(); stopSelf()
        }
        return START_NOT_STICKY
    }
    private fun capture(recorder: AudioRecord, manager: AudioManager, directory: File, captureId: String, startBeforeNs: Long, startAfterNs: Long) {
        var writer: WaveChunkWriter? = null
        var voiceTiming: WaveChunkWriter.CaptureTiming? = null
        var completedNormally = false
        val started = SystemClock.elapsedRealtime()
        try {
            val buffer = ByteArray(4096)
            while (!stopRequested) {
                if (SystemClock.elapsedRealtime() - started >= MAX_CAPTURE_MS) { stopRequested = true; break }
                if (directory.usableSpace < 50L * 1024 * 1024) error("storage_low")
                if (manager.isMicrophoneMute || manager.mode != AudioManager.MODE_NORMAL) error("microphone_interrupted")
                if (Build.VERSION.SDK_INT >= 29 && recorder.activeRecordingConfiguration?.isClientSilenced == true) error("capture_silenced")
                val count = recorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                if (count < 0) { if (stopRequested) break else error("audio_read_$count") }
                if (count == 0) { Thread.sleep(5); continue }
                if (writer == null) {
                    val timing = captureTiming(recorder, startBeforeNs, startAfterNs)
                    voiceTiming = timing
                    RecorderState.startedAt = timing.startedAt.toString()
                    writer = WaveChunkWriter(directory, captureId, 10, timing) { receipt ->
                        syncDirectory(directory)
                        RecorderState.segments += 1
                        pipeline?.accept(receipt.wave, JSONObject(receipt.json()))
                        sendBroadcast(Intent(CHUNK).setPackage(packageName).putExtra("receipt", receipt.json()))
                    }
                    syncDirectory(directory)
                }
                val firstFrame = writer.totalFrames
                writer.write(buffer, 0, count)
                realtime?.accept(buffer, count, firstFrame, checkNotNull(voiceTiming))
                RecorderState.frames = writer.totalFrames
                lastFrameAt = SystemClock.elapsedRealtime()
            }
            completedNormally = true
        } catch (failure: Exception) {
            RecorderState.error = failure.javaClass.simpleName + ": " + failure.message
        } finally {
            // Cut microphone access before any file sync or pipeline shutdown work.
            releaseAudio()
            RecorderState.voiceCameraArmed = false
            PhoneCameraState.update { put("voice_armed", false) }
            PhoneCameraController.cancel(this)
            realtime?.stop(); realtime = null
            pipeline?.stop(); pipeline = null
            try {
                if (completedNormally) writer?.close() else writer?.abort()
                syncDirectory(directory)
            } catch (failure: Exception) { RecorderState.error = "file_finalize_failed: " + failure.javaClass.simpleName }
            RecorderState.recording = false; RecorderState.stopping = false
            if (wakeLock?.isHeld == true) wakeLock?.release()
            wakeLock = null
            main.post {
                if (RecorderState.captureId == captureId) {
                    main.removeCallbacks(progress); broadcast(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
                }
            }
        }
    }
    private fun captureTiming(recorder: AudioRecord, startBeforeNs: Long, startAfterNs: Long): WaveChunkWriter.CaptureTiming {
        val timestamp = AudioTimestamp()
        val available = recorder.getTimestamp(timestamp, AudioTimestamp.TIMEBASE_BOOTTIME) == AudioRecord.SUCCESS
        val before = SystemClock.elapsedRealtimeNanos()
        val wall = Instant.now()
        val after = SystemClock.elapsedRealtimeNanos()
        val reference = before + (after - before) / 2
        val frameZero = if (available && timestamp.framePosition >= 0 && timestamp.framePosition < 160000)
            timestamp.nanoTime - timestamp.framePosition * 62500 else -1L
        val usable = frameZero >= startBeforeNs - 500000000L && frameZero <= reference && reference - frameZero < 10000000000L
        val started = if (usable) frameZero else startBeforeNs + (startAfterNs - startBeforeNs) / 2
        return WaveChunkWriter.CaptureTiming(wall.plusNanos(started - reference).toString(), started,
            if (usable) "audio_timestamp_boottime" else "audio_record_start_estimate")
    }
    private fun requestStop(reason: String?) {
        if (reason != null) RecorderState.error = reason
        stopRequested = true; RecorderState.stopping = RecorderState.recording
        RecorderState.voiceCameraArmed = false
        PhoneCameraState.update { put("voice_armed", false) }
        PhoneCameraController.cancel(this)
        realtime?.stop()
        // STOP does not depend on transcription, uploads, databases or WebView.
        try { audio?.stop() } catch (_: IllegalStateException) { }
        pipeline?.stop()
        broadcast()
        if (worker?.isAlive != true) stopSelf()
    }
    private fun releaseAudio() {
        val current = audio; audio = null
        try { current?.stop() } catch (_: IllegalStateException) { }
        current?.release()
    }
    private fun syncDirectory(directory: File) {
        val fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW, 0)
        try { check(OsConstants.S_ISDIR(Os.fstat(fd).st_mode)); Os.fsync(fd) } finally { Os.close(fd) }
    }
    /** The shutter takes about a second; the accepted command is announced at once instead. */
    private fun commandAcceptedFeedback() {
        try {
            val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                (getSystemService(VibratorManager::class.java))?.defaultVibrator
            else @Suppress("DEPRECATION") (getSystemService(VIBRATOR_SERVICE) as? Vibrator)
            vibrator?.vibrate(VibrationEffect.createOneShot(45, VibrationEffect.DEFAULT_AMPLITUDE))
        } catch (_: Throwable) { }
        try {
            synchronized(this) {
                tone?.release()
                tone = ToneGenerator(AudioManager.STREAM_MUSIC, 70).also { it.startTone(ToneGenerator.TONE_PROP_BEEP, 120) }
            }
        } catch (_: Throwable) { tone = null }
    }

    private fun broadcast() { sendBroadcast(Intent(STATUS).setPackage(packageName)) }
    override fun onDestroy() {
        main.removeCallbacks(progress)
        requestStop(null)
        super.onDestroy()
    }
    companion object {
        const val STOP = "com.withecho.companion.STOP_RECORDING"
        const val STATUS = "com.withecho.companion.RECORDING_STATUS"
        const val CHUNK = "com.withecho.companion.RECORDING_CHUNK"
        private const val CHANNEL = "recording"
        private const val MAX_CAPTURE_MS = 12 * 60 * 60 * 1000L
    }
}
