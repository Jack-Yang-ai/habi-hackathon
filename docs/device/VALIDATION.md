# 设备验证回执 · 2026-10-15

本回执区分源码、编译、系统读回和用户肉眼结果。所有原始设备输出存于忽略的 `.tools/`；未把手机序列号、用户数据库、旧录音或凭据加入仓库。

## 当前可用结果

| 项目 | 本次结果 | 凭据与边界 |
| --- | --- | --- |
| 手机 USB/ADB | 通过 | StepX PZ261A / pandora，Android 16，SDK 36；授权 device 状态 |
| 新 App 编译 | 通过 | JDK17、AGP8.9.2、Gradle8.11.1、Android35，最终 `BUILD SUCCESSFUL` |
| 新 App 安装 | 通过 | 系统先展示本次“小伴 · 开发版”USB安装确认；随后 `adb install -r` 返回 `Success` |
| 已装版本 | 通过 | 独立包 `com.withecho.companion.dev`，versionName `0.3.0`、versionCode `3`、minSdk26、targetSdk35；安装后APK hash与本机一致 |
| 前屏实际页面 | 通过 | 实机 screencap 已查看：首页小伴、饮食/变化导航、相机未连接；修正 Android16 状态栏/手势区重叠后再次安装验证 |
| 后端连接 | 通过 | 原生 WebView → `adb reverse tcp:8787 tcp:8787` → 电脑 `127.0.0.1:8787`；依赖电脑与 USB |
| 背屏硬件发现 | 通过 | `display_ext` + `vendor.stepos.hardware.dot_matrix.IDotMatrix/default`，chipProbe present / chipId0x20 |
| 背屏真实尺寸 | 通过 | 独立只读 app_process 探针在 UID2000 返回 17×23、单独厂商 manager；并非公共 Android secondary Display |
| 系统内置动画点亮 | 通过 | state listening + wake；系统 power on / policyAllowsOutput true / applied listening；用户即时反馈“现在亮了” |
| 自定义小伴像素帧 | 未实现/未验收 | 当前已见画面是厂商 `agent_pixel_listening`；网页 IP 画稿不等于硬件已上屏 |
| 当前 root | 不可用 | `su -c id`、`su 0 id`均 not found；`adb root`明确拒绝 production build；shell仍 UID2000 |
| APK原生厂商控制 | 未接通 | `com.stepos.permission.MANAGE_BACK_SCREEN` 为 signature/privileged；shell只读探针 checkSelfPermission=-1，普通新包未获此权限 |
| Android连续录音 | 357.28秒真实麦克风短测通过 | 单条AudioRecord16k/mono/PCM16，36个完成WAV含停止尾段；连续帧偏移及全部hash核对，0处理失败/0队列溢出；长时/锁屏/续航未验收 |
| WAV文件原子提交 | 真机合成测试通过 | 本包instrumentation：400123帧→3 WAV；连续字节/SHA/时间锚点/尾段/碰撞保护/目录fsync通过；不启麦，不读旧音频 |
| 录音→本地ASR/Decider | 已接通 | 手机原生worker自动处理35个完整片，真实测试句产生首图线索；模型仍作辅助，详见PHONE_PIPELINE.md |
| XIAO固件编译 | 通过 | 最终固定依赖版本编译成功，0.3.1，RAM49,220/327,680B，Flash878,853/3,342,336B |
| XIAO板实测 | 未开始 | 本机仅发现手机；串口仅 debug-console / Bluetooth，无已确认开发板；未上传固件，不宣称相机/SD/AF/续航已验证 |

APK 本地路径：`android/app/build/outputs/apk/debug/app-debug.apk`。

- 当前0.3.0 APK（84,255,107B）SHA256：`b03eb58e7d7cd2c3f5e454379a1b6b9906a1432b88a73dd59c7fffdfb974ed5d`；安装字节hash核对通过，`output/validation/phone-deployment.json`。
- 调试签名证书 SHA256：`2e5a2f51630eb88814fd34b14aca5c79b0394686029d856acc171d5e84c05234`。这是开发签名，不是发布证书。
- 固件 bin SHA256：`8a6ae073511b854829c7cc7da52f62ef45f3c36c7459d56cad20c53617095b25`。

最终安装回执 `.tools/device-diagnostics/this-project-install-receipt.json`；前屏 `.tools/device-diagnostics/this-project-companion-main.png`。这些是本工程 App，未拿 APT 或 Step Studio 的页面当成果。期间布局修正引入的初始化时序 NPE 已按实际日志修正，最终包重新编译、安装、启动并截图。

## 背屏黑屏的定位与用户验收

