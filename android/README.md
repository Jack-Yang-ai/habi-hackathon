# Habi Android 设备宿主（开发版）

独立包名 `com.withecho.companion.dev`。它不覆盖 StepX Studio 或 APT，不读取它们的数据库、录音或私有存储。主屏承接本仓库的 Web App，原生层提供设备状态、公共副显示设备探测、用户显式开启的麦克风/相机前台服务，以及手机后置相机单张拍照识别。

## 构建与启动

需要 JDK 17、Gradle 8.11.1、Android platform 35、build-tools 35.0.0，以及 PATH 中的 Node >=22.16 和 npm（可用自己的 nvm/fnm 等版本管理器选定，不固定开发机路径；也可用 `-PnpmPath=/path/to/npm` 或环境变量 `NPM` 指定 npm）。AGP 固定 8.9.2、Kotlin 固定 2.1.10。0.3.0加入手机本地SenseVoice/Decider，先按[本地推理说明](../tools/decision/ANDROID_LOCAL_INFERENCE.md)准备NDK/JNI；默认脚本寻找被忽略的 `.tools/`。

```sh
npm ci
python3 tools/decision/prepare-android-local.py --install-toolchain --skip-probe-build
python3 tools/decision/prepare-android-kws.py
python3 tools/device/build-android.py
python3 tools/device/build-android.py --install
python3 tools/decision/deploy-android-models.py --serial YOUR_ADB_SERIAL
python3 tools/decision/prepare-android-kws.py --deploy --serial YOUR_ADB_SERIAL
```

仅构建 APK 时，可将上面的本地推理准备命令改为 `python3 tools/decision/prepare-android-local.py --native-only`（工具链缺失时仍需 `--install-toolchain`）。此选项只准备 APK 所需的 JNI 库和 Kotlin 绑定，保留锁文件、大小与 SHA256 校验及 native 编译，跳过 models/samples 和独立 probe；输出 `native_only: true`、`probe_built: false`。这不表示手机模型已就绪，模型准备与部署仍需另行完成。

0.6.0 / versionCode 10 的构建配置通过 `preBuild → syncStudioAssets → buildStudio` 先在仓库根目录执行 `npm run build`，再用 Gradle `Sync` 将 `apps/studio/dist` 放进 generated assets 的 `studio/`，最终打包到 APK 的 `assets/studio/`。直接调用 Gradle 构建也会执行 Web build，不依赖预先生成的 dist；`buildStudio` 声明了 `apps/studio`（除 dist）、`contracts/`、`services/api/src/meal-draft.mjs` 与根 `package.json`/`package-lock.json` 为输入，`apps/studio/dist` 为输出，输入未变且 dist 完好时为 UP-TO-DATE，任一输入变化或 dist 被改动即重新构建；构建失败不使用旧页面。脚本的推理库大小、SHA256、锁文件及 KWS 源码检查保持不变，不自动下载模型。

APK 生成在 `android/app/build/outputs/apk/debug/app-debug.apk`。`--install` 只安装这个独立开发包，建立 `adb reverse tcp:8787 tcp:8787` 并打开主 Activity。录音中 --install 会拒绝安装，需先在手机停止录音，避免 APK 更新直接杀进程并留下未结束的 WAV。直接调用 adb install 同样需要先停止录音。正式发布还需要独立签名、部署方式和权限验收。本节描述构建配置；本次 APK 构建与交付事实见下面回执，不表示已安装或已完成断网真机验收。

### 2026-10-16 构建任务回执

本次最后重打包与覆盖交付的实际本机时间为 **2026-10-17 01:48 +08:00**（承接 2026-10-16 构建任务，不回填为前一天构建）。仅最小修复对话 timeline：餐食包含本地照片 captureId 时不再另加本地卡；餐食继续显示本地图，直到远程图片 decode 成功，再沿用 `local-${captureId}` key 交接。原生相机类型没有 `captured_at` 字段，保留现有时间，不扩展契约。

