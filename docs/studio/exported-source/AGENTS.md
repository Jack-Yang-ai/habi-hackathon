# AGENTS.md —— 本工程的开发约束（改动前必读）

> 本文件约束**在本工程里写代码 / 改配置 / 提交**的 Agent 与人。
> 产品与工程规范见 Skill：`app-creator-skill`（工程侧）、`capsule-native-api`（端能力）、
> `alipay_vibepay` connector 实际下载的 Builder Skill（支付接入）、`builder-app-packaging`（壳侧产物规格与打包流程，打包由平台执行）。

## 1. 先搞清楚两套界面、两个产物

`npm run build` 产出**互不依赖**的目录。Admin UI（管理后台）是**按需能力**——
空白脚手架生成的工程**不带**后台（没有 `admin.html` / `src/admin/` /
`vite.config.admin.ts`），需要时按 `app-creator-skill` 的「管理后台的增删」加入：

| 入口 | 界面 | 面向 | 构建产物 | 去向 |
| --- | --- | --- | --- | --- |
| `index.html` | App UI（移动端 H5） | 手机 App 内 | `dist/client/web/**` | 与 `capsule/` 一起构成壳侧 bundle，**打进 APK** |
| `admin.html`（按需） | Admin UI（PC 优先 + 响应式） | 运营 / 管理 | `dist/admin/**` | 整目录拷到静态服务器 |

- 工程含后台时，两个入口在**同一个 DevServer** 上：`http://127.0.0.1:5173/`（App UI）、
  `http://127.0.0.1:5173/admin.html`（Admin UI）。
- 两个产物**不得互相引用**（不共享 chunk、不互相 import、不写死对方路径），必须能各自单独部署。
  共享代码放 `src/shared/`，由两边各自打包一份。
- 不要为了"复用"把 Admin UI 的页面挂进 App UI 的路由，也不要给 Admin UI 加原生能力调用。

## 2. 每次改完代码，都要回头维护 `capsule/`

`capsule/` 是壳侧交付信息的**源码**（构建时由 `scripts/finalize-build.mjs` 复制进 `dist/client/`）。

| 什么时候 | 必须同步改什么 |
| --- | --- |
| 新增/删除任何原生能力调用（`capsule.invoke(...)`） | `capsule/manifest.json` 的 `permissions`（见 §3） |
| 应用名变化 | `capsule/manifest.json` 的 `name`；`src/shared/config/app.ts` 的 `APP_NAME` |
| 版本发布 | `capsule/manifest.json` 的 `version` 与 `versionCode`（`versionCode` **每次 +1**）；`src/shared/config/app.ts` 的 `APP_VERSION` |
| 新增页面目录 / 改首页位置 | `capsule/manifest.json` 的 `entry`（默认 `web/index.html`，指向 `dist/client/` 内的相对路径） |
| 改应用运行的屏幕方向（锁定竖屏 / 横屏 / 跟随） | `capsule/manifest.json` 的 `orientation`——**只改这一处**（应用运行方向的唯一来源，取值 `portrait` / `landscape` / `auto`＝已适配横竖屏、旋转不加补偿；门禁 G52 会校验，口径见 §14） |
| 新增 / 改「原子能力」（让语音助手 / 系统智能体在后台调用本 App 的功能） | `capsule/functions/contract.json` + `capsule/functions/handlers.js`，并在 `capsule/manifest.json` 的 `appFunctions` 声明（固定 `{"contract":"functions/contract.json","entry":"functions/handlers.js"}`）；`capsule/functions/` 会**整目录**复制进产物，只放这两个文件。写法与交付前自查见 `app-creator-skill` 的 [`app-functions` 领域库](../../../library/app-functions/SKILL.md)（门禁 **G56**） |
| 新增数据表 / 改表结构 | `supabase/migrations/` 下**新建**迁移文件（不改已执行的）；页面读写经 `src/shared/track.ts`（见 §9） |
| 换桌面图标 | `capsule/icon/ic_launcher_background.xml`、`ic_launcher_foreground.xml`（文件名不可改） |
| 换签名证书 | 用正式证书覆盖 `capsule/signing/capsule.p12` + `capsule.properties`，**不要**擅自换回调试证书 |

`npm run build` 会校验上述一致性（版本号不一致、`permissions` 含非法值、`entry` 指向的文件不存在都会直接构建失败）；
同时会拦下**非法注释**：`capsule/icon/*.xml` 与 `dist/client/web/*.html` 的注释里不得出现两个连续横杠 `--`
（写注释时别写 CSS 变量名 `--brand-600` 这类内容），否则 Android 打包会直接失败。

