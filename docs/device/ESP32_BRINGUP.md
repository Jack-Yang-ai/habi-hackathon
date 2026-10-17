# ESP32 接板联调手册 · XIAO ESP32S3 Sense

开发板已到手，这份手册只讲**怎么一步步把板子接进现有链路**。每层单独验收，前一层的通过不能顶替后一层。编译和不接板的仿真证据见[ESP32连接器](ESP32_CONNECTOR.md)，本手册不重复。

## 0. 真机结果（2026-10-16 首轮 → 10-17 打通）

实物为 XIAO ESP32S3 **Sense**（OV3660 摄像头）。10-17 已走通"真机曝光 → SD 落盘 → 上传 → 服务端落库 → Step 云端复核"，期间发现并修复了一个从未暴露过的上传接口 bug（固件给 metadata 字段声明 `Content-Type: application/json`，被 multipart 库自动解析成对象后服务端重复 `JSON.parse` 失败），固件因此升到 `0.3.2`。完整回执见[设备验证](VALIDATION.md)。

| 层 | 状态 | 关键证据 |
| --- | --- | --- |
| 板型与实物 | 通过 | `flash_id`：ESP32-S3 rev v0.2、PSRAM 8MB、Flash 8MB quad、MAC `44:bd:8d:71:ea:cc` |
| L0 上电与串口 | 通过 | `camera_ready sensor_pid=0x3660 psram=1 af=0`；`boot device_id=xiao-ccea718dbd44 boot_id=... paused=1 pending=0` |
| L1 联网与鉴权 | 通过 | `wifi state=3 local_ip=172.20.10.4 rssi=-45/-66`；LAN 8788 无 token 401 / 正确 token 200 / App 路由 404 |
| L1.5 窗口下行 | 通过 | 板子上报 `window_active=true`、`window_remaining=1`、`capture_phase=probe` |
| L2 真拍与入库 | 通过 | `queued capture_id=...-0000000001 pending=1` → 退避重试后 `pending_uploads=0 / successful_uploads=1`；服务端出现 `source=esp32` 记录与原图 |
| L3 视觉复核 | 通过（首张） | Step 真实返回 `status=uncertain / foodDetected=false`，未凭空建餐；首张画面无纹理，画质本身未验收 |

SD 卡的坑值得单独记：这张 64GB 卡原来被格式化成 **NTFS**，ESP32 只认 FAT16/FAT32，所以首轮报 `f_mount failed: (13)`。格式化成 FAT32（卷名 HABI）后直接可用，比文档写的"≤32GB"更宽松——容量上限不是本次失败的真正原因。

上电前已核实：固件编译与 10-15 记录逐字一致（RAM 49,220B / Flash 878,853B），`window_policy`/`capture_ack`、connector 4 项 unittest、`http-e2e.mjs` 7 场景全部通过，设备 token 位于 `.tools/esp32/device-token`（0600），macOS 防火墙关闭。

固件默认 `paused`：**没有有效采集窗口时板子不会拍**。整条链路的起点不是板子，是电脑侧开一个窗口。

### 实测踩到的两个坑

- **iPhone 个人热点在"设置 → 个人热点"页面关闭后不再对新设备广播。** 板子会停在 `wifi state=6`（断开）与 `state=0`（重试）之间；已连上的电脑不受影响，所以看起来像板子的问题。把热点页面停在屏幕上，板子很快拿到 IP。频段必须是 2.4GHz（iPhone 上叫"最大兼容性"）。
- **`last_error` 是粘性字段，固件不清除。** 首次请求的瞬时失败会一直留在里面（本次是 `config_http_-1`），即使之后一切正常。判断通道是否健康看 `window_active` / `lastSeenAt`，不要看 `last_error`。

## 1. 网络：已确定并实测通过

**本轮采用的配置**：iPhone 个人热点，`Channel 6 (2GHz, 20MHz)` / WPA2 Personal；电脑 `en0 = 172.20.10.3`，板子 `172.20.10.4`。电脑直接连热点会让它暂时离开公司网，联调结束再切回去即可。

