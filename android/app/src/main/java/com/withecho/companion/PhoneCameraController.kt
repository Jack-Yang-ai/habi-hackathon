package com.withecho.companion

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.*
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.view.Surface
import android.view.WindowManager
import android.webkit.CookieManager
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

object PhoneCameraState {
    // A committed capture is carried to the page as a data URL, so the photo the user just took can
    // The committed capture is kept as a small preview so the page can show the photo it just took
    // before the upload and the next poll finish. It is served on request rather than inside the
    // capability payload, which the page reads every two seconds.
    private const val LOCAL_PREVIEW_MAX_EDGE = 720
    private var value = JSONObject().put("phase", "idle").put("voice_armed", false)
    @Volatile private var preview: String? = null
    @Synchronized fun update(change: JSONObject.() -> Unit) { value.change(); value.put("updated_at", Instant.now().toString()) }
    @Synchronized fun json() = JSONObject(value.toString())
    @Synchronized fun attachLocalPhoto(file: File) {
        preview = buildPreview(file)
        value.put("local_photo_ready", preview != null)
    }
    @Synchronized fun clearLocalPhoto() { preview = null; value.put("local_photo_ready", false) }
    @Synchronized fun localPhoto(): String? = preview

    /** A downscaled copy for display only; the committed file stays untouched as the uploaded original. */
    private fun buildPreview(file: File): String? = try {
        if (!file.isFile) null else {
            val full = android.graphics.BitmapFactory.decodeFile(file.absolutePath) ?: return null
            val longest = maxOf(full.width, full.height)
            val scaled = if (longest <= LOCAL_PREVIEW_MAX_EDGE) full else android.graphics.Bitmap.createScaledBitmap(
                full, full.width * LOCAL_PREVIEW_MAX_EDGE / longest, full.height * LOCAL_PREVIEW_MAX_EDGE / longest, true)
            val out = java.io.ByteArrayOutputStream()
            scaled.compress(android.graphics.Bitmap.CompressFormat.JPEG, 80, out)
            if (scaled !== full) scaled.recycle()
            full.recycle()
            "data:image/jpeg;base64," + android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP)
        }
    } catch (_: Throwable) { null }
}