## 3. 危险能力必须写进 `permissions`，且只能写这 7 个

构建期合法值：`camera` / `flashlight` / `album` / `location` / `contact` / `bluetooth` / `record`。
写白名单以外的值会让 APK 构建失败。

**没声明的危险能力，APK 里就没有对应权限**：运行时系统直接静默拒绝（不弹框），H5 只会看到
`xxx:fail cancel`（走页内 Web API 的摄像头 / 麦克风则表现为 `getUserMedia` reject）。引导用户去系统设置也没用，只能重新打包。所以：

- 用了拍照 / 扫码 / 录像（`recordVideo`）→ 加 `camera`；手电筒 → `flashlight`；选图选视频 / 列出本机视频（`getVideoList`） / 保存相册 / **把本机媒体画到页面上（`resolveMediaUrl` 或图库类原子能力出图）** → `album`；
  定位 → `location`；`chooseContact` → `contact`；任何 BLE 接口 → `bluetooth`；
  录音（`recordAudio`）→ `record`。
- **页内摄像头（`getUserMedia` 实时预览 / 拍照 / 录像，不走 JSBridge）同样要加 `camera`**；
  页内录像**要带声音**时再加 `record` —— 没声明时容器不给 WebView 放行，`getUserMedia` 直接失败。
  选路与排查见 `capsule-native-api` 的页内摄像头分册。
- 能力的完整清单、参数、失败语义一律以 `capsule-native-api` Skill 为准，**不要凭记忆写接口名**。

## 4. 禁止线上 CDN 与外部静态资源

- 除 `/sdk/capsule.js`（壳提供的桥接 SDK，测试包主机 `appassets.t-stepos.com`，线上包 `appassets.stepaos.com`）外，
  页面里**不得**出现任何外部静态资源（`https://cdn...`、外部字体、外部图标库、外链图片）。
  这个 SDK **不要手写进源 `index.html`**（浏览器 / 平台预览没有它，会 404）：由构建期插件
  （`vite.config.ts` 的 `capsuleSdkInjectPlugin`）在构建 App UI 时注入产物 HTML，Admin UI 不带。
- 需要第三方资源时先下载到 `src/assets/`（或 `public/`）再从本地引用；依赖一律走 `package.json`。
- 需要图片素材（封面、配图、头像）时可从 Unsplash 检索来源，但必须下载到 `src/assets/` 再 `import`，禁止外链直引。
- 项目初始化时生成贴合名称与功能的 SVG 图标（favicon / logo）放进 `src/assets/`，不要用通用占位图形。
- 第三方业务 API 走 `capsule.invoke('request')`（壳代发、无 CORS、仅 https）：CSP 的 `connect-src` 虽放行任意 `https:`，
  但页面 `fetch` 仍受 WebView CORS 限制；平台内置后端的数据 / 云函数用 `src/shared/track.ts`（见 §9）。
- CSS / JS 一律用相对路径（构建时 `base: './'` 已保证），不要写 `/assets/...` 这类站点根路径（壳桥接 SDK `/sdk/capsule.js` 除外，见本节第 1 条）。
- **不要用 `window.location.origin` 拼后端 / 外部服务地址**：Admin UI 会被部署到任意静态 host，
  此时 `origin` 就是 CDN 域，请求会打到静态文件（TOS 返回 `NoSuchKey`）。平台后端地址由平台注入
  （`src/shared/track.ts`，其预览期"同源代理"是平台机制，别改）；后台支付管理 IDE 预览走同源 `/api/pay`、
  测试 / 生产构建读取平台注入的 `VITE_PAY_BASE`（见 §7）；自建 / 第三方后端等外部服务地址走
  显式构建期配置，**配置缺失要报错，不能回退同源**。

## 5. 样式与移动端适配

- 颜色只走语义 token：`src/shared/styles/tokens.css` 定义 → `tailwind.config.js` 挂载 → 组件用
  `bg-surface` / `text-muted-foreground` 这类类名。**禁止**在组件里写死色值或 `bg-[#fff]`。
- 新增颜色 / 圆角 / 阴影 / 字号必须先加 token（只有一套值）。
- **不做配色切换**：不得写 `dark:` 变体、不得用 `prefers-color-scheme` 接管配色、不得加切换开关
  （门禁 G10 会拦）；把颜色抽成 token 是为了以后改一处全局生效，不是为了做多套配色。