为什么不能沿用电脑原来的网：ESP32-S3 只有 2.4GHz 射频，且当前固件只用 `WiFi.begin(ssid, password)`，没有实现 802.1X 企业认证——电脑原先连的是 channel 36 的 5GHz WPA2-Enterprise，板子两个条件都不满足。

换环境时的可选路径：

| 路径 | 要点 | 风险 |
| --- | --- | --- |
| 手机热点（已采用） | 手机开热点，电脑和板子都连它；iPhone 打开"最大兼容性"强制 2.4GHz | 热点页面不能关，见上面的坑 |
| 办公室/家里 2.4GHz SSID | 必须与电脑同一子网，且 AP 未开客户端隔离 | 企业 AP 常见客户端隔离，板子到不了 8788 |
| 自带 2.4GHz 路由器 | 最可控，WPA2-Personal | 需要额外硬件 |
| 有线 + 热点并存 | 本机存在 `en3`/`en4` 网口。插网线走公司网，Wi-Fi 腾给热点 | 需要 USB 网卡或扩展坞网口 |

要避开的两点：**WPA3-only**（当前 Arduino-ESP32 2.0.17 对 SAE 支持有限）和**客户端隔离**（板子和电脑互相看不见）。

换网络后取电脑地址：

```sh
ipconfig getifaddr en0
```

## 2. 四层验收

| 层 | 目标 | 通过判据 | 当前 |
| --- | --- | --- | --- |
| L0 | 板子上电、串口可读 | 串口打印 `boot device_id=xiao-<mac> boot_id=... paused=1` | 已通过 |
| L1 | 板子↔中继会话 | 串口出现 Wi-Fi 状态/IP/RSSI；`/api/state` 的 `device.lastSeenAt` 每 15 秒推进，`cameraConnected` 变 true | 已通过 |
| L1.5 | 窗口下行被正确解析 | 板子上报 `window_active=true`、`window_remaining`、`capture_phase` | 已通过 |
| L2 | 窗口内真拍一张并入库 | 窗口开出后 ≤15 秒（配置轮询周期）板子曝光；串口出现 `queued capture_id=... pending=N`；服务端 `/api/state` 出现照片与 review 记录 | **待插卡** |
| L3 | 视觉复核 → 候选餐 | `device.captureReview.status` 从 `waiting_photo` 变为复核结果；有食物才开 followup | 未开始 |

L2 的失败排查顺序：`sd_ready` 是否为 true → 窗口是否在 45 秒内 → `sensor_pid` 与实物是否一致。L2 之后再看断电补传和续航，优先级更低。

## 3. 逐步操作

### Step 1 · 接线

- USB-C **数据线**接电脑（充电线没有数据线芯，认不出串口）。
- XIAO ESP32S3 **Sense** 扩展板已装好摄像头；普通 S3 / Plus 不是同一硬件。
- microSD 为 FAT32、≤32GB，插到扩展板卡槽。
- 接好 2.4GHz 天线。

### Step 2 · 确认串口

```sh
.tools/pio-venv/bin/pio device list
```

期望多出 `/dev/cu.usbmodem*`。没出现就先换线换口，不要直接进 Step 4。

### Step 3 · 写入配网（在你自己的终端跑）

这一步要隐藏输入 Wi-Fi 密码，请在终端里自己执行；密码不要贴到聊天或命令行参数里。

```sh
python3 tools/esp32/connector.py prepare --interactive \
  --api-base http://<电脑IPv4>:8788 --replace
```

`--api-base` 必须是 **8788**（设备专用中继），不是 8787；也不能填 `127.0.0.1`、`0.0.0.0` 或主机名，脚本要求一个明确的私网 IPv4 字面量，不合格会直接拒绝。工具从 `.tools/esp32/device-token` 取 token 写进被 Git 忽略的 `firmware/xiao-sense/include/secrets.h`（0600），不打印任何凭据。

### Step 4 · 编译与烧录

```sh
.tools/pio-venv/bin/pio run -d firmware/xiao-sense
.tools/pio-venv/bin/pio run -d firmware/xiao-sense --target upload --upload-port /dev/cu.usbmodemXXXX
.tools/pio-venv/bin/pio device monitor --baud 115200
```

