package com.withecho.companion

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.*
import android.provider.Settings
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Sole native frame writer. Its separate process survives the Activity process disappearing. */
class VendorRearService : Service() {
    private val worker = HandlerThread("habi-rear-owner")
    private lateinit var queue: Handler
    private var requested = "idle"
    @Volatile private var pending: String? = null
    private var deadline = 0L
    @Volatile private var active = false
    private var lastWake = -30000L
    @Volatile private var stopping = false
    @Volatile private var cleaning = false
    @Volatile private var destroyed = false
    @Volatile private var latestStartId = 0
    private val main = Handler(Looper.getMainLooper())
    private var lease: android.net.LocalServerSocket? = null
    private var guardLease: android.net.LocalServerSocket? = null
    private var manager: Any? = null
    private val hashes = mutableSetOf<String>()
    private var submittedHash = ""
    private var generation = 0
    private val tick = object : Runnable {
        override fun run() {
            try {
                if (!active) return
                val now = SystemClock.elapsedRealtime()
                val observation = snapshot()
                publish(if (observation.activeOurs(android.os.Process.myUid())) "showing" else "submitted", observation)
                if (observation.foreign(android.os.Process.myUid(), hashes)) { finishLease("external-frame-preserved"); return }
                if (now >= deadline || observation.externalInteraction()) { cleanup(); return }
                queue.postDelayed(this, 700)
            } catch (e: Throwable) { cleanup(e.javaClass.simpleName) }
        }
    }
    override fun onCreate() {
        super.onCreate()
        val notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(NotificationChannel(CHANNEL, "Habi 背屏", NotificationManager.IMPORTANCE_LOW))
        val stop = PendingIntent.getService(this, 0, Intent(this, VendorRearService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        startForeground(NOTIFICATION, Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("Habi 背屏正在显示").setContentText("限时状态图案 · 不使用麦克风或相机")
            .addAction(Notification.Action.Builder(null, "停止背屏", stop).build()).setOngoing(true).build())
        worker.start(); queue = Handler(worker.looper)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        latestStartId = startId
        val scene = intent?.getStringExtra("scene") ?: "idle"
        if (intent?.action == STOP) { pending = null; stopping = true }
        else if (scene in SCENES && !stopping && (!active || scene != requested)) pending = scene
        queue.post {
            if (destroyed || cleaning) return@post
            if (stopping) {
                val previous = readJournal()
                if (!active && previous != null) {
                    previous.optJSONArray("hashes")?.let { values -> for (i in 0 until values.length()) hashes.add(values.getString(i)) }
                    active = true
                }
                if (active) cleanup() else finishLease("stopped")
                return@post
            }
            val next = pending ?: return@post
            pending = null
            if (active) { pending = next; cleanup() } else submit(next)
        }
        return START_NOT_STICKY
    }
    override fun onBind(intent: Intent?) = null
    private fun submit(scene: String) {
        try {
            check(!destroyed) { "service_destroyed" }
            check(checkSelfPermission("android.permission.DUMP") == 0) { "debug_diagnostics_permission_required" }
            if (lease == null) lease = android.net.LocalServerSocket("com.withecho.habi.frame.controller.v1")
            if (guardLease == null) guardLease = android.net.LocalServerSocket("com.withecho.habi.frame.guard.v1")
            val before = snapshot()
            val previous = readJournal()
            hashes.clear()
            previous?.optJSONArray("hashes")?.let { a -> for (i in 0 until a.length()) hashes.add(a.getString(i)) }
            // Recover only this app UID and exact hashes journaled before its previous setter.
            if (before.ours(android.os.Process.myUid(), hashes)) { pending = scene; active = true; requested = scene; cleanup(); return }
            check(before.empty() && !before.externalInteraction()) { "display_busy" }
            val pattern = assets.open("habi.json").bufferedReader().use { JSONObject(it.readText()) }
            val masks = pattern.getJSONObject("scenes").getJSONObject(scene).getJSONArray("frames").getJSONObject(0).getJSONArray("rowBitmasks")
            check(masks.length() == 23)
            for (row in 0 until masks.length()) check(masks.getInt(row) in 0 until (1 shl 17)) { "invalid_frame_mask" }
            val pixels = IntArray(391) { index -> ((masks.getInt(index / 17) shr (16 - index % 17)) and 1) * 255 }
            submittedHash = hash(ByteArray(391) { pixels[it].toByte() }); hashes.clear(); hashes.add(submittedHash)
            requested = scene; deadline = SystemClock.elapsedRealtime() + 8000; generation++
            writeJson(this, "journal.json", JSONObject().put("uid", android.os.Process.myUid()).put("boot", boot(this)).put("hashes", org.json.JSONArray(hashes.toList())).put("scene", scene))
            val target = getSystemService("display_ext") ?: error("vendor_manager_unavailable"); manager = target
            target.javaClass.getMethod("setBackScreenFrame", IntArray::class.java, Bundle::class.java).invoke(target, pixels, null)
            active = true
            // Wake is a policy request, never a power/brightness override. Quiet states do not wake.
            if (scene !in setOf("idle", "resting") && SystemClock.elapsedRealtime() - lastWake >= 30000) {
                try { target.javaClass.getMethod("wakeUpBackScreen").invoke(target); lastWake = SystemClock.elapsedRealtime() } catch (_: Throwable) { }
            }
            publish("submitted", null); queue.removeCallbacks(tick); queue.postDelayed(tick, 250)
        } catch (e: Throwable) {
            if (active || readJournal() != null) { active = true; cleanup(rootError(e)) }
            else { publish("unavailable", null, rootError(e)); finishLease("unavailable", preserveStatus = true) }
        }
    }
    private fun cleanup(error: String? = null) {
        if (cleaning) return
        cleaning = true
        queue.removeCallbacks(tick)
        publish("cleaning", null, error)
        val until = SystemClock.elapsedRealtime() + 16000
        var clearAt = -1L; var emptySince = -1L
        var final: RearFrameOwnership? = null
        try {
            while (SystemClock.elapsedRealtime() < until) {
                val first = snapshot(); final = first
                if (first.foreign(android.os.Process.myUid(), hashes)) { finishLease("external-frame-preserved"); return }
                if (first.empty()) {
                    if (emptySince < 0) emptySince = SystemClock.elapsedRealtime()
                    if (SystemClock.elapsedRealtime() - emptySince >= 6200 && (clearAt < 0 || SystemClock.elapsedRealtime() - clearAt >= 6200)) {
                        val second = snapshot()
                        if (second.empty() && first.same(second)) {
                            file(this, "journal.json").delete(); active = false
                            publish("idle", second, error)
                            val next = pending; pending = null
                            cleaning = false
                            if (next != null && !stopping) submit(next) else finishLease("idle", preserveStatus = true)
                            return
                        }
                    }
                } else emptySince = -1
                if (first.ours(android.os.Process.myUid(), hashes) && (clearAt < 0 || SystemClock.elapsedRealtime() - clearAt >= 6200)) {
                    Thread.sleep(75); val second = snapshot()
                    if (first.same(second) && second.ours(android.os.Process.myUid(), hashes)) {
                        val target = manager ?: getSystemService("display_ext") ?: error("vendor_manager_unavailable")
                        target.javaClass.getMethod("setBackScreenFrame", IntArray::class.java, Bundle::class.java).invoke(target, *arrayOf<Any?>(null, null))
                        clearAt = SystemClock.elapsedRealtime()
                    }
                }
                Thread.sleep(350)
            }
            publish("cleanup-pending", final, error ?: "cleanup_not_verified")
        } catch (e: Throwable) { publish("cleanup-pending", final, rootError(e)) }
        finishLease("cleanup-pending", preserveStatus = true)
    }
    private fun snapshot(): RearFrameOwnership {
        val process = ProcessBuilder("/system/bin/dumpsys", "display_ext", "back_screen").redirectErrorStream(true).start()
        val reader = java.io.ByteArrayOutputStream()
        val thread = Thread { process.inputStream.use { input ->
            val buffer = ByteArray(4096)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (reader.size() + count > 131072) { process.destroyForcibly(); break }
                reader.write(buffer, 0, count)
            }
        } }.apply { isDaemon = true; start() }
        check(process.waitFor(1800, TimeUnit.MILLISECONDS)) { process.destroyForcibly(); "display_snapshot_timeout" }
        thread.join(250); check(!thread.isAlive && process.exitValue() == 0) { "display_snapshot_failed" }
        val stored = Settings.System.getString(contentResolver, "stepos_back_screen_basic_frame")
        val storedHash = if (stored.isNullOrEmpty()) "" else try { android.util.Base64.decode(stored, android.util.Base64.DEFAULT).let { if (it.size == 391) hash(it) else "invalid" } } catch (_: Throwable) { "invalid" }
        return RearFrameOwnership(reader.toString("UTF-8"), storedHash)
    }
    private fun readJournal(): JSONObject? = try { JSONObject(file(this, "journal.json").readText()).takeIf { it.getInt("uid") == android.os.Process.myUid() && it.getString("boot") == boot(this) } } catch (_: Throwable) { null }
    private fun publish(phase: String, observation: RearFrameOwnership?, error: String? = null) {
        writeJson(this, "status.json", JSONObject().put("backend", "vendor-custom").put("pattern", "habi-star-v1").put("scene", requested)
            .put("phase", phase).put("native_rendering", phase == "showing" && (observation?.let { it.activeOurs(android.os.Process.myUid()) && it.applied == "true" && it.policy == "true" && it.power == "on" } ?: false))
            .put("vendor_control_available", phase !in setOf("unavailable", "cleanup-pending"))
            .put("physical_visual_confirmed", false).put("requires_cable", false).put("deadline_elapsed_ms", deadline)
            .put("observed_elapsed_ms", SystemClock.elapsedRealtime()).put("boot", boot(this)).put("generation", generation)
            .put("custom_frame_active", observation?.activeOurs(android.os.Process.myUid()) ?: active)
            .put("error", error ?: JSONObject.NULL))
    }
    private fun finishLease(phase: String, preserveStatus: Boolean = false) {
        active = false; queue.removeCallbacks(tick)
        if (!preserveStatus) publish(phase, null)
        cleaning = false; lease?.close(); lease = null; guardLease?.close(); guardLease = null
        val completedStartId = latestStartId
        main.post {
            // A newer scene intent must retain its foreground lifetime.
            if (latestStartId == completedStartId && !active && !cleaning) {
                stopForeground(STOP_FOREGROUND_REMOVE); stopSelfResult(completedStartId)
            }
        }
    }
    override fun onDestroy() { destroyed = true; queue.removeCallbacks(tick); lease?.close(); guardLease?.close(); worker.quitSafely(); super.onDestroy() }
    companion object {
        const val STOP = "com.withecho.companion.STOP_REAR"
        private const val CHANNEL = "habi_rear"; private const val NOTIFICATION = 73
        val SCENES = setOf("idle", "collecting", "received", "listening", "watering", "resting")
        fun status(context: Context): JSONObject = try {
            val value = JSONObject(file(context, "status.json").readText()).takeIf { it.optString("boot") == boot(context) } ?: JSONObject()
            if (value.optString("phase") in setOf("submitted", "showing", "cleaning") && SystemClock.elapsedRealtime() > value.optLong("deadline_elapsed_ms") + 16000)
                value.put("native_rendering", false).put("phase", "cleanup-pending").put("error", "service_status_expired")
            value
        } catch (_: Throwable) { JSONObject() }
        private fun file(context: Context, name: String) = File(context.filesDir, "habi-rear/$name").also { it.parentFile?.mkdirs() }
        private fun writeJson(context: Context, name: String, data: JSONObject) {
            val target = AtomicFile(file(context, name)); val output = target.startWrite()
            try { output.write(data.toString().toByteArray()); target.finishWrite(output) } catch (e: Throwable) { target.failWrite(output); throw e }
        }
        private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        private fun boot(context: Context) = Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT, -1).also { check(it >= 0) { "boot_count_unavailable" } }.toString()
        private fun rootError(error: Throwable): String { var cause = error; while (cause is java.lang.reflect.InvocationTargetException && cause.cause != null) cause = cause.cause!!; return cause.javaClass.simpleName + ": " + (cause.message ?: "") }
    }
}
