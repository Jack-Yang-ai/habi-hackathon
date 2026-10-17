# Studio 连接器与 ESP32 拍照接入核对

核对时间：2026-10-15。对象为 Studio 项目 [小伴](https://studio.stepx.com/builder/app/p_fe2def065fda0280) 第二轮导出版本 `0e380d8`，以及当前主工程设备契约。此次只读检查，没有修改 Studio 项目、安装连接器、重新生成 demo、发布或安装 APK。

## 结论与范围

**已确认导出项目没有接入 ESP32 连接器，导出拍照代码没有实现 ESP32 的配对或拍摄控制。** 它包含手机媒体桥的类型和自建服务的 HTTP 适配器，可以参考传输封装，但不能当成现成的硬件协议。

**本轮未能重新读取在线连接器目录，不能据此认定 Studio 平台不存在相机或 ESP32 连接器。** 当前可确认的具体 ESP32 协议来自主工程固件、API 与 `docs/device/CONTRACTS.md`，不应标成 Studio 官方接口。

## 导出源码里实际有什么

| 项目 | 证据 | 能说明什么 |
| --- | --- | --- |
| 已登记连接器 | [`capability.json`](./exported-source/capability.json) 的 `includes.connectors=[]` | 此导出版本没有已集成连接器；不代表整个平台目录为空 |
| 危险权限 | [`capsule/manifest.json`](./exported-source/capsule/manifest.json) 的 `permissions=[]` | 此版本没有声明 camera、bluetooth 或 record，不能直接把原型当成已有设备权限的 APK |
| 连接器发现机制 | [`AGENTS.md` L319](./exported-source/AGENTS.md#L319) 提到 `list_connectors`、`download_connector` 与 connector_id/name/version | 只是脚手架给平台生成代理的说明；本机导出包没有这些工具、目录回执或某个 ESP32 连接器的调用参数 |
| 手机取图 | [`bridge/types.ts` L180](./exported-source/src/shared/bridge/types.ts#L180) 的 `chooseImage` | 参数为 count、sourceType（album/camera）、sizeType，返回 tempFilePaths/tempFiles；没有 ESP32 deviceId、相机地址或 BLE UUID 参数 |
| HTTPS 请求 | [`bridge/types.ts` L191](./exported-source/src/shared/bridge/types.ts#L191) 的 `request` | 通用壳侧网络能力，非某个硬件连接器；参数与返回见下节 |
| 照片上传 | [`companionApi.ts` L257](./exported-source/src/shared/api/companionApi.ts#L257) | `FormData(image, metadata)` → 自建 `POST /api/capture`；代码只上传已有 Blob，不触发相机 |
| BLE | [`README.md` L146](./exported-source/README.md#L146) | 生成说明列出一般 BLE 调用链，没有服务/特征 UUID、特征属性、命令帧、ACK 或配网协议，不能据此连板 |
| Webhook | 对导出源文件搜索 webhook/ESP32/配对/UUID | 没有发现 ESP32 Webhook 地址、注册入口或命令/回执约定；通用 HTTP request 不等于已有 Webhook 服务 |

### 可复用的传输封装

导出类型声明的通用请求形状为：

```ts
capsule.invoke('request', {
  url: 'https://your-service.example/path',
  method: 'POST',
  header: { 'Content-Type': 'application/json' },
  data: { /* 由具体服务定义 */ },
  timeout: 10000,
  dataType: 'json',
  responseType: 'json',
})
// { statusCode: number, data: unknown, header: Record<string, string> }
```

上例只解释导出源码中的类型，不是已执行的设备请求。其 HTTP 客户端会检查 `statusCode`，4xx/5xx 不能只按 invoke 成功就当业务成功。桥 SDK `/sdk/capsule.js` 由壳提供，导出包没有 SDK 实现；没有做真机 request 验收。

[`companionApi.ts` L188–212](./exported-source/src/shared/api/companionApi.ts#L188) 的 JSON 请求在 native 模式使用壳 request，multipart 则直接用 fetch。导出说明明确壳 request **仅支持 HTTPS**；因此它不能直接替代当前局域网 HTTP 客户端，也不能直接指向 `http://127.0.0.1`。multipart 的 fetch 仍受 WebView 的来源与网络策略约束，不能把“JSON 可代发”推广为“文件也可绕过 CORS”。

导出上传 metadata 只有 `capturedAt/deviceId/width/height/source`。当前主工程要求 `schema_version/capture_id/device_id/boot_id/sequence/captured_at/time_source/uptime_ms`，自动拍摄还要带阶段和候选会话字段。**旧 Studio 上传适配器与当前协议不兼容，不能不加适配地机械同步。**

### 不能当作设备成功的预览行为

[`bridge/loader.ts` L63–77](./exported-source/src/shared/bridge/loader.ts#L63) 在没有可用壳时回落 mock；[`bridge/index.ts` L122–130](./exported-source/src/shared/bridge/index.ts#L122) 在 mock 下的能力探测直接返回 true。`chooseImage` 的 mock 返回固定示例图（[`mock.ts` L500](./exported-source/src/shared/bridge/mock.ts#L500)）。因此预览中的拍照、canIUse=true 或显示了一张图都不能证明手机相机、ESP32 或 BLE 已可用。

## 当前主工程的实际设备协议

这些是本项目的接口，不是 Studio 连接器地址。规范以 [`docs/device/CONTRACTS.md`](../device/CONTRACTS.md)、[`contracts/app.ts`](../../contracts/app.ts)、API 和固件源码为准；此处给集成者索引，不另造一份协议。

| 方向 | 入口 | 数据/作用 |
| --- | --- | --- |
| 手机上下文 → 判定服务 | `POST /api/signals/context` | 上下文、时间与来源；判定结果可创建 probe 窗口，不直接证明用户吃过 |
| 板 → 服务 | `GET /api/device/config?device_id=...` | 拉取 paused、capture_mode、capture_window、间隔与上传开关 |
| 板 → 服务 | `POST /api/device/captures` | multipart image + JSON metadata；`X-Device-Token`；照片幂等 ID 与阶段身份随 SD 队列保留 |
| 板 → 服务 | `POST /api/device/status` | 相机、SD、暂停与队列状态，不能用软件模拟心跳冒充硬件已连接 |
| App → 服务 | `POST /api/device/pause` | 开启/暂停新采集；已经拍下的队列仍可补传 |
| App → 服务 | `GET /api/state` | 读 captureWindow/captureReview、候选餐与模型结果，供 UI 显示 |

窗口 payload 中的 `id/phase/session_id/expires_at/remaining` 必须完整对应：

1. `phase=probe`、remaining=1 时仅拍首张。
2. 上传保留 `session_id`、`capture_window_id`、`capture_phase`。首图到达后窗口可能为 null，等待服务端 Step 视觉复核。
3. 只有收到新 window id、同 session_id 的 followup 才补拍。服从服务端更小预算；正常补拍最多 2 张，模糊重试最多 1 张，全候选轮最多 3 张。
4. 无窗口、超时或预算为 0 时停止新采集；同 ID 轮询和重启不能补满预算。
5. 首图无食物则结束，不创建餐食；食量仍需用户确认。

### 目前怎样“配对”

目前固件通过本地 `secrets.h` 配置 Wi-Fi、API 可达地址和设备 token，示例见 [`secrets.example.h`](../../firmware/xiao-sense/include/secrets.example.h)。`device_id` 从板 MAC 生成，配置轮询和上传复用同一设备鉴权。

这是开发用静态联网配置，不是 Studio 提供的扫码、BLE、SoftAP 或用户账号绑定流程。板端 API 地址必须从板上可访问，不能用板子自己的 127.0.0.1。是否换成手机热点网关由手机服务工作线决定；此文档不把电脑地址冒充手机独立服务。

当前固件明确使用局域网 HTTP 原型，拒绝 HTTPS（[`firmware README`](../../firmware/xiao-sense/README.md)）；与 Studio 壳 request 仅 HTTPS 的约束不同。若以后真用 Studio 壳控制板，必须先确认官方连接器的局域网通道、设备发现、鉴权和上传能力，或做独立的原生桥，不能通过改 URL 字符串解决这个差异。

## 源码出口

已有真实下载归档 [`studio-source.tar.gz`](./studio-source.tar.gz)，SHA-256：`b15b5caa9efa872db506793436b8de64348f6d15e6d08dce981d3968dc389bb9`。这份导出已做过本地运行和构建验证，详情见 [`VALIDATION.md`](./VALIDATION.md)。

出口是本项目第二轮增加的**开发预览源码归档路由**，不是平台通用“导出连接器”功能：

- `/preview/<id>/__ai-builder/source-archive.tar.gz` 或 `/__ai-builder/source-archive.tar.gz`。
- 由 [`vite.config.ts` L93–137](./exported-source/vite.config.ts#L93) 的 serve-only middleware 生成。
- 页面入口为“变化”页底部“下载完整源码（.tar.gz）”，仅 DEV 显示（[`ChangesPage.tsx` L147–165](./exported-source/src/app/pages/ChangesPage.tsx#L147)）。
- 它导出工程文件，没有把平台 `capsule-native-api` Skill、连接器 SDK 或壳实现一并打包。

## 本轮在线核对结果与待补证据

本轮 web 工具打开 `https://studio.stepx.com/` 返回不可访问。CUA 既有 browser 2 不可用，`listBrowsers()` 为空；已读取官方浏览器排障说明，没有重登、获取账号 token 或探测未公开后台接口。两次针对 stepx.com 官方域名的 ESP32/相机连接器检索没有结果；搜索无结果不是平台无此能力的证明。

待在线会话恢复后，只需补查下面几个具体证据，无须先创建新 demo：

- 连接器准确名称、connector_id、版本，以及官方文档/下载入口。
- 是否支持该 XIAO ESP32-S3 Sense，而非仅能调用手机摄像头。
- 设备发现和配对方式，BLE UUID/命令帧，或局域网 HTTP/WebSocket/Webhook 的准确路径、消息与 ACK。
- 图片如何回传、是否支持后台服务、超时/重试、会话和预算字段能否透传。
- 依赖是否能导出运行；仅云端可调用和可本地运行应分别记录。

没有得到以上证据前，继续沿用已落地的本项目设备协议，Studio 的可复用范围限于已核对的源码封装与 UI。