最初 `resting → idle_night` 已提交，但设备背屏朝下时 `posture_back_screen_down` 阻止输出。用户把背面朝上后仍反馈“背屏仍是黑的”，这条失败证据保留，不把命令成功冒充可见。

暂停本工程 relay 后，实际姿态已变 `OTHER` / `postureBackScreenDown=ok`，背屏仍是 off。随后只设置系统已知 `listening` 并请求一次 wake，读回：

```text
policyAllowsOutput=true
appAgentState=listening
agentStateOwner=uid=2000
appUsesCustomFrame=false
appFrameOwner=none
appliedAgentState=listening
currentAnimInfo=BackScreenAnimationInfo{id=agent_pixel_listening, name=活跃态-聆听, state=listening, type=agent}
power=on
```

用户即时回复“现在亮了”。这证明本机厂商内置聆听动画可由已授权电脑 ADB 路径点亮，不证明自定义 IP 帧、脱线控制或全天运行。手机 screencap 只能证明前屏，未将它当成背屏照片。

较早的单像素短测只返回 `frame sent to HAL`、power off→on；已立即 `pixel off` 恢复。没有写入持久 custom frame，也没有更改全局常显、亮度、基本类型或休眠/温度保护。

新 relay 的策略：

- `idle/resting` 只更新安静状态，不主动熄屏，不循环 wake。
- `collecting/listening/watering` 只在有效场景改变时 wake 一次，至少 30 秒冷却；场景到期回 idle。
- 仍尊重姿态、睡眠、温度、省电和系统显示优先级。翻面动作由系统传感器决定；不会以常显强制弥补门控。
- 有 custom frame 或另一个 owner 正在播放交互时让出；已结束的旧 owner 状态不会永久阻止后续交互。
- 不写/清任何 custom frame。结束时仅当 agent 状态仍匹配且无新 custom frame 时复位；不清其他 owner 的更新。

隔离测试 `python3 -m unittest discover -s tools/device -p 'test_*.py' -v`：7 项通过，覆盖已有 custom 不抢占、其他活跃 owner、退出保留外部更新、静默状态不唤醒、重复轮询不重复唤醒、已结束 owner 不永久阻塞。

## 连续音频文件验证

原15分钟MediaRecorder轮换已移除。从0.2.0开始保留一条AudioRecord输入，仅在文件边界完成10秒WAV，输出schema_version=2回执及session.json；0.3.0复用这条流接本地推理。capture_started_at/elapsed_realtime锚点来自采集开始，优先使用硬件AudioTimestamp BOOTTIME；不可用时明确标记audio_record_start_estimate。chunk_started_at由帧偏移计算，不用mtime或处理now替代。UTC仍是设备墙钟。

Host纯Java合成测试通过；真机先暴露Files.createLink返回AccessDeniedException，已更正为应用私有目录单writer锁、检查已有目标后同目录atomic rename。Android本包instrumentation随后通过同一固定合成测试，并通过directory fsync。原shell app_process夹具的137退出不能推断为OOM或系统策略；本包测试给出了文件API的明确失败及修复验证。

最终回执 `.tools/device-diagnostics/this-project-wave-fixture.txt` 包含：

```text
INSTRUMENTATION_RESULT: directory_fsync=true
INSTRUMENTATION_RESULT: microphone_started=false
INSTRUMENTATION_RESULT: private_audio_read=false
INSTRUMENTATION_RESULT: result=WAVE_TEST_OK frames=400123 chunks=3 microphone_started=false
INSTRUMENTATION_CODE: -1
```

以上历史合成测试只验证文件与元数据；后续真实麦克风357.28秒证据另见PHONE_PIPELINE.md。锁屏续航与代码12h上限尚未验证。

## 操作与停止

从仓库根目录运行：

```sh
python3 tools/device/inspect-device.py
python3 tools/device/probe-vendor.py
python3 tools/device/relay.py
```

停止本工程中继：

```sh
python3 tools/device/relay.py --stop
```

`--stop` 核 PID 命令和工作目录后只停止这个仓库的进程；Ctrl-C 也能结束。脚本采用工作区单实例锁与 PID 文件，不停止 APT 或其他录音/背屏进程。中继退出不卸载 App；移除 USB 转发可以执行 `.tools/platform-tools/adb reverse --remove tcp:8787`。当前页面依赖转发，移除后需重新配置可达服务。

## 参考经验的使用边界

用户提供的 `StepX-root开发经验总结.md` 及其固定 APT commit 源码仅用于理解 root、真实帧数、ACK、背屏所有权和5秒持久化问题。只读了明确指向的源码与设备进程/权限元数据；没有读取用户旧音频、数据库，也没有部署、更新、停止 APT runtime。

