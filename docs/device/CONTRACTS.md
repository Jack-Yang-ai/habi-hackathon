# 设备接入契约 v1

## XIAO → API

`POST /api/device/captures` 使用 multipart/form-data：

- `image`：JPEG 二进制，Content-Type `image/jpeg`。
- `metadata`：下面的 JSON 字符串。
- Header：`X-Device-Token`，仅通过本地配置注入，不放网页或示例常量。

```json
{
  "schema_version": 1,
  "capture_id": "xiao-example-boot-example-0000000001",
  "device_id": "xiao-example",
  "boot_id": "boot-example",
  "sequence": 1,
  "captured_at": null,
  "time_source": "unsynchronized",
  "uptime_ms": 60000,
  "mime_type": "image/jpeg",
  "width": 800,
  "height": 600,
  "session_id": "candidate-example",
  "capture_window_id": "probe-example",
  "capture_phase": "probe",
  "firmware_version": "0.3.1"
}
```

示例为协议数据，不是实拍证据。signals模式的`session_id`来自服务端稳定候选餐组ID，探测图与补拍图共用；`capture_window_id`是本阶段预算窗口ID，两个阶段各用新ID；`capture_phase`为probe或followup。候选分组不证明这些照片都是用户同一餐或已摄入；固件不推断餐次。未校时时captured_at必须为null，API可以另存接收时间但不能冒充真实拍摄UTC。

`capture_id` 是传输幂等键。成功响应应为 2xx 且顶层含精确 `capture_id`；固件也兼容 `capture.capture_id`。同 ID 同内容重送不新建照片；同 ID 不同内容应拒绝。只有成功 ACK 才能删除 SD 队列。

`GET /api/device/config?device_id=...` 返回：

```json
{
  "paused": true,
  "capture_mode": "signals",
  "capture_window": null,
  "capture_interval_seconds": 30,
  "upload_enabled": true,
  "server_time": "2026-10-15T08:00:00Z",
  "epoch_ms": 1792051200000
}
```

时间字段仅示例，以实际 server_time/epoch_ms 为准。配置、状态和上传使用同一设备鉴权。设备每 15 秒拉配置，暂停指令可有此轮询延迟；第一版不承诺实时停止。

默认`capture_mode=signals`，服务端打开的窗口形如：

```json
{
  "id": "probe-example",
  "phase": "probe",
  "session_id": "candidate-example",
  "expires_at": "2026-10-15T08:00:45Z",
  "remaining": 1
}
```

首次probe最多一张；固件提交照片后等待服务器判断。只有服务器明确下发新ID、phase=followup、同session_id的窗口才补拍，followup本地上限两张且服从更小的remaining。食物/无食物/不清晰的判断及是否补一张由后端决定，固件不自行识别或续窗。

无窗口/过期/remaining=0时即使网络失联也不得继续拍；每个新窗口首张立即安排。同一ID配置重送不能延长本地期限、换phase/session_id或重新装满预算。NVS保存阶段身份和剩余数，每次调用相机前先预占预算；重启恢复同ID时不能补满。phase/session_id缺失或非法、旧NVS身份不匹配均暂停，等待新窗口；不把旧无阶段配置默认成连续三张。当前典型45秒窗口、本地期限最多60秒。显式periodic模式另行走间隔采集，已有SD队列始终可按upload_enabled继续补传。

`POST /api/device/status`：`device_id / boot_id / camera_ready / sd_ready / paused / pending_uploads / uptime_ms`，signals模式附`capture_window_id/capture_phase/session_id/window_remaining/window_active`，并可附`firmware_version / sensor_pid / autofocus_initialized / last_error / successful_uploads / dropped_captures`。没有电量传感器时不伪造battery_percent。

设备专用本地/LAN中继及复现命令见[ESP32_CONNECTOR.md](./ESP32_CONNECTOR.md)。电脑8787默认loopback；手机adb reverse不让ESP32直接访问该地址。本项目connector默认同样loopback、独立强设备token、只开放上述三条设备路由；本轮仅在随机loopback端口完成HTTP仿真，没有启动LAN监听或替换手机相机。

## Android 与网页

`EchoDevice` 方法及事件见 `android/README.md`。原生宿主与 Web App 仅共享能力和用户控制请求，不开放任意命令、路径或生产凭据。

`setRearScene` 的 `accepted=true` 不等于 LED 可见。原生的 `backend=unverified` 与服务器的 `rearDisplay=adb-relay` 可同时成立：前者说明 APK 本身未获得厂商控制，后者说明电脑中继已连接。

录音完成片通过 `recording_chunk` 事件给出schema_version=2回执：`capture_id/sequence/frame_offset/frames/sample_rate/channels/encoding/bytes/sha256/file/uploaded=false`，以及`capture_started_at/capture_started_elapsed_realtime_ns/time_source/clock/chunk_started_at`。相同锚点也保存为session.json。回执只表示本地原子落盘，不表示转写或服务端接收；当前原生`asr_connected=false`。时间不能由文件mtime或稍后处理时间替代，设备墙钟偏差仍需后续校验。

## 电脑 ADB 中继

`GET /api/state` 读取 `companion.scene`：

| 场景 | 系统内置 agent state |
| --- | --- |
| idle | idle |
| collecting | executing |
| resting | idle_night |
| watering | idle_loafing |
| listening | listening |

这只是系统内置动画映射，尚未将本项目的小伴画稿写入硬件。`collecting/listening/watering` 在有效场景改变时请求一次 wake，至少30秒冷却，场景过期回idle；idle/resting不循环唤醒，也不强制熄屏。操作遵守系统姿态、睡眠、温度及省电门控；背屏正在向下时可返回命令成功但不亮。

`POST /api/phone/status` 上报 `device_id / model / os / rootAvailable / rearDisplay=adb-relay`，中继还提供实际 `rearPower / rearPolicyAllowsOutput / rearAppliedState / customFramePresent / physicalVisualConfirmed=false` 以区分提交、系统应用和肉眼验收。

已有 custom frame 或其他 owner 的活跃交互时让出，不写任意 frame、不清任何 custom frame、不改常显/亮度/基本显示模式。结束时只在状态仍与最后写入匹配且无 custom frame 时复位 agent state。厂商 debug setter 对 resident state 可能显示 owner=none，因此这条通道并不具备自有像素帧的强所有权；不能用于后续长期 custom frame 覆盖。

后续自有像素帧必须新增带 owner/pattern/epoch 的 journal、跨进程 guard、8 秒跨持久化和强杀恢复验收，不能把此中继的 state-only 验证直接复用成 custom frame 成功证据。