- **交付前必须换掉默认主色**：`src/shared/styles/tokens.css` 的 `--primary` 默认是骨架的靛蓝 600，
  它只是"能跑起来"的占位配色——按需求推导后替换（用户给的颜色 / 参照物优先；没有就先调研再定色彩角色与色相，
  口径见 `ui-design-skill` 的 `references/09-color-system.md`）。
  沿用默认色 = 没做配色（门禁 **G48** 会拦）；确需沿用（品牌本身就是这个蓝）时在注释里写明理由并加 `brand-kit: keep-default`。
- **整屏 / 视口高度用 `h-dvh` / `min-h-dvh` / `h-svh` / `lvh`（或模板 `h-screen-dvh` / `min-h-screen-dvh`），
  不要写 `100vh`**：模板已内置 svh / lvh / dvh 的**老内核兜底**——构建期 [`postcss.config.js`](./postcss.config.js)
  把任何 `NNdvh` 重写成 `calc(var(--1dvh) * NN)`，运行时 [`src/shared/native/viewport-units.ts`](./src/shared/native/viewport-units.ts)
  为老内核写 `--1dvh` 等。**任意倍数都行**（`h-[33dvh]` / `min-h-[50dvh]` 也会被兜底）；**只有行内样式
  `style={{ height:'33dvh' }}` 绕过不了**——高度一律用 class。口径见 `app-creator-skill` 的 `references/07-mobile-adaptation.md` §1。
- 最小点击区域、安全区、触摸反馈等约束见 `app-creator-skill` 的 `references/07-mobile-adaptation.md`：
  安全区（`--safe-top` / `--safe-bottom` / `--safe-left` / `--safe-right`）由
  [`src/shared/native/safe-area.ts`](./src/shared/native/safe-area.ts)
  统一写入（真机读壳、预览模拟值）。**普通页面顶部 / 底部要让出**：顶部默认垫成页面主体背景色
  （状态栏那一条不透出滚动内容）、底部由 `.page` / `.page-dense` 让出；**顶部是全出血媒体的页面**
  用 `useTopBleed()` 声明穿透（穿透与顶栏二选一；正文首块标 `data-top-bleed-content`，滚动后
  状态栏由框架自动渐变垫底，见 07 §2）。
- 界面观感（字号 / 间距 / 圆角 / 描边 / 密度 / 顶栏内容）按 `ui-design-skill` 的口径来：
  App UI 看它的 `references/02-app-ui-mobile-h5.md`（字号只用语义类、间距 ≤24px、描边 1px、
  卡片不做"圆角 + 描边 + 阴影"三件套），管理后台看 `references/03-admin-ui.md`。
  **顶栏只放“返回 + 标题 + 本页动作”**，全局偏好类入口不进顶栏；交付前跑一次
  `app-creator-skill` 的 `scripts/validate.mjs`（门禁 G42 会检查 App UI 的尺度红线、G44 会算颜色对比度、
  G45 会核对自定义档位是否登记给了 `cn()`、G46 会检查有没有留着用不到的页面）。
  加自定义字号（`tailwind.config.js` 的 `fontSize`）或发丝线时，**必须同步登记到 `src/shared/lib/cn.ts`**：
  没登记的话，tailwind-merge 会把它们当成颜色类合并掉 —— 实心彩色按钮上的文字会丢色（对比度掉到 3:1 以下）、
  徽标与表单提示的字号会回到 14px。

## 6. 原生能力在 dev 与真机下的差异

- **在线预览**（浏览器直接开 DevServer）：没有壳，SDK 不可达（dev 侧不注入桥接 SDK，这是设计如此），
  桥接层自动回落到 mock，DevServer 终端会打印 `[native] ...` 提示。这类提示**不是 bug**，是提醒你去真机验证。
- **真机预览**（App 壳指向 DevServer）：壳在页面加载时提供 `capsule`，原生能力走真实实现，**不会**有任何提示。
  真机预览里仍看到"浏览器预览"的提示 → 说明壳没提供 SDK（多半用的不是支持端能力的壳）。
- 生产构建里不存在任何 mock / 上报逻辑（`import.meta.env.DEV` 已静态剔除），**不要**为了
  "预览方便"给生产产物加兜底。

## 7. 要收费 / 加会员时：先发现并下载支付 Skill

先读取环境中的 `app-creator-skill/references/13-plugin-connector-integration.md`，按「支付能力发现与下载」查询、检查就绪并下载 VibePay Builder Skill。使用下载回执中的路径及版本；其他支付方案也通过该入口发现并下载对应 connector 的指引，不从内部 Skill 仓库加载支付实现。以下托管商品约定仅针对 VibePay。

