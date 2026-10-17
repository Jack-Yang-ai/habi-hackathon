package com.withecho.companion

import android.animation.ValueAnimator
import android.app.Activity
import android.app.Presentation
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.View
import org.json.JSONArray
import org.json.JSONObject

/** Public presentation adapter with a bounded vendor-frame service fallback. */
class RearDisplayController(private val activity: Activity) {
    private val manager = activity.getSystemService(DisplayManager::class.java)
    private val pattern by lazy { HabiPattern.load(activity) }
    private var presentation: ScenePresentation? = null
    private val handler = Handler(Looper.getMainLooper())
    private var lastScene = "idle"
    private var lastError: String? = null
    private val reset = Runnable { setScene("idle", 0) }
    private val listener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) { refresh() }
        override fun onDisplayRemoved(displayId: Int) { refresh() }
        override fun onDisplayChanged(displayId: Int) { refresh() }
    }
    init { manager.registerDisplayListener(listener, handler) }
    fun refresh() {
        val display = manager.getDisplays(DisplayManager.DISPLAY_CATEGORY_PRESENTATION).firstOrNull()
        if (display == null) {
            presentation?.dismiss(); presentation = null
            if (!enabled() && activity.checkSelfPermission("android.permission.DUMP") == PackageManager.PERMISSION_GRANTED && java.io.File(activity.filesDir, "habi-rear/journal.json").exists()) {
                try { activity.startForegroundService(Intent(activity, VendorRearService::class.java).setAction(VendorRearService.STOP)) } catch (_: Exception) { }
            }
            return
        }
        if (presentation?.display?.displayId == display.displayId) return
        presentation?.dismiss()
        try {
            presentation = ScenePresentation(activity, display, pattern).also { it.show(); it.scene(lastScene) }
            lastError = null
        } catch (e: Exception) { lastError = e.javaClass.simpleName; presentation = null }
    }
    fun setScene(scene: String, ttlMs: Long): JSONObject {
        if (scene !in SCENES) return JSONObject().put("ok", false).put("error", "unknown_scene")
        lastScene = scene
        refresh(); presentation?.scene(scene)
        if (presentation == null && enabled() && activity.checkSelfPermission("android.permission.DUMP") == PackageManager.PERMISSION_GRANTED) {
            try { activity.startForegroundService(Intent(activity, VendorRearService::class.java).putExtra("scene", scene)) }
            catch (e: Exception) { lastError = e.javaClass.simpleName }
        }
        handler.removeCallbacks(reset)
        if (presentation != null && ttlMs > 0) handler.postDelayed(reset, ttlMs.coerceIn(1000, 300000))
        return status().put("ok", presentation != null)
    }
    fun status(): JSONObject {
        val vendor = VendorRearService.status(activity)
        val vendorPermission = activity.checkSelfPermission("com.stepos.permission.MANAGE_BACK_SCREEN") == PackageManager.PERMISSION_GRANTED
        val displays = JSONArray()
        manager.displays.forEach { displays.put(JSONObject().put("id", it.displayId).put("name", it.name).put("state", it.state)) }
        val result = JSONObject().put("scene", lastScene).put("pattern", "habi-star-v1")
            .put("backend", if (presentation != null) "public-display" else "unverified")
            .put("vendor_permission_granted", vendorPermission)
            .put("diagnostics_granted", activity.checkSelfPermission("android.permission.DUMP") == PackageManager.PERMISSION_GRANTED)
            .put("enabled", enabled())
            .put("native_rendering", presentation != null).put("displays", displays)
            .put("error", lastError ?: JSONObject.NULL)
            .put("note", if (presentation != null) "公共第二显示设备已提交 Habi 点阵，物理画面需验收" else if (activity.checkSelfPermission("android.permission.DUMP") != PackageManager.PERMISSION_GRANTED) "手机直连已接入；调试包需诊断读取授权才能核对帧归属" else "手机直连接口已接入，等待首次状态提交和真机验收")
        if (vendor.length() > 0 && presentation == null) vendor.keys().forEach { key -> result.put(key, vendor.get(key)) }
        if (vendor.optBoolean("vendor_control_available")) result.put("note", "手机直接提交 Habi 静态帧，每次8秒；系统通知和保护策略优先")
        return result
    }
    fun enabled() = activity.getSharedPreferences("habi_rear", Context.MODE_PRIVATE).getBoolean("enabled", true)
    fun enable(value: Boolean): JSONObject {
        activity.getSharedPreferences("habi_rear", Context.MODE_PRIVATE).edit().putBoolean("enabled", value).apply()
        if (value) setScene(lastScene, 8000)
        else if (VendorRearService.status(activity).optString("phase") in setOf("submitted", "showing", "cleaning", "cleanup-pending")) {
            try { activity.startService(Intent(activity, VendorRearService::class.java).setAction(VendorRearService.STOP)) } catch (_: Exception) { }
        }
        return status()
    }
    fun close() { handler.removeCallbacksAndMessages(null); manager.unregisterDisplayListener(listener); presentation?.dismiss(); presentation = null }
    companion object { val SCENES = setOf("idle", "collecting", "resting", "watering", "listening", "received") }
}

