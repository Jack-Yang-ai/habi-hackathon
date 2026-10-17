package com.withecho.device;

import android.content.Context;
import android.os.Looper;
import org.json.JSONObject;
import org.json.JSONArray;

/** Fixed read-only probe: no frame setter, settings writer, microphone or command endpoint. */
public final class StepXReadOnlyProbe {
    public static void main(String[] arguments) throws Exception {
        if (arguments.length != 0) throw new IllegalArgumentException("no arguments accepted");
        JSONObject result = new JSONObject();
        result.put("uid", android.os.Process.myUid());
        try {
            if (Looper.myLooper() == null) Looper.prepareMainLooper();
            Class<?> threadType = Class.forName("android.app.ActivityThread");
            Object thread = threadType.getMethod("systemMain").invoke(null);
            Context context = (Context) threadType.getMethod("getSystemContext").invoke(thread);
            result.put("manage_back_screen_permission", context.checkSelfPermission("com.stepos.permission.MANAGE_BACK_SCREEN"));
            Object manager = context.getSystemService("display_ext");
            if (manager == null) throw new IllegalStateException("vendor_manager_unavailable");
            result.put("manager", manager.getClass().getName());
            JSONArray frameMethods = new JSONArray();
            for (java.lang.reflect.Method method : manager.getClass().getMethods()) {
                String name = method.getName();
                if (name.contains("BackScreen") && (name.contains("Frame") || name.contains("Bitmap"))) frameMethods.put(method.toGenericString());
            }
            result.put("frame_methods", frameMethods);
            Object info = manager.getClass().getMethod("getBackScreenDisplayInfo").invoke(manager);
            if (info == null) throw new IllegalStateException("vendor_display_info_unavailable");
            for (String field : new String[] {"LogicalWidth", "LogicalHeight", "State", "Brightness", "Rotation"}) {
                result.put(Character.toLowerCase(field.charAt(0)) + field.substring(1), info.getClass().getMethod("get" + field).invoke(info));
            }
            result.put("read_only_probe_ok", true);
        } catch (Exception failure) {
            Throwable cause = failure;
            while (cause instanceof java.lang.reflect.InvocationTargetException && cause.getCause() != null) cause = cause.getCause();
            result.put("read_only_probe_ok", false).put("error", cause.getClass().getSimpleName()).put("detail", String.valueOf(cause.getMessage()));
        }
        System.out.println(result.toString());
        System.exit(0);
    }
}
