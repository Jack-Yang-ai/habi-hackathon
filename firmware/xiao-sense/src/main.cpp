#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <SD.h>
#include <SPI.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_camera.h>
#include <esp_timer.h>
#include <sys/time.h>
#include <ESP32_OV5640_AF.h>
#include "CaptureWindowPolicy.h"
#include "CaptureAck.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

namespace {
constexpr uint32_t CONFIG_PERIOD_MS = 15000;
constexpr uint32_t STATUS_PERIOD_MS = 15000;
constexpr uint32_t WIFI_RETRY_MS = 20000;
constexpr uint32_t MAX_PENDING = 1000;
constexpr uint32_t UPLOAD_ATTEMPTS = 3;
constexpr char QUEUE_DIR[] = "/echo-queue";
constexpr char VERSION[] = "0.3.2";

String deviceId, bootId, lastError, timeSource = "unsynchronized";
String captureMode = "signals";
CaptureWindowPolicy captureWindow;
Preferences budgetStore;
bool budgetStoreReady = false;
String persistedWindowId, persistedWindowPhase, persistedSessionId;
uint32_t persistedWindowRemaining = 0;
bool cameraReady = false, sdReady = false, paused = true, uploadEnabled = true;
bool configured = false, focusReady = false;
uint16_t sensorPid = 0;
uint32_t intervalSeconds = 60, sequenceNumber = 0, pendingCount = 0;
uint32_t lastConfig = 0, lastStatus = 0, lastWifi = 0, lastCapture = 0;
uint32_t nextUpload = 0, uploadFailures = 0, successfulUploads = 0;
uint32_t droppedCaptures = 0;
OV5640 autofocus;

uint64_t uptimeMs() { return static_cast<uint64_t>(esp_timer_get_time()) / 1000; }
bool elapsed(uint32_t now, uint32_t before, uint32_t period) { return now - before >= period; }
bool due(uint32_t now, uint32_t target) { return static_cast<int32_t>(now - target) >= 0; }

bool clockReady() { return time(nullptr) >= 1700000000; }
String utcNow() {
  if (!clockReady()) return "";
  time_t now = time(nullptr);
  tm utc{};
  gmtime_r(&now, &utc);
  char value[25];
  strftime(value, sizeof(value), "%Y-%m-%dT%H:%M:%SZ", &utc);
  return String(value);
}

camera_fb_t *freshFrame(uint64_t requestedAtUs) {
  // WHEN_EMPTY may hold an old idle frame. Retire it rather than treating an
  // earlier image as a response to this context signal; no extra image is saved.
  for (uint8_t attempt = 0; attempt < 3; ++attempt) {
    camera_fb_t *frame = esp_camera_fb_get();
    if (!frame) return nullptr;
    const uint64_t frameUs = static_cast<uint64_t>(frame->timestamp.tv_sec) * 1000000 + frame->timestamp.tv_usec;
    const bool validJpeg = frame->format == PIXFORMAT_JPEG && frame->len >= 4
      && frame->buf[0] == 0xff && frame->buf[1] == 0xd8 && frame->buf[2] == 0xff;
    const bool unexpired = captureMode != "signals" || uptimeMs() < captureWindow.expiresAtMs;
    if (frameUs >= requestedAtUs && frameUs <= static_cast<uint64_t>(esp_timer_get_time()) && validJpeg && unexpired) return frame;
    esp_camera_fb_return(frame);
    if (!unexpired) break;
  }
  return nullptr;
}

int64_t parseUtcMs(const String &value) {
  if (!value.endsWith("Z")) return 0;
  tm utc{};
  const char *end = strptime(value.c_str(), "%Y-%m-%dT%H:%M:%S", &utc);
  if (!end) return 0;
  int millisPart = 0;
  if (*end == '.') {
    ++end;
    for (int multiplier = 100; multiplier && isdigit(*end); multiplier /= 10, ++end) millisPart += (*end - '0') * multiplier;
  }
  return static_cast<int64_t>(mktime(&utc)) * 1000 + millisPart;
}

String apiPath(const char *path) {
  String base(ECHO_API_BASE);
  while (base.endsWith("/")) base.remove(base.length() - 1);
  return base + path;
}

bool openHttp(HTTPClient &http, WiFiClient &client, const String &url) {
  // A certificate-validated TLS transport is a separate production integration.
  // Refuse https rather than silently using an insecure TLS client.
  if (!url.startsWith("http://")) { lastError = "development_transport_requires_lan_http"; return false; }
  http.setConnectTimeout(2500);
  http.setTimeout(4000);
  if (!http.begin(client, url)) return false;
  if (strlen(ECHO_DEVICE_TOKEN)) http.addHeader("X-Device-Token", ECHO_DEVICE_TOKEN);
  return true;
}

void initializeCamera() {
  camera_config_t c{};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer = LEDC_TIMER_0;
  c.pin_d0 = 15; c.pin_d1 = 17; c.pin_d2 = 18; c.pin_d3 = 16;
  c.pin_d4 = 14; c.pin_d5 = 12; c.pin_d6 = 11; c.pin_d7 = 48;
  c.pin_xclk = 10; c.pin_pclk = 13; c.pin_vsync = 38; c.pin_href = 47;
  c.pin_sccb_sda = 40; c.pin_sccb_scl = 39;
  c.pin_pwdn = -1; c.pin_reset = -1;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  // Reserve enough JPEG buffer before OV5640 AF briefly evaluates at SXGA.
  c.frame_size = psramFound() ? FRAMESIZE_UXGA : FRAMESIZE_SVGA;
  c.jpeg_quality = 12;
  c.fb_count = 1;
  c.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  c.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  esp_err_t result = esp_camera_init(&c);
  if (result != ESP_OK) {
    lastError = "camera_init_" + String(result, HEX);
    return;
  }
  sensor_t *sensor = esp_camera_sensor_get();
  if (!sensor) { lastError = "sensor_unavailable"; return; }
  sensorPid = sensor->id.PID;
  // The driver selects OV2640/OV3660/OV5640 from the actual sensor ID.
  // Only OV5640 has an AF lens; do not run its firmware on other sensors.
  if (sensorPid == OV5640_PID && psramFound()) {
    sensor->set_framesize(sensor, FRAMESIZE_SXGA);
    if (autofocus.start(sensor) && autofocus.focusInit() == 0 && autofocus.autoFocusMode() == 0) {
      const uint32_t start = millis();
      while (millis() - start < 8000) {
        if (autofocus.getFWStatus() == 0x10) { focusReady = true; break; }
        delay(100);
      }
    }
    if (!focusReady) lastError = "ov5640_autofocus_not_confirmed";
  } else if (sensorPid == OV5640_PID) lastError = "ov5640_af_psram_unavailable";
  if (sensor->set_framesize(sensor, FRAMESIZE_SVGA) != 0) { lastError = "camera_output_size_failed"; return; }
  cameraReady = true;
  Serial.printf("camera_ready sensor_pid=0x%04x psram=%d af=%d\n", sensorPid, psramFound(), focusReady);
}

String fullPath(const String &name) { return name.startsWith("/") ? name : String(QUEUE_DIR) + "/" + name; }

void recoverQueue() {
  pendingCount = 0;
  File directory = SD.open(QUEUE_DIR);
  if (!directory) return;
  for (File file = directory.openNextFile(); file; file = directory.openNextFile()) {
    String path = fullPath(file.name());
    bool isDirectory = file.isDirectory();
    file.close();
    if (isDirectory) continue;
    if (path.endsWith(".tmp")) SD.remove(path);
    else if (path.endsWith(".json")) {
      String jpeg = path.substring(0, path.length() - 5) + ".jpg";
      if (SD.exists(jpeg)) ++pendingCount;
      else SD.remove(path);
    }
    else if (path.endsWith(".jpg")) {
      String metadata = path.substring(0, path.length() - 4) + ".json";
      if (!SD.exists(metadata)) SD.remove(path); // interrupted commit, never a valid queued capture
    }
  }
  directory.close();
}

void initializeSd() {
  SPI.begin(7, 8, 9, 21);
  if (!SD.begin(21, SPI, 10000000) || SD.cardType() == CARD_NONE) {
    lastError = "sd_unavailable_capture_disabled";
    return;
  }
  if (!SD.exists(QUEUE_DIR) && !SD.mkdir(QUEUE_DIR)) { lastError = "sd_queue_create_failed"; return; }
  sdReady = true;
  recoverQueue();
}

String nextQueuedMetadata() {
  if (!sdReady) return "";
  File directory = SD.open(QUEUE_DIR);
  String found;
  for (File file = directory.openNextFile(); file; file = directory.openNextFile()) {
    String path = fullPath(file.name());
    bool match = !file.isDirectory() && path.endsWith(".json");
    file.close();
    if (match) { found = path; break; }
  }
  directory.close();
  return found;
}

bool writeExact(const String &path, const uint8_t *data, size_t size) {
  File file = SD.open(path, FILE_WRITE);
  if (!file) return false;
  size_t written = file.write(data, size);
  file.flush(); file.close();
  return written == size;
}

void capture() {
  if (!cameraReady || !sdReady || paused || !configured) return;
  if (captureMode == "signals" && !captureWindow.allowed(uptimeMs())) return;
  if (pendingCount >= MAX_PENDING) { lastError = "queue_full_capture_suspended"; return; }
  // Two MiB reserve avoids consuming the last allocation units during a commit.
  if (SD.totalBytes() - SD.usedBytes() < 2 * 1024 * 1024) { lastError = "sd_full_capture_suspended"; return; }
  if (captureMode == "signals") {
    if (!budgetStoreReady) { lastError = "window_budget_storage_unavailable"; return; }
    captureWindow.consume();
    persistedWindowRemaining = captureWindow.remaining;
    // Reserve an exposure before asking the sensor; reboots cannot refill its budget.
    if (!budgetStore.putUInt("remaining", persistedWindowRemaining)) { budgetStoreReady = false; lastError = "window_budget_commit_failed"; return; }
  }
  const uint64_t requestedAtUs = static_cast<uint64_t>(esp_timer_get_time());
  camera_fb_t *frame = freshFrame(requestedAtUs);
  if (!frame) { lastError = "fresh_frame_unavailable_or_expired"; ++droppedCaptures; return; }
  const uint64_t frameAtUs = static_cast<uint64_t>(frame->timestamp.tv_sec) * 1000000 + frame->timestamp.tv_usec;
  char suffix[16]; snprintf(suffix, sizeof(suffix), "%010u", ++sequenceNumber);
  String captureId = deviceId + "-" + bootId + "-" + suffix;
  String stem = String(QUEUE_DIR) + "/" + captureId;
  DynamicJsonDocument doc(1536);
  doc["schema_version"] = 1;
  doc["capture_id"] = captureId;
  doc["device_id"] = deviceId;
  doc["boot_id"] = bootId;
  doc["sequence"] = sequenceNumber;
  if (clockReady()) doc["captured_at"] = utcNow(); else doc["captured_at"] = nullptr;
  doc["time_source"] = clockReady() ? timeSource : "unsynchronized";
  doc["uptime_ms"] = uptimeMs();
  doc["capture_requested_uptime_ms"] = requestedAtUs / 1000;
  doc["frame_uptime_ms"] = frameAtUs / 1000;
  doc["frame_age_ms"] = (static_cast<uint64_t>(esp_timer_get_time()) - frameAtUs) / 1000;
  doc["mime_type"] = "image/jpeg";
  doc["width"] = frame->width; doc["height"] = frame->height;
  doc["sensor_pid"] = sensorPid;
  doc["autofocus_initialized"] = focusReady;
  if (sensorPid == OV5640_PID) doc["sensor_focus_status"] = autofocus.getFWStatus();
  doc["firmware_version"] = VERSION;
  doc["capture_mode"] = captureMode;
  if (captureMode == "signals") {
    doc["session_id"] = captureWindow.sessionId.c_str();
    doc["capture_window_id"] = captureWindow.id.c_str();
    doc["capture_phase"] = captureWindow.phase.c_str();
  }
  if (doc.overflowed()) { esp_camera_fb_return(frame); ++droppedCaptures; lastError = "capture_metadata_capacity_exceeded"; return; }
  String metadata; serializeJson(doc, metadata);
  bool imageOk = writeExact(stem + ".jpg.tmp", frame->buf, frame->len);
  esp_camera_fb_return(frame); // release before any network operation
  bool metadataOk = imageOk && writeExact(stem + ".json.tmp", reinterpret_cast<const uint8_t *>(metadata.c_str()), metadata.length());
  bool committed = metadataOk && SD.rename(stem + ".jpg.tmp", stem + ".jpg") && SD.rename(stem + ".json.tmp", stem + ".json");
  if (committed) { ++pendingCount; Serial.printf("queued capture_id=%s pending=%u\n", captureId.c_str(), pendingCount); }
  else {
    SD.remove(stem + ".jpg.tmp"); SD.remove(stem + ".json.tmp");
    SD.remove(stem + ".jpg"); SD.remove(stem + ".json");
    ++droppedCaptures; lastError = "sd_commit_failed";
  }
}

class MultipartStream : public Stream {
 public:
  MultipartStream(String head, File &body, String tail) : head_(head), body_(body), tail_(tail) {}
  int available() override { return head_.length() - headAt_ + body_.available() + tail_.length() - tailAt_; }
  int read() override {
    if (headAt_ < head_.length()) return static_cast<uint8_t>(head_[headAt_++]);
    if (body_.available()) return body_.read();
    if (tailAt_ < tail_.length()) return static_cast<uint8_t>(tail_[tailAt_++]);
    return -1;
  }
  int peek() override {
    if (headAt_ < head_.length()) return static_cast<uint8_t>(head_[headAt_]);
    if (body_.available()) return body_.peek();
    return tailAt_ < tail_.length() ? static_cast<uint8_t>(tail_[tailAt_]) : -1;
  }
  void flush() override {}
  size_t write(uint8_t) override { return 0; }
 private:
  String head_, tail_;
  File &body_;
  size_t headAt_ = 0, tailAt_ = 0;
};

bool uploadOne(const String &metadataPath) {
  File metadataFile = SD.open(metadataPath);
  if (!metadataFile) { lastError = "queue_metadata_open_failed"; return false; }
  String metadata = metadataFile.readString(); metadataFile.close();
  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, metadata)) { lastError = "queue_metadata_invalid"; return false; }
  String imagePath = metadataPath.substring(0, metadataPath.length() - 5) + ".jpg";
  File image = SD.open(imagePath);
  if (!image) { lastError = "queue_image_missing"; return false; }
  const String boundary = "EchoCaptureBoundary";
  // The metadata part deliberately carries no Content-Type: @fastify/multipart auto-parses a
  // field declaring application/json into an object, which broke JSON.parse on the server. The
  // phone camera sends the same shape. The image part keeps its image/jpeg type.
  String head = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"metadata\"\r\n\r\n" + metadata;
  head += "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"image\"; filename=\"capture.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n";
  String tail = "\r\n--" + boundary + "--\r\n";
  bool accepted = false;
  for (uint32_t attempt = 0; attempt < UPLOAD_ATTEMPTS && WiFi.status() == WL_CONNECTED; ++attempt) {
    image.seek(0);
    WiFiClient client; HTTPClient http;
    if (!openHttp(http, client, apiPath("/api/device/captures"))) break;
    http.addHeader("Content-Type", "multipart/form-data; boundary=" + boundary);
    MultipartStream stream(head, image, tail);
    int code = http.sendRequest("POST", &stream, head.length() + image.size() + tail.length());
    // Only an explicit server acknowledgement can delete a durable capture.
    if (code >= 200 && code < 300) {
      accepted = captureAcknowledged(http.getString(), doc["capture_id"].as<const char *>());
    }
    http.end();
    if (accepted) break;
    lastError = "upload_not_acknowledged_" + String(code);
    if (code == 401 || code == 403 || (code >= 400 && code < 500 && code != 408 && code != 429)) break;
    delay(150 * (attempt + 1));
  }
  image.close();
  if (!accepted) return false;
  // Remove commit marker first. A power cut leaves an orphan cleaned on boot.
  if (!SD.remove(metadataPath)) { lastError = "queue_remove_failed"; return false; }
  SD.remove(imagePath);
  if (pendingCount) --pendingCount;
  ++successfulUploads;
  return true;
}

