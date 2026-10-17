# 本地音频采集信号验证

验证日期：2026-10-15。目标是提醒和短时相机采集信号。音频证据不能直接成为“本人已吃了一餐”或热量记录。

## 已实现的两条独立支路

```text
16 kHz / 单声道 / PCM16 连续音频
  ├─ 语音：Silero VAD → 有界语段及前后上下文 → SenseVoice → 文本/时段/原生标签 → 手机Decider辅助 / ContextTrigger
  └─ 声音：独立 10 秒窗口 → AudioSet Zipformer INT8 → 咀嚼候选门控 → eating_candidate

来源归属、暂停、冷却和时效门控 → 轻提醒 / 短时采集建议
```

语音 VAD 只用于语音支路。咀嚼声音可能不是语音，不能先用语音 VAD 把它过滤掉。

- `audio/local_audio.py`：文件式原始 SenseVoice / 音频事件推理；保留原生输出和模型分数，支持有界分窗。
- `audio/speech_pipeline.py`：Silero VAD → SenseVoice；仅在出现有效语段时加载 ASR 模型；16 kHz 输入；语段前保留 0.3 秒、后保留 0.5 秒，避免切掉音节。
- `audio/eating_gate.py`：咀嚼候选状态机；默认连续 3 个独立窗口，排除已知媒体/旁人、强语音/音乐、近静音，支持暂停与 180 秒冷却。阈值尚未按本手机录音标定。
- `audio/context_adapter.py`：输出 `/api/signals/context` JSON。默认 `speaker=unknown`、`sourceContext=unknown`、`dryRun=true`，不自动提交。
- `audio/android/PublicAudioProbe.kt`：只读取模型公开测试 WAV 的 Android CPU 探针；不启用麦克风、相机和网络。

`eating_candidate` 的动作建议为 `capture_window`，对象仍是 `unknown`。模块不会实际启动相机、推送提醒、创建餐食或计算热量。明确的“我要去吃饭了”由语义支路处理，不等待 3 个声学窗口。

## 模型和标签

| 模型 | 实际文件大小 | 用途与边界 |
|---|---:|---|
| SenseVoiceSmall ONNX INT8，2024-07-17 | 239,233,841 B | 中文等语音转写及语言/情绪/事件标签；没有专门的咀嚼/吞咽标签，也不识别本人 |
| AudioSet Zipformer-small ONNX INT8，2024-04-15 | 27,038,066 B | 环境声音多标签基线，包含 Chewing, mastication / Biting；不是已标定的佩戴者进食检测器 |
| Silero VAD | 643,854 B | 检出语音片段；不能区分本人、旁人或电视 |

本次 Zipformer class map 中，咀嚼为 index 54、Biting 为 55。YAMNet 的同类索引不同；应按各自 class map 的 MID 或名称取值。当前所用标签中没有 swallowing；打嗝、胃鸣、餐具声音也不单独证明进食。