已核 README/provision 仍要求 `adb shell su 0`；不能把旧项目的 UID0 经验写成这台当前系统已 root。后续自定义17×23帧需另建仅接受固定场景的接口、owner/pattern/epoch journal、独立 guard，并完成跨8秒持久化、到期和强杀恢复验收。当前 state-only relay不冒充已覆盖这些用例。

## 拍照信号窗口的编译与隔离验证

固件0.3.1采用signals默认模式；只有服务端有效UTC、未过期窗口、有效phase/session_id和剩余预算才新增曝光。probe最多一张，等待后端按画面判断；后端明确下发新ID的followup窗口才补拍，最多两张且服从更小预算。探测与补拍共用稳定候选session_id，每阶段独立capture_window_id。显式periodic是另一模式，缺失模式不会意外退回持续拍照。同ID重送不延长单调期限、不补预算、不改变phase/session_id；每次曝光前将阶段身份及剩余数写NVS，重启同ID不能重新装满。缺阶段/餐组、旧NVS身份不匹配均暂停，等待新窗口。已有SD队列补传不依赖当前拍摄窗口。

纯C++隔离测试通过：probe最多1次、followup最多2次/服从更小预算、跨阶段同候选餐组、同ID不换阶段/餐组、不补预算/不延长期限、空窗/已过期/非法身份不能拍、本地到期断网停止。NVS断电原子性及实际曝光行为仍需接板实测。编译依赖PlatformIO espressif32 6.12.0 / Arduino 2.0.17 / ArduinoJson6.21.5 / OV5640AF固定commit；当前bin文件879,216B，回执 `.tools/device-diagnostics/this-project-firmware-receipt.json`。

## ESP32 connector与真实HTTP仿真

用户明确板暂不在手边，本轮没有刷写、开麦、调用手机相机或开放LAN端口。新增device-only connector默认仅loopback、固定转发到本机API，仅接受config/status/captures及独立强设备token；配网工具只把用户本机输入写入忽略的0600 secrets.h，不打印值。Step Studio导出没有已接ESP连接器，详见[Studio核对](../studio/CONNECTORS.md)。

`node tools/esp32/http-e2e.mjs`实际通过7组TCP HTTP流程，使用同一固件C++窗口策略、独立临时API及明确的确定性视觉夹具，覆盖无食物停止、有食物两补拍、模糊一次重试、失ACK幂等、暂停补传、离线到期、文件模拟NVS重启预算和入口隔离。报告`output/validation/esp32-http-e2e.json`明确hardware_camera_test=false/step_api_called=false/production_8787_contacted=false/lan_listener_opened=false。4项配置/凭据边界测试及同ArduinoJson ACK解析器50KB合成大响应测试通过；不等于板端SD/NVS/Wi-Fi或Step视觉实测。

固件0.3.1另外在WHEN_EMPTY模式有界丢弃触发前旧帧，只保存有效新JPEG；PSRAM下预留AF较大图像缓冲再恢复SVGA。这些路径只完成编译，新鲜度与AF仍待板验证。启动、配网与停止说明见[ESP32_CONNECTOR.md](./ESP32_CONNECTOR.md)。

## 仍需真实验证

开发板接线、实际 sensor PID 与 AF、SD断电边界、Wi-Fi断连/重启补传、真实餐食拍摄和电量；手机实际连续AudioRecord输入、麦克风竞争与通话/强杀、熄屏长测和后台上传；自定义 IP 像素帧、授权后的脱线运行和功耗。上述能力没有由本轮编译或短测推定通过。

## Habi UI 与共享背屏帧（同日追加）

Habi UI 已集成源码并实际安装到独立开发包。正常页面隐藏重复原生工具栏，设备配置从 App 设置打开，服务无法加载时保留原生配置入口。主屏遵循系统栏和 IME insets，系统返回可先关闭键盘、再关闭资料/设置弹层。真机 WebView 的卡片间距、TabBar、资料保存底栏和聊天键盘均已通过几何断言与 screencap 核对，详见 `docs/studio/VALIDATION.md`。UI 测试没有开始录音或拍摄。

本轮安装 APK 为 84,305,447 字节，SHA256 `6f479abea9ca231ec89670e9ca2ebe5abf68a04a0772921f70fb14c2ff89413e`；与设备安装字节核对一致。安装回执 `output/validation/habi-phone-deployment.json`、界面回执 `output/validation/habi-phone-ui-results.json`，不包含手机序列号。

新 Habi 星形点阵取代旧文档中的兔形设计：`contracts/rear-display/habi.json` 是唯一源，6 状态21帧；React 和 Android 公共 Display 读取同源数据，已装 APK 的 `assets/habi.json` 也核对一致。支持减少动画及生命周期清理，验证脚本为 `tools/device/check-rear-display-frames.py`。

