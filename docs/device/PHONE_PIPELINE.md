# 手机本地感知与 ESP32 首图链路

验收日期：2026-10-15。手机为 StepX PZ261A / SM8845 / Android 16；独立开发包 `com.withecho.companion.dev`，版本0.3.0。没有获得root，当前方案使用可见通知的普通麦克风前台服务。用户已授权部署、录音和真实语音测试。

0.4.0 新增手机后置相机与明确语音口令，独立于下述 ESP32 准备态流程；最新操作及验收见[手机语音拍照](PHONE_CAMERA.md)。下述 0.3.0 记录保留为历史证据。

## 当前运行方式

手机单条AudioRecord持续采样，16kHz/mono/PCM16；每10秒只切文件。WAV和JSON提交标记落盘后，单个原生worker依次执行Silero VAD、SenseVoice INT8和Decider 0.8B Q4。模型均在手机CPU上运行，不借Mac完成这三步。常驻模型文件约769.5MB，原始音频留在手机App私有目录。

本地API接收转写、真实采集时间、原生模型分布与hash；有效 `localDecision` 跳过电脑的JEV推理服务。当前手机页面和API仍通过USB反向8787端口访问电脑，Step视觉密钥仅在电脑后端。拔线后的独立服务尚未实施。

```text
持续录音 → 完成WAV → VAD → SenseVoice → Decider辅助 + 明确上下文规则
  → 准备/邀请用餐线索 → ESP32 probe（最多1张）
  → 原图和任务持久化、ACK → Step首图复核
  → 有食物：同session新followup窗口，最多补2张
  → 无食物：结束；模糊：最多再试1张；失败/暂停/超时：停止
```

“准备去吃饭”足以请求首图，不要求已经进食。“还没吃饭，准备去吃”不是拒绝。语音来源和说话人未识别时保持unknown；不伪装成声纹识别。看到食物只创建候选餐，实际吃了多少仍需用户确认；不按照片数量累计热量。

## 本机已验证

| 项目 | 结果与证据边界 |
| --- | --- |
| 手机公开文件推理 | 5.592秒中文音频：VAD24.7ms、SenseVoice130.9ms、Decider1554.1ms，总约1.72秒；三模型常驻峰值约1.37GiB。测试音频明确标test-fixture，不触发真实相机 |
| 静音与重复 | 10秒纯静音segments=[]，ASR/Decider均未运行；同capture/offset/SHA重复返回duplicate，不重发信号 |
| 真正麦克风 | 连续357.28秒，36个完成WAV（35个10秒片+7.28秒停止尾段）；frame_offset连续、全部WAV SHA与回执匹配、无pending尾片 |
| 自动处理 | 35个完整片由手机自动推理，0处理失败、0队列溢出；停止尾段只保留音频，不继续发拍照指令 |
| 用户真实说话 | 最新收到完整“我还没吃饭，准备去吃饭了。”；手机Decider原始结果与规则均为start_soon，产生probe首图窗口，ingestionConfirmed=false、餐食0条。此前短句原始模型曾猜错，保留在限制说明中 |
| 停止 | 原生按钮停止麦克风/消费队列，独立异步请求服务器暂停；回读remote_pause=confirmed、backend paused=true、无有效窗口，餐食为0 |
| ESP32软件协议 | 7组真实TCP/HTTP仿真复用同一固件C++窗口策略，覆盖首图无食物、两补拍、单次模糊重试、失ACK重送、暂停、断网到期与重启预算。视觉为明确的deterministic fixture |

最终APK安装字节hash与主机一致；最后一次起停回归又处理6片，0失败/0溢出，暂停回读在轮询开始后约0.36秒完成（不等于精确麦克风停止延迟）。原生起停后关闭旧设备面板，回到实时主页，避免显示陈旧按钮。当前录音和自动拍照已暂停。

