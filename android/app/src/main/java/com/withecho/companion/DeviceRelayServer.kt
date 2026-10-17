package com.withecho.companion

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.URL
import java.time.Instant
import java.util.concurrent.atomic.AtomicInteger

/**
 * 板子 → 手机 → 服务器 的设备专用中继。
 *
 * ESP32 只有 2.4GHz 射频、只会明文 HTTP，而且拿不到公网地址；服务器（Mac mini）在别处。
 * 手机开热点后，板子把三条设备路由打到这台手机，手机再把它们原样转发给服务器。
 *
 * 这里刻意做成透明转发：不解析 multipart、不重新编码 JPEG、不保存也不校验设备 token。
 * `X-Device-Token` 与图片字节逐字节透传，真正的鉴权仍然发生在服务器上；本类只负责
 * 路径白名单、大小上限和超时，避免把手机变成任意流量的开放代理。
 */
object RelayState {
    @Volatile var running = false
    @Volatile var port = 8788
    @Volatile var upstream = ""
    @Volatile var listenAddresses: List<String> = emptyList()
    @Volatile var observedBoardAddress: String? = null
    @Volatile var forwarded = 0
    @Volatile var rejected = 0
    @Volatile var failed = 0
    @Volatile var lastPath: String? = null
    @Volatile var lastRequestAt: String? = null
    @Volatile var lastError: String? = null

    fun json(): JSONObject = JSONObject()
        .put("running", running).put("port", port).put("upstream", upstream)
        .put("listen_addresses", listenAddresses.joinToString(" "))
        .put("board_address", observedBoardAddress ?: JSONObject.NULL)
        .put("forwarded", forwarded).put("rejected", rejected).put("failed", failed)
        .put("last_path", lastPath ?: JSONObject.NULL)
        .put("last_request_at", lastRequestAt ?: JSONObject.NULL)
        .put("last_error", lastError ?: JSONObject.NULL)
}

fun localSiteLocalIpv4(): List<String> = runCatching {
    NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .flatMap { it.inetAddresses.toList() }
        .filterIsInstance<Inet4Address>()
        .filter { !it.isLoopbackAddress && it.isSiteLocalAddress }
        .mapNotNull { it.hostAddress }
        .distinct()
}.getOrDefault(emptyList())

class DeviceRelayServer(private val port: Int, private val upstreamBase: String) {
    companion object {
        private const val MAX_HEAD = 16 * 1024
        private const val MAX_BODY = 8 * 1024 * 1024
        private const val MIN_TOKEN = 32
        private const val MAX_TOKEN = 200
        // 固件 HTTPClient 总超时 4 秒；中继必须比它更快地回答不可达，而不是把板子挂死。
        private const val UPSTREAM_CONNECT_MS = 2500
        private const val UPSTREAM_READ_MS = 8000
        private val DEVICE_PATHS = setOf("/api/device/config", "/api/device/status", "/api/device/captures")
    }

    private var server: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val connections = AtomicInteger(0)

    fun start() {
        val socket = ServerSocket()
        socket.reuseAddress = true
        // 绑定所有网卡：热点接口地址由系统分配，不能假设固定值。
        socket.bind(InetSocketAddress(port))
        server = socket
        RelayState.port = port
        RelayState.upstream = upstreamBase
        RelayState.listenAddresses = localSiteLocalIpv4()
        RelayState.running = true
        RelayState.lastError = null
        acceptThread = Thread({ acceptLoop(socket) }, "device-relay-accept").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        RelayState.running = false
        runCatching { server?.close() }
        server = null
        acceptThread?.interrupt()
        acceptThread = null
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (RelayState.running && !socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (error: Exception) {
                // A transient accept failure (fd pressure, a reset while queued) must not kill the
                // relay: the socket stays open, so breaking here would leave the port listening but
                // unanswered forever. Only stop when the server is genuinely shutting down.
                if (!RelayState.running || socket.isClosed) break
                RelayState.lastError = "accept_${error.javaClass.simpleName}"
                runCatching { Thread.sleep(100) }
                continue
            }
            if (connections.get() >= 4) {
                runCatching { client.close() }
                RelayState.rejected += 1
                continue
            }
            connections.incrementAndGet()
            Thread({
                try {
                    handle(client)
                } catch (error: Exception) {
                    RelayState.failed += 1
                    RelayState.lastError = "relay_${error.javaClass.simpleName}"
                } finally {
                    runCatching { client.close() }
                    connections.decrementAndGet()
                }
            }, "device-relay-conn").apply { isDaemon = true; start() }
        }
    }

    private class Request(val method: String, val target: String, val headers: Map<String, String>) {
        fun header(name: String): String? = headers[name.lowercase()]
        val path: String get() = target.substringBefore('?')
    }

