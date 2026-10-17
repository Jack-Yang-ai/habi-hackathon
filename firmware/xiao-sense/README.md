# XIAO ESP32S3 Sense 自动拍照固件

目标是带 Sense 摄像头扩展与 microSD 的 XIAO ESP32S3，普通 S3 / Plus 不应直接当成同一硬件。引脚、PSRAM 与 SD 接法按 Seeed 官方文档；驱动按实际 sensor PID 识别 OV2640 / OV3660 / OV5640，仅 OV5640 初始化 AF。

第一版做语义信号触发的短时采集窗口、耐网络中断队列和远程暂停；不要求先证明正在进食，也不在板上估算热量。

## 配置与构建

1. 安装 PlatformIO Core 6.1.19，或使用本仓库已有的 `.tools/pio-venv/bin/pio`。
2. 把 `include/secrets.example.h` 复制到被 Git 忽略的 `include/secrets.h`，配置 Wi-Fi、API 地址、与服务端一致的设备 token。
3. API 地址使用同一局域网内的真实电脑 IP，不能填写板子自己的 `127.0.0.1`。服务对 LAN 监听时按根工程说明设置访问令牌。

从本仓库根目录：

```sh
.tools/pio-venv/bin/pio run -d firmware/xiao-sense
.tools/pio-venv/bin/pio run -d firmware/xiao-sense --target upload --upload-port /dev/cu.usbmodemXXXX
.tools/pio-venv/bin/pio device monitor --baud 115200
```

不接板的固件验证需要C++11编译器；复用同一个窗口策略及已锁定ArduinoJson ACK解析器，不执行相机或网络操作：

```sh
python3 tools/esp32/test-firmware.py
```

实际串口通过 `pio device list` 确认；不要对未核实设备刷写。代码不等待串口监视器，电池上电后能进入主循环。

**无板时可完成编译，不能据此声明相机、AF、SD、Wi-Fi、续航或断电恢复已实测。** 本次编译和硬件连接事实见 `docs/device/VALIDATION.md`。

## 行为

- 每次启动生成随机 `boot_id`，`capture_id = device_id + boot_id + sequence`。同一照片的重试和重启后 SD 补传沿用同一 capture_id。
- 默认暂停。服务端`capture_mode=signals`时必须有未过期窗口、有效phase/session_id及剩余预算才拍；空窗保持暂停。probe最多一张，等待服务器按第一张画面判断；只有明确下发新ID的followup窗口才补拍，最多两张且服从更小预算。每个新窗口首张尽快拍，后续遵循服务端间隔；固件不自行判断食物或创建下一阶段。
- 同window ID轮询不会补充预算、延长期限或改变phase/session_id；本地单调时钟到期就停止，断网也不会无限拍摄。预算与阶段身份在NVS提前预占，重启也不把同一窗口补满；存储预算失败则不拍。缺阶段的旧配置、身份不匹配均暂停等新窗口。
- `capture_window.session_id`写入照片`metadata.session_id`，探测和补拍共享候选餐组；本阶段`id`写入`metadata.capture_window_id`，`phase`写入`metadata.capture_phase`，SD补传沿用原元数据。显式`capture_mode=periodic`可兼容后续间隔模式，间隔仍限制10–3600秒。
- `captured_at` 未校时时为 `null`，`time_source=unsynchronized`，同时给真实 `uptime_ms`；读取配置里的 `epoch_ms` 后才记录 UTC 时间，绝不伪装成已校时。
- JPEG 与 JSON 先写临时文件、flush/close，再 rename；JSON 是队列提交标记。仅收到服务器精确 capture_id ACK 才删除。
- 每轮最多尝试三次上传，跨轮指数退避最长 60 秒；401/403 等客户端错误不热重试。断网继续存 SD，联网后补传。
- SD 不可用时不自动丢图式运行。队列最多 1000 张，保留 2 MiB 空间；满时暂停新增，不删除用户旧照片。上报原因，补传后可继续。
- `paused` 只控制新采集，已有队列可以继续上传；`upload_enabled=false` 才暂停上传。signals断网时只用窗口剩余预算和原期限，重启重新等待配置；不是无限沿用最后一次允许拍摄。
- 不读取开发板麦克风，手机录音是独立能力。
- 触发后只保存驱动boot时间不早于请求的JPEG，有界丢弃WHEN_EMPTY中的旧缓存；窗口已到期、无新帧或元数据容量不足则结束该次尝试，不自行退预算。相机新鲜度待真实板验证。
- ACK只解析顶层或capture内的精确capture_id；候选餐组附带的大JSON不会耗尽固定解析容量。已用50KB合成附加字段验证，不把这项主机测试说成ESP网络实测。

SD 使用 FAT32、≤32GB。实际摄影与电池测试需要安装天线、确认供电和摄像头批次。[官方入门](https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/)、[官方相机与 SD 教程](https://wiki.seeedstudio.com/xiao_esp32s3_camera_usage/)。

此版传输是局域网 HTTP 原型，并显式拒绝 `https://`，不会通过关闭 TLS 验证伪装 HTTPS 可用。对外部署需要证书验证的 TLS 与设备配网/令牌轮换；不应把当前端口公开到互联网。

API默认只监听电脑loopback；实际板可通过本项目单独的device-only LAN中继访问。静态配网、强设备token、loopback默认运行与真实HTTP仿真命令见[ESP32_CONNECTOR.md](../../docs/device/ESP32_CONNECTOR.md)。本轮没有启用LAN监听，也没有把Step Studio的手机chooseImage当成ESP32连接器。