物理背屏的限制仍在：实机只枚举公共 display 0；原生读回 `vendor_permission_granted=false`、`native_rendering=false`。系统权限定义再次核对为 `signature|privileged`，ADB shell 是 UID2000，su 不存在。自定义 Habi 目前只完成共享帧、预览与公共 Display 路径，尚未经厂商接口实际写入这台点阵背屏；未以厂商内置动画或前屏截图代替物理上屏验收。

## 直接调用系统内置动画复测（同日追加）

用户提出“不写背屏，只调取”。本轮沿用 `tools/device/relay.py` 的具名状态调用，未发送自定义 frame/bitmap，也未修改常显、亮度、背屏基本类型或保护策略。

首轮请求 `listening` 已接受，但背屏姿态门控为 `BACK_SCREEN_DOWN`，输出始终 off；用户反馈“仍然是黑屏”。测试恢复 idle 后，用户看到默认时间页。此时重读为 `BACK_SCREEN_UP`，再请求 `state listening` 与一次 wake：第1、11、21秒均为 `rearPower=on`、`rearPolicyAllowsOutput=true`、`rearAppliedState=listening`、owner UID2000、customFrame=false。用户即时明确确认“两只会动的眼睛”，因此这次具备系统回读和肉眼结果。

第31秒按未改动的30秒超时熄屏；受控测试结束后只在状态和 owner 仍属于本次调用时恢复 idle。现有常驻 relay 保留，可继续由 Habi 真实状态驱动系统动作。回执 `output/validation/habi-built-in-rear-faceup-test.json`；首轮失败回执 `habi-built-in-rear-test.json`。

只读检查 `/system_ext/app/AgentSprite/AgentSprite.apk`：系统包有39组 `agent_pixel_*` 资源，为17×23亮度矩阵 JSON。实际背屏资源主要是双竖眼表情，没有本项目新增的星形身体轮廓；不把内置动画宣称为自定义 Habi 帧。检查摘要位于忽略目录 `output/validation/backscreen-resources/`，系统包仅保存在忽略的本机诊断目录。

结论：直接调用内置表情的 USB/ADB 路径可用；自定义星形写帧与普通 APK 脱线独立调用仍分别待接入。前端设置和背屏页已据此区分“内置动作联调”和“Habi 自定义设计预览”。

## ESP32 真机接板首轮（2026-10-16 追加）

用户提供 XIAO ESP32S3 Sense 开发板。本轮完成实物识别、烧录、联网、设备鉴权与采集窗口下行验证；**没有拍照**，因为固件要求 SD 挂载才曝光，而当时没有可用 microSD。步骤见[ESP32接板联调](ESP32_BRINGUP.md)。

| 项目 | 结果 | 凭据与边界 |
| --- | --- | --- |
| 板型识别 | 通过 | esptool `flash_id`：ESP32-S3 (QFN56) rev v0.2、Embedded PSRAM 8MB (AP_3v3)、Flash 8MB quad、USB-Serial/JTAG、MAC `44:bd:8d:71:ea:cc` |
| 出厂固件 | 已确认并被覆盖 | 烧录前串口为 `Hello from Seeed Studio XIAO ESP32-S3 Sense` |
| 固件烧录 | 通过 | `/dev/cu.usbmodem1101`；无凭据 879,216B、含配网 879,488B，两次均 `Hash of data verified` |
| 摄像头 | 通过 | 串口 `camera_ready sensor_pid=0x3660 psram=1 af=0`；实物为 OV3660，`af=0` 符合“仅 OV5640 初始化 AF”的设计 |
| SD 卡 | **未通过** | 首轮 `sdCommand(): Card Failed! cmd: 0x00` + `sdcard_mount(): f_mount failed: (3)`（无卡）。插入卡后变为 `f_mount failed: (13) There is no valid FAT volume`——**卡已被识别、SPI 通信正常，但文件系统不是 FAT**（多半 exFAT），需格式化为 FAT32 后重测；`capture()` 依赖 `sdReady`，因此尚未产生任何曝光 |
| Wi-Fi 联网 | 通过 | iPhone 个人热点，`Channel 6 (2GHz, 20MHz)` / WPA2 Personal；串口 `wifi state=3 local_ip=172.20.10.4 rssi=-45` |
| 设备鉴权与中继隔离 | 通过 | LAN 8788：无 token 401、正确 token 200、App 路由 404；仅转发 loopback 8787 |
| 状态与配置上行 | 通过 | 设备记录 `firmware_version=0.3.1`、`sensor_pid=13920`(0x3660)、`camera_ready=true`、`sd_ready=false`、`pending_uploads=0`；`lastSeenAt` 每 15 秒推进 |
| 采集窗口下行 | 通过 | 开窗后板子上报 `window_active=true`、`window_remaining=1`、`capture_phase=probe`，证明 phase/session/预算解析正确 |
| 真机拍照、ACK、视觉复核 | **未验收** | 无 SD 卡，L2/L3 待插卡后进行 |

