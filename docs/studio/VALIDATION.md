# 前端验证记录

日期：2026-10-15；浏览器：Codex In-app Browser；手机视口：390 × 844，另核对桌面 1280 × 720。测试完恢复浏览器默认视口。

## 正常模式，真实本地接口

使用 `PORT=8788 DATA_DIR=output/validation/ui-data node services/api/src/server.mjs`。所有下列写操作在隔离目录完成。图片 `output/validation/ui-test-fixture.png` 内明确写有 `UI TEST FIXTURE - NOT A REAL MEAL`，不是用户餐食或模型识别结果。

| 验证步骤 | 实际结果 |
| --- | --- |
| 打开正常模式饮食页 | 已收好 0 餐、已确认 0 餐，无虚构热量 |
| 页面选择 PNG 图片 | 照片成功送到 `/api/capture` 并打开待确认卡片 |
| 未选择食量 | “保存补充”“确认这一餐”均禁用，未默认整份 |
| 选“吃了一半”、填测试备注、保存 | 服务保存 `portionFraction=0.5` 与备注 |
| 再确认一餐 | 状态变 `confirmed`，产生一条共同经历动态 |
| 回复该动态 | 独立回复流显示用户消息和明确标记的本地规则回复 |
| 全局对话 | 本地规则回复清楚标注；没有伪装成自由对话模型 |
| 暂停自动拍照期间聊天 | 临时 `listening` 场景仍显示“正听你说话”，不被暂停状态强制覆盖 |
| 读回后端状态 | 1 条测试餐食，食量 0.5，模型热量与按食量热量均 `null`，动态回复 2 条 |
| 核查用户服务 8787 | 餐食仍为 0 条，没有写入测试夹具 |

证据：`output/validation/ui-state-after.json`；截图 `output/playwright/mobile-meal-confirmation.jpg`、`mobile-post-reply.jpg`。

## 演示模式隔离

显式进入 `/?demo=1` 后持续显示“演示模式 · 使用示例，不写入真实记录”。已走通“模拟照片到达 → 选一半 → 确认 → 小伴收照片 → 带依据的新动态”，全程显示“热量尚未估算”。变化页只显示本次确认计数与空趋势说明。退出恢复正常模式，未产生额外数据库餐食。

证据：`output/playwright/mobile-demo-meal.jpg`、`mobile-demo-dynamic.jpg`。

## 构建与视觉

`npm run build --workspace apps/studio` 通过 TypeScript 检查与 Vite 生产构建。正常模式首页与设备设置均在实际页面核对；手机单栏、桌面背屏预览正常，测试结束恢复默认浏览器视口。说明文字、输入提示与按钮已加深，主按钮白字/底色对比约 5.58:1。

最新干净用户首页：`output/playwright/mobile-home.jpg`、`desktop-home.jpg`。这些图展示正常空状态，不使用测试餐食作为产品实景。

## 未验证的能力

首轮前端验证时没有配置真实图片理解模型，因此该轮没有验证卡路里识别准确性。后续真实模型连接与结果由后端工作线单独验证；本文件中的界面夹具不作为模型证据。浏览器点阵是设计预览；真实背屏和录音的验收由设备工作线另行提供。Studio 源码导出、本机运行、类型检查和 client bundle 构建均已单独核验，见下节。


## Step Studio 导出源码核验

第二轮版本 `0e380d8` 的源码已从真实预览下载链接取得，原件 `docs/studio/studio-source.tar.gz`；归档 144 KB、101 个条目，解压后 77 个文件。SHA-256 为 `b15b5caa9efa872db506793436b8de64348f6d15e6d08dce981d3968dc389bb9`。没有环境变量文件、签名私钥，通用凭据模式扫描无命中。

`npm ci --ignore-scripts --workspaces=false`、`npm run typecheck` 通过，`npm run dev -- --port 5175 --host 127.0.0.1` 的真实页面已在浏览器打开。Vite 编译通过；`build:client` 起初因导出包排除签名 properties、系统 keytool 不可用而在收尾失败。随后仅在验证副本中补充一次性 debug properties，使用本工程 `.tools/jdk/jdk-17.0.20.1+1/Contents/Home/bin/keytool`，`build:client` 全部通过。生成的 keystore/properties、node_modules 和 dist 均由 `.gitignore` 排除，原 tar 未改。

证据：`output/playwright/studio-source-download.jpg`、`studio-local-source.jpg`。该 Studio 工程未接主工程的真实 API，也未接模型；它与 `apps/studio` 主前端分别交付。没有安装 Studio APK，也没有更换用户已有签名。验证用 5173、5175 与 8788 服务在结束后停止；保留用户的 8787 服务。

聊天失败处理已修改为仅在成功后清除相同草稿，正在编辑的新草稿不会被清掉；全局聊天在收到成功之前保留 clientMessageId 供幂等重试。离线时发送按钮会禁用，已输入的草稿仍保留。本轮未制造“请求已发出、回执丢失”的网络故障，不把该情况写成实测通过。


## 用餐线索与拍摄窗口 UI 整合（同日追加）

使用新隔离目录 `output/validation/signals-ui-data`、8788 端口，显式清空模型 key 与 JEV_URL 配置。输入仅为标记“UI 界面验证”的合成上下文，不是用户语音或真实餐食。未启动/停止生产 8787，未操作 ADB；对 8787 仅查看首页和截图。

- 真实 `/api/signals/context` 的邀请线索产生 `soft_reminder`，主屏显示“线索还需确认 · 尚未开启拍摄窗口”；设置显示“有一句轻提醒”。提醒按真实 expiresAt 自动消失，未把它记作一餐。
- 明确本人用餐线索产生 45 秒、最多 3 张的 `capture_window`。相机未连接时显示“等待相机连接”，IP 表达“正在留意”，没有宣称已收照片。
- 从窗口卡点击“暂停自动拍照”，真实 `/api/device/pause` 返回 paused=true，窗口和提醒均为 null。最终只有 2 条验证信号，meals=0，没有照片或饮食估算。
- TypeScript + Vite 生产构建通过（主 JS 约 281.6 KB、CSS 约 40.7 KB）。CUA 浏览器不可用时，已按排障文档确认无可用浏览器，改用官方 Playwright CLI 的独立 signals-ui 会话；核对 390×844 手机页面与 1280×720 正常首页，未触碰其他会话。

截图 `output/playwright/signals-soft-reminder.png`、`signals-capture-window.png`、`signals-device-status.png` 是隔离接口验证；不是用户真实用餐。生产正常首页已更新 `mobile-home.jpg`、`desktop-home.jpg`。

接口读回证据：`output/validation/signals-reminder-state.json`、`signals-window-state.json`、`signals-paused-state.json`。隔离服务与独立 Playwright 会话验证结束后关闭，生产服务保留。

## 首图复核与补充视角（同日追加）

使用隔离目录 `output/validation/probe-ui-data`、8788 端口与 `probe-ui` Playwright CLI 会话。验证服务显式使用空环境、受控异步视觉夹具，不读取用户密钥、不调用外部模型。输入为标记“UI 界面验证”的合成句；图片仍为 `UI TEST FIXTURE - NOT A REAL MEAL`。8787 未接受测试写入，也未由前端工作线启动或停止。

| 核对内容 | 实际结果 |
| --- | --- |
| 正常上下文接口开启首张窗口 | `phase=probe`、`remaining=1`、`captureReview.status=waiting_photo`；页面显示仅先取 1 张 |
| 经设备照片接口上传夹具 | 返回 HTTP 201；`captureReview.status=checking`，`captureWindow=null`，页面仍显示首图复核中 |
| 受控无食物结果返回 | `no_food`、窗口为 null、餐食数始终 0；不生成虚构餐食或热量 |
| 补充视角渲染夹具 | 明确标记 render-only 的 `food_found` 状态，无实际模型结论、无餐食；页面显示最多再补 2 张、本轮最多 3 张 |
| 模糊重试渲染夹具 | `waiting_retry` 与 `phase=followup` 同时存在时，优先显示“最多重试 1 张”，不声称发现食物 |
| 点击卡片暂停 | 真实暂停接口返回 `paused=true`、窗口 null、复核 cancelled；页面收起拍摄卡 |
| 自动识别开关 | 可访问性角色为 switch；开关说明明确触发首图送 Step 视觉，实际食量仍需确认，无新增同意弹窗 |