- 商品配置、下单、权益与额度核销**按 `alipay_vibepay` connector 实际下载的 Builder Skill 接入**（托管下单 + 平台核销）。
  禁止手写支付弹窗、自己拼支付宝跳转链接、自己维护商品与权益的读写逻辑。
- **支付完成后返回 App 的深链**（`stepxvibe://open/<applicationId>?...`）也属于 `alipay_vibepay` connector 实际下载的 Builder Skill 的接入契约，
  不要在工程里另拼一套 scheme：`applicationId` 用 `src/shared/bridge` 的 `invokeNative('getAppBaseInfo')` 读取
  （`host.applicationId`），深链用回跳工具生成；IDE 预览没有真壳、端能力走 mock 兜底、唤起用 Toast 提示去真机调试，
  口径见 `alipay_vibepay` connector 实际下载的 Builder Skill 给出的回跳指引。
- 该 Skill 的 `assets/` 是**参考实现**：它只保证支付契约（调用顺序、幂等、状态机、失败语义）正确，
  不保证符合本工程的约定与视觉风格。落地时**有机移植，不要整段照抄**：
  - 组件放 `src/shared/ui/`、适配模块放 `src/shared/lib/`，不要另建目录；
  - 视觉对齐本工程已落地的页面与 §5 的语义 token，**不要保留参考实现里的色值字面值**（会过不了构建）；
  - 移动端形态按 §5 与 `app-creator-skill` 的 `references/07-mobile-adaptation.md` 收敛；
  - 新增依赖（如二维码渲染用的 `qrcode`）走 `package.json`，不许改用线上二维码服务。
- 后台「支付宝收款商品」的管理请求走**支付网关**（另一条链路，不是 Supabase）：**IDE 预览走同源相对路径
  `/api/pay`**（IDE 代理，不需要配置 host）；**测试 / 生产构建读取平台注入的 `VITE_PAY_BASE`**
  （完整支付 API 基址，保留网关路径前缀；缺失或无效时明确报错，不内置默认域名）。
  **不得用 `window.location.origin` 拼地址、构建产物也不要回退当前域名的 `/api/pay`**。
  接入见 `alipay_vibepay` connector 实际下载的 Builder Skill 给出的商品管理接入指引。

## 8. 提交前

```bash
npm run typecheck   # 类型门禁：tsc --noEmit
npm run build       # 构建：依赖自愈 + 两次构建（并行）+ 收尾校验 → dist/client/ 与 dist/admin/
```

> **两条都要跑，且 `npm run build` 通过不等于类型没问题。** 构建只产出产物、
> **不跑类型检查**——这是刻意拆开的：平台要求前端构建 ≤10s，类型检查占本步约 1/4 的
> CPU 却不产出任何产物，且平台上这一步近似只有一核可用（省下的 CPU ≈ 省下的墙钟）。

- `npm run build` 就是 [`scripts/build.mjs`](./scripts/build.mjs)：先 `ensure-deps`
  （依赖缺失自动重装），再**并行**两次 `vite build`（App UI / Admin UI），
  最后 `finalize-build`。两次构建互不依赖，并行是为了不让发布构建的时间白白串起来
  （逐项耗时见 `scripts/build.mjs` 头注释）。
- **只交付 APK 时用 `npm run build:client`**（= `build.mjs --client`）：只出 `dist/client/`，
  不跑 Admin 那次 `vite build`、也不动 `dist/admin/`。两个产物互不依赖，平台打 APK 只取
  `dist/client/`，Admin 是"发布静态站点"才需要的产物——省下的是一整个 vite 进程的固定成本
  （实测 CPU 约 −45%）。**判据是"这次交付要不要这个产物"，不是"工程有没有后台页面"。**
  另外它**不产出 `dist/admin/`**，所以不能拿它当交付门禁 G3 的构建（G3 要两个产物）。
- **只重建后台时用 `npm run build:admin`**（= `build.mjs --admin`）：只出 `dist/admin/`，
  不跑 App 那次 `vite build`、也不碰 `dist/client/`，并跳过 App 侧的 `capsule/` 校验与
  `dist/client/` 拼装。工程根没有后台三件套时它会**直接失败**（不是静默跳过）——它要的就是
  Admin 产物，跳过等于骗调用方。同样不能当 G3 的构建。`--client` 与 `--admin` 互斥。
