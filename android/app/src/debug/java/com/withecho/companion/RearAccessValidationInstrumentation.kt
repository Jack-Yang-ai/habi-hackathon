package com.withecho.companion

import android.app.Activity
import android.app.Instrumentation
import android.net.LocalServerSocket
import android.os.Bundle
import android.os.Process
import android.provider.Settings
import org.json.JSONObject

/** Explicit debug probe of the real app UID, never a shell/system Context. No pixels are submitted. */
class RearAccessValidationInstrumentation : Instrumentation() {
    private var confirmEmpty = false
    override fun onCreate(arguments: Bundle?) {
        confirmEmpty = arguments?.getString("confirm_empty") == "yes"
        super.onCreate(arguments); start()
    }
    override fun onStart() {
        val report = JSONObject().put("uid", Process.myUid()).put("package", targetContext.packageName)
            .put("permission_granted", targetContext.checkSelfPermission("com.stepos.permission.MANAGE_BACK_SCREEN") == 0)
            .put("frame_attempted", false).put("accepted", false).put("microphone_started", false).put("camera_started", false)
        val result = Bundle()
        try {
            check(Process.myUid() >= 10000) { "ordinary_app_uid_required" }
            check(confirmEmpty) { "explicit_empty_slot_confirmation_required" }
            LocalServerSocket("com.withecho.habi.frame.controller.v1").use {
                LocalServerSocket("com.withecho.habi.frame.guard.v1").use {
                    val stored = Settings.System.getString(targetContext.contentResolver, "stepos_back_screen_basic_frame")
                    check(stored.isNullOrEmpty()) { "persisted_custom_slot_not_empty" }
                    val manager = targetContext.getSystemService("display_ext") ?: error("vendor_manager_unavailable")
                    report.put("manager", manager.javaClass.name)
                    val setter = manager.javaClass.getMethod("setBackScreenFrame", IntArray::class.java, Bundle::class.java)
                    report.put("frame_attempted", true).put("method", "setBackScreenFrame(null,null)")
                    // Host must have confirmed both active and persisted slots empty. This is an idempotent clear.
                    setter.invoke(manager, *arrayOf<Any?>(null, null))
                    report.put("accepted", true)
                }
            }
        } catch (error: Throwable) {
            var cause = error
            while (cause is java.lang.reflect.InvocationTargetException && cause.cause != null) cause = cause.cause!!
            report.put("error", cause.javaClass.simpleName).put("detail", cause.message ?: "")
        }
        result.putString("report", report.toString())
        finish(Activity.RESULT_OK, result)
    }
}