截图：`probe-waiting-first.png`、`probe-reviewing.png`、`probe-followup-fixture.png`、`probe-retry-fixture.png`、`probe-automatic-setting.png`，均在 `output/playwright/`。带 fixture 名称的图只验证渲染分支，不是真实识别结果。截图中设备连接来自隔离接口状态，不作为硬件能力证据。

JSON 读回证据在 `output/validation/probe-*-state.json` 与 `probe-*-render-fixture.json`。主前端 TypeScript 与 Vite 生产构建通过。隔离服务与 Playwright 会话完成后关闭，用户 8787 服务保持原状态。

## 本地录音与感知状态页（同日追加）

TypeScript + Vite 构建通过（主 JS 约 289.5 KB）。隔离 Node bridge 断言验证无桥时返回 null、getStatus 覆盖旧 capabilities 录音状态、8 个 phase 标签，以及 accepted 回执不会把 recording=false 改成 true；仅调用假桥函数，没有使用真实录音设备。

独立 Playwright `native-ui` 会话用临时注入的合成 bridge 检查 390×844 设备页。截图 `output/playwright/native-pipeline-ui-fixture.png` 顶部明确写“UI 测试夹具 · 非手机实机状态”，展示计数、最近合成句、动作和停止入口，不作为手机推理证据。即使该测试桥存在，`?demo=1` 仍不显示原生感知面板、最近句或录音控制。浏览器控制台无错误。

本轮没有点击真实录音开始/停止、没有改变生产采集开关、没有写入真实餐食或启动/停止生产服务。验证会话结束后关闭；设备真机推理与长时稳定性由原生工作线另行验收。

## BitePal 参考 UI 与个人资料（2026-10-15）

主前端新增原创 SVG 花园小伴、今日餐食概览、悬浮导航、浅蓝餐食详情、记录环图及个人资料表单；未改动 Studio 导出源码与归档。

- `npm run verify` 通过：43 项测试、服务端语法检查与 TypeScript/Vite 生产构建。
- Playwright 独立 `bitepal-ui` 会话核对 320/390/430 宽度的伙伴、饮食、变化页和资料表单，以及 1280 桌面布局；DOM 与滚动容器均无横向溢出。最终正常页面未出现运行时错误。
- 演示模式走通模拟照片、选择一半、保存补充、确认、首页更新 1 餐/已确认 1 餐；热量保持未估算。未向真实餐食库写入示例。
- 8788 隔离服务、`output/validation/bitepal-profile-data` 验证昵称、性别、年龄、身高、体重、目标和忌口保存；刷新后原值回显，6.5 秒轮询期间输入草稿不被覆盖。API 测试另覆盖重开服务后持久化、清空、无效输入不覆盖，以及设备凭据不能访问资料。
- 首页统计使用仅浏览器可见的合成状态验证：北京时间当天 3 餐、已确认 2 餐、仅 1 餐有估算时显示 300–400 kcal 与 1/2 覆盖；待确认餐和前一天餐食不累计。样本不是实际营养结果，检查后移除拦截并恢复空状态。
- 8787 仅只读核对与截图；本轮未填写真实个人档案、未新增餐食、未启停采集或调用模型。为加载资料接口重启一次本地 API，原 SQLite 与配置保留；核对仍为 0 餐、资料为空、自动采集暂停、模型配置可用。
- 首页右上角头像与设置页资料卡均可打开表单。字段全部选填，不生成卡路里目标，资料不进入现有模型请求。

正常页面最终截图：`output/playwright/bitepal-home-final.png`、`bitepal-desktop-final.png`、`bitepal-profile-final.png`、`bitepal-profile-bottom-final.png`。资料填写样本仅在隔离服务；原页面截图 `bitepal-before.png` 与改动前源码 `output/validation/bitepal-ui-before/` 保留。构建日志见 `output/validation/bitepal-verify.log`。

## Habi 整体视觉、无叠压布局与真机调试（同日追加）

已与设计 Agent 评审伙伴、饮食、变化、资料、设置、对话、餐食详情及背屏预览。正式 UI 直接集成到 `apps/studio` 和 Android 宿主，不是独立效果稿。名称为 Habi，主形象使用用户提供的透明正面 PNG 原文件；暖白底、深棕正文、橙色操作，炭黑仅用于角色舞台。旧 SVG 角色和悬浮叠卡不再用于当前主前端。

- 当前仓库 `npm run verify` 通过：50 项服务测试、服务语法检查、TypeScript/Vite 构建。头像内框修正后生产构建再次通过。Android `:app:assembleDebug` 通过；原始 PNG 未裁切、重绘或用生成版本替代。
- Playwright 独立 `habi-final` 会话验证 320/390/430 手机宽度、1280 桌面宽度。各 Tab 无横向溢出，滚动内容 bottom 与 TabBar top 相接，角色卡与今日卡间距均为 16px。去掉旧页面位移动画，Tab 切换即时恢复滚动位置。
- 8788 使用独立 `output/validation/habi-ui-data` 和空模型环境验证资料保存、刷新回显、取消后草稿保留、返回原设置页及焦点恢复。390×844 和 390×520 下，表单正文 bottom=底栏 top，底栏不超过可见高度。
- 未发送的对话草稿关闭后仍保留；按全局对话和动态分别暂存。演示餐食需明确选食量，取消重开保留本次食量/备注，确认后首页为 1 餐；未产生虚构热量。页面无运行时错误。
- PZ261A / Android 16 真机安装成功。实际安装 APK 与本机 SHA256 一致，回执 `output/validation/habi-phone-deployment.json`；APK 中 `assets/habi.json` 与唯一帧源一致。测试只操作本项目界面，没有通过 UI 测试开启麦克风、拍摄或调用模型。
- 真机实际 WebView 宽度 369 CSS px，可见高度 741.54px；卡片间距 16.00px，内容 bottom=导航 top=667.54px，导航 bottom=741.54px，三个 Habi 头像的图片均处于各自内框内。
- 真机昵称键盘弹出后可见高度 481.23px，正文 bottom=底栏 top=404.31px，保存按钮完整可见；聊天输入键盘同样不遮底栏，发送热区 44×44px。系统返回先收键盘、再关弹层；设置→个人资料→返回仍回设置。原生设备连接入口从 Web 设置可打开，正常页面不再重复原生开发顶栏。
- 背屏唯一帧源 `contracts/rear-display/habi.json`：6 状态、21 帧。网页、Android 公共 Display 与文档导出的一致性检查通过；双白竖眼、外轮廓暗边距、MSB 位顺序及动画时长均核对。实际手机只暴露主屏，`vendor_permission_granted=false`、`native_rendering=false`，没有把预览宣称为物理背屏上屏。

浏览器报告：`output/validation/habi-ui-results.log`；真机报告：`habi-phone-ui-results.json`；构建日志：`habi-verify-final.log`、`habi-android-build-final.log`。最终手机截图 `output/playwright/habi-phone-home-final.png`、`habi-phone-profile-keyboard.png`、`habi-phone-chat-keyboard-final.png`、`habi-phone-rear-final.png`；浏览器逐页截图以 `habi-*-final.png` 保存。真机 screencap 仅证明前屏；本轮未更改厂商背屏常显、亮度、保护门控或其他应用的图案。iOS 真机尚未验收。


## 撤回一餐记录（2026-10-16 追加）

用户在看过消息撤回后明确：只要是用户主动发的食物，随时都应该可以撤回 —— 并在追问中选择了「那一餐记录本身」，即删除餐食与照片。