- `npm run build` 与 `git diff --check` 通过；使用已备 Eclipse Temurin JDK 21、Gradle 8.11.1、Android SDK 35 和原 `tools/device/build-android.py`（不带 `--install`）重打包，`BUILD SUCCESSFUL`。Gradle 实际重新执行 `buildStudio`、`syncStudioAssets` 和 APK 打包。
- APK 包名 `com.withecho.companion.dev`，versionName `0.5.2`，versionCode `9`，ABI `arm64-v8a`，大小 **91,274,207 字节**。APK 中 `assets/studio/` 的 **14 个文件**集合及各自 SHA256 均与本次最新 `apps/studio/dist` 一致，无重复资源项。
- `apksigner verify --verbose --print-certs` 通过，APK Signature Scheme v2 为 true，1 位签名者，`CN=Android Debug`。本机 debug 证书 SHA256：`2df0c69ca6c29f7871b0d804d2b5b7d6cff427b8421bc66e143990bd4f719f37`。**未核旧包签名**，不保证与旧包兼容覆盖安装。
- 已复制覆盖交付文件 `/Users/gogo/APT/Habi-0.5.2-code9-native-only-debug.apk`，与构建输出字节一致。最终 APK SHA256：`9ec4eea013340768d419fb34ed96c54470ff64e7be333777608ac645efa44110`。
- **未安装设备、未做本次真机测试**，未提交 commit；仅为本机 debug 构建与文件交付，不代表发布或线上运行，也不代表本地模型已部署或断网功能通过。

启动本仓库的 Web/API 服务后，手机通过 USB 反向端口访问 `http://127.0.0.1:8787`。从 App 右上角设置进入“设备连接设置”可手工配置可信后端地址；页面无法加载时保留原生“设备”入口。正常页面没有重复的开发顶栏。WebView 始终加载配置地址的 HTTP(S) origin 根页，保留这个 origin 的 cookies、存储与同源 API，不使用 `file://`，不开放跨域。配置中的路径、查询与 fragment 不用作页面入口；原生后端配置仍保留原值，建议填写后端根地址。

受信任 origin 的 GET `/`、`/index.html`、`/assets/`、`/fonts/`、`/habi/`、`/favicon.svg` 和页面实际引用的 `/favicon.png` 从 APK `assets/studio/` 提供，含正确 MIME、200 和 `Cache-Control: no-store`，不会被 HTTP 缓存。`/media/` 走 WebView 默认 HTTP 缓存，按服务端 ETag 校验后复用；不清除 cookies、用户数据或录音。缺失固定资源明确返回 404，不回退云端。路径经过严格单次 UTF-8 解码，拒绝畸形转义、重复编码、dot segment、反斜杠、编码分隔符、控制字符与重复斜杠，不能穿越资源目录。

仅同源 `/api/` 与 `/media/` 数据请求继续联网，主文档导航及声明为 HTML/文档/脚本的请求不由这些路径放行；其他未知文档/资源路径拒绝，不把远程 HTML 放到设备桥 origin。打包 HTML 的 CSP 禁止 frame/object/worker 与远程脚本，只允许同源 `/assets/` 的脚本。`EchoDevice` 仅挂到明确配置的 App origin，WebView 拒绝异源及非 HTTP(S) 请求，外站 HTTP(S) 主导航在系统浏览器打开，被拦截的应用内导航与非 HTTP(S) 跳转写入 `HabiWeb` logcat 警告；关闭文件访问。选照片通过系统 picker 逐次授权，不请求全盘存储权限。

固定界面资源随 APK 更新，后端页面更新不会替换它们。API、登录、云端识别、服务端记录和 `/media/` 照片仍依赖后端与网络；拔掉 USB 后若配置的是反向端口，数据请求会失败。固定资源本地化不等于离线数据同步、离线登录或全部功能断网可用，也不新增登录 token 桥接口。

## 设备桥

```js
JSON.parse(window.EchoDevice.getCapabilities());
JSON.parse(window.EchoDevice.getStatus());
window.EchoDevice.setRearScene(JSON.stringify({ scene: 'collecting', ttl_ms: 15000 }));
window.EchoDevice.startRecording(); // 原生确认，申请麦克风、相机和通知权限
window.EchoDevice.stopRecording();
window.EchoDevice.takePhoto(); // 仅可见页面发起；accepted 不等于拍照成功
window.addEventListener('echo-device-event', ({ detail }) => {
  // detail = { type: 'ready' | 'recording' | 'recording_chunk' | 'rear_scene' | 'capabilities', payload: {...} }
});
```

支持 `idle / collecting / received / resting / watering / listening`，Habi 公共 Display 与 App 预览共用 `contracts/rear-display/habi.json` 的6状态21帧。方法返回 `accepted` 只表示请求入队；应看事件里的 `native_rendering`、`vendor_permission_granted`、录音状态和实际设备回执。没有任意 shell、任意文件或 root 写命令入口。

## 背屏事实

原生默认通过 `DisplayManager` / `Presentation` 探测普通副屏。本次 PZ261A 的点阵背屏不在该列表；原生 App 因此返回 `unverified`，不会把主屏预览报告成真实背屏。