两条已确认的行为边界：

- iPhone 个人热点在“设置 → 个人热点”页面关闭后不再对新设备广播。板子首次关联失败（`wifi state=6`→`0`），页面打开后短时间内拿到 IP。这是联调环境限制，不是固件缺陷。
- `last_error` 是粘性字段，固件不清除。本次 `config_http_-1` 是配网后首次请求的瞬时失败残留；随后窗口下行正常，说明该字段不能当作当前状态判断依据。

本轮没有读取或改动手机侧数据，没有调用 Step 视觉，没有写 `.data` 以外的数据库，服务端暂停状态已恢复为默认暂停。

## MacBook 续跑清单（待执行，非回执）

本节是待执行步骤，不是本轮回执；承接 2026-10-16 首轮接板，L2 仍阻塞在 SD，本轮没有产生任何曝光。

已推的源码点：`origin/codex/dining-companion` = `6017e7f`，含 `bb1478c`（接板手册）、`8048872`（设备中继）、`77ca07e`（APK 内置 Studio 资源 + 相机运行时权限）、`4930025`（提版本到 0.6.0 / versionCode 10）、`6017e7f`（本清单）。此前工作树停在旧点 `05c3485` 且带未提交改动，“两边 APK 不一致”即由此而来，不用再排查。

1. 同步（先核本地改动，不要直接 pull）

```sh
cd <habi 仓库目录>
git status --short          # 有输出先保住改动，再往下
git fetch origin
git checkout codex/dining-companion
git pull --ff-only origin codex/dining-companion
git log --oneline -3        # 期望 6017e7f
```

2. 从 `4930025` 构建并安装（不要在旧点重打包）

```sh
npm ci
python3 tools/decision/prepare-android-local.py --native-only
python3 tools/device/build-android.py
python3 tools/device/build-android.py --install   # 先在手机停止录音
```

装完核手机上的 `com.withecho.companion.dev` 是 `0.6.0` / `versionCode 10`。两台机器都有 `.tools/`，从已推 commit 构建即可，“Mac mini 编不出 APK”不成立。

3. 解 L2（硬件，唯一阻塞）

- 取一张 microSD，格式化 **FAT32、≤32GB**，插入 XIAO Sense 扩展板卡槽。
- 照[ESP32接板联调](./ESP32_BRINGUP.md) Step 2→7 重跑：`pio device list` → `connector.py prepare --interactive --api-base http://<电脑IPv4>:8788 --replace` → `pio run --target upload --upload-port /dev/cu.usbmodemXXXX` → `pio device monitor --baud 115200` → 另一终端 `connector.py serve --host 0.0.0.0 --port 8788 --upstream http://127.0.0.1:8787 --token-file .tools/esp32/device-token` → 开采集窗口。
- L2 判据：窗口开出后 ≤15 秒串口出现 `queued capture_id=...`，且 `/api/state` 出现照片与 review 记录。
- L3 判据：`device.captureReview.status` 离开 `waiting_photo`；有食物才出 followup 第二张。
- 取证时标明这一层是编译、仿真还是真机曝光，不用仿真顶替 L2。

4. 沿用首轮已确认的坑

- iPhone 个人热点“设置 → 个人热点”页面不能关；频段必须 2.4GHz（“最大兼容性”）。
- `last_error` 是粘性字段，判通道健康看 `window_active` / `lastSeenAt`，不看它。
- 首图自动送 Step 复核，每张首图产生真实 API 用量。
- 无有效采集窗口时板子默认 `paused` 不拍；同 window ID 重复轮询不补预算。

5. 已处理：`services/api/src/app.mjs` 的确认归因日志不再无条件输出。该日志会把确认请求体（可能含用户备注）写进日志，现改为只在 `HABI_CONFIRM_TRACE=1` 时输出；查误确认时显式开启，日常和设备验收默认关闭。

### 本清单核验（2026-10-17，另一台机器拉取 `6017e7f` 后）

| 项目 | 结果 | 依据 |
| --- | --- | --- |
| 拉取与版本 | 通过 | 快进到 `6017e7f`；`versionCode 10` / `versionName "0.6.0"` |
| 合并后 API 测试 | 通过 | `npm test` 92 项全过，0 失败 |
| `--native-only` 存在 | 通过 | `tools/decision/prepare-android-local.py:89` |
| 构建前置 | 通过 | `node -v` = v22.22.2，满足 `build-android.py` 新增的 ≥22.16 检查 |
| 0.6.0 APK 可构建 | 通过 | 从 `6017e7f` 构建：`versionCode='10'` / `versionName='0.6.0'`、包名 `com.withecho.companion.dev`、APK 91,299,602 字节，内含 `assets/studio/` 14 个资源；Gradle 先 `npm run build` 再同步 Studio |