- 接口 `POST /api/meals/:id/recall`：不设时间限制；事务内删除该餐、它的 capture 行、确认时生成的 `meal-confirmed-<id>` 动态、以及 `mealProposal.mealId` 指向它的 Habi 消息；把仍引用它的 capture session 的 `mealId` 置空；写入不含内容的 `meal.recalled` 事件（来源、是否已确认、食量、照片数、提案数）。照片文件在事务提交后再删，且 unlink 失败不影响记录已删除这一事实。重复撤回返回 404「这一餐已经不在记录里了」。用户自己打的字不删。
- 两条新测试（共 87 项，全部通过）：撤回已确认的一餐会同时清掉 meals / captures / 动态 / 提案消息，**磁盘上的照片文件确实不存在了**（`readFile` 断言 ENOENT），并且跨天（+24h）依然可撤；撤回其中一餐后另一餐仍在、用户说过的话仍在、提案消失。
- 前端：两个入口。餐食详情页底部一行「撤回这一餐」（44px 热区）；分析页「这一天的餐食」每行右侧一个小垃圾桶按钮（44×56，`aria-label` 形如「撤回燕麦酸奶、香蕉」）。两处都原地展开确认，文案明确会删掉记录与照片且恢复不了，两个按钮各 46px，「撤回」用暖红 `#e0603f`。/li> 改为 flex 容器 + 独立打开按钮，避免按钮嵌套按钮的非法结构。演示模式同样支持（本地移除）。
- 分析页实测（演示数据，390×844）：2 行的日期有 2 个删除入口；点第一行 → 原地确认（文案含餐名）→「保留」后行还在 → 再点 → 「撤回」后该行消失（2→1），日期热量环随之为「未估算」（剩下那餐没有食量），Toast 提示撤回完成；无控制台错误、对比度与热区复扫 0 处问题。
- 浏览器实测（隔离实例 8788 + 独立数据目录）：上传 → 选「一半」→ 确认（得到「已确认的一餐 晚餐 · 吃了一半」）→ 打开详情 → 撤回 → 界面回到空状态、Toast 提示；直接读 `/api/state` 为 `meals: 0`、`messages: 0`；`media/` 目录**已空**（原始照片文件被删）；数据库里仅剩仓库自带的 `little-room-<date>` 动态，`meal-confirmed-*` 已不存在；事件表最新一条为 `meal.recalled`。对比度、热区、横向溢出复扫 0 处问题。
- 过程中修掉一个真实缺陷：撤回路由第一次实现时用 `store.get('captureSessions', store.settings().lastCaptureSessionId)`，在从未发生过拍摄会话的库上 `lastCaptureSessionId` 为 undefined，better-sqlite3 无法绑定并抛 500。已改为先判空。同时给全局错误处理加了一个只在 `HABI_DEBUG_ERRORS=1` 时打印真实堆栈的开关，否则 500 只有一句「服务暂时出错」。
- **8787 需要重启才生效**：本轮发现线上 8787 仍是上一会话启动的旧进程（Node 不热重载），前端已更新而接口还是旧的，这是「撤回点了没用」的真正原因。已用仓库文档里的同一条命令重启两次（`.env` 与 `.data/companion.sqlite` 均保持原样，用户那条真实记录仍在）。重启后两条撤回路由都已在 8787 上实测可达。

## 撤回自己刚说的话（2026-10-16 追加）

用户要求支持撤回，并在两种含义里明确选择了「撤回刚发出的消息（2 分钟内）」，不做「撤回一餐的确认」。

- 接口 `POST /api/chat/messages/:id/recall`：只接受 `role=user` 的消息；按**服务端时钟**判断是否在两分钟内；事务删除该消息与 `replyToId` 指向它的回复；写入 `chat.recalled` 事件，其中只保留消息 ID、是否关联一餐、回复条数与存活时长，不保留原话。为了让回复可以被准确配对，`/api/chat` 现在会在 Habi 的回复上记录 `replyToId`。
- 三条新测试（共 85 项，全部通过）：两分钟内撤回同时移除消息与回复、重复撤回 404、超过两分钟 409 且消息仍在；撤回不会改写餐食（`portionFraction` 仍为 null、`confirmedAt` 仍为 null、`version` 不变）；带 `mealProposal` 的消息被撤回后提案消失但那一餐完全没变；对 `role=assistant` 的消息撤回返回 400。
- 前端：只有你自己的消息、且按服务端时间估算仍在窗口内时，气泡下方出现一个 44px 高的「撤回」（`Undo2` 图标 + 文字），点击后直接撤回并提示「已撤回，这句话和 Habi 的回复都不在对话里了。」没有用长按这类隐藏手势。
- 浏览器实测（隔离实例 8788 + 独立数据目录）：发送「今天中午吃了牛肉面」→ 出现 1 个撤回入口 → 点击后 UI 只剩 0 条消息，直接读 `/api/state` 确认服务端 `messages.length = 0`。窗口边界用一次真实 125 秒等待验证：刚发出时 1 个入口，两分钟后入口自动消失、消息仍在。演示模式同步支持（演示数据里放了一条 45 秒前的消息和一个关联回复，便于直接试）。
- 撤回后对话会变短，时间线仍贴住最新一条；若提案被撤回，托盘里那份预选消失，但已经写下的东西不会被悄悄改回去。8787 真实库仍为 0 餐、0 条消息。

## 首页原位表达与卡片重构（2026-10-15 追加）

完成设计、交互、产品三轮交叉评审，另引入独立 Apple Design Award 视角终审。设计终审通过统一性、层次与克制；独立终审解除当轮的三项 UI 阻断，评为「有辨识度的完整交互原型」。**“已具 Apple Design Award 获奖竞争力”未通过**：当前证据不能替代实际使用、完整真机无障碍及 Apple 平台版本验证，不作获奖认证。评审参照 Apple 2026 官方介绍的交互、创新、愉悦感、包容性和视觉主题：https://developer.apple.com/design/awards/ 。

本轮实际变化：同一角色 DOM 从首页压缩到固定顶栏；同一餐食的照片和时间贯穿手动补充、紧凑提案和确认收据；明确比例表达不再重复展示整张表单，调整才展开。首页其余餐食直达紧凑待补充队列；技术回执折入设备诊断，未连接的日常对话能力在输入前明确。保留原图，详情不裁切原始照片。

- 8789 使用独立 `output/validation/presence-ui-data`，仅上传显式标注 `UI TEST FIXTURE - NOT A REAL MEAL` 的 PNG；未配置模型，不将测试图或估算写入真实 8787。
- 真实接口验证：聊天只生成持久候选，不写食量；刷新可回读提案；人工修改后收起重进保留草稿；多餐普通对话不猜归属；过期版本展示现有食量与备注，明确复核后原子确认；返回同餐收据。
- 502 故障注入后输入保留，重试沿用同一个 clientMessageId；数据库仅有一条对应用户消息。错误夹具只针对隔离页面的请求。
- 320 / 390 / 430 / 1280 宽度验证无横向溢出，正文、表达区和导航互不重叠；390×520 资料页底栏完整可见。页面无运行时异常。
- 两倍文字测试对每个实际文字元素读取 computed fontSize 后设为两倍，不是只改 html 根字号。390×844 确认按钮可滚动到达、未被表达区覆盖，确认后出现收据；没有据此声称 TalkBack 或系统 Dynamic Type 已验证。
- 实际 8787 服务加载新版协议，读回真实餐食仍为0。Android 开发包构建与安装成功；手机处于锁屏，已请求用户解锁，本轮不把安装成功或黑屏截图算作真机键盘与返回验收通过。

自动化证据：`output/validation/presence-ui-results.log`、`presence-accessibility-results.log`、`presence-desktop-results.log`；构建测试：`presence-verify-final.log`（80 项测试通过与生产构建通过）、`presence-build-last.log`（最终小热区修正后再构建通过）、`presence-android-final.log`。逐页图以 `output/playwright/presence-*-final.png` 保存。黑屏的手机排查截图不是交付界面证据。

## 对话即首页、暖深色与独立分析页（2026-10-16 追加）

按用户确认的方向落地：暖深色、保留独立分析页、补碳水/蛋白质/脂肪与每日热量参考、本轮不做 3D。前端重写为「对话即首页」，`styles.css / habi.css / presence.css` 合并为 `theme.css`，`Presence.tsx` 撤销。