后续重连补验：同一录音累计1478.34秒（约24分38秒），148个完成WAV，所有帧位置连续且SHA匹配。142片已处理、0处理失败，但出现1片推理队列溢出；148片中共6片未分析，包含溢出、停止时待处理片与尾段，原音频均保留。重连后已停止，最终回读phase=stopped、models_ready=false、remote_pause=confirmed；录音前台服务退出，后端paused=true、无有效窗口、餐食0条。不能把这轮表述为全部音频均成功分析。

另将已保存的准备态回执送入隔离临时API，经实际Python设备连接器上传512×512合成无食物PNG，调用真实step-1o-turbo-vision。第二次运行返回HTTP200、foodDetected=false、no_food、餐食0条、无后续窗口；相同capture_id重传返回200且没有重复调用视觉。首次运行复核failed，未保存底层失败原因，不能据此归因为网络或格式。两次记录均保留。此项是旧回执的软件回放：未重跑ASR/Decider、未执行固件曝光，也未访问用户8787服务；与同一时刻的整链路实拍验收有别。

本地原始报告位于被Git忽略的 `output/validation/android-local-inference-public.json`、`phone-live-trigger-check.json`、`phone-microphone-continuity.json`、`esp32-http-e2e.json`、`phone-deployment.json`、`phone-final-stop-check.json`、`phone-preparation-retest.json`、`phone-reconnect-continuity.json`、`phone-reconnect-stop-check.json`、`phone-connector-step-replay.json`和`phone-connector-step-replay-02.json`。其中部分含用户本次授权测试的文字，不随代码公开。

## Decider的真实限制与本轮调整

本次真实短句在有前文时，原始模型曾把准备态猜成declined；这个错误没有被改写成“模型识别成功”。明确准备语义由规则优先，原始7项分布仍保存在 `localDecision` / `modelAssessment`，主界面呈现最终的准备线索，原始猜测放入折叠诊断。

本轮在Mac离线比较了2/3项首图任务和3种前后文排列，未得到稳定改善，因而没有把未验证的新格式移植到手机。短句在无背景时，原版7项的start_soon/invited/eating_now概率和较高，但细分常为invited；开发用19例中的负例仍有多次误支持。这不是领域准确率评估，不能让模型独自确认进食。更完整的模型来源与结果见[模型选型](../models/decision-options.md)和[Android推理接口](../../tools/decision/ANDROID_LOCAL_INFERENCE.md)。

## 起停、持久化与时间

原生“开始录音与感知”说明后请求麦克风/通知权限，在Activity可见时启动FGS；运行中不依赖WebView计时器。开始完整感知会允许服务端后续自动拍照；相机未接时保持真实的未连接状态。通知或设备面板可停止，停止不等待推理或网络。已在途的服务器任务最终受paused和45秒窗口期限约束。

采集锚点优先用AudioRecord BOOTTIME回算第0帧，否则明确标为audio_record_start_estimate。每条线索时间为capture_started_at + frame_offset/16000 + window_end_sec，服务端核对这些字段，不用处理时刻冒充录音时刻。默认source/speaker为unknown；synthetic_fixture有硬性排除。

每个完成片的推理报告与WAV共置App私有目录。最多6片在内存等待；网络有界重试、信号超过120秒不再触发。录音停止或App重启不会把旧语音重新当实时指令。原始音频不上传，未处理/失败片仍留在手机，不通过自动删除伪装处理完成。

## 仍需验收

开发板暂不在手边：未刷写、未真实曝光、未验证相机新鲜帧/SD/AF/佩戴视角/电源与断网恢复。手机到“等待ESP32首图”的真实语音链路通过，ESP32拍摄和首图后的物理补拍还不能宣称通过。后续按[ESP32连接器](ESP32_CONNECTOR.md)接同一局域网，刷写当前固件，再做真实食物/空桌/模糊三类实拍。

目前最长连续录音1478.34秒；覆盖了本次USB断开期间的本地运行，但未覆盖12小时、长期锁屏可靠性、通话中断和电池消耗，且已观察到1片推理队列溢出。当前手机语音分支没有接入独立咀嚼声音模型；VAD只证明存在语音，不证明本人身份或排除电视。背屏仍由电脑ADB中继，独立厂商权限和自有像素帧未验收。