private data class HabiFrame(val rows: IntArray, val durationMs: Long)
private data class HabiSequence(val loop: Boolean, val frames: List<HabiFrame>)
private class HabiPattern(val width: Int, val height: Int, val scenes: Map<String, HabiSequence>) {
    companion object {
        fun load(context: Context): HabiPattern {
            val json = context.assets.open("habi.json").bufferedReader().use { JSONObject(it.readText()) }
            val width = json.getInt("width"); val height = json.getInt("height")
            require(width == 17 && height == 23)
            val scenes = json.getJSONObject("scenes")
            val sequences = scenes.keys().asSequence().associateWith { name ->
                val sequence = scenes.getJSONObject(name)
                val frames = sequence.getJSONArray("frames")
                require(frames.length() > 0)
                HabiSequence(sequence.getBoolean("loop"), (0 until frames.length()).map { index ->
                    val frame = frames.getJSONObject(index)
                    val rows = frame.getJSONArray("rowBitmasks")
                    require(rows.length() == height)
                    val duration = frame.getLong("durationMs")
                    require(duration in 120L..10000L)
                    HabiFrame(IntArray(height) { y -> rows.getInt(y).also { require(it in 0 until (1 shl width)) } }, duration)
                })
            }
            require("idle" in sequences)
            return HabiPattern(width, height, sequences)
        }
    }
}

private class ScenePresentation(context: Context, display: Display, private val pattern: HabiPattern) : Presentation(context, display) {
    private lateinit var renderer: CompanionView
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); renderer = CompanionView(context, pattern); setContentView(renderer) }
    override fun onStart() { super.onStart(); renderer.resumeAnimation() }
    override fun onStop() { renderer.stopAnimation(); super.onStop() }
    fun scene(value: String) { renderer.showScene(value) }
}

/** Exact 17 x 23 white-on-black pixels, with no text or calorie data. */
private class CompanionView(context: Context, private val pattern: HabiPattern) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val timer = Handler(Looper.getMainLooper())
    private var scene = "idle"
    private var frameIndex = 0
    private val sequence get() = pattern.scenes[scene] ?: pattern.scenes.getValue("idle")
    private val advance = object : Runnable {
        override fun run() {
            if (!isAttachedToWindow || !ValueAnimator.areAnimatorsEnabled()) return
            if (frameIndex + 1 >= sequence.frames.size && !sequence.loop) return
            frameIndex = (frameIndex + 1) % sequence.frames.size
            invalidate(); schedule()
        }
    }
    fun showScene(value: String) {
        if (scene == value) return
        stopAnimation(); scene = value; frameIndex = 0; invalidate(); schedule()
    }
    private fun schedule() {
        timer.removeCallbacks(advance)
        if (isAttachedToWindow && ValueAnimator.areAnimatorsEnabled() && sequence.frames.size > 1)
            timer.postDelayed(advance, sequence.frames[frameIndex].durationMs)
    }
    fun stopAnimation() { timer.removeCallbacksAndMessages(null) }
    fun resumeAnimation() { schedule() }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); schedule() }
    override fun onDetachedFromWindow() { stopAnimation(); super.onDetachedFromWindow() }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas); canvas.drawColor(Color.BLACK)
        val cell = minOf(width / pattern.width.toFloat(), height / pattern.height.toFloat())
        val left = (width - cell * pattern.width) / 2f
        val top = (height - cell * pattern.height) / 2f
        val frame = sequence.frames[if (ValueAnimator.areAnimatorsEnabled()) frameIndex else 0]
        frame.rows.forEachIndexed { y, row ->
            for (x in 0 until pattern.width) if (row and (1 shl (pattern.width - 1 - x)) != 0)
                canvas.drawCircle(left + (x + .5f) * cell, top + (y + .5f) * cell, cell * .29f, paint)
        }
    }
}
