# Habi 附近餐厅推荐后端

单店轻卡的后端实现。只保存高德实际返回的餐厅，推荐依据是店铺名称/标签、距离、已知人均与用户显式设置；没有菜品营养数据时 `nutrition=null`。本轮没有修改前端、Android 定位桥或系统通知展示。

## 服务端配置

私有 `.env` 中设置：

```dotenv
AMAP_WEB_SERVICE_KEY=你的高德Web服务Key
AMAP_TIMEOUT_MS=8000
AMAP_SEARCH_KEYWORDS_MAX=1
```

使用「Web 服务」类型 Key。可以执行 `python3 tools/backend/configure-amap.py` 隐藏输入，工具只更新这一项，保留其他设置，文件权限设为 0600；不打印 Key、不启动服务。重启服务后生效。Key 不进入接口返回、卡片、导航 URL、SQLite、前端或模型请求，也不提供通过 HTTP 设置 Key 的接口。

官方接口：[周边与详情](https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch)、[步行路线](https://lbs.amap.com/api/webservice/guide/api/newroute)、[坐标转换](https://lbs.amap.com/api/webservice/guide/api/convert)、[导航 URI](https://lbs.amap.com/api/uri-api/guide/travel/route)。服务端使用固定 `https://restapi.amap.com`，不接受客户端传入上游地址。

## 接口清单

以下接口全部使用 App cookie 或 `X-App-Token`，设备凭据不能使用。默认 loopback 未配置 App 口令时沿用现有本地访问规则。错误格式为 `{error:{code,message}}`。

| 方法与路径 | 请求 / 返回 |
| --- | --- |
| GET `/api/dining` | 配置是否就绪、偏好、位置有效性、当前卡片、最近任务 |
| POST `/api/dining/preferences` | 局部更新推荐偏好，返回完整 dining 状态 |
| POST `/api/dining/location` | 上传带坐标系、精度和采集时间的位置；返回有效性摘要 |
| POST `/api/dining/location/clear` | `{}`，清除当前位置及推荐任务/卡片中保存的用户位置，撤回推荐 |
| POST `/api/dining/recommendations` | `{requestId}`，主动请求找店，202 返回查询任务 |
| GET `/api/dining/requests/:requestId` | `{job,card}`，轮询任务结果或恢复断线请求 |
| GET `/api/dining/recommendations/:id` | `{card}`，也可查看已收起/过期的卡片状态 |
| POST `/api/dining/recommendations/:id/swap` | `{requestId,expectedVersion}`，202 排队换一家 |
| POST `/api/dining/recommendations/:id/dismiss` | `{requestId,expectedVersion}`，这餐收起 |
| POST `/api/dining/recommendations/:id/select` | `{requestId,expectedVersion}`，选定这家，停止这餐主动推荐 |
| GET `/api/dining/recommendations/:id/navigation` | 步行导航主链接、H5 备用链接、目的地和已获得的路线数据 |
| GET `/api/dining/deliveries` | 待投递主动提醒，供未来客户端轮询 |
| POST `/api/dining/deliveries/:id/ack` | `{}`，幂等确认已消费提醒 |

`GET /api/state` 额外包含同一份 `dining`。共享类型见 `contracts/app.ts`；现有客户端可忽略这一新增字段。

## 联调顺序

1. 上传真实定位。以下经纬度只是公开区域的接口示例，不是用户当前位置；实际使用必须来自定位结果。

```json
{
  "longitude": 116.397,
  "latitude": 39.908,
  "coordinateSystem": "gcj02",
  "accuracyMeters": 20,
  "observedAt": "2026-10-15T11:40:00+08:00"
}
```

`coordinateSystem` 必填 `gcj02` 或 `wgs84`，不能猜坐标系。WGS84 在查询时调用高德 GPS 坐标转换；GCJ02 不再转换。经度在前、纬度在后。位置须在 5 分钟内、未来不超过 10 秒、精度不超过 200 米才能查询。较粗位置可保存，但状态为 inaccurate，不会触发地图请求。更旧的位置不能覆盖新位置，同一时间不同内容返回 409。

2. 按需启用主动推荐。只更新提供的字段；不影响相机暂停设置。

```json
{
  "proactiveEnabled": true,
  "mealTimeEnabled": true,
  "style": "lighter",
  "radiusMeters": 1500,
  "maxCostYuan": 60,
  "excludedKeywords": ["烧烤", "花生"],
  "mealTimes": { "lunch": "11:20", "dinner": "17:20" }
}
```

默认两项主动开关均 false，半径 1500 米，人均上限 null，无排除词。style 可选 balanced/lighter/plant-forward，是召回偏好，不是营养认证。排除词按店名、类型与标签直接匹配，**不解析用户个人资料中的自由文本忌口，不证明食材、过敏原或交叉接触安全**。设置人均上限后，只保留返回了人均且不超过上限的店。

午餐时间允许 10:00–14:59，晚餐时间允许 15:00–22:59。时间均为 Asia/Shanghai。仅启用 `proactiveEnabled` 时响应明确本人用餐准备；同时启用 `mealTimeEnabled` 后，后端每分钟检查饭点，在设置时间起 90 分钟内尝试一次。无有效位置或未配置 Key 时不查、不占用饭点机会。

3. 手动找店：POST `/api/dining/recommendations` 提交 `{ "requestId": "客户端生成的唯一ID" }`。首次返回 202：

```json
{
  "job": {
    "id": "diningjob_...",
    "requestId": "客户端生成的唯一ID",
    "type": "recommend",
    "source": "explicit_request",
    "status": "queued"
  },
  "card": null,
  "duplicate": false
}
```

任务的完整字段以类型定义为准。轮询 GET `/api/dining/requests/:requestId`，直到 `succeeded / failed / skipped / cancelled`。成功时得到一张 `kind=restaurant_recommendation,layout=single` 卡片；card 中包含一个餐厅、推荐依据、点餐建议、未核实项、版本号、过期时间与可用动作。失败时读取 `job.error.code/message`，不生成示例店兜底。

4. 换店：提交新的 requestId 和当前 card.version，202 后按同一方式查任务。保持 card.id，成功后 version 加一，不重复本卡已经展示过的 POI，不延长原卡有效期。暂时查不到其他店时保留原卡。`swapAvailable=false` 时直接隐藏或禁用换店入口。

5. 导航：GET navigation，使用返回的 `url`（尝试调起高德）或 `fallbackUrl`（H5）。两者仅含导航参数，不含 Key。先 POST select 可记录用户选定，停止这餐后续推荐；选定后仍可导航。这里只生成合法 URI，实际调起需客户端承接；Android WebView 后续需处理外部跳转。

6. 用户关闭：POST dismiss，成功后从当前卡片中移除，并撤回未投递提醒；保留历史与幂等回执。

## 主动推荐与投递

`POST /api/signals/context` 和无 mealId 的 `/api/chat` 已接入餐厅判断。明确本人、user-conversation、近 120 秒的「准备去吃饭」且开启 proactiveEnabled 才自动找店；陌生说话人、媒体、测试素材、VAD 未通过、未来或引用内容不会主动推荐。仅有未校准模型分类不触发推荐。

明确请求「帮我推荐附近餐厅」「午饭吃什么」视为主动找店，可不启用自动推荐；该类请求不新开拍摄窗口。澄清已有一餐的 mealId 对话继续沿用原流程。明确说正在吃、吃完、拒绝或已选定后撤回推荐及待查询任务；已确认摄入/视觉确认食物也会抑制当前餐次推荐。没有记录不被解释为没有吃饭。

自动推荐成功后生成一条持久化 outbox 提醒。GET deliveries 只返回当前有效的 pending 项；实际展示成功后 ACK，丢失 ACK 可以重试。客户端应按 delivery.id 去重，展示前重新读取 card，确认 status、expiresAt 与最新版本。换店更新原卡，不新发一条主动提醒。手动找店只生成卡片，不生成系统提醒。

这实现了服务端饭点任务、推荐生成和可消费提醒；尚不包含 APNs、FCM、Android NotificationManager 或前端监听，不能仅凭后端队列成功宣称手机已经弹通知。后端只使用手机上报的位置，不用 IP 推测当前位置，也不主动开启定位。

## 生命周期与失败行为

- 默认每个北京时间餐次最多一次主动尝试（10–15 点算午餐，15–23 点算晚餐，5–10 点早餐，其余夜间）。手动找店也占用该餐次后续自动提醒机会；客户端显式手动请求可重新找店。收起/选择会阻止本餐自动推荐。
- 卡片最多 30 分钟有效；位置超过 5 分钟、移动超过 500 米、坐标系变化、精度不足、偏好变化、开吃或退出推荐时提前失效。客户端继续展示期间需要更新定位。换店不续期。
- requestId 对推荐/换店必须稳定重试；同 ID 不同操作/卡片/版本为 409。收起/选择也需要唯一 requestId，旧版本不覆盖新版本。ACK 自身幂等。
- 查询是持久化任务，自提交起两分钟内有效。服务重启可恢复，运行中异常中断最多恢复一次。正常关闭会将进行中的任务留待重启；时效/位置/开关仍重新检查。新请求、用户收起或清除位置会取消旧任务，旧网络结果不能复活卡片。
- 为控制费用，默认只搜一个关键词；`AMAP_SEARCH_KEYWORDS_MAX` 可设置 1–3，显式扩大召回。多词分别查询并去重，换店复用这一批候选而不重新周边搜索。营业信息只有可明确解析的当日时段才判定 within_hours/outside_hours；未知不写“营业中”。超过营业时段的店排除。
- 路线失败仍可给餐厅与导航链接，但 walking.status=unavailable，耗时/路程为 null；直线距离始终单独标注，不能当步行距离。详情请求失败可保留本次周边搜索信息并提示，部分搜索失败也明确记录。
- 空结果、预算或排除条件过滤完为 skipped；高德权限、额度、超时为 failed，错误只给安全摘要。没有伪造餐厅、评分、照片、热量或步行时间。任务和卡片不改动餐食摄入数据。

## 验证

离线合成接口测试：

```sh
node --test services/api/test/dining.test.mjs
npm run verify
```

配置真实 Key 后，可以在独立临时数据库里验证真实查询与导航返回；下面为公开区域测试坐标，需显式 `--live`，会使用高德额度，不写真实业务库。默认最多 3 次高德请求，超限不会发送，不自动重试；默认不做真实换店。确需验证换店时单独提供 `--swap --max-requests 5`，换店失败也不会突破总上限。

```sh
node --env-file=.env tools/backend/check-amap.mjs --live --longitude 116.397 --latitude 39.908 --coordsys gcj02
```

这验证接口可调用与结果链路，不证明餐厅实际营业、菜品健康程度或手机已完成导航跳转。

2026-10-15 最小真实验证：使用公开示例坐标 116.473168,39.993015，总计 3 次高德请求（单词周边搜索、详情、步行路线各一次），得到「七加三轻食健身餐」，路线数据有效，后端导航接口 HTTP 200。没有真实调用换店，没有测试手机跳转；没有追加重试。测试数据库在结束后清理，未写业务库。摘要保存在本机忽略提交的 `output/validation/amap-live-minimal.json`；真实 Key 仅在私有 `.env`。