一条执行前容易踩的状态问题：本机 8787 的 Node 进程早于本次合并启动，仍在跑旧代码。**R1 前必须用 HEAD 代码重启 8787**，否则测到的是旧行为（例如确认归因日志的开关不会生效）。8788 的 connector 进程若也在跑，同样按需重启。

## ESP32 首张真机照片与云端复核（2026-10-17）

承接上一节的 L2 阻塞。本轮把 SD 卡修好并走通了"板子拍照 → 上传 → 服务端落库 → Step 云端复核"，同时发现并修复了一个**固件从未成功上传过**的接口 bug。

| 项目 | 结果 | 依据 |
| --- | --- | --- |
| SD 卡 | 通过 | 原卡为 64GB **NTFS**（即上一轮 `f_mount failed: (13)` 的原因）；`diskutil eraseDisk MS-DOS HABI MBR` 格式化为 FAT32 后挂载，启动日志不再出现 `Card Failed` / `f_mount failed` |
| 相机与 PSRAM | 通过 | `camera_ready sensor_pid=0x3660 psram=1 af=0` |
| 真机曝光 | 通过 | 开窗后串口 `queued capture_id=xiao-ccea718dbd44-6a098eddd4e2421d-0000000001 pending=1` |
| 上传 | **首轮失败，修复后通过** | 首轮 `upload_not_acknowledged_400`；修复后板子在指数退避重试中自动重传成功：`pending_uploads` 1→0、`successful_uploads` 1 |
| 服务端落库 | 通过 | `captures` 中出现 `source=esp32` 记录，原图 `.data/media/39ca0fb023aa20aec07c6e19261eebe5f0e2b9d6.jpg`（12,024 B） |
| Step 云端复核 | 通过 | 真实调用返回 `status=uncertain`、`foodDetected=false`、`reason=首张画面不清楚，再试一张就好。`；未凭空建立餐食 |

### 上传 400 的根因与修复

- 现象：板子上传返回 400，服务端消息"照片元信息格式不正确"，固件记录 `upload_not_acknowledged_400`。
- 根因：固件给 metadata 字段声明了 `Content-Type: application/json`。`@fastify/multipart` 会**自动把该字段解析成对象**（`index.js:310-319`），而 `receiveCapture` 随后对对象执行 `JSON.parse()`，抛错被当作元信息非法。手机端上传不带这个头，所以一直正常；**板子这条路此前从未成功上传过**，本次是首次真机上传。
- 修复面：服务端同时接受字符串与已解析对象两种形态；固件去掉 metadata 字段的 Content-Type 以对齐手机端契约，版本升到 `0.3.2`。新增回归测试覆盖"声明 application/json 的 metadata 字段"，`npm test` 93 项全过。
- 固件 bin SHA256：`3317b3568607e8048cf52bf2e5fed4ec28ba800c32ed3beb1daeca50142bdc02`（含本机配网，二进制随凭据变化，不作为发布物）。

### 未通过或未验收

- 首张画面为空/无纹理（800×600、12 KB），Step 判"不清楚"是**正确结果**，不是链路故障。相机对准真实场景（餐食、桌面、人物）后的画质与构图尚未验收。
- 断网补传、SD 断电恢复、长时续航、佩戴角度、背屏联动均未因此次单张通过而成立。

## 首张真机照片经 Step 识别并建立候选餐（2026-10-17）

在上一节修复上传 400 后，第一次用板子对准真实目标（一杯奶茶）跑完整闭环：**曝光 → SD 落盘 → 上传 → Step 云端识别 → 服务端自动开模糊重试窗口 → 重拍 → 识别到食物 → 建立候选餐**。

| 阶段 | 结果 |
| --- | --- |
| probe 首图 | `successful_uploads=1`；Step 返回 `waiting_retry`、`foodDetected=false`（画面不清楚） |
| 自动重试窗口 | 服务端下发 `capture_phase=followup`，板子取到后补拍第 2 张 |
| 第 2 张 | `successful_uploads=2`；Step 返回 **`food_found`、`foodDetected=true`** |
| 候选餐 | **已创建** `meal_92c2493b67a8b527f0593622220fa544`；`meals` 由 0 变 1，无需人工确认前不产生摄入结论 |