void pollConfig() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClient client; HTTPClient http;
  if (!openHttp(http, client, apiPath("/api/device/config?device_id=") + deviceId)) return;
  const uint64_t requestStartedMs = uptimeMs();
  int code = http.GET();
  if (code == 200) {
    DynamicJsonDocument doc(2048);
    if (!deserializeJson(doc, http.getString())) {
      if (doc["paused"].is<bool>()) { paused = doc["paused"]; configured = true; }
      if (doc["upload_enabled"].is<bool>()) uploadEnabled = doc["upload_enabled"];
      uint32_t requested = doc["capture_interval_seconds"] | intervalSeconds;
      intervalSeconds = constrain(requested, 10u, 3600u);
      int64_t epochMs = doc["epoch_ms"] | static_cast<int64_t>(0);
      const bool validServerTime = epochMs >= 1700000000000LL && epochMs < 4102444800000LL;
      if (validServerTime) {
        timeval value{static_cast<time_t>(epochMs / 1000), static_cast<suseconds_t>((epochMs % 1000) * 1000)};
        settimeofday(&value, nullptr); timeSource = "server";
      }
      captureMode = String(doc["capture_mode"] | "signals");
      if (captureMode == "signals") {
        JsonObject window = doc["capture_window"].as<JsonObject>();
        if (window.isNull() || paused || !validServerTime) { captureWindow.clear(); paused = true; }
        else {
          String id = window["id"] | "";
          String phase = window["phase"] | "";
          String sessionId = window["session_id"] | "";
          int64_t expiry = parseUtcMs(String(window["expires_at"] | ""));
          uint32_t remaining = window["remaining"] | 0u;
          const bool validWindow = CaptureWindowPolicy::validIdentity(id.c_str(), phase.c_str(), sessionId.c_str()) && expiry > epochMs && remaining;
          if (!validWindow) { remaining = 0; lastError = "capture_window_invalid"; }
          else if (!budgetStoreReady) { remaining = 0; lastError = "window_budget_storage_unavailable"; }
          else if (id == persistedWindowId) {
            if (phase != persistedWindowPhase || sessionId != persistedSessionId) { remaining = 0; lastError = "window_identity_changed"; }
            else remaining = min(remaining, persistedWindowRemaining);
          } else {
            persistedWindowId = id; persistedWindowPhase = phase; persistedSessionId = sessionId;
            persistedWindowRemaining = min(remaining, CaptureWindowPolicy::budgetLimit(phase.c_str()));
            // Write zero first: a cut between the new ID and budget is fail-closed.
            bool stored = budgetStore.putUInt("remaining", 0) && budgetStore.putString("window-id", id)
              && budgetStore.putString("phase", phase) && budgetStore.putString("session-id", sessionId)
              && budgetStore.putUInt("remaining", persistedWindowRemaining);
            if (!stored) { budgetStoreReady = false; remaining = 0; lastError = "window_budget_commit_failed"; }
          }
          bool changed = captureWindow.update(id.c_str(), phase.c_str(), sessionId.c_str(), requestStartedMs, expiry - epochMs, remaining);
          if (!captureWindow.allowed(uptimeMs())) paused = true;
          else if (changed) lastCapture = millis() - intervalSeconds * 1000; // first useful frame promptly
        }
      } else if (captureMode == "periodic") captureWindow.clear();
      else { paused = true; captureWindow.clear(); lastError = "unknown_capture_mode"; }
    } else lastError = "config_json_invalid";
  } else lastError = "config_http_" + String(code);
  http.end();
}

