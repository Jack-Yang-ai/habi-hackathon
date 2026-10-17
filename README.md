# Habi · 饮食记录与背屏 IP 原型

产品名 Habi。面向希望改善饮食、又难以持续手动记录的成年人：随身相机降低记录负担，手机主屏承接对话、动态和确认，背屏展示 IP 的表情与生活状态。

## 启动

需要 Node.js 22.16+。本工程使用 Node 自带 SQLite，22.x 上会出现实验性模块提示。

```sh
npm install
npm run build
npm start
```

打开 http://127.0.0.1:8787 。开发时运行 `npm run dev`，前端为 5173，API 为 8787。

首次启动：没有预置餐食、没有虚构热量，设备拍摄默认暂停。小屋动态属于明确标记的虚拟 IP 故事。演示模式仅保存在前端，不写真实数据库。

## 当前可验证的应用链路

- 首页右上角头像可填写个人资料；昵称、性别、年龄、身高、体重、目标和忌口全部选填，保存到本地 SQLite，支持再次编辑和清空。资料当前不发送给模型。
- 手机/浏览器上传一张 JPEG、PNG 或 WebP，保留原图和接收来源。0.4.0 原生设备版新增手机后置相机单张拍照与 Step 自动复核。
- 设备上传以 `capture_id` 幂等；同设备同用餐 session 的多张图归到一个候选餐，不按每张图累计热量。
- 用户明确选择吃了多少，支持“一半”及补充说明；保留原始估算、食量和更正记录。
- 首页原位表达可关联具体一餐；对话只产生待确认建议，明确确认后原子保存食量和备注，并显示同餐收据。多餐时不猜归属，冲突时保留草稿并重新核对。
- 没有模型凭据时显示“未估算”和“本地基础对话”；本地规则不是自由对话模型。本机已按用户配置接通 Step 视觉与对话，凭据不随工程分发。
- 模型适配器支持兼容的 Chat Completions。手动照片在用户选择分析后发送；开启“自动拍照与识别”后，设备首图会送 Step 复核。模型失败保留原始记录并停止本次补拍。

模型配置见 `.env.example`，复制到本地 `.env` 并填写自己的服务地址、密钥与模型名称。密钥保留在服务端，不进入前端或 Git。没有做真实模型准确率验证；结构化输出通过只说明格式合法。

`STEPFUN_API_KEY` 会复用 health-agent 的官方 `step-1o-turbo-vision` 配置；`CHAT_MODEL_NAME=step-1o-turbo-vision` 可用于陪伴对话。本机已用合成无食物图片和中性问候完成真实接口验证，未把测试图写进餐食库。这不代表真实餐食份量和热量误差已经验证。

0.4.0 已在当前无 root 的 PZ261A 上验证：后台收到“拍照”→手机后置相机→原图落盘/上传→真实 Step 复核。三次口令各拍一张，其中两次发生在系统桌面前台；均无食物、未建餐。真实餐食和长期锁屏仍待验收。

## 附近餐厅推荐后端

单店轻卡后端已接入高德 Web 服务：位置上报、按用餐意图/饭点主动生成、换一家、步行导航数据、收起/选择与待投递提醒。Key 只在服务端 `.env` 配置 `AMAP_WEB_SERVICE_KEY`；`python3 tools/backend/configure-amap.py` 可隐藏输入。主动推荐默认关闭，定位、偏好、任务和卡片生命周期见[餐厅接口文档](docs/dining-api.md)。本轮没有接前端、Android 定位或系统通知展示；离线合成接口测试不等于真实高德调用或餐厅健康程度验收。

## 进食线索与短时拍摄

本地上下文提出可能用餐时先开`probe`，只拍一张。首图原子保存并回ACK，再由Step视觉复核；看到食物才开新`followup`窗口补充视角，无食物结束，模糊最多重试一次。全程45秒、最多3张、15秒补拍间隔，五分钟触发冷却。未知说话人可以试拍；已知媒体、旁人自己的计划、未来安排、旧录音和明确拒绝仍过滤。用户暂停或吃完会关闭新采集，已拍文件可以独立补传。

手机原生端已接通单条连续AudioRecord → 10秒WAV → Silero VAD → SenseVoice INT8 → Decider Q4 → 本地API首图窗口。2026-10-15真实麦克风验证357.28秒，35段自动处理，0处理失败、0队列溢出；停止后关闭录音和拍照窗口。手机本地模型不调用Mac推理服务，音频不上传。详见[手机链路与验收](docs/device/PHONE_PIPELINE.md)。这不是12小时或锁屏续航验证。

“准备去吃饭”即可请求一张验证图，不要求已经在吃；“还没吃饭”不等于拒绝。Decider原始中文分类仍不稳定，明确准备线索由本地规则优先，原始分布保留作辅助；不会把准备线索记成已进食。只有首图确认食物后才建立候选餐，实际食量仍需本人确认。

Android部署（本仓库已有JDK/SDK/Gradle时）：

```sh
python3 tools/decision/prepare-android-local.py --install-toolchain --skip-probe-build
python3 tools/decision/prepare-android-kws.py
python3 tools/device/build-android.py --install
python3 tools/decision/deploy-android-models.py --serial YOUR_ADB_SERIAL
python3 tools/decision/prepare-android-kws.py --deploy --serial YOUR_ADB_SERIAL
```

