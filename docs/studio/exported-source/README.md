# 小伴（暂名）

> 给想改善饮食、但坚持不了一天三次手动记录的成年人。
> 随身 ESP32 相机自动拍下每一餐，App 里只有一只住在窗边小屋里的柔软小生物，
> 它不催你、不评价你、不拿体重和"今天吃多了"来惩罚你。

这是一个**移动端 H5 原型**：可交互、可本地运行、源码完整可导出。
React 19 + TypeScript + Vite 6 + Tailwind CSS 3。

---

## 一、先跑起来

```bash
npm install
npm run dev        # 本地预览（终端会打印地址，默认 http://localhost:5173）
npm run typecheck  # 类型检查
npm run build      # 构建产物：dist/client/
```

跑起来之后默认是**离线态**——因为还没有接上真正的记录服务。
想先看看完整流程，进「变化」页打开**演示模式**。

## 二、三个页面

底部三个导航：**伙伴 / 饮食 / 变化**。

| 页面 | 它做什么 |
| --- | --- |
| 伙伴 | 主视觉是小伴在窗边的小屋（休息 / 浇花 / 收照片，随它的状态变）。可以打开聊天；下面是小伴**自己**发布的动态，每条都带事实依据，可以回应——回应即进入对话。桌面宽屏时右侧会出现一台**设备背屏模拟器**；手机上始终单栏。 |
| 饮食 | 照片到达后的一餐卡片：原图 + 份量确认（全部 / 吃了一半 / 少量）+ 你确认，然后小伴才发布一条有依据的动态。 |
| 变化 | 长期的那一点点不一样。初始是空态；只有真实记录出现后才列出记录出现在哪些日子。设备状态与暂停入口都在这里。 |

### 演示模式

正常模式**初始为空**——没有记录就是空态，不编造任何数据。

只有在小伴的「变化」页显式打开**演示模式**后，才会出现演示插画与示例内容。
开启期间，App 顶部常驻一条标记，每张演示卡片也带「演示」徽标，不会和真实记录混在一起。

演示的首轮链路：**模拟照片到达 → 一餐卡片 → 选「吃了一半」→ 小伴做出收照片的动作 → 新增一条可回复的动态**。
（照片刚到时估算还没到，卡片会先显示「尚未估算」——这是真实设备上也会经历的中间态。）

## 三、数据从哪来：三种来源，绝不互相冒充

这是本原型最在意的一条规则。一张餐食卡片上同时存在三类信息，界面把它们分节标注、各带标签：

| 来源 | 含义 | 没有它时显示 |
| --- | --- | --- |
| **相机记录** | 设备的原始事实：拍摄时间、原图、设备号。不含任何推断 | 无照片 = 没有这张卡片 |
| **AI 估算** | 模型对照片的看法（识别条目、热量、模型名） | **「尚未估算」**，留白，不补一个看起来合理的数字 |
| **你的确认** | 份量（全部 / 吃了一半 / 少量）。**只有你自己点过才有值** | 「等待你确认」 |

界面里不会出现的东西：编造的热量、编造的识别结果、体重、历史天数、"连续打卡 N 天"、
以及任何形式的假图表。设备没连上就写"未连接"，录音没接入就写"未启用"。

## 四、接口契约

所有接口定义集中在**一个文件**：[`src/shared/api/companionApi.ts`](./src/shared/api/companionApi.ts)。
页面与状态层只通过它读写数据，不在别处 fetch、也不在页面里内联 mock。

| 方法 | 端点 | 用途 |
| --- | --- | --- |
| GET | `/api/state` | 整体状态（设备 + 餐食 + 动态 + 对话） |
| POST | `/api/capture` | multipart：`image` + `metadata`（相机上传一餐照片） |
| POST | `/api/meals/:id/correction` | `{ portionFraction }` 用户确认 / 修正份量 |
| POST | `/api/chat` | `{ message }` 和小伴说话 |
| POST | `/api/device/pause` | `{ paused }` 暂停 / 恢复记录 |
| POST | `/api/posts/:id/reply` | `{ message }` 回应动态，同时进入对话 |

- 基地址走构建期变量 `VITE_API_BASE`，缺省为同源相对路径（方便本地起个后端直接联调）。
- **服务不存在时是"离线"，不是"出错"**：请求失败（连不上 / 404 / 5xx）一律进入离线态，
  页面显示明确原因，各列表留空——不会退回示例数据。
- 客户端**没有任何密钥**。这个原型也没有做支付和登录。

## 五、源码结构