串口只看这四类行，状态变化时才打印，不刷屏：

| 行 | 含义 |
| --- | --- |
| `boot device_id=... boot_id=... paused=1 pending=N` | 启动，设备身份与待传队列 |
| `camera_ready sensor_pid=0x.... psram=1 af=1` | 相机与 PSRAM/AF 初始化结果，PID 与实物批次要对得上 |
| `wifi state=... local_ip=... rssi=...` | 联网状态，`local_ip` 决定板子能否到 8788 |
| `queued capture_id=... pending=N` | 一次曝光已入队，接着会尝试上传 |

**串口不打印 SSID、密码或 token。**

### Step 5 · 起中继（电脑侧，另开一个终端）

```sh
python3 tools/esp32/connector.py serve --host 0.0.0.0 --port 8788 \
  --upstream http://127.0.0.1:8787 --token-file .tools/esp32/device-token
```

只开放 `config`/`status`/`captures` 三条设备路由，App 路由、聊天、媒体读取都不经过它。自检：

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/api/device/config   # 期望 401
```

401 是对的：无 token 必须被拒。

### Step 6 · 电脑侧开一个采集窗口

窗口 45 秒、probe 只允许 1 张。板子每 15 秒轮询一次配置，所以要在这 45 秒内让它轮询到。

```sh
curl -s -X POST http://127.0.0.1:8787/api/device/pause \
  -H 'Content-Type: application/json' -d '{"paused":false}' >/dev/null

curl -s -X POST http://127.0.0.1:8787/api/signals/context \
  -H 'Content-Type: application/json' \
  -d "{\"signalId\":\"bringup-$(date +%s)\",\"text\":\"我要去吃饭了\",\"speaker\":\"self\",\"sourceContext\":\"user-conversation\",\"observedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"dryRun\":false}" |
  python3 -c 'import json,sys; s=json.load(sys.stdin)["signal"]; print(s["action"], s["reason"])'
```

期望 `capture_window near_term_self_context`。可能出现的两种拒绝，都不是故障：

- `defer capture_cooldown`：距上次窗口不足 5 分钟，等冷却。
- `defer stale_or_future_signal`：`observedAt` 与服务器时间差超过 120 秒，重新取时间即可。

### Step 7 · 观测

```sh
curl -s "http://127.0.0.1:8787/api/device/config?device_id=<串口里的device_id>" | python3 -m json.tool
curl -s http://127.0.0.1:8787/api/state | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d["device"], ensure_ascii=False, indent=2))'
```

依次应该看到：`capture_window` 非空 → 板子 `lastSeenAt` 更新 → `captureReview.status` 离开 `waiting_photo` → 有食物时出现新 followup 窗口和第二张。

## 4. 取证

```sh
python3 tools/esp32/connector.py inspect
```

只输出串口列表和凭据是否存在。拍照回执、串口日志片段与失败证据按现有做法记入 `docs/device/VALIDATION.md`，标明**这一层是编译、是仿真、还是真机曝光**。不要用仿真结果顶替真机层。

## 5. 容易误判的坑

- 板子默认暂停；窗口过期或预算用尽就自动停，不会无限拍。
- 同一 window ID 重复轮询不会补预算、不会延长期限；重刷配置无用，需要新窗口。
- 首图上传后服务端会自动送 Step 复核（`.env` 已配 `STEPFUN_API_KEY`），**每张首图都会产生真实 API 用量**。
- L2 通过只说明"拍到了、传上来了、入库了"，不代表餐食识别正确。
- 本链路是局域网 HTTP 原型，不要把这个端口暴露到公网。

## 6. 联调加速开关

默认每次开窗之间有 5 分钟冷却。联调时反复等 5 分钟没有意义，用环境变量关掉：

```sh
CAPTURE_COOLDOWN_MS=0 node --env-file-if-exists=.env services/api/src/server.mjs
```

只影响 `triggerPlan` 的冷却判定，其它预算、窗口期限、probe/followup 规则不变；生产不设该变量即为 5 分钟。回归测试覆盖"默认仍拦"和"设为 0 放行"两种行为。