    private fun handle(client: Socket) {
        client.soTimeout = 15000
        val input = BufferedInputStream(client.getInputStream())
        val output = client.getOutputStream()
        val request = try {
            readRequest(input)
        } catch (error: Exception) {
            respond(output, 400, "{\"error\":\"bad_request\"}")
            return
        }
        val path = request.path
        val methodAllowed = when (path) {
            "/api/device/config" -> request.method == "GET"
            "/api/device/status", "/api/device/captures" -> request.method == "POST"
            else -> false
        }
        if (path !in DEVICE_PATHS || !methodAllowed) {
            RelayState.rejected += 1
            respond(output, 404, "{\"error\":\"device_routes_only\"}")
            return
        }
        // 只放行带强设备 token 的请求。值不在这里校验（服务端才有真 token），
        // 但没有 token 的一律不转发，避免热点上的任何设备借手机访问服务端设备路由。
        val token = request.header("x-device-token")
        if (token == null || token.length !in MIN_TOKEN..MAX_TOKEN) {
            RelayState.rejected += 1
            respond(output, 401, "{\"error\":\"device_authentication_required\"}")
            return
        }
        if (request.header("transfer-encoding") != null) {
            RelayState.rejected += 1
            respond(output, 411, "{\"error\":\"content_length_required\"}")
            return
        }
        val length = request.header("content-length")?.toIntOrNull() ?: 0
        if (length < 0 || length > MAX_BODY) {
            RelayState.rejected += 1
            respond(output, 413, "{\"error\":\"body_too_large\"}")
            return
        }
        if (request.method == "POST" && length == 0) {
            RelayState.rejected += 1
            respond(output, 411, "{\"error\":\"content_length_required\"}")
            return
        }

        RelayState.lastPath = path
        RelayState.lastRequestAt = Instant.now().toString()
        // 板子实际连到的是哪个本机地址，只有 accept 之后才知道；热点网关地址因此可确认。
        runCatching { client.localAddress.hostAddress }.getOrNull()?.let { RelayState.observedBoardAddress = it }

        val connection = try {
            (URL(upstreamBase + request.target).openConnection() as HttpURLConnection).apply {
                requestMethod = request.method
                connectTimeout = UPSTREAM_CONNECT_MS
                readTimeout = UPSTREAM_READ_MS
                useCaches = false
                instanceFollowRedirects = false
                setRequestProperty("X-Device-Token", token)
                request.header("content-type")?.let { setRequestProperty("Content-Type", it) }
                if (request.method == "POST") {
                    doOutput = true
                    setFixedLengthStreamingMode(length)
                }
            }
        } catch (error: Exception) {
            RelayState.failed += 1
            RelayState.lastError = "upstream_url_invalid"
            respond(output, 502, "{\"error\":\"upstream_unreachable\"}")
            return
        }

        try {
            if (request.method == "POST") {
                connection.outputStream.use { sink -> copyExactly(input, sink, length) }
            }
            val code = connection.responseCode
            val stream = if (code >= 400) connection.errorStream else connection.inputStream
            val body = stream?.use { it.readBytes() } ?: ByteArray(0)
            respond(output, code, body, connection.contentType)
            RelayState.forwarded += 1
        } catch (error: Exception) {
            RelayState.failed += 1
            // 固定类别名，不写入上游地址、token 或响应正文。
            RelayState.lastError = "upstream_${error.javaClass.simpleName}"
            respond(output, 502, "{\"error\":\"upstream_unreachable\"}")
        } finally {
            runCatching { connection.disconnect() }
        }
    }

    private fun readRequest(input: InputStream): Request {
        val head = StringBuilder()
        val buffer = ByteArray(1)
        while (true) {
            if (input.read(buffer) < 0) throw IllegalStateException("eof")
            head.append(buffer[0].toInt().toChar())
            if (head.length > MAX_HEAD) throw IllegalStateException("head_too_large")
            if (head.endsWith("\r\n\r\n")) break
        }
        val lines = head.toString().split("\r\n").filter { it.isNotEmpty() }
        val parts = lines.firstOrNull()?.split(' ') ?: throw IllegalStateException("no_request_line")
        if (parts.size < 2) throw IllegalStateException("no_request_line")
        val method = parts[0]
        val target = parts[1]
        if (target.length > 1024 || !target.startsWith("/")) throw IllegalStateException("bad_target")
        val headers = HashMap<String, String>()
        for (line in lines.drop(1)) {
            val index = line.indexOf(':')
            if (index <= 0) continue
            headers[line.substring(0, index).trim().lowercase()] = line.substring(index + 1).trim()
        }
        return Request(method, target, headers)
    }

    private fun copyExactly(input: InputStream, output: OutputStream, length: Int) {
        val buffer = ByteArray(8192)
        var remaining = length
        while (remaining > 0) {
            val read = input.read(buffer, 0, minOf(buffer.size, remaining))
            if (read < 0) throw IllegalStateException("short_body")
            output.write(buffer, 0, read)
            remaining -= read
        }
        output.flush()
    }

    private fun respond(output: OutputStream, code: Int, body: String) = respond(output, code, body.toByteArray(), "application/json")

    private fun respond(output: OutputStream, code: Int, body: ByteArray, contentType: String?) {
        val reason = when (code) {
            200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 404 -> "Not Found"
            411 -> "Length Required"; 413 -> "Payload Too Large"; 502 -> "Bad Gateway"
            else -> "Status"
        }
        val head = buildString {
            append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n")
            append("Content-Type: ").append(contentType ?: "application/json").append("\r\n")
            append("Content-Length: ").append(body.size).append("\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n\r\n")
        }
        output.write(head.toByteArray())
        output.write(body)
        output.flush()
    }
}
