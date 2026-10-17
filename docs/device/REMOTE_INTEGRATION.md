# 线上域名联调（habi.zhexin.site）

2026-10-17 起，联调的目标不再是本机 `127.0.0.1:8787`，而是 Mac mini 上部署的线上后端 **https://habi.zhexin.site**（Cloudflare 前置，启用 App 鉴权与设备鉴权）。本机 8787 仍用于无鉴权的快速回归，但“手机能用”的结论必须以域名这一侧为准。

## 先跑一键检查

```sh
node --env-file-if-exists=.env tools/backend/check-remote.mjs \
  --base https://habi.zhexin.site \
  --app-token "$APP_ACCESS_TOKEN" --device-token "$DEVICE_ACCESS_TOKEN" \
  [--photo] [--expect-bundle index-wZ3wwjE_.js]
```

- `APP_ACCESS_TOKEN` / `DEVICE_ACCESS_TOKEN` 取 Mac mini 部署目录 `.env` 里的两份口令（`configure.py` 生成）。只在环境变量或命令行里用，不写进代码、不提交、不贴进文档；脚本也从不打印它们。
- 也可以在本机 `.env`（Git 忽略）写 `HABI_REMOTE_BASE_URL` / `HABI_REMOTE_APP_TOKEN` / `HABI_REMOTE_DEVICE_TOKEN`，命令后半段全省略。
- `--photo`：用 `tools/backend/fixtures/no-food.png` 走一遍**真实的手机拍照上传→Step 复核→查询结果**路由，随后用正常的撤回接口删掉这张合成照片（`--keep-photo` 可保留）。默认不带 `--photo` 时只读。
- `--expect-bundle`：断言线上页面加载的前端包名。它必须是 **Mac mini 实际运行的那次提交**构建出的包，而不是本机未提交工作区的包。截至 2026-10-17，已推送的最新提交 `f904dab` 的构建是 `index-wZ3wwjE_.js`；如果本机还有未提交的前端改动，`apps/studio/dist` 的包名会不同，此时不加 `--expect-bundle` 只会得到 `warn`（“这正是未推送的改动”）。
- 报告写到 `output/validation/remote-check.json`（Git 忽略）；任何 `fail` 都会让退出码为 1。

脚本检查六项：

| 检查 | 通过条件 | 失败意味着什么 |
| --- | --- | --- |
| `health` | `GET /health` 200 | 部署或隧道挂了 |
| `deployment-bundle` | 线上 `/assets/index-*.js` 与本机构建一致（给 `--expect-bundle` 时硬性） | Mac mini 跑的是旧代码 |
| `app-session` | `POST /api/session` 200 且返回 `de_session` | 连接口令不对，或服务重启后会话失效 |
| `app-state` | `GET /api/state` 200，且 `config.analysisConfigured` 为真 | 口令不对；或线上没有配 `STEPFUN_API_KEY`，照片能传但永远不会识别 |
| `device-auth` | 带板子 token 的 `POST /api/device/captures` 得到 400（空上传被拒，鉴权已通过） | 服务端 `DEVICE_ACCESS_TOKEN` 与板子不一致 → 随身相机 401 |
| `photo-review`（可选） | 合成图上传 201、复核终态 `no_food`、撤回 200 | 上传/鉴权/模型链路有问题 |

`device-auth` 故意不发 `GET /api/device/config`：那个路由会写一条设备记录，让 App 把一台并不存在的“随身相机”显示成已连接，污染页面状态。

## 2026-10-17 首次检查结果（两处线上问题）

```
health            pass   200
deployment-bundle fail   线上 index-a4WV5-iw.js = 本仓库 05c3485（10-16 21:56）构建
                        本机 10-17 构建为 index-C1YhDFSZ.js
device-auth       fail   板子 token 被 401
```

1. **线上是 10/16 的旧版本。** 线上前端包与 `05c3485` 的构建逐字节同名（用 `git archive` 各提交重跑 `vite build` 对照得出），说明 Mac mini 还没同步 10/17 的提交；其中 `50d487e` 修的正是 ESP32 上传元信息的兼容问题。修复方式：Mac mini 上 `git pull` 后重新构建前端、重启服务，再跑本脚本确认 `deployment-bundle` 变绿。
2. **设备 token 不一致。** 板子固件里的 token 来自本机 `.tools/esp32/device-token`，手机中继会把它原样转发；Mac mini 的 `.env` 里 `DEVICE_ACCESS_TOKEN` 是另一份随机值，所以 `/api/device/*` 全部 401，随身相机的照片（经手机中继到域名）根本到不了后端。修复方式：把 Mac mini `.env` 的 `DEVICE_ACCESS_TOKEN` 改成与 `.tools/esp32/device-token` 相同的值（或反过来重新给板子烧同一份 token，见[ESP32接板联调](./ESP32_BRINGUP.md)），重启服务后重跑检查。

## App 页面来自 APK，不来自线上部署

`MainActivity` 会拦截受信 origin 的 `/`、`/assets/*`、`/fonts/*`、`/habi/*`，直接返回 APK 里打包的 `assets/studio/*`。因此：

- **改前端后只同步 Mac mini 不够**：手机上的页面代码还是旧 APK 里那份，必须 `python3 tools/device/build-android.py --install` 重装 APK 才生效；Mac mini 的前端只影响浏览器访问。
- 反过来，线上后端更新后手机不用重装 APK（API 向后兼容期内）；域名只作为 API 目标。
- 核对 APK 是否带新前端：`unzip -l app-debug.apk | grep studio/assets` 与 `apps/studio/dist/assets` 对照。

## 明文 HTTP 来源没有 `crypto.randomUUID`

App 的服务地址若填成 `http://<Mac mini 局域网 IP>:8787`（[Mac mini 后端](./MAC_MINI_BACKEND.md) 里的局域网用法），页面就不是安全上下文，`crypto.randomUUID` 不存在：手动选图/拍照上传与聊天发送都会直接抛 `crypto.randomUUID is not a function`，页面看起来“能连上但什么都不能用”。`apps/studio/src/uuid.ts` 已改为优先 `randomUUID`、缺失时用 `getRandomValues` 组 v4 UUID（两条路径都有 `services/api/test/uuid.test.mjs` 覆盖）。产品联调仍优先用 HTTPS 域名；局域网 HTTP 只作直连调试。

## 边界

- 合成无食物图只能证明链路通、返回格式合法，**不能代表真实餐食的识别准确率、份量或热量**。
- `--photo` 会短暂写一条合成 capture 到线上库并立即撤回；不带该参数时脚本不写业务数据。
- 手机相机原图只到后端（域名），Step 密钥只在 Mac mini；这份文档不包含任何 token。