在手机设备面板点“开启聆听与语音拍照”。0.5.0 在同一录音流加入约 5.45 MB 的本地流式唤醒模型；“哈比”唤醒，6 秒内说“记录”（也可连说“哈比记录”），短句 SenseVoice 确认后走手机后置相机单张识别，不等 10 秒文件，也不等用餐 Decider；后台运行需先在可见页面启动相机与麦克风前台服务。操作和验收边界见[手机语音拍照](docs/device/PHONE_CAMERA.md)。构建脚本检查四个native库，部署脚本核对App私有目录中的模型hash；不要在录音或模型推理中替换模型。手机页面和视觉后端目前仍依赖电脑/USB。完整工具链与模型接口见 `tools/decision/ANDROID_LOCAL_INFERENCE.md`。

Mac上的Decider服务保留作文本联调对照：

```sh
python3 tools/decision/setup-decider.py
.tools/decider-venv/bin/python tools/decision/server_decider.py --backend cpu --port 8150
```

`JEV_URL=http://127.0.0.1:8150`用于没有手机推理结果的文本联调；携带有效 `localDecision` 的手机请求会跳过它。`audio/` 的独立声音事件/咀嚼分支尚未接入当前手机链路，语音VAD不替代本人识别。`node tools/decision/check-context.mjs`只测合成文本。选型与对照见 `docs/models/decision-options.md`；原AgentJev研究环境由`tools/decision/install.py`和`run.py`保留。

## 手机与背屏

本轮 ADB 发现 StepX PZ261A / Android 16。背屏是厂商点阵接口，不属于 Android 常规 secondary display。root 可用性、命令回执、背屏肉眼可见与脱离电脑运行分别验收；不能彼此替代。

- 原生宿主和录音实现：`android/`。
- 设备诊断、受限 ADB 中继及证据：`tools/device/`、`docs/device/`。
- 连接手机的本地开发可使用 ADB reverse，将手机的 127.0.0.1:8787 转发到电脑服务。
- ADB 中继依赖电脑与 USB；它不代表手机已经取得 root 或具备原生厂商权限。

现有 APT 项目与录音材料不属于本工程，不卸载、不覆盖、不清数据，也不把旧项目测试当作本工程通过。

## 开发板

目标为 XIAO ESP32S3 **Sense**（带兼容相机扩展）。固件位于 `firmware/xiao-sense/`。官方起点：

- [入门与版本区别](https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/)
- [摄像头与 SD 示例](https://wiki.seeedstudio.com/xiao_esp32s3_camera_usage/)

固件构建成功不代表开发板已经烧录或完成真实拍摄。实际板型、相机 PID、佩戴角度、画质、断网恢复和续航需分别验证。

本轮到货前的固件0.3.1编译和7组真实HTTP协议仿真见[ESP32连接器](docs/device/ESP32_CONNECTOR.md)，设备专用LAN入口、token与隐藏输入配网工具也在那里。开发板到手后的接线、配网、烧录与分层验收步骤见[ESP32接板联调](docs/device/ESP32_BRINGUP.md)。

2026-10-16 首轮真机结果：实物为 XIAO ESP32S3 Sense（OV3660，8MB PSRAM/8MB Flash），已烧录 0.3.1、经 iPhone 2.4GHz 热点联网、通过设备 token 与 LAN 中继上报状态，并正确解析了下发的采集窗口。**尚未真拍**——固件要求 microSD 挂载才曝光，当时没有可用卡。回执见[设备验证](docs/device/VALIDATION.md)。这是本工程连接器；Studio导出项目未接ESP32连接器，在线目录尚未核验，见 `docs/studio/CONNECTORS.md`。

## 数据与连接

常驻后端计划放到后续Mac mini；当前电脑只做代码和手动测试。可迁移代码包、目标机配置、Step联网自测、起停和备份见[Mac mini后端](docs/device/MAC_MINI_BACKEND.md)。打包工具不包含本机密钥或用户数据，也不会安装服务。

SQLite 和图片保存在忽略提交的 `.data/`。默认只监听电脑 loopback。通过局域网连接板子时，需在 `.env` 设置 `HOST=0.0.0.0`、不同的 `APP_ACCESS_TOKEN` 和 `DEVICE_ACCESS_TOKEN`；App 会话和设备凭据分开。不要将此开发服务直接公开到公网。

对外联调以 Mac mini 的 **https://habi.zhexin.site** 为准（启用连接口令与设备口令，Cloudflare 前置）。`node tools/backend/check-remote.mjs` 会检查线上健康、前端包版本、App 会话与状态、板子设备口令和一次可选的合成图识别往返；命令、口令来源与已知问题见[线上域名联调](docs/device/REMOTE_INTEGRATION.md)。

## 验证与交接

```sh
npm run verify
```

接口与事件：`contracts/app.ts`、`docs/api.md`。分工与材料：`docs/architecture.md`。Studio 生成内容、实际导出状况和本地前端来源分别记录在 `docs/studio/`；本地构建不自动进入 Studio，也不自动更新手机 APK。