- `npm run typecheck` 是独立脚本（`ensure-deps` + `tsc --noEmit`），也是交付门禁里的 G2；
  交付前它必须单独跑过（最省事的是直接跑 `node <app-creator-skill>/scripts/validate.mjs . --build`）。
- 任一步失败整个构建就失败（退出码非 0），日志每行带 `[vite:app]` /
  `[vite:admin]` 前缀，按前缀认领报错。
- 没有 admin 三件套时自动跳过 Admin 构建，**不需要**为此改 `package.json`。

- 不要提交 `node_modules/`、`dist/`、签名私钥（`.gitignore` 已覆盖）。
- 提交信息里写清：改了什么、为什么改、验证方式与结果、影响面（是否动了 `capsule/`、是否影响两个产物）。

## 9. 平台内置后端（数据库 / 云函数 / 认证 / 存储）

- 数据读写、云函数调用**统一走 `src/shared/track.ts`**（不要新建客户端、不要写死地址与密钥）；
  注册登录的会话管理走骨架预置的 `src/shared/auth/`（`useAuth()` / `<RequireAuth>`，不要直接调 `supabase.auth.*`）。
  **登录方式默认（也是唯一）手机号双模式**（密码登录 `signInWithPassword` + 验证码登录 `signInWithOtp` / `verifyOtp`）；
  `useAuth()` 的 `signInWithEmail` / `signUpWithEmail` 与 `track.ts` 的 `signUp` 是**邮箱**方法，属备用形态、排在成员表最后，别默认用它们
  （`backend_capabilities.auth_methods` 里没列手机号**不是**换邮箱的理由——手机号登录平台内置、预览与发布都可用）。
  昵称（用户显示名）读写走 `useAuth().updateNickname` / `user.user_metadata.nickname`——唯一存储位置是用户元数据，**不写业务表**（平台管理台只读用户元数据）。
  落地登录后把 `capability.json` 的 `appAuth`（App UI 登录）/ `adminAuth`（后台登录）置 `true`（见 §14）。
  **前后台登录态互相隔离**：两个入口的 `<meta name="ui-scope">`（`index.html`=app / `admin.html`=admin）与 `track.ts` 的 `auth.storageKey` 是骨架接好的隔离机制，不要删/改错（门禁 G53 会拦）。
  页面样板见 app-creator-skill 的 `assets/demo-pages/app/TodosPage.tsx`（参考区，按需拷进工程）。
- **平台绑定要求先看工作区根目录的 `.app-login`**：内容是 `zhiyue` 时，页面通过 `@zyql/auth-core` 建立登录会话，携带 cookie 在同源入口换成火山 JWT，交给 `track.ts` 的
  `accessToken` 钩子。壳不提供智跃身份；SDK 接线、SSO 回跳与同源入口需按登录指南核实。此时**入口不挂 `AuthProvider`、不用 `useAuth()`、不写手机号登录页**（`supabase-js` 配了 `accessToken` 后
  `supabase.auth.*` 会直接抛错），业务表也不要外键到 `auth.users`；`app_login_default` 或标记缺失时，平台不强制新增登录，按应用需求和已有实现决定是否及如何登录；需要接入上一段的认证方式时再做，已有应用保持当前登录和鉴权要求，用户明确要求调整时才改。
  落地方式见 app-creator-skill 的 `references/15-zhiyue-login.md`。
- 后台要做用户管理（管理员 / 用户列表 / 删用户）：数据模型与特权操作见 `platform-supabase` 的「管理员与用户管理」；
  权限由 RLS / 云函数在服务端校验，service role 密钥不可能出现在前端（工程门禁 G51 会拦）。
- **后台 Dev 免登、生产严格**：工程带后台时，Dev 模式（DevServer / 平台预览）后台**免登且当前用户是管理员**，
  生产构建**仍必须登录**（首个进后台的账号经 `claim_admin()` 自领为管理员——后台守卫读取到「还不是管理员」时
  自动调一次，不能只摆「没有权限」空态）。免登靠骨架预置的
  `src/shared/auth/devAutoLogin.ts`（自动登录 Dev 账号 + 调 `claim_admin()`，已在 `AuthProvider` 接线），
  整段逻辑由 `import.meta.env.DEV` 守卫、**生产产物不得残留**（工程门禁 G55 会拦）；只在后台入口（`ui-scope=admin`）生效，
  `?devlogin=0` 可关闭。免登自领管理员**幂等且可重试**（`claim_admin` 出错时下次进入再试，不永久放弃）；
  后台需要 `profiles` / `is_admin` / `claim_admin()`（迁移模板第 7 节）——**非模板工程自己写迁移时最容易漏这一段**。
  不要为了避免免登而放宽生产路径的登录 / 权限判定；
  口径见 `app-creator-skill` 的 `references/17-admin-dev-autologin.md`。