- 采集 ID：`xiao-ccea718dbd44-fd7d6a4c40d4996c-0000000001`（`/media/4086d679…jpg`，15,495 B）、`-0000000002`（`/media/2ec1fdcb…jpg`，14,774 B）。
- 画面质量：两张都贴得极近，能看到杯底标签和杯内深色液体，但明显失焦。OV3660 是**定焦**镜头（`af=0`，符合"仅 OV5640 初始化 AF"的设计），贴太近必然模糊；Step 首张判"不清楚"是正确结果，不是链路故障。
- 本轮同时验证了固件 `0.3.2` 的 multipart 契约修复与"模糊最多重试一次"的状态机在真机上按设计工作。

未验收：画质与构图（需退到 20–40cm 重拍）、食量与热量的本人确认流程、断网补传、SD 断电恢复、长时续航、佩戴角度。候选餐已建立但仍是候选，不代表已记录进食。

### 镜头保护膜导致整体失焦（同日追加）

7 张真机照片的客观清晰度（Laplacian 方差）为 0.9–5.9，且近景杯特写、中景桌面、人脸三个距离**一样软**，说明不是构图距离问题，而是整幅均匀失焦。撕掉镜头出厂保护膜后，同一台设备、同一位置：

| 时间 | 清晰度 | 对比度 | 字节 |
| --- | --- | --- | --- |
| 撕膜前 08:02:46 | 4.3 | 42.6 | 15KB |
| 撕膜后 08:05:32 | 27.2 | 46.3 | 19KB |
| 撕膜后 08:05:47 | **46.8** | **66.0** | 23KB |

撕膜后画面可清楚辨认桌面、显示器与珍珠奶茶（吸管、杯底配料）。结论：**失焦主因是出厂保护膜**，不是 OV3660 定焦缺陷；暂不需要换 OV5640 自动对焦模组。对比图见被忽略的 `output/validation/esp32-image-quality.png`。

两点仍需注意：

- 后续两张被判"不清楚"，实际原因是板子被挪动、镜头朝向天花板/笔记本底面，画面里没有主体。**判"不清楚"要结合画面内容看，不能只看状态字段。**
- 一次 Step 复核返回 `failed`，但 `capture-review.mjs` 的 catch 只写通用提示、未保留底层错误；随后 `tools/backend/check-step.mjs --live` 返回 `visionStatus 200 / chatStatus 200`，重测正常，判定为瞬时失败。建议后续在 catch 里保留安全化的错误类型，便于定位。

## 手机中继真机首次贯通（2026-10-17）

按产品链路"板子 → 手机热点 → App 内中继 → 服务器 → Step"完成第一次真机验收。板子不再连电脑，只连手机热点；手机把三条设备路由原样转发给后端。

| 项目 | 结果 | 依据 |
| --- | --- | --- |
| 热点与配网 | 通过 | 手机 SoftAp：SSID `STEPX Neo`、channel 1 / 2412 MHz、SecurityType=2（WPA3 过渡）；板子 `wifi state=3 local_ip=10.12.194.181 rssi=-42` |
| 中继鉴权 | 通过 | 无 token 401、带 43 字符设备 token 200；`adb forward` 从电脑直连手机 8788 可复现 |
| 心跳转发 | 通过 | 板子设备记录每 15 秒推进，连续 2 分钟 8 次更新，无中断 |
| 照片转发 | 通过 | 一次窗口内板子连拍 2 张（captures +2），两次上传全部成功（`successful_uploads` 1→3、`pending_uploads` 0） |
| 云端复核 | 通过 | 照片经中继到达后端并触发 Step 复核；本次画面是显示器底面与天花板，Step 判"不清楚"属正确结果 |

### 本轮修掉的三个中继缺陷

- **accept 循环遇异常永久退出**：socket 仍处于 LISTEN，但不再 accept，表现为端口在听却永不响应。改为仅在服务真正停止或 socket 关闭时退出，瞬时异常退避 100 ms 后继续。
- **通知权限否决启动**：已装版本要求通知可用才启动前台服务；改为通知仅影响状态卡，不再阻止中继运行。
- **中继需要手工开启**：改为随 App 启动自动开启（服务忽略重复启动）。另外确认了一个反直觉行为：`onCreate` 会调用 `configure(appUrl)`，把 `backend_url` 强制覆盖成 `app_url`，两者必须一致。

### 联调环境约束（非固件缺陷）

