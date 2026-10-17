# v1 接口与证据边界

服务默认 `127.0.0.1:8787`，根目录提供已构建前端。状态类型见 `contracts/app.ts`。所有写操作失败返回 `{error:{code,message}}`，不返回密钥、模型原始响应或堆栈。

| 方法与路径 | 作用 |
|---|---|
| GET `/health` | 服务存活，无用户数据 |
| POST `/api/session` | `{token}` 换取 8 小时 HttpOnly / SameSite=Strict 会话 |
| GET `/api/state` | 餐记录、IP 动态、对话、设备实际连接状态与模型配置状态 |
| GET `/api/profile` | 当前个人资料，初始为空；同一资料也随 `/api/state` 返回 |
| POST `/api/profile` | 整体保存个人资料，省略的字段恢复为空值 |
| POST `/api/capture` | 用户相册上传，multipart `image` 和可选 `metadata` |
| POST `/api/phone/captures` | 手机相机单张拍摄，必填 metadata；App 认证，自动排队 Step 复核 |
| GET `/api/phone/captures/:id` | 查询手机该张图的复核状态和候选餐；App 认证 |
| POST `/api/device/captures` | 设备上传，multipart `image` 和必填 `metadata` |
| GET `/api/device/config?device_id=...` | 拍摄暂停、间隔、上传开关、ISO 时间与 `epoch_ms` |
| POST `/api/device/status` | 相机/SD/待传队列/运行状态心跳 |
| POST `/api/phone/status` | 手机型号、root 实际可用性、背屏接入类型心跳 |
| POST `/api/device/pause` | App 请求 `{paused:boolean}`，停止新采集不阻塞已拍文件补传 |
| POST `/api/signals/context` | 语音/上下文线索，默认 dry-run；返回决策与当前状态，不生成餐食 |
| POST `/api/meals/:id/correction` | `{portionFraction:0..1,note?,expectedVersion?}` |
| POST `/api/meals/:id/confirm` | 旧 `{expectedVersion?}` 兼容；新 `{expectedVersion,portionFraction,note?}` 在单一事务更正并确认，比例为 0–1，版本必填 |
| POST `/api/meals/:id/analyze` | `{consentToUpload:true}`，逐次确认模型图片上传 |
| POST `/api/chat` | `{message,clientMessageId?,mealId?}`；消息与餐上下文共同参与幂等校验，选餐消息最多1000字 |
| POST `/api/posts/:id/reply` | `{message}`，保存该动态下的双方对话 |
| GET `/api/memories` | 用户明确分享的偏好事件 |

附近餐厅推荐已新增 `/api/dining/*` 后端接口，支持定位、主动生成单店卡、换店、导航链接、收起和提醒投递确认；完整请求/响应、幂等与失败行为见[餐厅推荐接口](dining-api.md)。`GET /api/state` 额外返回 `dining`，前端本轮尚未消费此字段。

## 个人资料

首页右上角头像与设置页均提供入口。`POST /api/profile` 接收 `nickname`（最多 30 字）、`gender`（undisclosed/female/male）、`age`（1–120 的整数或 null）、`heightCm`（50–250 或 null）、`weightKg`（10–500 或 null）、`goal`（balanced/weight-management/fitness/understand 或 null）、`dietaryNotes`（最多 500 字）。全部选填；数值空白保存为 null，不默认填写年龄、身高或体重。服务端记录 `updatedAt`，客户端不提交此字段。

这是完整替换接口；提交空对象清空所有选填字段。使用 App 授权，设备凭据不能访问。资料独立保存在本地 SQLite，不进入餐食模型请求，不自动生成热量目标，也不把忌口备注视为已实现的食物排除能力。演示资料只驻留前端内存，退出演示后丢弃。

## 设备照片元信息

以下为协议示例，不是实际设备记录：

```json
{
  "schema_version": 1,
  "capture_id": "sense01-boot01-000001",
  "device_id": "sense01",
  "boot_id": "boot01",
  "sequence": 1,
  "captured_at": null,
  "time_source": "unsynchronized",
  "uptime_ms": 4500,
  "mime_type": "image/jpeg",
  "width": 1280,
  "height": 1024,
  "session_id": "meal-session-01"
}
```