/** One rear JPEG per request. Upload retries reuse the durable file and capture ID. */
object PhoneCameraController {
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "HabiPhoneCamera") }
    // Review polling must not hold the shutter: a fresh photo is possible while the server checks the last one.
    private val reviewer = Executors.newSingleThreadExecutor { Thread(it, "HabiCameraReview") }
    // 1280 is the largest edge that still exposes enough detail for a food review while roughly
    // halving JPEG encoding time, which is what dominates the wait after the shutter.
    internal var CAPTURE_MAX_EDGE = 1280
    /** Upper bound on the 3A warm-up if exposure never settles. */
    internal var WARMUP_DEADLINE_MS = 1500L
    /** Consecutive settled frames required before the still, and the give-up point. */
    private const val AE_STABLE_FRAMES = 3
    private const val AE_GIVE_UP_FRAMES = 45
    private val busy = AtomicBoolean(false)
    private val generation = AtomicLong(0)
    @Volatile private var closeCamera: (() -> Unit)? = null
    @Volatile private var connection: HttpURLConnection? = null

    fun cancel(context: Context) {
        generation.incrementAndGet()
        closeCamera?.invoke()
        connection?.disconnect()
        if (busy.get()) update(context) { put("phase", "stopped").put("detail", "已停止；已保存照片保留在手机") }
    }

    fun request(context: Context, requestId: String = UUID.randomUUID().toString(), allowed: () -> Boolean = { true }): Boolean {
        val app = context.applicationContext
        if (!allowed() || !busy.compareAndSet(false, true)) return false
        val run = generation.get()
        val valid = { run == generation.get() && allowed() }
        executor.execute {
            val id = "phone-camera-" + sha256(requestId).take(32)
            val directory = File(app.filesDir, "phone-camera").apply { mkdirs() }
            val jpeg = File(directory, "$id.jpg")
            val receiptFile = File(directory, "$id.json")
            var receipt = JSONObject().put("capture_id", id).put("request_id", requestId)
            try {
                check(valid()) { "camera_request_stopped" }
                check(directory.usableSpace > 25L * 1024 * 1024) { "storage_low" }
                update(app) { put("capture_id", id).remove("error") }
                PhoneCameraState.clearLocalPhoto()
                if (jpeg.isFile && receiptFile.isFile) {
                    receipt = JSONObject(receiptFile.readText())
                    check(receipt.has("metadata")) { "saved_photo_receipt_missing" }
                } else {
                    check(app.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) { "camera_permission_required" }
                    // An interrupted shutter with no committed receipt is never silently reshot.
                    check(!jpeg.exists() && !receiptFile.exists()) { "camera_request_requires_review" }
                    atomicWrite(receiptFile, receipt.put("phase", "requested"))
                    update(app) { put("phase", "capturing").put("capture_id", id).put("uploaded", false).put("saved_locally", false)
                        .remove("error"); remove("review"); remove("detail"); remove("meal_title") }
                    val photo = takeJpeg(app, valid)
                    check(valid()) { "camera_request_stopped" }
                    val pending = File(directory, "$id.jpg.pending")
                    FileOutputStream(pending).use { it.write(photo.bytes); it.fd.sync() }
                    check(pending.renameTo(jpeg)) { "photo_commit_failed" }
                    // Committed. Hand the page the local bytes now; the upload continues behind it.
                    PhoneCameraState.attachLocalPhoto(jpeg)
                    val prefs = app.getSharedPreferences("native_pipeline", Context.MODE_PRIVATE)
                    val deviceId = prefs.getString("phone_camera_id", null) ?: ("phone-" + UUID.randomUUID()).also {
                        prefs.edit().putString("phone_camera_id", it).apply()
                    }
                    receipt.put("metadata", JSONObject().put("schema_version", 1).put("capture_id", id)
                        .put("device_id", deviceId).put("boot_id", "android-camera").put("sequence", 0)
                        .put("captured_at", photo.capturedAt).put("time_source", "phone").put("uptime_ms", SystemClock.elapsedRealtime())
                        .put("mime_type", "image/jpeg").put("width", photo.width).put("height", photo.height))
                        .put("sha256", sha256(photo.bytes)).put("bytes", jpeg.length()).put("phase", "saved")
                        .put("camera_timing_ms", photo.timing)
                    atomicWrite(receiptFile, receipt)
                }
                check(sha256(jpeg.readBytes()) == receipt.getString("sha256")) { "saved_photo_hash_mismatch" }
                check(valid()) { "camera_request_stopped" }
                update(app) { put("phase", "uploading").put("capture_id", id).put("saved_locally", true) }
                var uploaded = receipt.optBoolean("uploaded")
                var last: Exception? = null
                for (attempt in 0..2) {
                    if (uploaded) break
                    check(valid()) { "camera_request_stopped" }
                    try {
                        upload(app, jpeg, receipt.getJSONObject("metadata"), valid)
                        uploaded = true
                        receipt.put("uploaded", true).put("phase", "checking")
                        atomicWrite(receiptFile, receipt)
                    } catch (e: Exception) {
                        last = e
                        if (!valid() || e.message?.contains("http_401") == true || e.message?.contains("http_409") == true) break
                        if (attempt < 2) Thread.sleep((attempt + 1) * 750L)
                    }
                }
                if (!uploaded) throw last ?: IllegalStateException("photo_upload_failed")
                check(valid()) { "camera_request_stopped" }
                update(app) { put("phase", "checking").put("uploaded", true).put("detail", "已拍一张，Step 正在检查") }
                // The photo is committed and uploaded; free the shutter and watch the review separately.
                busy.set(false)
                reviewer.execute { pollReview(app, id, receiptFile, receipt, valid) }
                return@execute
            } catch (e: Exception) {
                receipt.put("error", e.javaClass.simpleName + ": " + e.message)
                receipt.put("phase", if (!valid()) "stopped" else if (receipt.optBoolean("uploaded")) "review_pending" else "failed")
                try { atomicWrite(receiptFile, receipt) } catch (_: Exception) { }
                if (valid()) update(app) { put("phase", receipt.getString("phase")).put("error", receipt.getString("error"))
                    put("saved_locally", jpeg.isFile).put("capture_id", id).put("uploaded", receipt.optBoolean("uploaded")) }
            } finally { closeCamera = null; connection = null; busy.set(false) }
        }
        return true
    }

    private fun pollReview(app: Context, id: String, receiptFile: File, receipt: JSONObject, valid: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 90000
        while (valid() && SystemClock.elapsedRealtime() < deadline) {
            try {
                val result = get(app, "/api/phone/captures/$id", valid)
                val review = result.optJSONObject("review")
                if (review != null && review.optString("status") !in setOf("checking", "waiting_photo", "waiting_retry")) {
                    receipt.put("phase", review.getString("status")).put("review", review)
                    atomicWrite(receiptFile, receipt)
                    update(app) { put("phase", review.getString("status")).put("review", review)
                        put("meal_title", result.optJSONObject("meal")?.optString("title") ?: JSONObject.NULL)
                        put("detail", review.optString("reason", "识别已完成，食量仍需确认")) }
                    return
                }
            } catch (_: Exception) {
                // A transient read failure keeps the saved photo; the next tick retries.
            }
            Thread.sleep(1000)
        }
        // Listening stopped or the request was cancelled: never leave the panel reading "checking".
        if (!valid()) update(app) { put("phase", "stopped").put("detail", "已停止；已保存照片保留在手机") }
        else update(app) { put("phase", "checking").put("detail", "照片已上传，稍后在 App 查看识别结果") }
    }

    fun retryLatest(context: Context): Boolean {
        val receipt = File(context.filesDir, "phone-camera").listFiles()?.filter { it.extension == "json" }
            ?.maxByOrNull { it.lastModified() } ?: return false
        val value = try { JSONObject(receipt.readText()) } catch (_: Exception) { return false }
        if (!value.has("metadata")) return false
        return request(context, value.getString("request_id"))
    }


    private data class Photo(val bytes: ByteArray, val width: Int, val height: Int, val capturedAt: String, val timing: JSONObject? = null)

    @SuppressLint("MissingPermission")
    private fun takeJpeg(context: Context, valid: () -> Boolean): Photo {
        val tStart = SystemClock.elapsedRealtime()
        var tOpened = 0L; var tConfigured = 0L; var tShot = 0L; var tFrames = 0
        val manager = context.getSystemService(CameraManager::class.java)
        val id = manager.cameraIdList.firstOrNull { manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
            ?: error("rear_camera_unavailable")
        val info = manager.getCameraCharacteristics(id)
        val map = checkNotNull(info.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP))
        val size = map.getOutputSizes(ImageFormat.JPEG).filter { maxOf(it.width, it.height) <= CAPTURE_MAX_EDGE }
            .maxByOrNull { it.width * it.height } ?: map.getOutputSizes(ImageFormat.JPEG).minBy { it.width * it.height }
        val warmSize = map.getOutputSizes(ImageFormat.YUV_420_888).filter { it.width <= 640 && it.height <= 480 }
            .maxByOrNull { it.width * it.height } ?: map.getOutputSizes(ImageFormat.YUV_420_888).minBy { it.width * it.height }
        val thread = HandlerThread("HabiCamera2").apply { start() }
        val handler = Handler(thread.looper)
        val latch = CountDownLatch(1)
        val reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 2)
        val warm = ImageReader.newInstance(warmSize.width, warmSize.height, ImageFormat.YUV_420_888, 2)
        var device: CameraDevice? = null
        var session: CameraCaptureSession? = null
        var result: Photo? = null
        var failure: String? = null
        var finished = false
        var shot = false
        var frameCount = 0
        var capturedAt = ""
        var timing: JSONObject? = null
        fun finish(error: String? = null) {
            if (finished) return
            finished = true; failure = error
            try { session?.close() } catch (_: Exception) { }
            device?.close(); reader.close(); warm.close(); latch.countDown()
        }
        closeCamera = { handler.post { finish("camera_request_stopped") } }
        handler.postDelayed({ finish("camera_timeout") }, 12000)
        warm.setOnImageAvailableListener({ source ->
            try { source.acquireLatestImage()?.close() } catch (_: IllegalStateException) { /* Reader closed after the still. */ }
        }, handler)
        reader.setOnImageAvailableListener({ source ->
            try {
                source.acquireNextImage()?.use { image ->
                    if (!valid()) { finish("camera_request_stopped"); return@use }
                    val buffer = image.planes[0].buffer
                    check(buffer.remaining() in 1..(8 * 1024 * 1024)) { "photo_size_out_of_range" }
                    val bytes = ByteArray(buffer.remaining()); buffer.get(bytes)
                    val text = capturedAt.ifBlank { Instant.now().toString() }
                    timing = JSONObject().put("open_ms", tOpened - tStart).put("configure_ms", tConfigured - tOpened)
                        .put("warmup_ms", tShot - tConfigured).put("warmup_frames", tFrames)
                        .put("decode_ms", SystemClock.elapsedRealtime() - tShot).put("total_ms", SystemClock.elapsedRealtime() - tStart)
                    result = Photo(bytes, size.width, size.height, text, timing)
                    // The image must be closed before its reader.
                }
                finish()
            } catch (e: Exception) { finish("jpeg_read_" + e.javaClass.simpleName) }
        }, handler)
        fun sendStill(camera: CameraDevice, configured: CameraCaptureSession) {
            if (shot || finished) return
            if (!valid()) { finish("camera_request_stopped"); return }
            shot = true
            tShot = SystemClock.elapsedRealtime(); tFrames = frameCount
            try {
                configured.stopRepeating()
                val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply {
                    addTarget(reader.surface); set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                    set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                    set(CaptureRequest.FLASH_MODE, CaptureRequest.FLASH_MODE_OFF)
                    val sensor = info.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
                    @Suppress("DEPRECATION")
                    val rotation = context.getSystemService(WindowManager::class.java).defaultDisplay.rotation
                    val degrees = when (rotation) { Surface.ROTATION_90 -> 90; Surface.ROTATION_180 -> 180; Surface.ROTATION_270 -> 270; else -> 0 }
                    set(CaptureRequest.JPEG_ORIENTATION, (sensor - degrees + 360) % 360)
                    set(CaptureRequest.JPEG_QUALITY, 88.toByte())
                }.build()
                configured.capture(request, object : CameraCaptureSession.CaptureCallback() {
                    override fun onCaptureStarted(s: CameraCaptureSession, r: CaptureRequest, timestamp: Long, frameNumber: Long) { capturedAt = Instant.now().toString() }
                    override fun onCaptureFailed(s: CameraCaptureSession, r: CaptureRequest, f: CaptureFailure) { finish("still_capture_failed_" + f.reason) }
                }, handler)
            } catch (e: Exception) { finish("still_capture_" + e.javaClass.simpleName) }
        }
        try {
            manager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(camera: CameraDevice) {
                    tOpened = SystemClock.elapsedRealtime()
                    device = camera
                    if (finished || !valid()) { camera.close(); finish("camera_request_stopped"); return }
                    try {
                        @Suppress("DEPRECATION")
                        camera.createCaptureSession(listOf(reader.surface, warm.surface), object : CameraCaptureSession.StateCallback() {
                            override fun onConfigured(configured: CameraCaptureSession) {
                                tConfigured = SystemClock.elapsedRealtime()
                                session = configured
                                if (finished || !valid()) { configured.close(); finish("camera_request_stopped"); return }
                                fun take() = sendStill(camera, configured)
                                try {
                                    val preview = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                                        addTarget(warm.surface); set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
                                        set(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_ON)
                                        if (info.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)?.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE) == true)
                                            set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                                    }.build()
                                    var stableFrames = 0
                                    configured.setRepeatingRequest(preview, object : CameraCaptureSession.CaptureCallback() {
                                        override fun onCaptureCompleted(s: CameraCaptureSession, r: CaptureRequest, result: TotalCaptureResult) {
                                            frameCount++
                                            // Exposure must be settled, not merely reported settled once: on this
                                            // device AE_STATE_CONVERGED flickers, so a single converged frame still
                                            // produced a blown-out shot (median 255) and a bare frame count produced a
                                            // black one (median 20). Stability is counted over consecutive frames, so the
                                            // still is only taken once the exposure has stopped moving.
                                            val ae = result.get(CaptureResult.CONTROL_AE_STATE)
                                            val settled = ae == CaptureResult.CONTROL_AE_STATE_CONVERGED || ae == CaptureResult.CONTROL_AE_STATE_LOCKED
                                            stableFrames = if (settled) stableFrames + 1 else 0
                                            if (stableFrames >= AE_STABLE_FRAMES || frameCount >= AE_GIVE_UP_FRAMES) take()
                                        }
                                    }, handler)
                                    handler.postDelayed({ take() }, WARMUP_DEADLINE_MS)
                                } catch (e: Exception) { finish("camera_warmup_" + e.javaClass.simpleName) }
                            }
                            override fun onConfigureFailed(s: CameraCaptureSession) { s.close(); finish("camera_session_failed") }
                        }, handler)
                    } catch (e: Exception) { finish("camera_open_" + e.javaClass.simpleName) }
                }
                override fun onDisconnected(camera: CameraDevice) { camera.close(); finish("camera_disconnected") }
                override fun onError(camera: CameraDevice, error: Int) { camera.close(); finish("camera_error_$error") }
            }, handler)
            check(latch.await(15, TimeUnit.SECONDS)) { "camera_callback_timeout" }
            check(failure == null) { failure ?: "camera_failed" }
            return checkNotNull(result) { "camera_image_missing" }
        } finally {
            handler.post { finish("camera_closed"); handler.removeCallbacksAndMessages(null); thread.quitSafely() }
            thread.join(1500); closeCamera = null
        }
    }

    private fun open(context: Context, path: String): HttpURLConnection {
        val prefs = context.getSharedPreferences("native_pipeline", Context.MODE_PRIVATE)
        val base = URI(prefs.getString("backend_url", "http://127.0.0.1:8787")!!)
        check(base.scheme in setOf("http", "https") && base.host != null && base.userInfo == null && base.query == null && base.fragment == null) { "invalid_backend_url" }
        return (base.resolve(path).toURL().openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = false; connectTimeout = 5000; readTimeout = 10000
            prefs.getString("app_token", "").orEmpty().takeIf { it.isNotEmpty() }?.let { setRequestProperty("X-App-Token", it) }
            CookieManager.getInstance().getCookie(base.resolve("/").toString())?.let { setRequestProperty("Cookie", it) }
        }
    }
    private fun upload(context: Context, jpeg: File, metadata: JSONObject, valid: () -> Boolean) {
        val boundary = "Habi" + UUID.randomUUID().toString().replace("-", "")
        val prefix = ("--$boundary\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n$metadata\r\n" +
            "--$boundary\r\nContent-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n").toByteArray()
        val suffix = "\r\n--$boundary--\r\n".toByteArray()
        val c = open(context, "/api/phone/captures"); connection = c
        try {
            check(valid()) { "camera_request_stopped" }
            c.requestMethod = "POST"; c.doOutput = true
            c.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
            c.setFixedLengthStreamingMode(prefix.size + jpeg.length() + suffix.size)
            c.outputStream.use { output -> output.write(prefix); jpeg.inputStream().use { it.copyTo(output) }; output.write(suffix) }
            check(c.responseCode in 200..299) { "photo_upload_http_${c.responseCode}" }
            c.inputStream.use { input -> val buffer = ByteArray(8192); while (input.read(buffer) > 0) { } }
        } finally { c.disconnect(); if (connection === c) connection = null }
    }
    private fun get(context: Context, path: String, valid: () -> Boolean): JSONObject {
        val c = open(context, path); connection = c
        try {
            check(valid()) { "camera_request_stopped" }
            check(c.responseCode == 200) { "photo_review_http_${c.responseCode}" }
            val bytes = c.inputStream.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (output.size() <= 1024 * 1024) {
                    val count = input.read(buffer, 0, minOf(buffer.size, 1024 * 1024 + 1 - output.size()))
                    if (count < 0) break
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            check(bytes.size <= 1024 * 1024) { "review_response_too_large" }
            return JSONObject(bytes.toString(Charsets.UTF_8))
        } finally { c.disconnect(); if (connection === c) connection = null }
    }
    private fun update(context: Context, change: JSONObject.() -> Unit) {
        PhoneCameraState.update(change)
        context.sendBroadcast(Intent(RecordingService.STATUS).setPackage(context.packageName))
    }
    private fun atomicWrite(file: File, json: JSONObject) {
        val pending = File(file.parentFile, file.name + ".pending")
        FileOutputStream(pending).use { it.write(json.toString().toByteArray()); it.fd.sync() }
        check(pending.renameTo(file)) { "camera_receipt_commit_failed" }
    }
    private fun sha256(text: String) = sha256(text.toByteArray(Charsets.UTF_8))
    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
}
