# 手机相机与后台语音口令（0.5.0）

## 操作

添加餐食照片时选择“拍一张并交给 Step 识别”，使用手机后置相机，拍一张并发送到配置的 Step 后端。添加餐食照片也可在原生选择框选择“拍一张并交给 Step 识别”；相册上传保留原来的手动分析流程。

在 App 可见时，从设备面板或设置点“开启聆听与语音拍照”，允许麦克风、相机和状态通知。保持通知存在后可返回桌面。说“哈比记录”，也可以先叫“哈比”，六秒内说“记录”。哈比是唤醒词，只叫名字不拍照。实时 KWS 检测后用 VAD 句尾和短句 SenseVoice 复核，不等十秒 WAV。大小写、空格和标点不影响完整口令匹配；保留 Habi 及已实际观察到的 happy记录 ASR 别名，不把普通 happy 当作口令。“拍照”“帮我拍一下”不再作为手机语音口令。

明确口令走确定性匹配，跳过用餐 Decider，不受用餐线索的五分钟冷却影响。“不要Habi记录”“他说Habi记录”“明天Habi记录”等不匹配。用餐上下文入口继续排除已标识的媒体、测试夹具、旁人及过期时间。实时唤醒只接本次麦克风帧，短句复核前后都检查五秒处理时效；停止立即取消相机。当前唤醒分支未识别说话人或声源，尚未做防电视误触发或声纹验收。

通知“停止”或设置中的停止按钮同时关闭录音、语音相机和未完成的手机拍照请求。关闭 App 页面和从系统强行停止 App 是不同操作：本版不承诺进程被杀、强行停止、重启后仍能唤醒，也未验收长时锁屏和续航。

## 数据和识别

```text
唯一 AudioRecord → 实时 KWS 检测“哈比”
  → 六秒命令窗口 / VAD 句尾 → 短句 SenseVoice 完整口令确认
  → 直接请求本机 Camera2 后置相机 → 1 张 JPEG + 回执写入 App 私有目录
  → POST /api/phone/captures → 本地后端持久化并 ACK
  → Step 首图复核 → GET /api/phone/captures/:id 查询真实结果
```

同一 PCM 同时写十秒 WAV，运行原来的 SenseVoice / Decider 用餐上下文；这个分支不再重复执行手机拍照。其他用餐线索继续原来的 Decider 辅助 → ESP32 首图、按首图决定是否补拍的流程。明确手机口令只拍一张，不打开 ESP32 窗口。相机先使用不保存的低分辨率预览帧等待曝光，再保存一张 JPEG；拍完立即关闭相机。

手机照片与 JSON 在 `files/phone-camera/`。同一个请求始终使用相同 capture_id 和原图；网络失败最多三次有界补传，不重新曝光。设备面板可“补传或查询这张照片（不重拍）”。识别失败保留原图；后端未见食物就不会创建餐食；看到食物只建立候选餐，食量和实际摄入仍需本人确认。

手机照片使用 App 会话或 X-App-Token，不能用 ESP32 的 X-Device-Token 访问。Step 密钥只在后端；原始音频留在手机。当前开发联调仍用 USB 反向 8787 端口和手动启动的 Mac API，后续常驻服务放 Mac mini。

## 平台边界