- 表结构与云函数是**代码**：改表在 `supabase/migrations/` 下新建迁移文件（不改已执行的）；
  服务端逻辑放 `supabase/functions/<函数名>/index.ts`。平台在**每轮对话结束时**自动执行 / 部署。
- 完整规则（迁移规范、云函数写法、RLS、调试与准入门禁）见 `platform-supabase` Skill——
  不要按公网通用 Supabase 的教程或 CLI 操作。

## 10. 只保留用户要的功能（素材是示例，不是需求）

本工程是从 AI Builder 平台的骨架 / 场景样板生成或组装出来的，**初始只有一页占位页**，
其余页面、导航项、示例数据全部是可选的“参考”，不是需求：

- **占位页必须替换**：`src/app/pages/HomePage.tsx` 与 `src/admin/pages/HomePage.tsx` 带 `@scaffold-placeholder` 标记，
  它们只是“能跑起来”的占位。交付前必须按需求换成真实页面（或删掉重写）——门禁 **G47** 会检查标记是否还在；
- 动手前先列一张「页面 / 功能 → 用户在需求里提到它的那句话」对照表；**对不上的一律不建**——
  页面文件、`src/app/App.tsx` 与 `src/admin/App.tsx` 的路由、导航入口、示例数据与 mock、相关图片资源都不要添加；
- **用户没提到的功能不做**：不要"顺手"加 Tab、入口、卡片、统计字段；也不为了填满一屏堆占位信息与假数据
  （信息架构与功能优先级的判断见 `ui-design-skill` 的 `references/06-information-architecture.md`）；
- 删完只剩一个"能跑的空壳"也要接受：空数据用空态组件（`src/shared/ui` 的 `EmptyState`）表达，不用示例内容撑场面；- 参考实现在 Skill 里，按需取用：`assets/demo-pages/`（单页参考：列表 / 详情 / 后台表格…）与
  `assets/scenario-samples/`（电商 / 小游戏场景增量）；**拷进去的必须按需求改造**，不要原样留用；- 示例数据的"真实感"只用于演示布局，交付前换成用户自己的数据或空态；测试 / 演示用的页面、开关、按钮不要留在产物里；
- **视觉不是照抄对象**：骨架 / 样板的配色、封面、插画与文案只是示例——机制（主循环 / 触控 / 样式体系）可以复用，
  外观必须按需求重新设计（口径见 `ui-design-skill` 的 `references/01-design-foundations.md` §12）；
- 交付门禁（`app-creator-skill` 的 `scripts/validate.mjs`）里，
  **G46 会检查 `src/**/pages/` 里有没有"留着但没接路由"的页面**——那是没做减法的直接证据。

## 11. 音乐素材生成（平台工具 `music_generate`）

需要 App 背景音乐、主题曲、角色歌曲、纪念/祝福歌曲，或做音乐类功能要 demo 素材时，
用 MCP 工具 `music_generate`（平台音乐模型，生成 1~3 分钟完整音乐）：

- `caption` 写清曲风/情绪/律动/人声（如「轻快的城市流行，女声，副歌有记忆点」）；
  `lyrics` 可用 `[Verse]`/`[Chorus]` 结构标签；留空自动写词。
- 翻唱/干声编曲传 `task: music_cover` / `vocal_to_music` + `referenceAudio`（工程内已有音频的相对路径）。
- 产物固定落 `src/assets/audio/`，工具返回相对路径，**按 §4 资源规则 `import` 引用，禁止外链**。
- **配额有限**（单用户每日约 20 首）：工具报「日配额已用尽/项目并发已满」时如实转告用户，
  不要重试烧配额；一次生成不满意，先改 caption/lyrics 再生成。
- **体积纪律**：产物为 mp3（每首数 MB）；整工程音频总量控制在 ~10MB 内，
  超预算时与用户确认取舍（音乐教学/多曲目场景尤其注意）。
- 生成中断或超时：工具错误里带 taskId，用 `music_status` 接续拿结果，不要重新提交。

轮次内需要纯背景氛围（无人声、非定制）时优先复用工程内已有音频或免费素材；
`music_generate` 留给用户明确要「生成音乐」的场景。

## 12. 沙箱回收后依赖会丢：先自愈，再排错