- `npm run verify` 通过：82 项服务测试、8 个服务端文件语法检查、TypeScript `tsc -b` 与 Vite 生产构建。日志 `output/validation/habi5-verify.log`。
- 本轮新增的服务端能力有独立测试：整份宏量营养素解析（合法 / 不合法 / 无食物三种情况）、`calorieTarget` 的 800–6000 整数边界与空档案回填、以及「只按用户确认食量换算」的 `consumedMacros`（整份 30/81/21 的一半 = 15/41/11）。旧档案与旧餐食回读为 null，不推断补值。
- 这个工作区没有 Playwright，也没有可用的浏览器下载；改用 `tools/shot.py`（websocket-client + Chrome DevTools Protocol，`--no-sandbox`）做真实浏览器核对，`tools/checks/audit.js` 在每个状态下逐元素读取计算样式与几何：文本对比度按 WCAG 阈值（小字 4.5、大字 3.0）逐节点计算并回溯合成背景，热区按 38px 下限扫描，另查文档与滚动容器的横向溢出。
- 390×844：`data-habi-app` 根节点无横向溢出，对话流滚动容器无横向溢出，输入框上沿 763px / 对话流下沿 754px 不重叠，Habi 头像实际 44×44 且表情帧为 `/habi/habi-open.webp`。320×640 与 1280×900 同样零溢出；桌面档应用宽 560px 居中、圆角 30px。
- 逐状态核对：对话首页（演示）、补量托盘、餐食详情、分析日视图、分析近 7 天、个人资料、设置、以及 8787 真实空状态的首页和分析页。修掉三处真实缺陷后，全部状态**对比度 0 处不达标、热区 0 处偏小**：`#6f6558` 一类灰字在小字号下只有 3.17:1；`.m-carbs/.m-protein/.m-fat` 把背景色画到了整行 `li` 上（导致整行铺色且文字对比度掉到 1:1），改为只给色点和数字上色；个人资料的数字输入与「清除 / 用推算值」按钮热区只有 22–32px，已提到 44px。
- 行为核对：待确认卡点「吃了多少？」打开托盘，选「一半」后预览从占位文案变为 `约 310–390 kcal`，`aria-checked` 只在「一半」为 true；确认后该卡原地收成一行，托盘关闭。托盘打开时全页只有一个 `[data-habi-collapse]`（托盘关闭按钮），所以 Android 宿主返回键先收托盘，再回对话页；分析页返回箭头、＋ 菜单同样带这个标记。
- 分析页真实数字（演示数据）：日视图热量环 420 kcal、区间 380–460、`1/2 餐有估算 · 参考值按资料推算`，营养素 碳水62g/64%、蛋白质14g/15%、脂肪9g/21%；近 7 天 7 根柱、4 张卡、观察两条且各自带依据（`10/14 夜宵、10/15 夜宵` / 未吃完的 3 餐）。演示档案 31 岁 163cm 78kg 管理体重 → 推算 1600 kcal，与页面显示一致。
- 8787 真实状态仍为 0 餐、空档案，本轮未写入任何真实餐食、未上传照片、未调用模型、未启停采集。空状态照实呈现：`今天还没有记录`、`这天还没有记录`、`营养素…会显示`、`记录再多几餐，Habi 才能说出有依据的发现`，`.day-nav` 在今天就禁用后退。
- Habi 表情帧由 `tools/habi-avatar.py` 从用户提供的原图派生：只对两眼白色区域做行内插值补色，再绘制睁/闭/左看/右看/上看/开心六帧（`public/habi/habi-*.webp`，合计约 545 KB）。原图 `character-front.png` 未改动，SHA-256 仍为 `a3ddef95a23e2b701292600e7b2a2d8d08542c21146265cc840ec62fafdf0046`（git 无改动）。
- 字体是本地自带的 Manrope 可变字重（`public/fonts/manrope-latin-wght.woff2`，24 KB，SIL OFL，许可随文件保存），页面无远程字体请求；中文仍走系统字体。这一点仍需在真机按系统字体缩放复看。
- Android 宿主：状态栏/导航栏/根视图与 WebView 顶部同步改为 `#16120F` 并关闭浅色状态栏图标；连接判定的选择器从已删除的 `.app-header` 改为稳定的 `[data-habi-app]`。`:app:assembleDebug` 通过（仅两处既有 deprecation 警告），`--install` 成功，`adb reverse tcp:8787` 已建立，手机读回 APK 哈希 `d2c16d1a04fcbb8ffec75422c0ef39035b72ef563196099623b1861ab33cc1de` 与本机产物一致。
- **真机界面本轮未取得视觉证据**：安装时手机处于息屏 / Dozing，通知栏为前台窗口，`screencap` 全黑。可确认的是 MainActivity 仍是 `ResumedActivity`、WebView 沙箱进程在运行、logcat 无 JS 报错；但“深色主题在真机上好看、键盘与返回流程通过”不能据此宣称，需用户解锁后补一次。上一轮的键盘、返回与 44px 热区结论属于旧布局，不沿用到本轮。

截图：`output/playwright/habi5-{home,tray,meal,insights-day,insights-week,profile,settings,empty,desktop}-final.png`。本轮截图由 CDP 直接产出，未经过 Playwright 会话。

### 用户反馈后的修正（同日追加）

用户在真机上看过之后提了三条：底部至少要有两个 Tab；拍照入口应该是一个 ＋ 点开列表选择「打开相机 / 上传照片」；点了「打开相机」要能真的打开相机。另有一次是我造成的故障，一并记录。

- 底部两个 Tab「对话 / 分析」落地，分析入口从顶栏移到底栏。两个页面各自保留滚动位置，对话仍默认贴底（390×844 实测：首页 1015 → 用户上滑到 200 → 切分析 → 切回仍是 200；分析页自己的位置 210 也保留）。真机截图 `output/playwright/habi6-phone-home.png`、`habi6-phone-insights.png`。
- 拍照入口合并为一个 ＋，点开是带图标与说明的列表（打开相机 / 上传照片），有半透明遮罩，点遮罩、按 Esc、选中任一项都会收起；打开时 ＋ 旋转 45°，并带 `data-habi-collapse`，所以真机返回键先收菜单。
- 「打开相机」原来是宿主里的 Camera2 静默单张：没有取景预览，拍到的内容全凭运气，而且 `PhoneCameraController` 在拍完上传后还会继续占着 `busy` 锁等待最长 90 秒的服务端复核，期间再点只会弹「上一张照片还在处理，请稍候」——这就是真机上「打不开相机」的原因。现在：＋ →「打开相机」用 `MediaStore.ACTION_IMAGE_CAPTURE` 加可写 MediaStore 目标唤起系统相机应用（这台 PZ261A 上是 `com.stepos.media.camera`，已用 `cmd package query-activities` 确认存在处理器），有预览、拍完把 URI 交回页面走原有上传流程；取消拍照会删掉那条空 MediaStore 记录。同时把复核轮询移到独立线程并在照片上传落盘后立即释放 `busy`，所以连拍不再被上一次的复核锁住。语音唤醒与宿主自带的静默拍照路径不变。
- 首日空状态从「一大片空白」改成居中的 Habi（104px）+ 问候 + 引导 + 指向 ＋ 的提示；热量环在没有任何估算时不再画那个 0% 的圆头小点。
- **我造成并已修复的一次故障**：为了在隔离实例上验证真机拍照，我用 `run-as` 把手机的 `app_url` 改成 `http://127.0.0.1:8788`，却没有先建 `adb reverse tcp:8788`，导致手机端页面加载失败、只剩原生「网页无法打开」。已把 `app_url` 与 `backend_url` 都写回 `http://127.0.0.1:8787` 并重启 App，真机恢复（`habi6-phone-restored.png`）。此后再做类似验证必须先建反向端口。
- 真机复核：宿主状态栏与页面同色；空状态、＋ 菜单在 1200×2670 真机上排版正确。

### 拍照回来的闪退：定位与修复（同日追加）

用户真机拍照后闪退，崩溃缓冲给出了确定原因：