校时后 `time_source=server/ntp/phone`，`captured_at` 必须为真实 ISO 时间；未校时必须为 null，不能用设备启动时间假装墙上时钟。`receivedAt` 独立保留。

设备请求使用 `X-Device-Token`；App 请求使用独立 `X-App-Token` 或会话 cookie。设备凭据不能读取 App 状态和餐食图片。局域网模式强制配置两种凭据。

## 幂等和归组

相同 `capture_id`、相同设备和图片 SHA256 返回原记录；身份或内容冲突返回 409。成功回执含顶层 `capture_id`，固件收到准确回执后才移除待传项。

`device_id + session_id` 是明确的候选餐归组键。未提供 session 时，以同设备、30 分钟窗口、尚未确认记录做临时归组；这只是待确认候选，不证明语义上属于同一餐。手动上传默认各自形成记录。

手动分析选择首张原图；自动流程分析首张或唯一重试图，记录 `analysis.captureIds`，不把后续所有帧冒充已分析。用户可发起重新分析；新图不自动覆盖用户食量。校正使用 version 检测冲突，远程模型返回时保留期间的用户更正。

## 真实与估算

原图、模型整份估算、用户实际食量、计算出的摄入范围分别保留。没有模型或没有用户食量时，摄入范围为 null。食量更改总是从原整份估算重新计算，避免连续减半。

无模型配置时只用明确标示的本地基础规则对话。任何聊天及动态回复均不直接更正餐食。显式传 `mealId` 后，只为未确认餐生成 `mealProposal:{mealId,expectedVersion,portionFraction,note}`，随 assistant 消息持久保存；用户明确的整餐比例可成为数字建议，疑问、否定、假设和食物分项比例不猜，返回 `null` 待本人选择。原句只作为候选备注，不据此扣除单个食物的热量。消息历史按同一 `mealId` 或全局隔离；补充已有餐不启动新拍摄。

新确认请求携带比例和版本时，将补充与确认写在同一事务；版本不符返回409且不部分写入。重复相同确认返回原结果，已确认餐收到不同候选返回409，明确修改仍走 correction。UI 回读冲突后展示当前食量与备注，保留草稿，要求再次核对。

共享经历动态必须关联来源事件；虚拟生活动态标记 `virtual-life`，不声称是真实用户经历。目前小屋动态在 App 活跃访问时按每日上限生成，不属于操作系统级后台定时推送。

## 语音与上下文线索

`POST /api/signals/context` 的协议示例（合成句子，默认仅预览）：

```json
{
  "signalId": "example-utterance-001",
  "text": "我要去吃饭了",
  "speaker": "unknown",
  "sourceContext": "test-fixture",
  "observedAt": "2026-10-15T08:00:00Z",
  "recentUtterances": [],
  "audioEvents": [],
  "dryRun": true
}
```

`speaker=self/other/unknown`，`sourceContext=user-conversation/media/unknown/test-fixture`。实时端必须传采集实际时间；旧音频不能用处理时间冒充。近 120 秒、未来不超过 10 秒才评估执行。`audioEvents` 只收真实声音分类的 `{label,score}`，这些分数不是经过本领域校准的发生概率。SenseVoice 的事件标签没有分数，不能伪造为 1.0。

可选 `asrEvidence` 保留 `languageTag / emotionTag / eventTag / windowStartSec / windowEndSec / audioSha256 / speechVadVerified`。语音分支必须先做 VAD；静音 ASR 幻觉不能作为用餐事实。VAD不证明说话者身份，语音源默认unknown；用户开启自动拍照与识别后，不明确的用餐线索可以申请一张验证图。

手机额外保留 `captureId / captureStartedAt / frameOffset / frames / sampleRate / timeSource`。sampleRate固定16000，windowEndSec不得超出本片frames；提供采集锚点与帧偏移时，observedAt必须与`captureStartedAt + frameOffset/16000 + windowEndSec`相差不超过2ms。timeSource为`audio_timestamp_boottime / audio_record_start_estimate / synthetic_fixture`；synthetic_fixture即使sourceContext填unknown也不会触发真实相机。