- **息屏 Doze 会冻住中继**：`mWakefulness=Dozing` 时进程仍存活（state=S）但网络与线程被限流，表现与"中继挂死"一致。联调期用 `adb shell dumpsys deviceidle disable` + `svc power stayon true` 规避；**产品上应改为中继服务持有 partial wake lock**，这是待补的代码项。
- 手机 SoftAp 空闲 10 分钟无客户端会自动关闭（`mIdleShutdownTimeoutMillis=600000`），需重新打开热点。
- `adb reverse tcp:8787` 可能因 USB/adb 重连丢失，丢失后中继转发会全部失败。
- 跨机器构建的 APK 调试签名不同，`adb install -r` 会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`；本轮在本机卸载重装解决，代价是 App 私有目录里约 740 MB 本地模型被清除，需用 `python3 tools/decision/deploy-android-models.py --serial <序列号>` 重新部署。
- App 原本指向 `https://habi.zhexin.site`；为便于观测，本轮用 `run-as` 临时把 `app_url`/`backend_url` 指到本机 `http://127.0.0.1:8787`（经 adb reverse）。产品路径应指回域名，且板子设备 token 需与服务端 `DEVICE_ACCESS_TOKEN` 一致。

未验收：息屏/锁屏下长时间转发（需 wake lock 修复后重测）、手机与服务器跨公网、模型重新部署后的本地语音链路。

### 息屏保活的实测边界（同日追加）

给中继服务加了 `PARTIAL_WAKE_LOCK`（停止时释放），但在这台 PZ261A 上仍不足以息屏保活，证据如下：

```
PARTIAL_WAKE_LOCK 'Habi:device-relay' ACQ 17:03:16.636
                                     REL 17:03:29.631  (13 秒后)
[96] DISABLE uid=10200 pkg=com.withecho.companion.dev tag=Habi:device-relay reason=FROZEN
```

即：**厂商 ROM 在息屏后冻结 App，并强制禁用它的 wake lock**（reason=FROZEN）。把应用加入 doze 白名单（`dumpsys deviceidle whitelist +pkg`）、设为 active standby bucket、允许后台运行之后，息屏 75 秒中继仍超时；唤醒屏幕并重启 App 后立刻恢复（wake lock `ACQ` 正常、心跳恢复）。

结论与后续：

- wake lock 改动保留：在标准 Android 上这是息屏保活的正确做法，属必要不充分。
- 这台厂商 ROM 还需要**系统级后台/自启动白名单**（在设置 UI 里授权，adb 无法替代）；否则息屏后中继不可用。
- 联调与演示期请保持屏幕常亮：`adb shell svc power stayon true`，或设置较长 `screen_off_timeout`。
- 未验证：拿到厂商后台权限后息屏长时间转发；换标准 Android 机型复测。

补充：用户在系统设置里给应用开了后台运行权限后复测，息屏 90 秒中继仍超时，`isFreezeExempt=false`、wake lock 依旧被 `DISABLED`。注意当前安装的是调试包 **`com.withecho.companion.dev`**（带 `.dev` 后缀），而厂商的后台/自启动白名单按**包名**生效——若在系统列表里授权的是正式包 `com.withecho.companion`，对调试包不生效。待确认项：确认授权条目是「Habi · 开发版」，或授权后重启手机再测；正式发布时应改用不带后缀的正式包名，避免同类错配。

### 息屏保活的最终结论（2026-10-17）

在用户于系统设置给应用开启后台运行权限、并**重启手机**之后复测，结论不变：

| 阶段 | 观察 |
| --- | --- |
| 亮屏基线 | 中继连续 3 次 401；`PARTIAL_WAKE_LOCK 'Habi:device-relay' ACQ=-7m7s LONG`；服务 `isForeground=true`、前台类型 `SPECIAL_USE`、`curProcState=4`（前台服务态） |
| 关屏 90 秒 | `mWakefulness=Dozing`；wake lock 变为 `DISABLED`（reason=FROZEN）；中继 HTTP 000 超时；板子心跳停止 |

已排除的因素：前台服务、`PARTIAL_WAKE_LOCK`、doze 白名单（`dumpsys deviceidle whitelist` 已含本包）、`RUN_ANY_IN_BACKGROUND=allow`、`standby-bucket`、厂商后台运行授权、重启后重新应用。**该机型在息屏后会冻结 App 并强制禁用其 wake lock，应用层无法规避。**

产品上的影响与结论：

- **不丢数据**：息屏期间板子的照片留在 SD 队列，手机唤醒后由固件退避重试自动补传（本轮已多次观察到 `pending` 归零、`successful_uploads` 递增）。代价是**上传延迟**，不是失败。
- **演示/验收期保持屏幕常亮**（`adb shell svc power stayon true`），或换标准 Android 机型/取得厂商系统级免冻结权限后再验收息屏场景。
- 该限制属机型/厂商 ROM 行为，不是本工程固件或中继的缺陷；换机复测应作为后续验收项。
- 另一条与测试环境有关的坑：**手机重启后热点不会自动恢复**，`wlan2` 消失、板子随即断链；需重新打开热点，并核对热点网关 IP 与固件 `ECHO_API_BASE` 是否仍一致，不一致要重烧固件。