void publishStatus() {
  if (WiFi.status() != WL_CONNECTED) return;
  DynamicJsonDocument doc(1536);
  doc["device_id"] = deviceId; doc["boot_id"] = bootId;
  doc["firmware_version"] = VERSION;
  doc["camera_ready"] = cameraReady; doc["sd_ready"] = sdReady;
  doc["paused"] = paused || (captureMode == "signals" && !captureWindow.allowed(uptimeMs())); doc["configured"] = configured;
  doc["capture_mode"] = captureMode;
  if (captureMode == "signals") {
    doc["capture_window_id"] = captureWindow.id.c_str();
    doc["capture_phase"] = captureWindow.phase.c_str();
    doc["session_id"] = captureWindow.sessionId.c_str();
    doc["window_remaining"] = captureWindow.remaining;
    doc["window_active"] = captureWindow.allowed(uptimeMs()) && !paused;
  }
  doc["pending_uploads"] = pendingCount; doc["uptime_ms"] = uptimeMs();
  doc["sensor_pid"] = sensorPid; doc["autofocus_initialized"] = focusReady;
  doc["time_source"] = clockReady() ? timeSource : "unsynchronized";
  doc["successful_uploads"] = successfulUploads; doc["dropped_captures"] = droppedCaptures;
  doc["last_error"] = lastError;
  String json; serializeJson(doc, json);
  WiFiClient client; HTTPClient http;
  if (!openHttp(http, client, apiPath("/api/device/status"))) return;
  http.addHeader("Content-Type", "application/json"); http.POST(json); http.end();
}
} // namespace