平台的沙箱容器可能随时被回收；项目重建后，之前 `npm install` 装好的 `node_modules/` 会整体丢失。
这时 `npm run dev` / `npm run build` / `npm run typecheck` 会报**模块解析错误**：
`Cannot find module '...'`、`Failed to resolve import "..."`、`Cannot find package 'vite'` 等。

- **先怀疑依赖、再怀疑代码**：这类报错十有八九是 `node_modules` 没了，不是代码写了 bug。
- `npm run dev` / `npm run build` / `npm run typecheck` / `npm run preview` 已**内置依赖自愈**
  （前置跑 [`scripts/ensure-deps.mjs`](./scripts/ensure-deps.mjs)：依赖缺失就自动 `npm install`，就绪则静默跳过），
  正常情况下直接重新执行原命令即可。
- 需要手动确认 / 重装时：

  ```bash
  npm run deps      # 检查并按需重装依赖（沙箱回收后重装属正常现象）
  ```

- 依赖已就绪后仍报同样的模块错误，才是真的代码 / 依赖声明问题（回查 `package.json` 与 import 路径、是否漏 `npm install <pkg>`）。

## 13. 预览读不到平台注入的配置：先怀疑注入，再怀疑代码

平台在预览 / 构建时把后端连接信息与 `VITE_PROJECT_ID` 注入进工程 `.env.local`；
**Vite 只在启动时读一次 env**，而预览进程的工作目录是工程的运行时副本，不会跟着工程目录更新。
页面因此显示「服务开通中」、`supabase` 为 `null`、后端数据恒空 —— **这是环境问题，不是代码 bug**
（不要为"预览方便"在业务代码里加配置兜底）。

- 取浏览器实际拿到的 env 与工程 `.env.local` 对照：
  `curl -s "http://127.0.0.1:5173/preview/$PROJECT_ID/src/shared/track.ts" | head -1`（端口以实际预览地址为准）；
- 自愈：把工程 `.env.local` 同步到预览进程实际读取的目录（`ls -l /proc/<pid>/cwd` 现查、先备份原文件），
  Vite 会自行重启读到新值；**绝不 kill / 重启预览服务、不占端口**；
- 完整定位三步（含凭据可用性验证）见 `app-creator-skill` 的 `references/12-runtime-config.md`。

## 14. 能力标识（`capability.json`）

工程根目录的 [`capability.json`](./capability.json) 用五个布尔字段声明**本工程实际实现了哪些能力**
（初始均为 `false`）：

| 字段 | 含义 |
| --- | --- |
| `admin` | 是否交付了可用的管理后台（`src/admin/` 的业务页面）。**骨架自带的空壳入口 / 占位页、仅为满足平台契约的最简页不算** |
| `supabase` | 是否接入了平台内置后端的**任何能力**（`supabase/` 里的表 / 云函数，或业务代码里的数据读写、登录、文件存储、向量库）。**平台按本声明决定是否为应用开通后端**——用到任何能力而不声明，发布时平台不会开通后端、线上功能会连不上 |
| `payment` | 是否接入了支付（接入支付必然交付后台支付管理页，故此时 `admin` 也应为 `true`） |
| `appAuth` | App UI（前端应用）是否落地了**用户登录**（用了 `useAuth()` / `<RequireAuth>` / 注册 `/auth` 路由等） |
| `adminAuth` | Admin UI（管理后台）是否落地了**用户登录**（后台登录还要求 `admin=true`） |

**应用运行方向不在这个文件里**：它是壳侧的事，只写一处——`capsule/manifest.json` 的 `orientation`
（`portrait` 锁竖屏、初始默认 / `landscape` 锁横屏 / `auto` 已适配横竖屏、不锁定不补偿；打包由壳在原生层按它锁定，
平台在线预览也按它限制横竖屏切换，**H5 不重锁应用基准方向；视频临时转屏用壳接口并自行恢复**）。**`capability.json` 里不要再写
`orientation`**（残留时门禁 G52 会把它列为「非约定字段」提示删除，不阻断交付）；横版玩法用「旋转舞台」塞进竖屏容器的按竖屏运行，保持 `portrait`。

**按真实意图做，并按实际实现如实维护**：

- 用户不需要管理后台 / 平台后端时**不要顺手做**：不新增后台业务页面 / 路由 / 导航、不新建 `supabase/` 目录、
  不写数据读写与登录代码（骨架预置的 `track.ts` / `src/shared/auth/` 在未接入时是惰性的，不用就不动它们）。
  管理后台是按需能力——不做后台时工程里**就没有** `admin.html` / `src/admin/` / `vite.config.admin.ts`
  （不留空壳、不留最简中性页）；要加 / 删后台按 `app-creator-skill` 的「管理后台的增删」操作。