本次固件系统的厂商接口是 `display_ext` / `StepOSDisplayManager`，`com.stepos.permission.MANAGE_BACK_SCREEN` 为 `signature|privileged`。当前开发包未获得此权限；没有通过更改系统权限强行接入。点阵状态暂由单独的电脑 ADB 中继控制，见 `tools/device/relay.py` 和 `docs/device/VALIDATION.md`。拔线运行、自有 IP 像素帧及厂商签名接入另行验收。

## 录音事实

0.4.0 使用 `camera|microphone` 前台服务，在可见页面取得相机、麦克风和通知权限后开启；持续通知可停止。PCM WAV保存在App私有目录，不上传、不读取别的App音频。0.3.0在单个后台worker中本地运行VAD、SenseVoice和Decider，将文字线索与原始决策分布交给配置的API申请ESP32首图。录音中不依赖WebView计时器；进程被系统终止后不自动恢复。

当前版本使用一条 `AudioRecord` 采集流，16kHz/单声道/PCM16，每10秒只切WAV输出文件，不反复stop/start麦克风。完成片先修头、核长度、fsync，在应用私有目录单writer锁下检查碰撞并原子重命名WAV/JSON，再同步目录。消费者只读取完成的JSON提交标记，并核对对应WAV长度与SHA256；未完成尾段保留pending。停止不依赖转写、上传或WebView；后台无进度、静音/通话中断、低空间等会收口并报告状态。

schema_version=2 的每个回执及 `session.json` 都持久化 `capture_started_at`、`capture_started_elapsed_realtime_ns`、`time_source`。优先从AudioRecord BOOTTIME时间戳回算第0帧；若硬件尚未提供，明确记作 `audio_record_start_estimate`，不是处理时刻。`chunk_started_at` 根据这条采集锚点与frame_offset/16000计算；UTC来自设备墙钟，不宣称已与服务器校时。参考[Android AudioTimestamp](https://developer.android.com/reference/android/media/AudioTimestamp)。

2026-10-15在用户授权下开启实际麦克风357.28秒：36个完成WAV（35个完整10秒片+停止尾段）、连续frame_offset和全部SHA通过，35片自动推理、0处理失败、0队列溢出，停止后服务端paused=true。没有把这一短测写成12小时、锁屏或续航通过。12小时是代码上限。详见[手机链路](../docs/device/PHONE_PIPELINE.md)。

新完成片通过 `recording_chunk` 给出元数据，并交给原生 `LocalAudioPipeline`。`asr_connected`只在本地模型已加载时为true；`recording.pipeline`包含处理计数、错误、最近真实转写、原始模型候选及最终用餐线索。停止先切断麦克风和推理指令，再异步暂停服务端拍摄；停止尾段保留为WAV，不再触发相机。语音源/说话人保持unknown，不伪装成声纹识别。

合成文件验证（不打开麦克风）：

```sh
python3 tools/device/test-wave-writer.py
.tools/platform-tools/adb shell am instrument -w com.withecho.companion.dev/com.withecho.companion.FileValidationInstrumentation
```

后者是debug包固定的合成夹具，在本App缓存的随机目录验证文件行为，随后只清理该目录。只在未录音时运行instrumentation，避免系统为了测试重启本App进程。

## 工具来源

- [Android 官方 platform-tools](https://developer.android.com/tools/releases/platform-tools)
- [Android 官方命令行工具](https://developer.android.com/studio#command-line-tools-only)
- [AGP 8.9 兼容矩阵](https://developer.android.com/build/releases/agp-8-9-0-release-notes)
- [Gradle 官方发行版](https://services.gradle.org/distributions/)
- [Eclipse Temurin 17 官方发行](https://github.com/adoptium/temurin17-binaries/releases)

下载工具和日志保存在忽略的 `.tools/`，不把第三方 SDK 二进制加入源代码仓库。官方 sdkmanager 的 shell 脚本在当前带空格工作路径上会错误分词；可用 Java 参数数组调用 `com.android.sdklib.tool.sdkmanager.SdkManagerCli` 避免改写官方脚本。

## 手机语音拍照

0.5.0 使用 sherpa-onnx 中英 3M 流式 KWS，五个部署文件合计 5,449,080 字节，哈希与 Kotlin 接口锁在 contracts/voice-kws/kws-lock.json。与 10 秒上下文共用唯一 AudioRecord；先实时检测“哈比”，再在六秒内由 VAD 句尾和短句 SenseVoice 确认“记录”，支持连说或分开说。只叫名字不拍照；确认通过直接请求手机相机，后续 10 秒分支不重复执行。短句确认只共享 ASR 锁，不等待 Decider。添加餐食照片仍可选择拍照或相册。照片和回执先落盘，补传不重拍，无食物不建立餐食。操作、接口与实际验证边界见[手机相机](../docs/device/PHONE_CAMERA.md)。