void setup() {
  Serial.begin(115200); // do not wait for a serial monitor on battery power
  setenv("TZ", "UTC0", 1); tzset();
  budgetStoreReady = budgetStore.begin("echo-capture", false);
  if (budgetStoreReady) {
    persistedWindowId = budgetStore.getString("window-id", "");
    persistedWindowPhase = budgetStore.getString("phase", "");
    persistedSessionId = budgetStore.getString("session-id", "");
    persistedWindowRemaining = budgetStore.getUInt("remaining", 0);
  }
  char mac[18], randomId[18];
  snprintf(mac, sizeof(mac), "%012llx", ESP.getEfuseMac());
  snprintf(randomId, sizeof(randomId), "%08x%08x", esp_random(), esp_random());
  deviceId = String("xiao-") + mac; bootId = randomId;
  initializeSd(); initializeCamera();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  if (strlen(ECHO_WIFI_SSID)) WiFi.begin(ECHO_WIFI_SSID, ECHO_WIFI_PASSWORD);
  else lastError = "wifi_not_configured";
  lastCapture = millis();
  Serial.printf("boot device_id=%s boot_id=%s paused=1 pending=%u\n", deviceId.c_str(), bootId.c_str(), pendingCount);
}

void loop() {
  uint32_t now = millis();
  static wl_status_t reportedWifi = WL_NO_SHIELD;
  if (WiFi.status() != reportedWifi) {
    reportedWifi = WiFi.status();
    Serial.printf("wifi state=%d local_ip=%s rssi=%d\n", reportedWifi,
      reportedWifi == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "none",
      reportedWifi == WL_CONNECTED ? WiFi.RSSI() : 0);
  }
  if (WiFi.status() != WL_CONNECTED && elapsed(now, lastWifi, WIFI_RETRY_MS)) {
    lastWifi = now;
    if (strlen(ECHO_WIFI_SSID)) WiFi.reconnect();
  }
  if (WiFi.status() == WL_CONNECTED && (!lastConfig || elapsed(now, lastConfig, CONFIG_PERIOD_MS))) {
    lastConfig = now; pollConfig();
  }
  // Pause survives a network failure in RAM; reboot always starts paused until a config is read.
  if (elapsed(now, lastCapture, intervalSeconds * 1000)) { lastCapture = now; capture(); }
  if (uploadEnabled && pendingCount && WiFi.status() == WL_CONNECTED && due(now, nextUpload)) {
    String record = nextQueuedMetadata();
    if (record.length() && uploadOne(record)) { uploadFailures = 0; nextUpload = millis() + 250; }
    else { uploadFailures = min(uploadFailures + 1, 6u); nextUpload = millis() + min(60000u, 1000u << uploadFailures); }
  }
  if (WiFi.status() == WL_CONNECTED && (!lastStatus || elapsed(now, lastStatus, STATUS_PERIOD_MS))) { lastStatus = now; publishStatus(); }
  delay(20);
}