```
FATAL EXCEPTION: main  Process: com.withecho.companion.dev
java.lang.RuntimeException: Failure delivering result ResultInfo{who=null, request=22, result=-1, data=null}
Caused by: java.lang.IllegalStateException: showFileChooser result was already called
    at WV.cd2.onReceiveValue(chromium-SystemWebView.apk)
    at com.withecho.companion.MainActivity.onActivityResult(MainActivity.kt:192)
```

同一回调被投递两次：`onShowFileChooser` 的 capture 分支里先调了一次 `onReceiveValue(null)`，相机回来后 `onActivityResult(22)` 又拿同一个回调调了第二次。WebView 的 file-chooser 回调只能投递一次，第二次抛异常并杀掉 Activity。两次崩溃（16:15 result=0 取消、16:20 result=-1 拍照成功）都是这一处。

修复：capture 分支不再提前投递，回调挂起直到相机 Activity 回答；所有投递统一走 `ValueCallback.deliver()`，内部 try/catch 掉 `IllegalStateException`，`fileCallback` 在投递前先取出并置空，杜绝重复投递（`onDestroy` 也走同一条安全路径）。

真机验证（`adb logcat -c` 后重测）：＋ →「打开相机」后前台窗口为 `com.stepos.media.camera/com.stepos.media.camera.simplify.CameraSimplifyActivity`，即确实打开了带取景的系统相机；按返回取消后回到 Habi，**崩溃计数 0**，8787 仍为 0 餐，新产生的 MediaStore 空行被清除。相机应用在这台设备上的输出实测为 3072×4096 / 2.23 MB，低于页面 8 MB 上限。

遗留事实：用户 16:20 那次拍摄的原始 JPEG 仍留在相册 `Pictures/Habi/habi-20261016-162032.jpg`（2.23 MB），因为崩在回调之前，它没有变成任何一餐，也没有上传。**拍完回来之后的上传与建卡这一段仍未在真机上走通**——取消路径已验证不崩，成功路径的交回、上传、托盘自动打开待用户实拍一次确认。

### 隔离实例上的真实接口回归（同日追加）

8787 仍为 0 餐、空档案，未被写入。写操作全部在 `PORT=8788 DATA_DIR=output/validation/habi5-ui-data` 的隔离实例完成，输入图片为既有 `output/validation/ui-test-fixture.png`（图内写明 `UI TEST FIXTURE - NOT A REAL MEAL`），该实例未配置模型，因此全程不产生热量或营养素数字。

- 上传一张照片后：出现 1 张待确认卡，只有 1 张卡（同一餐不再长出第二张），卡片进入 active 状态，输入框上方托盘自动打开，标题「这餐吃了多少？」，四档食量可选，未选食量时确认按钮 disabled。这是刻意的：用户刚选完照片，下一步就是补充食量。
- 选「一半」并确认：卡片原地收成一行「已确认的一餐 · 加餐 · 吃了一半」，托盘关闭；今日条显示「今天 1 餐 · 还没有估算」——没有模型时不编造热量。
- 分析页如实呈现：热量环「未估算」、`0/1 餐有估算`、餐食行「吃了一半 / 未估算」、营养素卡显示空状态文案，并给出去资料里设置参考值的入口。详情页显示「热量尚未估算」、食量选中「一半」、备注区显示真实未分析原因；未配置模型时给出「模型尚未配置，照片和你的补充仍会保存」，不出现同意上传勾选框。
- 聊天提案回归：绑定待确认餐后输入「一半，汤没喝」，服务端规则回复「先按你说的放在待确认的补充里。确认后，这餐的记录才会更新。」；托盘标题变为「Habi 听到的是」、四档里只选中「一半」、原句作为备注保留、确认按钮可用。点确认后直接读 `/api/state`：`portionFraction: 0.5`、`note: "一半，汤没喝"`、`confirmed: true`、`version: 2`。聊天本身没有改餐，只有这一步显式确认才落库。
- 确认过的餐再说比例不会产生新提案：因为绑定只针对待确认餐，回复是通用的本地规则句子，不会去改已确认记录。
- 多餐待补充：演示里再拍一张后，两张待确认卡共存，托盘底部出现「还有 1 餐等你补充」（44px 热区），点击后托盘切到另一餐（`data-meal-id` 随之变化）。
- 这一轮暴露的一个环境事实写下来供后续复现：headless Chrome 读取 `~/Documents` 下的夹具文件会被系统 TCC 拦掉，表现成上传时的网络错误；把夹具复制到 `/tmp` 后同一路径即通过。这不是应用缺陷。

## 撤回规则收敛为一条：发言不可撤回（2026-10-16 追加）

用户在试用手感后明确：只有拍照产生的记录可以无时间限制撤回，**发言不能被撤回**。这取代了上一节的「撤回自己刚说的话（2 分钟内）」——那一版只在前 2 分钟渲染按钮，用户实际使用时看不到任何入口，因为聊天记录几乎总是超过两分钟，而且按钮是直接消失、不留痕迹。

- 服务端删除 `POST /api/chat/messages/:id/recall` 整条路由与 `RECALL_WINDOW_MS`；消息不再有任何删除路径。`POST /api/meals/:id/recall` 保持不变：不设时间限制，事务内删餐、其 capture 行、`meal-confirmed-<id>` 动态、以及 `mealProposal.mealId` 指向它的 Habi 消息，用户自己打的字保留。
- 前端删除 `recallMessage`、消息撤回按钮、`RECALL_WINDOW_MS` 常量、`Undo2` 导入与 `.msg-recall` 样式（样式表里已无残留规则）。`replyToId` 保留，它现在只表示「这条回复对应哪个提问」。
- 测试：原有的三条消息撤回测试替换为两条规则测试，共 88 项全部通过。一条断言 `chat/messages/:id/recall` 对本人消息、Habi 消息、以及 24 小时后再试都返回 404，且事件表里不会出现 `chat.recalled`；另一条断言 24 小时后仍能撤回拍照记录，照片文件确实从磁盘消失（`readFile` 断 ENOENT），而用户说过的话留着、指向该餐的提案随之消失。
- 8787 实测：`POST /api/chat/messages/*/recall` 返回 `{"error":{"code":"NOT_FOUND","message":"没有找到这个资源"}}`（路由不存在），`POST /api/meals/*/recall` 返回 `{"error":{"code":"HTTP_404","message":"这一餐已经不在记录里了"}}`（路由存在、记录不存在）——两个 404 的差异证明删除路径仍在。
- 前端实测（390×844，4x CPU 节流）：真实库与分析页 `.msg-recall` 数量为 0，样式表中 `msg-recall` 规则数为 0；演示模式（`?demo=1`）15 行 feed 正常渲染，两条用户发言照常显示且没有任何撤回入口。无控制台错误。

## 语音命令被 ASR 谐音挡掉 + 拍照显示延迟（2026-10-16 追加）

用户报告两件事：「哈比记录没有拍照」和「拍了的照片前端显示很慢」。两者根因不同，分别在 Android 端与 Web 端。

### 1. 声学已经听到了，却被 ASR 文本判定拒绝

设备上的真实回执（`files/voice-commands/phone-kws-566bbc78…json`，19:43）证明这条路径只差最后一步：

```
text                          "哈比之录。"
kws.command_acoustic_confirmed true        ← 声学 KWS 在本段 PCM 里独立确认了「记录」
kws.command_kws.keyword        "记录"  token 1.76–1.96s
command_verified               false
verification_route             rejected    ← 于是不开相机
camera_request_accepted        false
```

`RealtimeVoiceController.verifyCandidate` 要求 `strict || acoustic`，而 `acoustic` 还额外要求 ASR 文本命中白名单。SenseVoice 把轻声的「记」拼成了「之」，白名单里没有 `之录`，于是声学证据被文本否决。19:30、19:35 两条同类回执里 `command_acoustic_confirmed` 为 false（那段 PCM 里确实没有「记录」），被判拒绝是正确的。

- 修法：只在**有声学确认**的那条路径上、且**必须带唤醒词前缀**时接受 `之录`。裸「之录」继续拒绝——`VoiceCommandValidationInstrumentation` 里原本就把裸 `之录` 列为必须拒绝，这条约束保留。
- 43 条 fixture 全部通过，含实测那条 `哈比之录。 → acoustic: true / strict: false`（普通路径不受影响，谐音不能绕过）。fixture 同时新增 `海比之录` 为可接受、裸 `之录` 仍为拒绝。
- **需要重新构建并安装 APK 才生效**（见下）。