Android本地推理可额外传 `localDecision`：固定模型 `decider-0.8b-q4`、已锁定GGUF的 `modelSha256`、`runtime=llama.cpp-android-cpu`、`temperature=1.03`、七选项的 `stage/probability/margin/distribution`、`wallMs`，及可选的 `promptVersion/promptTokens/domainCalibrated=false`。服务核对模型身份、完整分布和概率一致性；携带有效手机结果时不会再调用Mac上的JEV服务。明确的上下文规则仍优先，手机原始结果保存在 `localDecision` / `classification.modelAssessment`；运行来源是 `android-local`，模型输出不等于已进食。信号内容与手机结果共同参与幂等校验，重试须沿用相同内容。

`dryRun` 默认true，不持久化也不控制相机。false时按`signalId`幂等；同ID对应不同内容为409。返回动作是`ignore / defer / soft_reminder / capture_window / phone_capture / cancel`。明确规则优先，决策模型实际输出留在`classification.modelAssessment`，领域校准为false。可能用餐可以开一张`probe`，后续拍摄必须经视觉复核。

App对话被视为本人主动输入，只使用最近两分钟的上下文判断邀请后的接受。拍摄会话五分钟冷却，45秒、总共最多3张；接受邀请不会重置正在进行的会话预算。拒绝/吃完/用户暂停会关闭。

设备config包含`capture_mode=signals`和`capture_window={id,phase,session_id,expires_at,remaining}|null`。`phase=probe`最多1张；`followup`最多2张，实际剩余数还受总预算约束。每阶段独立id，稳定`session_id`用于同一候选餐归组。metadata增加`capture_window_id`和`capture_phase`，服务端检查阶段/身份/预算，重复capture_id仍先幂等ACK。

无有效窗口时设备`paused=true`；App的`device.paused=false`表示用户允许后续自动拍照与首图外发复核。固件按本地单调时间和已消费预算约束，断网、重复轮询和重启不得补满拍摄数。

首图保存与`reviewJobs`任务一并提交后立即回ACK，再异步请求视觉。无食物不生成餐记录；有食物才建立一个候选餐并下发补拍窗口；画面不清最多再试1张。任务在进程重启后可恢复一次，模型失败不延长拍摄窗口。未被实际分析过的补拍只作为原图视角保留。

`state.reminder`只在有效期内返回；`state.device.captureWindow`还必须有剩余预算。首图预算耗尽时window可以为null，独立的`device.captureReview.status=checking`继续表示复核中；其余状态有waiting_photo/waiting_retry/food_found/complete/no_food/uncertain/failed/cancelled。它们不证明用户已经吃过。

## 手机相机单张口令

0.4.1 将整句“Habi记录”（兼容“哈比记录”，忽略大小写、空格和标点）明确口令返回为 `phone_capture`，最多一张，跳过用餐 Decider 和五分钟用餐冷却，不创建 ESP32 采集窗口。仍检查媒体/测试/旁人/时效及暂停。否定、引用、未来表述不匹配；“拍照”“帮我拍一下”不再作为手机语音口令。

`POST /api/phone/captures` 必须携带普通相机 metadata，不可携带 ESP32 的 session/window/phase。服务端以设备和 capture_id 生成独立单张复核会话、先落盘 ACK，再异步 Step；食物出现才建候选餐，不下发补拍窗口。手动手机拍照属于逐次明确请求，即使被动采集暂停也会复核。上传重试沿用相同 ID 与图片，已有 ACK 不会重复推理。GET 返回 `{captureId, review, meal}`，`review.status` 以 complete/no_food/uncertain/failed 结束。

## 手机桥

规划对象为 `EchoDevice`，仅在可信 App origin 注入。方法：`getCapabilities`、`getStatus`、`setRearScene(json)`、`startRecording`、`stopRecording`、`takePhoto`；异步事件为 `echo-device-event`。方法存在、命令被接受、硬件实际执行与用户看见是不同阶段，以实际实现和回执为准。

背屏场景枚举：`idle / collecting / resting / watering / listening`。服务只传固定状态，不接收任意 shell、路径或系统服务名。