```
src/
├── app/                          # App UI（移动端）
│   ├── App.tsx                   # 路由：/ 伙伴、/meals 饮食、/changes 变化、/chat 对话
│   ├── pages/                    # 四个页面，一页一个文件
│   ├── layout/                   # AppShell（顶栏 + 底部导航）、TabBar、演示模式标记条
│   ├── components/
│   │   ├── companion/            # 小伴本体、小屋场景、背屏模拟器、动态卡片
│   │   └── meals/                # 一餐卡片、演示插画
│   └── state/
│       ├── AppStateProvider.tsx  # 状态与调用顺序：live（走接口） / demo（本地脚本）
│       └── demoContent.ts        # 演示内容（只在演示模式里使用）
└── shared/
    ├── api/companionApi.ts       # ★ 唯一的接口定义文件
    ├── styles/tokens.css         # ★ 唯一的色值来源（米白 / 苔绿 / 木色）
    └── ui/                       # 通用组件（按钮、卡片、空态…）
```

小伴本人是**纯 SVG + CSS 画出来的**（[`XiaobanFigure.tsx`](./src/app/components/companion/XiaobanFigure.tsx)），
不依赖任何外部图片或付费素材；五个动作（休息 / 浇花 / 收照片 / 思考 / 睡觉）各有各的姿态。
小屋场景与演示餐食插画同样是本地 SVG。

## 六、导出源码

**在预览里点一下就行，不用命令行**：「变化」页最底部有一个 **下载完整源码（.tar.gz）** 按钮，
点击即下载当前工程的完整源码（约 145 KB）。

这个入口是**开发预览专用**的：

- 只在开发预览里出现 —— `npm run build` 的产物里既没有这个按钮，也没有对应的下载端点；
- 归档是**点击时现场打包**的，所以拿到的永远是最新代码，不是某次构建的残留；
- 已排除：`node_modules`、`dist`、`.git`、`.env.local`（环境变量）、
  `capsule/signing/capsule.p12` 与 `capsule.properties`（签名私钥与口令）。

实现见 [`vite.config.ts`](./vite.config.ts) 的 `sourceArchivePlugin`（`apply: 'serve'`，只在 dev 装配）。
不走 `public/` 目录、也不走 `/@fs/`：前者会被复制进打进 APK 的 bundle，后者被 Vite 的
serving allow list 挡住（预览进程服务的是运行时副本，不是工程目录本身）。

本地拿到源码后 `npm install && npm run dev` 即可运行。用命令行打包时也要排除掉同样的东西：

```bash
tar --exclude=node_modules --exclude=dist --exclude=.git \
    --exclude=.env.local --exclude='capsule/signing/*.p12' \
    --exclude='capsule/signing/*.properties' -czf xiaoban-src.tar.gz .
```

构建产物：`npm run build` 会产出 `dist/client/`（含 `manifest.json`、`signing/`、`web/`），
这一层就是可直接打进 APK 的壳侧 bundle 内容；打包出包由平台完成。

## 七、这一版还没有做的事

诚实列出来，免得被界面上的留白误导：

- **没有接记录服务**：六个端点只是契约，没有配套后端，所以默认一直是离线态。
- **没有模型通道**：平台的端能力清单（`capsule-native-api`）与连接器目录里，**都没有**
  图片理解 / 对话这类接口，所以没有"内置模型"可以直接调。AI 估算的字段结构已经齐了，
  但要真的出结果，需要**在服务端接一个模型**（云函数是放这类密钥调用的正式位置，见
  `platform-supabase` 的云函数分册）。在那之前，真实记录里永远是「尚未估算」。
- **演示模式里也不编热量**：演示的估算样本把 `kcal` 设为 `null`，界面照实显示「热量未提供」。
- **录音未启用**：设备区块里如实标注。
- **没有历史趋势图**：等真实记录积累起来再说，现在不画。
- 演示模式之外，不提供任何手工录入一餐的入口。

## 八、背屏

设备背屏是 **17 × 23 单色点阵**（实机确认），不是全彩副屏 —— App 里右侧那台模拟器只是
桌面宽屏下的示意图，别把它当背屏的真实渲染效果。

平台**没有**针对这块屏的专用接口。能走的两条通道（都在 `capsule-native-api` 里）：

| 通道 | 接口 |
| --- | --- |
| BLE（推荐，近距离直连） | `openBluetoothAdapter` → `createBLEConnection` → `getBLEDeviceServices` / `getBLEDeviceCharacteristics` → `setBLEMTU` → `writeBLECharacteristicValue` |
| 网络 | `request`（仅 https） |

用 BLE 时记得在 `capsule/manifest.json` 声明 `bluetooth` 权限（没有声明的话 APK 里就没有这个权限，
系统会静默拒绝且不弹框）。一帧 17 × 23 单色位图是 49 字节，MTU 协商到 185 后一包可发完。

## 九、开发约定

改代码前请先读 [AGENTS.md](./AGENTS.md)——它写清了本工程的连带义务（改了什么必须同步改什么、
构建产物怎么产出、`capsule/` 怎么维护）。核心几条：

- 颜色**只能**来自 [`src/shared/styles/tokens.css`](./src/shared/styles/tokens.css)，组件里不写色值；只有一套配色，不做深浅色切换。
- 高度用 `dvh` 系列，不写 `100vh`。
- 交付前 `npm run typecheck` 与 `npm run build` 两条都要跑（构建不含类型检查）。