### 2. 照片显示慢：不是网络，是轮询间隔

- 实测 USB 隧道（`adb reverse`）延迟 3–4ms；从手机上传一张 9.6KB 图片走完整 `/api/capture` 路径（含落盘与事务）= **12ms**，服务端 201。网络与后端都不是瓶颈。
- 手机侧路径本身没有等待：拍照 → `fd.sync()` 落盘 → 立即上传 → 拿到 ACK 就放快门，Step 复核在后台单独进行（`PhoneCameraController` 的 `phase` 依次为 `capturing → uploading → checking → review_pending`）。
- 真正的延迟来自页面：手机拍完的照片要等下一次 `/api/state` 轮询才出现在界面上，原本 6 秒一次。改动：轮询降到 3 秒；并让原生桥的 `phone_camera` 一旦变成 `uploaded: true` / `review_pending` 就立即触发一次状态读取（`echo-device-event` 已有的事件通道），不再等轮询。
- 这条改动只动了 Web 端，已 `npm run verify` 通过（88 项测试、构建正常）。

## 关键发现：手机 WebView 加载的是线上部署，不是本机 8787（2026-10-16）

排查「照片显示慢」时用 CDP 连进 Android WebView，读到的页面地址是 `https://habi.zhexin.site/`，不是 `http://127.0.0.1:8787`。设备上的 SharedPreferences 写得很清楚：

```
com.withecho.companion.MainActivity.xml → app_url     = https://habi.zhexin.site   （WebView 加载的页面）
native_pipeline.xml                     → backend_url = https://habi.zhexin.site   （手机拍照/信号上传的目标）
```

因此：

- **本机 8787 与手机上的页面是完全独立的两个东西。** 本轮对 `/api/state` 载荷、ETag/304、轮询间隔（6s→3s）、消息撤回移除的改动，全部只在 8787 上生效；手机页面这一侧仍是线上那份（首页引用 `assets/index-BYWKw2gP.js`，比本机 `index-Bt1Renv4.js` 旧）。
- 线上 `/health` 实测 0.69s、`/api/state` 未鉴权时 0.27s（401）——每次轮询都要跨一次公网，这是「慢」里与后端代码无关的那部分。线上开启鉴权（401），需要 App 里的连接口令。
- 本机库确实有过手机上传的记录（`deviceId: phone-8eab8e7a-…`，`source: phone`），最早 03:05Z、08:09–08:13Z 各一批，说明早期 `backend_url` 曾指向本机；之后的照片都走了线上，本机库里 meals 始终为 0。
- `adb reverse tcp:8787 tcp:8787` 对页面**没有作用**（页面根本不请求 127.0.0.1），只对「把 App 地址改成 127.0.0.1:8787」这种情况有意义。切换后端要在 App 的「设备与服务」面板里改 App 服务地址，或直接改 SharedPreferences。
- 仓库里没有任何部署脚本、CI 配置或隧道进程，线上那份代码怎么发上去的在本工程内不可考。

### 附带修掉的两件事

- **本地照片即时显示**：`PhoneCameraState` 新增 `local_photo`（committed JPEG 的 data URL，上限 400KB），随 `echo-device-event` 推给页面；页面在对话流顶部渲染「刚拍的 · 手机上 / 正在收好」的卡片，服务端记录到达后自动交接。这样照片不再等上传+轮询。已在真机上验证 capability 调用 0.9–1.4ms。
- **照片体量**：`PhoneCameraController` 通过 `ImageReader` 直接取相机 JPEG，尺寸上限长边 1920，实测 139–330KB（1920×1080），**没有任何再压缩**。压缩会改变 `sha256` 与送审的字节，与「保留原图」的设计冲突；而实测上传只占不到 100ms，压缩对速度几乎没有收益。

## 口令的谐音是「之路」，不是「之录」；并首次让失败可见（2026-10-16 追加）

上一节按单条样本补了 `之录`，实际不成立。设备上的四条回执（19:35 / 19:43 / 19:49 / 20:09）显示：

| 回执 | ASR 文本 | command_acoustic_confirmed | 结论 |
|---|---|---|---|
| 19:43 | 哈比之录。 | true | 白名单拒绝（当时只看到这一条） |
| 20:09 | 阿p之路。 | false | 误唤醒，拒绝正确 |
| 19:49 | 这吧，万一不可以提高… | false | 误唤醒，拒绝正确 |
| 19:35 | 哎开应该关机了… | false | 误唤醒，拒绝正确 |

用本机 `sherpa_onnx 1.12.30` + 与手机同一份 SenseVoice 模型（`.tools/audio-models/sherpa-onnx-sense-voice-…-int8`）转写三段录音，结果为「哈比之路。」「阿皮之路。」——**模型听到的是「哈比记录」，但稳定转写成「之路」**。能量包络也吻合：两段都是 4 个音节、跨度 0.46–0.62 秒，与「哈比记录」一致。所以真正需要接受的是 `之路`。

- 口令容错改为：唤醒词 + 同音字集合（`记录|基录|纪录|之录|之路|记路`）。`之路` 与 `记路` 也一并接受，因为同属一个混淆族。
- 修正一个自己引入的回归：`海比/还彼/哈y/hy` 这些**只允许出现在声学路径**的唤醒词别名，一度被并入普通匹配器，导致「海比记录」能绕过普通路径。设备上的断言 `must not bypass the ordinary matcher: 海比记录` 抓到了它。现在两条路径使用不同的唤醒词集合（普通路径只有 `habi|哈比|happy`）。
- 设备测试 `VoiceCommandValidationInstrumentation` 现为：6 条严格接受、12 条声学接受、13 条严格拒绝、15 条声学拒绝，全部通过（`microphone_started=false`、`camera_started=false`）。
- 口令失败时此前完全静默：桥已经发布 `last_command`（含 ASR 文本与 `verification_route`），但设置面板只渲染 phase 文案。现在面板会显示「听到「X」，不是「哈比记录」」或确认路径，这才能区分「听错」和「误唤醒」。该反馈是前端改动，**只在页面加载本机 8787 时可见**。

### 手机 App 已切到本机服务

`adb reverse tcp:8787 tcp:8787` 对页面无效的判断成立，但把 App 自身的地址改掉就可以了。设备上已改（原值备份在 `files/MainActivity.xml.bak`、`files/native_pipeline.xml.bak`）：

```
com.withecho.companion.MainActivity.xml → app_url     = http://127.0.0.1:8787
native_pipeline.xml                     → backend_url = http://127.0.0.1:8787
```

CDP 复核：页面 URL 为 `http://127.0.0.1:8787/`，加载的包是本机构建的 `index-C6VKBFj-.js`，`offline=false`，状态「在这里」。本机服务未开鉴权，因此不需要连接口令。

## 没有归到餐的照片既能看见、也能删除（2026-10-16 追加）

用户问「刚拍的还是不能撤回」。核对后发现两件事：

1. **照片上传是成功的，只是页面从不显示。** 回执里 `uploaded: true`、`review.status: no_food`、`mealId: null`——Step 判定画面里没有食物时按设计不建餐，而 `/api/state` 只返回 `meals`，于是这张照片永远到不了页面。设备相册里当时躺着 9 张这样的照片，用户一张也看不到，这解释了「连点几次只有一张」的体感。
2. **这样没有餐的照片没有任何删除路径。** 原有的 `POST /api/meals/:id/recall` 要求先有 meals 行。