Android 需要在 Activity 可见时启动 camera|microphone 前台服务，本工程明确声明 CAMERA、FOREGROUND_SERVICE_CAMERA、RECORD_AUDIO 和 FOREGROUND_SERVICE_MICROPHONE，使用常驻通知。参考 [Android 相机前台服务](https://developer.android.com/develop/background-work/services/fgs/service-types#camera)及[后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start#wiu-restrictions)。

当前 PZ261A 未发现 su，bootloader locked / verified boot green。没有 root，没有解锁、刷机或修改系统权限。代码使用标准权限；硬件实际支持以本次真机测试记录为准。

## 验证记录

2026-10-15：后端 50 项测试、前端构建、Android 0.4.0 编译安装通过。新增测试覆盖口令及否定/引用/未来语义，App/设备认证隔离，ACK 幂等，空图不建餐，手机来源及不触发 ESP32 补拍。以上接口测试使用明确标识的合成图片与响应，不代表真实相机或食物准确率。

真机已确认服务在 Activity 可见时成功启动，isForeground=true、types=0xC0（camera|microphone），模型就绪。用户本次麦克风测试收到三段“拍照。”，产生三个不同信号 ID，每条各对应一张 1920×1080 JPEG（约 247–286 KB）。手机回执、手机原图与后端原图三方 SHA256 全部一致，三次真实 Step 复核均为 no_food，餐食数为 0，未产生 ESP32 补拍窗口。

按系统 wm_set_resumed_activity 事件与快门时间交叉核对，其中两次拍摄时前台为系统桌面，一次为 Habi；因此后台语音到手机相机、持久化和真实 Step 识别在这台无 root 手机通过。三次都是桌面杂物画面，没有真实餐食份量或热量准确率结论；“帮我拍一下”通过规则测试，本次实际麦克风语句为“拍照”。

本轮被同目录其他 APK 安装中断过，第一次通知准备后未收到真实语音，恢复会话后才取得上述证据。后来再次更新使旧 pipeline-status.json 留下历史 listening 值；结束时读取新进程原生状态为 recording=false、models_ready=false、voice_armed=false，服务端已暂停，不能用磁盘旧状态冒充当前录音状态。构建安装脚本现会在构建前及安装前检查本包录音服务，录音时拒绝 --install；直接调用 adb install 仍须由操作者先停止录音。

原始照片、语音和包含本次文字的回执只在本地，未纳入 Git；证据包括被忽略的 output/validation/phone-voice-camera-summary.json、phone-voice-camera-commands.json、phone-voice-camera-event-timeline.txt。


## 口令更新与响应时间（0.4.1）

用户将固定口令改为“Habi记录”。Android 和后端使用相同整句规则，中文“哈比记录”为发音别名，原泛用拍照口令失效；用餐上下文的 ESP32 分支保持原流程。版本 0.4.1 尚未新增独立关键词模型，仍使用现有 SenseVoice 转写后匹配。上述 0.4.0 三次真实麦克风证据保留原文，新口令需另行验收发音识别，不能把旧口令测试当作新口令识别通过。

已保存的三次旧口令实测，从 ASR 音频窗口结束到快门分别约 2.35、8.86、9.10 秒。计时包含 10 秒 WAV 的等待及相机准备，音频窗口包含 VAD padding，不能冒充精确发声结束计时。SenseVoice 自身三次约 28–31 ms，明确口令跳过 Decider；这些是本次短句小样本，不代表所有语音的推理速度。

## 实时小模型（0.5.0）

已下载、哈希核对并部署 sherpa-onnx 的 `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20`。INT8 encoder + joiner、FP32 decoder 及词表共 5,449,080 字节。来源和锁定校验值在 `contracts/voice-kws/kws-lock.json`。官方 chunk-8 的 160 ms 是模型分块延迟，不是完整拍照或 Step 响应时间。来源：[模型和关键词格式](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html)。

使用同一条麦克风流，KWS 检测“哈比”，VAD 句尾后用原有 SenseVoice 确认完整短句。只有名字时等待后续“记录”，超过六秒恢复等待唤醒；成功请求后冷却四秒。VAD 和 ASR 不会仅凭 KWS 命中拍照。ASR 与上下文共用识别器锁，Decider 推理不占该锁。后端识别通过已有上传流程异步进行，断网不妨碍本地快门。

十秒上下文分支继续运行，但不能再执行 `phone_capture`，避免同一句重复拍。通知停止会立即使录音、实时候选和相机请求失效。KWS 内部静音重置后的相对时间戳只作原始诊断，短句截取与时效完全使用录音真实帧号和 BOOTTIME 锚点。

手机文件回放验证七组通过：原句、前置八秒静音、两秒分开说都各确认一次；只叫名字、只说记录、七秒后再说记录及静音未通过拍照确认。这些是同一用户授权录音的回放与变体，不开麦克风、相机或网络，不代表新一次实拍、多人准确率或续航。独立语法验证六条接受、十三条拒绝。原始录音、JSON 报告及日志留在被忽略的 `output/validation/habi-kws-native-replay.json` 等本地文件。

新版实时麦克风到相机的实际延迟需另行实测；不沿用 0.4.0 十秒切片的历史计时。完整上下文仍持续运行，不能仅因增加 KWS 宣称整机功耗降低。