- **每轮实现后就地更新对应字段**（做了后台 → `admin`；接了后端 → `supabase`；接了支付 → `payment`；
  App 做了登录 → `appAuth`；后台做了登录 → `adminAuth`；删掉对应功能 → 字段回 `false`）。
  **屏幕方向每轮一并核对**：应用开始（或不再）支持横屏 / 跟随设备 → 把 `capsule/manifest.json` 的 `orientation`
  相应更新为 `landscape` / `auto` / `portrait`（**只改这一处**，`capability.json` 不登记该字段）。
  注意：接入支付必然交付后台支付管理页，所以 `payment=true` 时 `admin` 也必须为 `true`；
  登录依赖平台内置后端认证，所以 `appAuth` / `adminAuth=true` 时 `supabase` 也必须为 `true`，
  且 `adminAuth=true` 时 `admin` 也必须为 `true`。
- 格式由 `app-creator-skill` 的门禁 **G52** 校验（文件存在、合法 JSON、五个字段为布尔值、
  `includes` 两个数组存在且元素必填字段完整；文件里若残留 `orientation` 会被列为「非约定字段」提示删除——它已收敛到 `capsule/manifest.json`）；
  它还核对**声明与实际自洽**：工程里已出现 `supabase/` 下的文件、支付接入、或入口 UI 里的登录会话
  却对应字段仍为 `false`，`payment=true` 而 `admin=false`，`adminAuth=true` 而 `admin=false`，
  `appAuth` / `adminAuth=true` 而 `supabase=false`，或 `admin=true` 而工程根缺少 `admin.html`，都会报红；
  `capsule/manifest.json` 的 `orientation` 必须是 `portrait` / `landscape` / `auto` 之一
  （应用运行方向的唯一来源，由 G52 与 `npm run build` 两道校验）。
- **应用方向由 `capsule/manifest.json` 的 `orientation` 驱动，工程里不要重锁整个 App**：打包产物由壳在原生层
  按该字段锁定，平台**在线预览也按该字段限制预览时的横竖屏切换**（平台前端负责）——所以页面层**不要**再做应用级
  方向锁定或整页旋转补偿；**视频页**可经壳 `setScreenOrientation` 临时原生转屏、退出须恢复基准方向；
  游戏旋转舞台只旋转玩法内容，`auto` 时不得叠加旋转。视频播放流程见安装的 App Creator Skill 的
  `references/16-video-playback.md`（本工程内不复制该规范）。
  `portrait` / `landscape` 只需各自那个视口排版正常，`auto` 要横竖两种视口都测通。
  改 `capsule/manifest.json` 的 `orientation` 后重新进入 / 刷新平台预览（或重启 dev）即可生效。

### 插件 / 连接器的接入登记（`includes`）

`capability.json` 还用 `includes` 记录**从平台接入的插件 / 连接器**（这是接入登记，不是能力布尔值）：

| 字段 | 含义 |
| --- | --- |
| `includes.plugins` | 接入的插件（Plugin），每条 `{plugin_id, name, version}` |
| `includes.connectors` | 接入的连接器（Connector），每条 `{connector_id, connector_name, version}`（`connector_id` 是标识 / 去重键，`connector_name` 是展示名） |

- 两个数组必须存在（可为空数组），元素必填字段必须完整；取值从对应的插件 / 连接器信息里取
  （插件读产物清单的 `name` / `version` 或 `download_plugin` 回执；连接器用 `list_connectors` /
  `download_connector` 回执的 `connector_id` / `name` / `version`），**不要猜版本、不要填假值**。
- **每一轮结束前都要核对**：本轮新增、移除、换版的插件 / 连接器都要同步 `includes`（**换版 = 更新对应行的 `version`，不新增行**）；声明了但工程里
  **实际没用到**的接入要**在会话里提醒用户及时清理**（冗余接入会拖累后续迭代与工程质量）。
  门禁 G52 只校验 `includes` 的结构与字段完整性，不做"是否用到"的判定。
- 移除连接器先在平台解绑；插件能力从工程里删掉后同步去掉登记行，并提醒用户清理平台侧依赖。
- 插件的暂存产物（`.project-plugin-*` 临时目录）怎么整合、连接器为什么不需要装配文件，
  见 `app-creator-skill` 的 `references/13-plugin-connector-integration.md`。