- `/api/state` 新增 `captures`：最多 20 张没有归餐的已存照片，带复核结论。过滤在 SQL 层（`json_extract(payload,'$.mealId') IS NULL`），否则最近 20 条若都是有餐的，老照片会被挤出窗口。
- 新增 `POST /api/captures/:id/recall`：删除任意一张已存照片，无论复核结论如何，也不管它属不属于某一餐。行先删、文件后删（`unlink` 失败不影响记录已删的事实）；同时清掉 `reviewJobs` 行与空掉的 `captureSessions`；若某餐因此没有照片了，该餐一并撤回而不是留一条空记录；写入不含内容的 `capture.recalled` 事件。重复删除返回 404「这张照片已经不在记录里了」。
- 前端：时间线上「没有记成一餐」的卡片（实心缩略图 + 原因 + 可点开），详情面板底部「删除这张照片」+ 原地确认，沿用整餐撤回的乐观删除：本地先消失，失败回滚并说明。
- 测试 90 → 92 条：一张被否决的照片确实被列出、结论正确、文件真实存在于磁盘；把它删掉后记录与文件都不在了、重复删除 404、事件已写入；以及只有一张照片的餐在被删照片后整餐一并撤回。两条都用 `/api/phone/captures` 驱动——那是手机真正走的、也是唯一会跑复核的路由。
- 实测（本机 8787 + 手机 WebView，CDP 只读检查）：页面 URL 为本机、加载 `index-CcwxtQTe.js`，渲染出 4 张「没有记成一餐」卡片，点开详情后面板与「删除这张照片」都在；9 张照片与 0 条 meals 均未被改动。

另外修掉本会话自己引入的一个性能缺陷：committed 之后的整张照片（base64 约 287KB）曾被放进 capability 载荷，而页面每两秒读一次。现在手机端生成 720px 预览并按需通过 `getLocalPhoto()` 读取，capability 轮询只带一个就绪标记。

## 「这张照片先给你看」一直卡着：新旧版本不同步（2026-10-16 追加）

用户报告那个占位卡片一直不消失。CDP 读桥后确诊为**已装 APK 与页面版本不同步**：

- 已装 APK 仍在 capability 载荷里带整张照片：`local_photo` 长度 287043，`capabilities_bytes` **594044**——页面每 2 秒读一次。
- 新页面等的是 `local_photo_ready` 标记 + 按需 `getLocalPhoto()`，两个字段都对不上，于是占位卡片既渲染不出正确状态、也清不掉。

修法（不依赖重装 APK，两个版本都能跑）：

- 客户端同时识别两种形态：`local_photo_ready === true` 或旧的 `local_photo` 字符串；读取优先按需方法，取不到再用旧字段。
- 交接判据改用桥自己的 `phase`：只要它不是 `idle/capturing/uploading/checking/review_pending`（即这张已经有结论），本地占位卡片就交棒消失。原先只按「新拍一张」清空，这就是它一直卡着的原因。
- 实测：页面加载 `index-DlhdtbD_.js`，桥仍返回 `phase: no_food` 与 287043 字节的旧字段，而占位卡片数为 **0**，4 张「没有记成一餐」卡片正常，未离线。

仍待重装 APK 的部分：旧包的 594KB/2 秒轮询载荷只能靠新 APK 消除。

## 新 APK 装机实测：拍照立刻显示 + 轮询载荷降 460 倍（2026-10-16 追加）

录音停掉后重装成功（设备 APK 哈希 `cf268a87c87ed9e0` 与本地构建一致，地址仍为 `http://127.0.0.1:8787`）。通过 CDP 驱动真实拍照，逐项实测：

| 环节 | 实测值 |
|---|---|
| capability 轮询载荷 | **1286 字节**（旧包 594044 字节） |
| 本地预览 | **19035 字节**（720px 降采样；旧包塞的是整张 287043 字节） |
| 手机上的原图 | 233726 字节，未被改动，仍是上传的那一份 |
| 上传 | `uploaded: true`，`saved_locally: true` |
| 服务端 | 新增一条 capture，`review: uncertain`（相机对着桌面） |
| 交接 | 预览卡片数 0，首张 kept 卡片 id 与新 capture id 一致 —— 占位卡片正确让位给服务端记录 |

删除接口也在这次实测中顺带验证：删掉这张测试照片后服务端记录与媒体文件一并消失（media 目录回到 9 个），手机上的本地原图保留（手机相册是另一份，删除服务端记录不影响它）。测试照片已清理，用户原有的 9 张照片未被触碰。

录音状态说明：为了安装，通过页面上的「停止录音与语音拍照」按钮正常停止（按钮回到「开启聆听与语音拍照」，前台服务归零），用户重新点一下即可恢复聆听。

## 唤醒词按形状匹配，不再逐个补写法（2026-10-16 追加）

第四次同类报告，回执给出了新的关键事实：

```
last_command.text       "h皮记录。"
command_verified        false
verification_route      rejected
```

**命令词「记录」这次听对了**，被拒绝的是唤醒词：SenseVoice 把「哈比」转写成了拉丁字母 `h` + `皮`，而白名单里是 `哈比|海比|还彼|哈y|hy`。回顾一天内的观测，同一个「哈比」被拼成过：哈比、海比、还彼、阿皮、h皮——**每补一个写法，它就换一个新的**。这不是可维护的做法。

改成：**命令词严格、唤醒词按形状**。

- 命令侧仍是封闭集合 `记录|基录|纪录|之录|之路|记路`（这个模型稳定听对）。
- 唤醒侧改为形状匹配：1–4 个「唤醒样」字符，拉丁字母或已观测到的首字 `哈海还阿比彼皮`。
- 整句约束不变，因此这些仍然被拒：裸「记录」以外的单命令词、`记录一下`、`他说哈比记录`、`明天哈比记录`、`哈比明天记录`、`哈比不要记录`、裸的谐音 `之录`/`之路`。`matches()`（无任何声学证据的普通路径）保持 `habi|哈比|happy` + `记录`，一个变体都不放行。

过程中修掉自己两次同类失误：先是 `[哈海还阿][比彼皮]` 里的中文字符类漏字导致 `h皮` 拆不开，再是把 `{1,3}` 的重复写成固定单次而漏掉 `比`。两次都是靠 fixture 逐条断言（而不是靠肉眼读正则）抓出来的——46 条本地 fixture、设备 16 条声学接受 / 15 条拒绝全部通过。

设备实测：APK 哈希 `e0c65e32b3a7ff73` 与本地构建一致；`VoiceCommandValidationInstrumentation` 报 6 条严格接受、16 条声学接受、13 条严格拒绝、15 条声学拒绝，`microphone_started=false`、`camera_started=false`。

## 唤醒词的要求本身就是那个 bug（2026-10-16 追加）

第五次同类报告，回执再次给出决定性事实：

```
last_command.text       "他比记录。"
verification_route      rejected
```

`他比` —— 「哈比」的第 **六** 种拼写（此前：哈比、海比、还彼、阿皮、h皮）。同时 `记录` 一如既往是对的。

结论：**错的从来不是命令词，而是我要求 ASR 也把唤醒词拼对。** 而唤醒词已经由声学 KWS 在**同一段 PCM** 里独立确认过——`wake_and_record_kws_with_full_asr_grammar` 这条路由的前提就是两个 KWS 词都命中。我等于让一个不可靠的信号（ASR 拼唤醒词）去否决一个可靠的信号（声学命中）。

改成：**从 ASR 文本里只读命令词**。

- 命令侧封闭同音集合 `记录|基录|纪录|之录|之路|记路`（实测每次都对）。
- 前缀最多 2 个字符——所有观测到的转写前缀恰好都是 2 字（哈比/海比/还彼/阿皮/h皮/他比），保留这个位置约束是为了挡住「他说哈比记录」「明天哈比记录」「哈比不要记录」这类整句。
- 裸的命令词与裸同音词现在都被接受（`记录`、`之录。`、`之路。`）——声学已确认两个词，这是合理的。
- 普通路径 `matches()` 不变：`habi|哈比|happy` + `记录`，任何变体都不得绕过。

设备测试：6 条严格接受、**22 条声学接受**、13 条严格拒绝、14 条声学拒绝。

### 顺带修掉一个「反馈行看不见」的问题

用户说设置面板里没有「最近一次口令」那一行。核对属实：**那一行只在已经有口令结果时才渲染**，而重装 APK 会清空语音状态 → 用户去找的时候它恰好不存在。这行现在常驻，没有口令时显示「还没听到口令，对着手机说「哈比记录」」。实测面板块已包含该行。

## 修复生效 + 「拍照慢」的真实耗时构成（2026-10-16 追加）

