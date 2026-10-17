package com.withecho.companion

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * 前台服务承载设备中继，避免 App 退到后台后热点里的板子断连。
 * 上游地址复用 App 已有的 backend_url 偏好，不新增第二套配置。
 */
class DeviceRelayService : Service() {
    companion object {
        private const val CHANNEL = "device_relay"
        private const val NOTIFICATION_ID = 101
        private const val START = "com.withecho.companion.DEVICE_RELAY_START"
        private const val STOP = "com.withecho.companion.DEVICE_RELAY_STOP"
        @Volatile private var server: DeviceRelayServer? = null

        fun start(context: Context) {
            val intent = Intent(context, DeviceRelayService::class.java).setAction(START)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, DeviceRelayService::class.java).setAction(STOP))
        }

        fun isRunning(): Boolean = server != null
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) {
            shutdown()
            return START_NOT_STICKY
        }
        if (server != null) return START_NOT_STICKY
        try {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "设备中继", NotificationManager.IMPORTANCE_LOW))
            // A hidden notification only affects visibility of the status card; it must not keep the
            // paired camera offline, so the relay keeps running when notifications are disabled.
            val stop = PendingIntent.getService(this, 11, Intent(this, DeviceRelayService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val open = PendingIntent.getActivity(this, 12, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val notification = Notification.Builder(this, CHANNEL)
                .setContentTitle("Habi 设备中继已开启")
                .setContentText("板子的照片经手机转发到服务器；点停止可关闭")
                .setSmallIcon(android.R.drawable.stat_sys_download_done).setOngoing(true).setContentIntent(open)
                .addAction(Notification.Action.Builder(null, "停止", stop).build()).build()
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            else startForeground(NOTIFICATION_ID, notification)
            // Screen-off put the device into doze, and the relay sockets stopped answering even
            // though the process was alive. A partial wake lock keeps the CPU and network usable
            // while a paired camera is on the hotspot; it is released on stop/destroy.
            val power = getSystemService(PowerManager::class.java)
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Habi:device-relay").apply {
                setReferenceCounted(false)
                acquire()
            }
            val upstream = getSharedPreferences("native_pipeline", MODE_PRIVATE)
                .getString("backend_url", "http://127.0.0.1:8787")!!.trimEnd('/')
            val relay = DeviceRelayServer(RelayState.port, upstream)
            relay.start()
            server = relay
        } catch (error: Exception) {
            RelayState.running = false
            RelayState.lastError = "relay_start_${error.javaClass.simpleName}"
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    private fun shutdown() {
        server?.stop()
        server = null
        RelayState.running = false
        wakeLock?.let { lock -> runCatching { if (lock.isHeld) lock.release() } }
        wakeLock = null
        runCatching { stopForeground(STOP_FOREGROUND_REMOVE) }
        stopSelf()
    }
}