Jev 使用用户指定的 [agent-jev](https://github.com/malevrigns/agent-jev)。它处理文本/结构化状态；原始音频先经过本模块。其输出在中文饮食领域需要独立评估，不能当作已经校准的饮食置信度。

模型、测试 WAV、运行时及下载包保存在已忽略的 `.tools/`；仓库只保留脚本、来源锁和报告。`audio/models.lock.json` 锁定 URL、字节数和 SHA-256。SenseVoice 与 Silero 摘要可与 GitHub release digest 核对；旧 Zipformer 归档没有上游 digest，其 SHA-256 是首次 HTTPS 下载时记录的固定复现摘要。

## 复现

在仓库根目录执行：

```sh
uv venv --python 3.12 .tools/audio-venv
uv pip install --python .tools/audio-venv/bin/python -r audio/requirements.txt
.tools/audio-venv/bin/python -m audio.fetch_models
python3 -m unittest audio.test_eating_gate audio.test_context_adapter -v
```

语音支路只接受显式提供的 16 kHz 文件，不扫描目录、不自动启麦。以下是官方公开测试音频：

```sh
.tools/audio-venv/bin/python -m audio.speech_pipeline \
  .tools/audio-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav \
  --source-context test_media --output .tools/audio-validation/speech-vad-zh.json

.tools/audio-venv/bin/python -m audio.local_audio tagging \
  .tools/audio-models/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15/test_wavs/3.wav \
  --repeat 3 --output .tools/audio-validation/tagging-public.json

python3 -m audio.make_smoke_fixtures
```

Android 探针复用工作区已有 JDK 17、SDK 35 和 Kotlin 编译缓存。下载并校验匹配版本的官方 JNI 与 Kotlin API，再构建不安装 APK 的 DEX：

```sh
python3 -m audio.build_android_probe
# 仅由当前手机开发负责人协调执行；显式指定已授权设备。
python3 -m audio.run_android_public_probe --serial AUTHORIZED_DEVICE_SERIAL
```

探针只推送锁定的模型和公开 WAV 到随机隔离目录，再校验设备文件 SHA-256，逐个启动独立 CPU 进程。运行结果写入 `.tools/audio-validation/android-public.json`。

## 已测结果和实际发现

完整结果见 `public-validation.json`，原始本机报告在 `.tools/audio-validation/`。

| 环境与样本 | 推理三轮耗时 | 内存口径 | 结果 |
|---|---|---|---|
| Mac arm64，SenseVoice，5.592 秒公开中文 | 0.136 / 0.129 / 0.125 秒 | 整个 Python 进程峰值约 757 MiB | “开放时间早上9点至下午5点。” |
| Mac arm64，tagging，10 秒公开音乐 | 0.122 / 0.112 / 0.088 秒 | 整个 Python 进程峰值约 251 MiB | Music；候选门控抑制 |
| PZ261A / SM8845 / Android 16，SenseVoice，同一中文 | 0.253 / 0.121 / 0.121 秒 | 含 ART 与 native 的独立进程 VmHWM 716 MiB | “开饭时间早上9点至下午5点。”，与 Mac 输出有语义差异 |
| 同一手机，tagging，10 秒公开音乐 | 0.225 / 0.117 / 0.116 秒 | 独立进程 VmHWM 381 MiB | Music，原始 score 约 0.789 |
| 同一手机，tagging，10 秒公开猫声音 | 0.203 / 0.117 / 0.113 秒 | 独立进程 VmHWM 381 MiB | Animal / Cat |

这是小样本 CPU 可执行性与资源测量；不是中文 ASR 准确率、进食识别准确率、全天稳定性或续航验证。手机与 Mac 使用不同版本运行时，量化模型同一 SHA-256 仍出现不同文字；必须让下游保留不确定性。

负样本暴露两处问题：

1. 30 秒纯静音直接送 SenseVoice，会转写出“我.”，并附 BGM 标签。加 VAD 后，该静音文件输出 `segments=[]`。不能把任何 ASR 文本直接当作真实话语。
2. tagging 在纯静音上也会给 Music 约 0.366 的分数。分数不是校准概率；声学门控另测 RMS，近静音硬抑制。

Mac 的 VAD 语段若不保留前后上下文，会截断公开中文的起始音节。加入 0.3 / 0.5 秒上下文后，输出恢复为与该 Mac 整段推理一致。连续流实现也应保留跨文件的这段缓存。

## Android 运行时兼容修复

官方 Android sherpa-onnx 1.12.30 包携带的 ORT 1.23.2，在该 SM8845/Android 16 上推理时 SIGILL。仅对本工程新探针 PID 取得崩溃记录：`libonnxruntime.so + 0x7664b8`，反汇编为 SME2 指令 `ptrue pn9.b`。微软有[对应芯片和症状的上游问题](https://github.com/microsoft/onnxruntime/issues/27884)。

直接混搭新版 ORT 与旧 JNI 会遇到 ELF 符号版本不匹配。因此最终使用完整匹配的官方 sherpa-onnx Android **1.13.8 / ORT 1.28.2** 和同一 commit 的 Kotlin API。升级后公开样本在手机上全部完成；未修改系统保护、SELinux 或现有 App。

`audio/android-runtime.lock.json` 锁定最终运行时和每个 Kotlin 文件。旧版失败的来源与 PC 记录保存在 `android-sm8845-legacy-failure.json`，原始本工程崩溃文本在忽略目录。

## 接连续 WAV 与后端

Android 采集层负责单一连续 AudioRecord 流，每 10 秒原子发布完整 WAV 与回执。分析端只消费已完成文件，先校验 `sha256`，不读取 `.pending.wav`。schema 2 回执应持久化 session 的实际 `capture_started_at` 和单调时钟锚点。

适配器按下面的时间计算观察发生时刻：

```text
chunkStart = capture_started_at + frame_offset / 16000
observedAt = chunkStart + speech.window_end_sec
```

处理时间、文件 mtime、重试时间都不能替代录制时间。旧回执缺少锚点时必须显式补充实际 session 起始时间；缺少真实时间则不投递。后端应继续执行 120 秒 freshness、暂停、冷却和来源检查。

`audio.context_adapter.to_context_signals()` 产出每个语音段的 JSON；`audio.context_adapter.chunk_recording_start()` 校验回执格式、hash，并换算连续流帧偏移。`audioEvents` 只保留同一音频 hash、重叠时段的真实 tagging 分数；SenseVoice 只有标签而没有置信度，因此标签放进 `asrEvidence`，不伪造分数。公开模型测试音频的 hash 自动强制标为 `test-fixture`，不能通过默认选项变成本人实时证据。

文件式Python脚本仍用于验证与集成；手机0.3.0已另外实现LocalAudioPipeline和常驻本地推理实例，并完成357.28秒真实麦克风短测，见[手机链路](../device/PHONE_PIPELINE.md)。手机语音VAD逐完成片计算，片内前后padding与60秒文本上下文已接；跨文件音频语段拼接、10秒咀嚼分支及其3窗口状态尚未接入。真实佩戴位置、混音、进食正样本、漏报误报和耗电仍需验证。

## 原始来源

- [SenseVoice 上游](https://github.com/QwenAudio/SenseVoice)与[官方模型卡](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)：实际发布 checkpoint 的能力与推理接口。
- [sherpa SenseVoice 模型说明](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)：ONNX INT8、测试 WAV 和 Android 路径。
- [sherpa 音频 tagging 模型说明](https://k2-fsa.github.io/sherpa/onnx/audio-tagging/pretrained_models.html)：Zipformer-small AudioSet 模型。
- [AudioSet 官方 ontology](https://github.com/audioset/ontology/blob/master/ontology.json)：咀嚼、咬等标签语义。
- [锁定版本 Android 发布包](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8)和[Android 构建说明](https://k2-fsa.github.io/sherpa/onnx/android/build-sherpa-onnx.html)。