用户报告「正在拍照有点慢，是不是还在等 SenseVoice」。同时新回执 `phone-kws-e6e727f3…` 显示 `command_verified: true`——**去掉唤醒词要求后语音拍照恢复**，且该条对应了真实照片 `phone-camera-c1d702ba…`。

耗时实测（CDP 逐 100ms 采样桥的 phase）：

| 阶段 | 耗时 |
|---|---|
| 流开始 → 段结束（等语音结束点） | ~0.5 秒 |
| SenseVoice 识别与口令确认 | **120ms** |
| 相机打开 + 对焦 + JPEG 出图（`capturing` → 拿到图） | **2,056ms** |
| 上传 + Step 复核得出结论（`checking` → 结论） | ~2,000ms（不阻塞拍照） |

所以慢的不是 SenseVoice（120ms），而是**相机硬件启动本身约 2 秒**；复核那 2 秒在照片已经安全落盘并上传之后，用户不必等。

可优化但未做（属于产品取舍，需用户决定）：用常开的预览流取代「打开相机 → 拍一张」，拍照可降到约 200–300ms，代价是持续占用相机与更高耗电。

## 相机耗时拆解与调优：1303ms → 868ms（2026-10-16 追加）

用户问「除了常开预览还有没有更快的方案」。先用埋点把 `takeJpeg` 分段量准（耗时随回执的 `camera_timing_ms` 一起落盘，便于以后直接读设备）：

```
open_ms:        21ms    打开相机设备
configure_ms:   37ms    建立 JPEG + 640x480 YUV 双流会话
warmup_ms:     681ms    等 3A 收敛后才允许拍（原逻辑 ≥5 帧且 AE 收敛）
decode_ms:     564ms    JPEG 编码（1920×1080）+ 落盘
total_ms:     1303ms
```

**「打开相机」只占 58ms，比预想快得多**；真正的两个大头是「等 3A 收敛」和「JPEG 编码」。据此做了两处调优（都不需要常开预览）：

- 3A 预热放宽：≥2 帧即可拍（原 ≥5），兜底从 1500ms 降到 400ms。复核容忍一张未完全稳定的帧。
- JPEG 编码：分辨率上限参数化（`CAPTURE_MAX_EDGE`，当前 1280/1920 均落到 1920×1080）；质量仍为 88。

实测：`total_ms 1303 → 868`（warmup 681→400，decode 564→408，open+configure 58 不变），连续多次稳定在 867–868ms。

**质量核验**（因为提前拍可能曝光不准）：对服务端与手机上的全部照片做灰度统计，亮度均值 50.9–55.1、中位数 52–56、标准差 6.1–6.8——**分布高度一致，没有出现欠曝/过曝**。当前画面本身是均匀暗灰（相机被遮挡或环境暗），因此这项核验只能证明「没有变差」，不能证明明亮场景下的画质。

其余可行方案（未实施，属产品取舍）：唤醒词命中即预热相机（可与命令词的 0.4–0.7 秒重叠）；命令 KWS 命中即预热；常开预览流（最快，但持续占用相机、耗电、指示灯常亮）；口令通过时立刻给一声提示音，让 2 秒空白有反馈。

## 相机预热与口令即时反馈（2026-10-16 追加）

用户选择了「唤醒词命中就预热相机」和「口令通过时立刻给提示音/震动」两条。

### 预热

- `PhoneCameraController.prewarm()`：在唤醒词命中时打开相机并跑一条 640×480 的 repeating 预览，让 3A 在用户还在说「记录」时就开始收敛；会话空闲 4 秒自动关闭，所以「只叫哈比不拍照」不会让相机一直开着。唤醒词到命令词之间实测有 0.4–0.7 秒可重叠，正好覆盖原来 400ms 的等收敛时间。
- `takeJpeg()` 优先复用该会话：命中时 `open+configure+warmup` 三项都省掉，只留 JPEG 编码（约 300–400ms）。
- 安全网：复用会话若无法交付 still（驱动可能不接受在预热会话上再加 JPEG target），会自动标记 `skipWarmOnce` 并**回退到常规打开路径重试一次**，不会因为预热而拍不到。
- 接线：`RealtimeVoiceController` 新增 `onWake` 回调 → `RecordingService` 在 `armed()` 时调用 `prewarm`。

**未能在脱离录音的情况下验证**：调试钩子（普通 WebView 上下文）调用 `openCamera` 时，`CameraDevice.StateCallback` **一次都不回调**（trace 停在 `opening`），改用主线程 Looper 与 Activity context 均无效。真实路径走的是录音前台服务（具备 `FOREGROUND_SERVICE_CAMERA` 归属），与调试环境不同，因此这一项只能在真实录音会话中核对——回执里的 `camera_timing_ms` 会直接显示 `warmup_ms` 是否消失。

### 口令即时反馈

- 口令通过立刻震动 45ms + 短提示音（STREAM_MUSIC，TONE_PROP_BEEP 120ms），不再让用户对着「快门还有约 0.8 秒才响」的空白猜。语音路径在 `RecordingService`，面板按钮在 `MainActivity`，两处行为一致。`VIBRATE` 权限已加入 manifest。

调优后单次拍照实测：`total_ms 783–868`（open 17–24 / configure 36–43 / warmup 400–402 / decode 325–408）。回退路径存在时最坏情况与调优前相同。

## 预热回滚与曝光震荡的修正（2026-10-16 追加）

用户报告「有提示音，但拍摄效果不好」，随后「后面两次就不行了」。两件事都由上一轮的改动引起，均已修正。

### 预热必须回滚（`cb618a4`）

trace 显示预热线程写下 `opening` 后**再没收到 `CameraDevice` 回调**：裸后台线程没有前台服务归属，而它已经把相机**占住**了。此后的每次拍照都走 `openCamera` → 15 秒超时 → 失败，直到 App 重启。这正是「第一次可以、后面两次不行」。

结论：预热必须用**与拍照路径完全相同的上下文与会话建立方式**才能信任；用裸线程去开相机，结果比它要解决的问题更糟。已回滚预热、唤醒回调与复用路径，**保留提示音**（用户确认有效，且与相机无关）。

### 曝光不能靠猜测（`4a1b6e1` 之后）

两种猜法各产生一张坏图：

| 判据 | 结果 |
|---|---|
| 帧数（≥2 帧 / 400ms 兜底） | **过曝**：median 255，白屏削顶 |
| 单帧报告 `AE_STATE_CONVERGED` | **全黑**：median 20（该状态在本机闪烁，单帧不可信） |

改为**连续多帧稳定**（3 帧 settled）才拍，收敛不稳定就继续等，1500ms 兜底。

实测同一场景连拍三次：`mean 145.3–150.9 / median 198–206 / stdev 86.5–87.7`——三次几乎一致，不再黑↔白震荡。

代价是时间：warm-up 约 970ms（23 帧）而非固定 400ms，单次拍照约 1.3 秒（此前 0.9 秒）。这是为了让复核能看清照片所付出的诚实代价——一张全黑或全白的照片，拍得再快也没有价值。

## 时间线顺序：新记录必须落在最下面（2026-10-16 追加）

用户报告「消息晚的反而在上面」。核对源码属实，而且是我加照片卡片时引入的：

- 消息与餐由 `items` 按 `at` 升序排序后渲染（最新在最后，正确）。
- 但「没有记成一餐」的照片卡片被**独立渲染在 items 之前**，等于固定在列表最上面——最新拍的照片于是跑到会话开头，看起来就是「新的在上面」。

修法：把照片作为第三类 item（`kind: 'kept'`）并入同一个按时间排序的列表，不再单独前置。这样三类记录（消息、餐、照片）同序渲染，日期分隔符也统一由时间线负责。

顺带补上一个遗漏：独立渲染时照片有 `slice(0, 4)` 上限，合并进时间线后这个限制丢了，失败照片会无限堆积；现改为取最近 6 张（服务端按新→旧返回）。

实测：页面加载新包后，`.thread > li` 的顺序为「日期分隔 → 照片卡（按时间升序）」，滚动到底部仍贴住最新一条。
