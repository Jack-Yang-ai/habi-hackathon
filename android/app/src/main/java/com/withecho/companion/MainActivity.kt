package com.withecho.companion

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.provider.MediaStore
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.ValueCallback
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.TimeUnit

private const val TAG = "HabiWeb"

class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var rear: RearDisplayController
    private lateinit var status: TextView
    private lateinit var connectionBar: LinearLayout
    @Volatile private var trustedOrigin = ""
    private var bridgeAttached = false
    private var appUrl = "http://127.0.0.1:8787"
    private var rootResult = "not_checked"
    private var active = false
    private var pendingRecordingStart = false
    private var pendingPhotoRequest = false
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var cameraOutputUri: Uri? = null
    private var pendingCameraChooser = false
    private var tone: ToneGenerator? = null
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == RecordingService.CHUNK) {
                try { event("recording_chunk", JSONObject(intent.getStringExtra("receipt") ?: "{}")) } catch (_: Exception) { }
            }
            event("recording", RecorderState.json()); refreshStatus()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        rear = RearDisplayController(this)
        appUrl = getPreferences(MODE_PRIVATE).getString("app_url", appUrl)!!
        // Matches the studio's warm dark theme so the system bars do not flash a light strip.
        val paper = Color.rgb(22, 18, 15)
        window.statusBarColor = paper
        window.navigationBarColor = paper
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(paper) }
        root.setOnApplyWindowInsetsListener { view, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                val keyboard = insets.getInsets(WindowInsets.Type.ime())
                view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, keyboard.bottom))
            } else {
                @Suppress("DEPRECATION")
                view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            }
            insets
        }
        val toolbar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(12, 6, 12, 6); setBackgroundColor(paper); visibility = View.GONE }
        connectionBar = toolbar
        status = TextView(this).apply { textSize = 12f; setTextColor(Color.rgb(198, 186, 172)) }
        toolbar.addView(status, LinearLayout.LayoutParams(0, 48, 1f))
        toolbar.addView(Button(this).apply { text = "拍照"; setOnClickListener { takePhonePhoto() } }, LinearLayout.LayoutParams(72.dp(), 48.dp()))
        toolbar.addView(Button(this).apply { text = "设备"; setOnClickListener { showDevicePanel() } }, LinearLayout.LayoutParams(85.dp(), 48.dp()))
        root.addView(toolbar)
        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.textZoom = (resources.configuration.fontScale * 100).toInt().coerceAtLeast(75)
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = true // selected system-picker URIs; no blanket storage permission
            settings.javaScriptCanOpenWindowsAutomatically = false
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                    fileCallback?.deliver(null)
                    fileCallback = null
                    pendingCameraChooser = false
                    // The page asks for a specific source: capture inputs open the camera directly,
                    // everything else opens the system picker. No extra dialog in between.
                    if (params.isCaptureEnabled) {
                        // A visible camera with a preview the user can aim, not a blind rear shot.
                        // The callback stays pending until the camera activity answers.
                        launchSystemCamera(callback)
                        return true
                    }
                    fileCallback = callback
                    val type = params.acceptTypes?.firstOrNull { it.startsWith("image/") } ?: "image/*"
                    @Suppress("DEPRECATION")
                    startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE); this.type = type
                    }, 21)
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (!request.isForMainFrame) return false
                    if (isTrusted(request.url)) {
                        val path = resourcePath(request.url)
                        if (path != null && isLocalResource(path)) return false
                        Log.w(TAG, "Blocked in-app navigation to ${request.url}")
                        return true
                    }
                    if (request.url.scheme in setOf("http", "https")) {
                        try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (e: Exception) { Log.w(TAG, "No app for ${request.url}", e) }
                    } else Log.w(TAG, "Blocked navigation to ${request.url}")
                    return true
                }
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    // The bridge is visible to all frames: only packaged documents may load here.
                    if (!isTrusted(request.url)) return resourceError(403, "Untrusted origin")
                    val path = resourcePath(request.url) ?: return resourceError(400, "Invalid resource path")
                    if (isLocalResource(path)) {
                        if (request.method != "GET") return resourceError(405, "Local resources require GET")
                        return localResource(path)
                    }
                    // Best effort only: WebView may not expose Sec-Fetch-* headers here. The packaged
                    // CSP is the primary guard against remote documents and scripts.
                    val document = request.isForMainFrame || request.requestHeaders.any { (name, value) ->
                        (name.equals("Accept", true) && value.contains("text/html", true)) ||
                            (name.equals("Sec-Fetch-Dest", true) && value in setOf("document", "iframe", "frame", "object", "embed", "script", "worker", "serviceworker"))
                    }
                    if (!document && (path.startsWith("/api/") || path.startsWith("/media/"))) return null
                    return resourceError(403, "Remote documents are disabled")
                }
                override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                    if (url == null || !isTrusted(Uri.parse(url))) detachBridge()
                }
                override fun onPageFinished(view: WebView, url: String?) {
                    if (url != null && isTrusted(Uri.parse(url))) {
                        event("ready", capabilities())
                        refreshStatus()
                        view.evaluateJavascript("!!document.querySelector('[data-habi-app]')") { loaded -> connectionBar.visibility = if (loaded == "true") View.GONE else View.VISIBLE }
                    }
                }
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                    if (request.isForMainFrame) { status.text = "服务未连接 · 点设备配置地址"; connectionBar.visibility = View.VISIBLE }
                }
            }
        }
        root.addView(web, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        // The paired camera should reach the backend as soon as the app runs, without hunting for a
        // hidden panel: start the device relay here. The service ignores duplicate starts.
        DeviceRelayService.start(this)
        root.post {
            if (Build.VERSION.SDK_INT >= 30) {
                root.windowInsetsController?.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
            } else {
                @Suppress("DEPRECATION")
                window.decorView.systemUiVisibility = 0
            }
        }
        val audioEvents = IntentFilter(RecordingService.STATUS).apply { addAction(RecordingService.CHUNK) }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, audioEvents, RECEIVER_NOT_EXPORTED)
        else { @Suppress("DEPRECATION") registerReceiver(receiver, audioEvents) }
        configure(appUrl)
    }

    override fun onResume() { super.onResume(); active = true; rear.refresh(); refreshStatus();
        if (pendingRecordingStart && capturePermissionsGranted()) launchRecording()
        if (pendingPhotoRequest && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) takePhonePhoto()
    }
    override fun onPause() { active = false; super.onPause() }
    private fun releaseTone() { try { tone?.release() } catch (_: Throwable) { }; tone = null }
    @Deprecated("Activity API remains compatible with this minimal dependency-free host")
    override fun onBackPressed() {
        web.evaluateJavascript("""(() => {
            if (document.querySelector('[role="dialog"]')) { document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true})); return true; }
            if (document.querySelector('[data-habi-conversation="open"]')) { const collapse = document.querySelector('[data-habi-collapse]'); if (collapse) { collapse.click(); return true; } }
            const home = document.querySelector('.bottom-nav .nav-button');
            if (home && !home.classList.contains('active')) { home.click(); return true; }
            return false;
        })()""") { handled -> if (handled != "true") { if (web.canGoBack()) web.goBack() else super.onBackPressed() } }
    }
    override fun onDestroy() { fileCallback?.deliver(null); fileCallback = null; unregisterReceiver(receiver); rear.close(); detachBridge(); web.destroy(); super.onDestroy() }

    @Deprecated("Activity API remains compatible with this minimal dependency-free host")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 21) {
            val pending = fileCallback
            fileCallback = null
            pending?.deliver(if (resultCode == RESULT_OK && data?.data != null) arrayOf(data.data!!) else null)
        }
        if (requestCode == 22) {
            val uri = cameraOutputUri
            val pending = fileCallback
            cameraOutputUri = null
            fileCallback = null
            val ok = resultCode == RESULT_OK && uri != null
            // A cancelled shot leaves an empty MediaStore row behind; remove it again.
            if (!ok && uri != null) try { contentResolver.delete(uri, null, null) } catch (_: Exception) { }
            pending?.deliver(if (ok) arrayOf(uri!!) else null)
        }
    }

    private fun ValueCallback<Array<Uri>>.deliver(value: Array<Uri>?) {
        // Delivered exactly once per showFileChooser call; a late or repeated delivery must not crash the host.
        try { onReceiveValue(value) } catch (_: IllegalStateException) { }
    }

    private fun Int.dp() = (this * resources.displayMetrics.density).toInt()
    private fun origin(uri: Uri): String {
        val port = if (uri.port == -1) (if (uri.scheme == "https") 443 else 80) else uri.port
        return "${uri.scheme}://${uri.host}:$port"
    }

    private fun isTrusted(uri: Uri) = uri.scheme in setOf("http", "https") &&
        uri.userInfo.isNullOrEmpty() && !uri.host.isNullOrBlank() && origin(uri) == trustedOrigin

    private fun resourcePath(uri: Uri): String? = try {
        // URI rejects malformed escapes; decode UTF-8 once, never allowing encoded separators
        // or another decoding pass to change the path used by AssetManager or the backend.
        val raw = URI(uri.toString()).rawPath.orEmpty().ifEmpty { "/" }.toByteArray(Charsets.UTF_8)
        val bytes = ByteArrayOutputStream()
        var index = 0
        while (index < raw.size) {
            if (raw[index].toInt() == 37) {
                val value = (Character.digit(raw[index + 1].toInt().toChar(), 16) shl 4) or
                    Character.digit(raw[index + 2].toInt().toChar(), 16)
                require(value != 47 && value != 92)
                bytes.write(value)
                index += 3
            } else {
                bytes.write(raw[index].toInt())
                index++
            }
        }
        val path = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
        require(path.startsWith("/") && !path.contains("//"))
        require(path.none { it == '\\' || it == '%' || it == '?' || it == '#' || it.code < 32 || it.code == 127 })
        require(path.split('/').none { it == "." || it == ".." })
        path
    } catch (_: Exception) { null }

    private fun isLocalResource(path: String) = path in setOf("/", "/index.html", "/favicon.svg", "/favicon.png") ||
        path.startsWith("/assets/") || path.startsWith("/fonts/") || path.startsWith("/habi/")

    private fun resourceError(code: Int, message: String) = WebResourceResponse(
        "text/plain", "UTF-8", code, message, mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff"),
        ByteArrayInputStream(message.toByteArray(Charsets.UTF_8))
    )

    private fun localResource(path: String): WebResourceResponse {
        val asset = if (path == "/") "index.html" else path.removePrefix("/")
        val mime = when (asset.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "application/javascript"
            "css" -> "text/css"
            "json", "map" -> "application/json"
            "svg" -> "image/svg+xml"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "webp" -> "image/webp"
            "gif" -> "image/gif"
            "ico" -> "image/x-icon"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "ttf" -> "font/ttf"
            "txt" -> "text/plain"
            else -> "application/octet-stream"
        }
        val headers = mutableMapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff")
        if (mime == "text/html") headers["Content-Security-Policy"] =
            "script-src $trustedOrigin/assets/; frame-src 'none'; object-src 'none'; base-uri 'none'; worker-src 'none'"
        return try {
            WebResourceResponse(mime, if (mime.startsWith("text/") || mime in setOf("application/javascript", "application/json", "image/svg+xml")) "UTF-8" else null,
                200, "OK", headers, assets.open("studio/$asset"))
        } catch (_: IOException) { resourceError(404, "APK resource not found") }
    }

    private fun configure(value: String) {
        val uri = Uri.parse(value)
        if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank() || !uri.userInfo.isNullOrEmpty()) {
            status.text = "地址格式不正确"; return
        }
        detachBridge()
        appUrl = value
        trustedOrigin = origin(uri)
        getPreferences(MODE_PRIVATE).edit().putString("app_url", value).apply()
        getSharedPreferences("native_pipeline", MODE_PRIVATE).edit().putString("backend_url", value).apply()
        web.addJavascriptInterface(DeviceBridge(), "EchoDevice")
        bridgeAttached = true
        web.loadUrl(uri.buildUpon().encodedPath("/").clearQuery().fragment(null).build().toString())
    }

    private fun detachBridge() { if (::web.isInitialized) web.removeJavascriptInterface("EchoDevice"); bridgeAttached = false }
    private fun refreshStatus() { if (::status.isInitialized) status.text = if (RecorderState.recording) {
        when (PipelineState.json().optString("phase")) {
            "loading_models" -> "● 录音中 · 模型加载中"
            "failed" -> "● 录音中 · 推理失败，点设备查看"
            "processing" -> "● 本地识别中 · 可随时停止"
            else -> "● 本地聆听中 · 可随时停止"
        }
    } else "Habi · 设备开发版" }
    private fun capabilities(): JSONObject = JSONObject().put("bridge_version", 1)
        .put("model", Build.MODEL).put("manufacturer", Build.MANUFACTURER).put("sdk", Build.VERSION.SDK_INT)
        .put("root", rootResult).put("rootAvailable", rootResult == "available")
        .put("rear_display", rear.status()).put("recording", RecorderState.json()).put("phone_camera", PhoneCameraState.json()).put("voice_trigger", RealtimeVoiceState.json())
        .put("trusted_origin", trustedOrigin).put("standalone_vendor_rear_supported", rear.status().optBoolean("vendor_control_available"))
        .put("device_relay", RelayState.json())

    private fun event(type: String, payload: JSONObject) {
        if (!::web.isInitialized || !bridgeAttached) return
        val envelope = JSONObject().put("type", type).put("payload", payload)
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('echo-device-event',{detail:$envelope}));", null)
    }

    private fun showDevicePanel() {
        lateinit var panel: AlertDialog
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24.dp(), 10.dp(), 24.dp(), 10.dp()) }
        val address = EditText(this).apply { setText(appUrl); isSingleLine = true; hint = "App 服务地址" }
        val pipeline = PipelineState.json()
        form.addView(TextView(this).apply { text = "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}\n背屏：${rear.status().getString("backend")}\nroot：$rootResult\n本地感知：${pipeline.optString("phase", "idle")}\n已处理 ${pipeline.optInt("processed_chunks")} 段 · 已提交 ${pipeline.optInt("submitted_signals")} 条线索\n最近转写：${pipeline.optString("last_transcript", "暂无")}\n${pipeline.optString("last_error", "")}" })
        form.addView(address)
        form.addView(Button(this).apply { text = "保存地址并连接"; setOnClickListener { configure(address.text.toString().trim()) } })
        val relayStatus = TextView(this).apply { textSize = 12f }
        var relayButton: Button? = null
        fun renderRelay() {
            val relay = RelayState.json()
            relayStatus.text = buildString {
                append(if (relay.optBoolean("running")) "设备中继：运行中 · 端口 ${relay.optInt("port")}\n" else "设备中继：已停止\n")
                append("转发到：${relay.optString("upstream", appUrl)}\n")
                val addresses = relay.optString("listen_addresses", "")
                append("手机地址：${addresses.ifBlank { "未取到，热点网关通常是 192.168.43.1" }}\n")
                append("板子实际连到：${if (relay.isNull("board_address")) "尚未收到请求" else relay.optString("board_address")}\n")
                append("转发 ${relay.optInt("forwarded")} · 拒绝 ${relay.optInt("rejected")} · 失败 ${relay.optInt("failed")}")
                val error = relay.optString("last_error", "")
                if (error.isNotBlank()) append("\n最近错误：$error")
            }
            relayButton?.text = if (relay.optBoolean("running")) "停止设备中继" else "开启设备中继"
        }
        form.addView(TextView(this).apply { text = "随身相机（ESP32）中继"; setPadding(0, 16.dp(), 0, 4.dp()) })
        form.addView(TextView(this).apply {
            textSize = 12f
            text = "手机开热点后让板子连这个热点。这里只把板子的配置/状态/照片原样转发到上面填的服务地址；服务器仍校验设备 token，手机不保存图片和 Step 密钥。"
        })
        form.addView(relayStatus)
        relayButton = Button(this).apply {
            setOnClickListener {
                if (RelayState.running) DeviceRelayService.stop(this@MainActivity) else DeviceRelayService.start(this@MainActivity)
                relayStatus.postDelayed({ renderRelay() }, 500)
            }
        }
        form.addView(relayButton)
        renderRelay()
        val camera = PhoneCameraState.json()
        form.addView(TextView(this).apply { text = "手机相机：${camera.optString("phase", "idle")}\n语音拍照：${if (camera.optBoolean("voice_armed")) "已开启" else "未开启"}\n${camera.optString("detail", "")}\n${camera.optString("error", "")}" })
        form.addView(Button(this).apply { text = "手机拍一张并识别"; setOnClickListener { panel.dismiss(); takePhonePhoto() } })
        if (camera.optBoolean("saved_locally") && camera.optString("phase") in setOf("failed", "review_pending", "stopped"))
            form.addView(Button(this).apply { text = "补传或查询这张照片（不重拍）"; setOnClickListener { PhoneCameraController.retryLatest(this@MainActivity); panel.dismiss() } })
        form.addView(Button(this).apply { text = if (RecorderState.recording) "停止录音与语音拍照" else "开启聆听与语音拍照"; setOnClickListener { panel.dismiss(); if (RecorderState.recording) stopRecording() else confirmRecording() } })
        form.addView(Button(this).apply { text = "检查已有 root（只读）"; setOnClickListener { inspectRoot() } })
        form.addView(TextView(this).apply { text = "背屏原生接口适配中。当前点阵背屏由电脑 ADB 中继控制，拔线后的独立显示尚未验证。"; textSize = 12f })
        val scroll = ScrollView(this).apply { addView(form) }
        panel = AlertDialog.Builder(this).setTitle("设备连接").setView(scroll).setPositiveButton("完成", null).show()
    }

    private fun confirmRecording() {
        if (!active || RecorderState.recording) return
        AlertDialog.Builder(this).setTitle("开启聆听与语音拍照？")
            .setMessage("开启后可以把 App 退到后台。说“哈比记录”，手机后置相机拍一张并发送到 Step 识别。“哈比”是唤醒词，只叫名字不会拍照；六秒内说“记录”才执行。\n\n录音和 SenseVoice 转写留在本机，文字线索发送到你配置的服务。其他用餐线索仍由 Decider 辅助判断，再触发 ESP32 首图。音频不上传。\n\n实时小模型检测唤醒词，不等待 10 秒切片。短句复核通过后拍照；其他用餐上下文仍按 10 秒分析。通知栏可随时停止麦克风和相机。")
            .setNegativeButton("取消", null).setPositiveButton("开始") { _, _ ->
                pendingRecordingStart = true
                val permissions = mutableListOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
                if (Build.VERSION.SDK_INT >= 33) permissions.add(Manifest.permission.POST_NOTIFICATIONS)
                val missing = permissions.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 11) else launchRecording()
            }.show()
    }

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == 11 && capturePermissionsGranted()) {
            if (active && pendingRecordingStart) launchRecording()
        } else if (code == 11) { pendingRecordingStart = false; event("recording", JSONObject().put("error", "microphone_or_camera_permission_denied")) }
        if (code == 12 && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            if (active && pendingPhotoRequest) takePhonePhoto()
        } else if (code == 12) pendingPhotoRequest = false
        if (code == 13 && pendingCameraChooser) {
            pendingCameraChooser = false
            val pending = fileCallback ?: return
            fileCallback = null
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchSystemCamera(pending)
            else {
                pending.deliver(null)
                android.widget.Toast.makeText(this, "需要相机权限才能拍照", android.widget.Toast.LENGTH_SHORT).show()
            }
        }
    }
    private fun capturePermissionsGranted() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    /** Opens the system camera app with a writable MediaStore target and hands the result back to the page. */
    private fun launchSystemCamera(callback: ValueCallback<Array<Uri>>) {
        // The manifest declares CAMERA, so Android refuses IMAGE_CAPTURE until it is granted at runtime.
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            fileCallback = callback
            pendingCameraChooser = true
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 13)
            return
        }
        val name = "habi-" + java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date()) + ".jpg"
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Habi")
        }
        val uri = try { contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) } catch (_: Exception) { null }
        if (uri == null) {
            callback.deliver(null)
            android.widget.Toast.makeText(this, "没有可用的相册写入位置", android.widget.Toast.LENGTH_SHORT).show()
            return
        }
        fileCallback = callback
        cameraOutputUri = uri
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, uri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, 22)
        } catch (e: Exception) { // ActivityNotFoundException, or SecurityException if CAMERA is revoked meanwhile
            Log.w(TAG, "system camera launch failed", e)
            cameraOutputUri = null
            fileCallback = null
            try { contentResolver.delete(uri, null, null) } catch (_: Exception) { }
            callback.deliver(null)
            val message = if (e is SecurityException) "需要相机权限才能拍照" else "这台设备没有可用的相机应用"
            android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    private fun takePhonePhoto() {
        if (!active) return
        pendingPhotoRequest = true
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 12); return
        }
        pendingPhotoRequest = false
        val accepted = PhoneCameraController.request(this) { active || RecorderState.voiceCameraArmed }
        if (!accepted) android.widget.Toast.makeText(this, "上一张照片还在处理，请稍候", android.widget.Toast.LENGTH_SHORT).show()
        else commandAcceptedFeedback()
        refreshStatus()
    }

    /**
     * The shutter itself takes about a second, so the command being accepted is said out loud at
     * once: a short tone and a tick, not a promise that a photo already exists.
     */
    private fun commandAcceptedFeedback() {
        try { vibrator()?.vibrate(VibrationEffect.createOneShot(45, VibrationEffect.DEFAULT_AMPLITUDE)) } catch (_: Throwable) { }
        try {
            tone?.release()
            tone = ToneGenerator(AudioManager.STREAM_MUSIC, 70).also { it.startTone(ToneGenerator.TONE_PROP_BEEP, 120) }
        } catch (_: Throwable) { tone = null }
    }

    private fun vibrator(): Vibrator? =
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S)
            getSystemService(android.os.VibratorManager::class.java)?.defaultVibrator
        else @Suppress("DEPRECATION") (getSystemService(VIBRATOR_SERVICE) as? Vibrator)
    private fun launchRecording() {
        if (!active) return
        pendingRecordingStart = false
        if (!getSystemService(NotificationManager::class.java).areNotificationsEnabled()) {
            AlertDialog.Builder(this).setMessage("需要允许录音状态通知，才能在通知栏随时停止录音。录音尚未开始。")
                .setPositiveButton("知道了", null).show()
            return
        }
        try { startForegroundService(Intent(this, RecordingService::class.java)) }
        catch (e: Exception) { event("recording", JSONObject().put("error", e.javaClass.simpleName)) }
    }
    private fun stopRecording() { startService(Intent(this, RecordingService::class.java).setAction(RecordingService.STOP)) }

    private fun inspectRoot() {
        Thread {
            rootResult = try {
                val process = ProcessBuilder("su", "-c", "id").redirectErrorStream(true).start()
                if (!process.waitFor(5, TimeUnit.SECONDS)) { process.destroyForcibly(); "unavailable" }
                else if (process.exitValue() == 0 && process.inputStream.bufferedReader().readText().contains("uid=0")) "available" else "unavailable"
            } catch (_: Exception) { "unavailable" }
            runOnUiThread { event("capabilities", capabilities()); AlertDialog.Builder(this).setMessage("已有 root：$rootResult").setPositiveButton("完成", null).show() }
        }.start()
    }

    inner class DeviceBridge {
        @JavascriptInterface fun getCapabilities(): String = capabilities().toString()
        @JavascriptInterface fun getStatus(): String = JSONObject().put("recording", RecorderState.json()).put("rear_display", rear.status()).put("phone_camera", PhoneCameraState.json()).put("voice_trigger", RealtimeVoiceState.json()).toString()
        @JavascriptInterface fun setRearScene(json: String): String {
            val command = try { JSONObject(json) } catch (_: Exception) { return "{\"ok\":false,\"error\":\"invalid_json\"}" }
            val scene = command.optString("scene", "idle")
            if (scene !in RearDisplayController.SCENES) return "{\"ok\":false,\"error\":\"unknown_scene\"}"
            runOnUiThread { event("rear_scene", rear.setScene(scene, command.optLong("ttl_ms", 15000))) }
            return "{\"ok\":true,\"accepted\":true,\"rendering_confirmed\":false}"
        }
        @JavascriptInterface fun setRearEnabled(value: Boolean): String { runOnUiThread { event("rear_scene", rear.enable(value)) }; return "{\"accepted\":true}" }
        @JavascriptInterface fun startRecording(): String { runOnUiThread { confirmRecording() }; return "{\"accepted\":true,\"requires_user_confirmation\":true}" }
        @JavascriptInterface fun stopRecording(): String { runOnUiThread { this@MainActivity.stopRecording() }; return "{\"accepted\":true}" }
        @JavascriptInterface fun takePhoto(): String { runOnUiThread { takePhonePhoto() }; return "{\"accepted\":true,\"capture_confirmed\":false}" }
        /** Read on demand: a preview must not ride along with every capability poll. */
        @JavascriptInterface fun getLocalPhoto(): String =
            PhoneCameraState.localPhoto()?.let { JSONObject().put("photo", it).toString() } ?: "{\"photo\":null}"
        @JavascriptInterface fun openDeviceSettings(): String { runOnUiThread { showDevicePanel() }; return "{\"accepted\":true}" }
        /** Same guard as the device panel's retry: only a saved photo that did not finish, never a reshoot. */
        @JavascriptInterface fun retryLocalPhoto(): String {
            val camera = PhoneCameraState.json()
            val retryable = camera.optBoolean("saved_locally") && camera.optString("phase") in setOf("failed", "review_pending", "stopped")
            return JSONObject().put("accepted", retryable && PhoneCameraController.retryLatest(this@MainActivity)).toString()
        }
        @JavascriptInterface fun dismissLocalPhoto(): String { PhoneCameraState.clearLocalPhoto(); return "{\"accepted\":true}" }
    }
}
