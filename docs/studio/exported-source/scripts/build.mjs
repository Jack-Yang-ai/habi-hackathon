/* =============================================================================
 * 构建入口（`npm run build`）—— 只管产出产物，不跑质量门禁
 *
 * 「构建」与「门禁」是两件事，这里只做前者：
 *   构建  vite build（App UI → dist/client/web） + vite build --config vite.config.admin.ts（Admin UI → dist/admin）
 *   门禁  `npm run typecheck`（tsc --noEmit，纯检查、不产出任何产物）
 *
 * 只打包 App（不打 Admin）时用 `npm run build:client`（= 本脚本加 `--client`）；
 * 只打包 Admin 时用 `npm run build:admin`（= 本脚本加 `--admin`）。
 * 两个产物互不依赖（见 09-deployment.md 的"关键前提 1"），所以只交付 APK 的场景
 * 没必要为 Admin 付一次完整的 vite 构建——平台打 APK 只取 dist/client/，
 * 只有发布静态站点时才需要 dist/admin/。省下的是一整个 vite 进程的固定成本。
 *
 * 两个 `--xxx` 主要是给**服务端**用的：拆成两条命令后，平台可以把两次构建派到不同的
 * 执行单元（不同容器 / 独立 CPU 配额 / 独立重试），那时才有额外收益。**同机同容器并发
 * 调用并不会更快**——本脚本默认就已经把两次 vite 并行跑了（见下面"为什么并行"），
 * 再拆成两个进程只是把它们换个地方抢同一批核。
 *
 * 类型检查刻意**不**在这个脚本里跑。它占本步约 1/4 的 CPU 时间却一个字节都不产出，
 * 而发布链路的 build-web 步时间很紧（产品要求前端构建 ≤ 10s，改前实测 10–14s）：
 * 平台上这一步近似只有一核可用（本地 CPU 时间 12.1s ↔ 平台墙钟 10–14s 基本同量级），
 * 省下的 CPU 基本等于省下的墙钟。去掉后本步 CPU 从 12.1s 降到 6.7s。
 *
 * **代价：`npm run build` 通过 ≠ 类型没问题。** 交付前必须另外跑 `npm run typecheck`
 * （或直接跑交付门禁 `node scripts/validate.mjs <项目目录> --build`，它包含类型检查
 * 与构建两项）。发布链路与门禁侧的覆盖不变，只是不再由 build 顺带承担。
 *
 * 两次 vite 各自付一遍「Node 启动 + 配置与插件初始化 + 源码转换压缩」的固定成本，
 * 所以两条并行跑（墙钟由最慢的一项决定）。本地 14 核基准（同一模板、同一 lockfile，
 * **改前的数值**，用于说明"为什么并行"；改后的对比见 references/09-deployment.md §1.1）：
 *
 *   ensure-deps 38ms | vite(App) 2670ms | vite(Admin) 2315ms | finalize 51ms
 *
 * 注意 Admin 只是个很小的页面，耗时却接近 App——时间几乎全是固定成本，所以
 * 「合成一次进程出两份产物」或「两条并行」都能拿到大部分收益；这里选并行，
 * 是为了不改动两个 config 的结构（单入口、不共享 chunk 的约定见 vite.shared.ts）。
 *
 * 行为差异（刻意为之，均不改变对外契约）：
 *   1. 任一步失败仍然让整个构建失败（退出码非 0），发布侧看到的失败阶段不变
 *      （仍是 build-web）；差别只是失败时另一项的产物可能已经落盘。
 *   2. 没有 admin 三件套（admin.html / vite.config.admin.ts）时跳过 Admin 构建，并清掉
 *      上一轮留下的 dist/admin/（不清就会把已经删掉的后台当产物交付出去）：
 *      这替代了 scaffold.mjs 里对 package.json 的字符串手术，那个手术在本脚本
 *      上线后必然失效（详见 scaffold.mjs 的同名备注）。
 *   3. `--client`（npm run build:client）只构建 App UI：不跑 Admin 那次 vite，也不动
 *      dist/admin/。**调它的调用方要自己保证这次交付不需要 Admin 产物**——脚本不会
 *      替它判断（平台侧判据：这次构建要不要发布静态站点）。后台三件套已不全却还留着
 *      上一轮的 dist/admin/ 时，只打一条提醒（不代删，见下面分支注释）。
 *   4. `--admin`（npm run build:admin）只构建 Admin UI：不跑 App 那次 vite，也不碰
 *      dist/client/。工程里没有后台三件套时**直接失败**——调它的人要的就是 Admin 产物，
 *      静默跳过等于骗调用方。与 `--client` 互斥（同时传直接报错）。
 *
 * 输出每行带 [步骤名] 前缀：两个进程的 stdout 交错时，没有前缀就无法判断某行
 * 属于谁，排障时会退回猜。
 * ========================================================================== */

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRIPTS = path.join(ROOT, 'scripts')
const ADMIN_OUT = path.join(ROOT, 'dist', 'admin')
/** 只构建 App UI（`npm run build:client`）：跳过 Admin 那次 vite，也不碰 dist/admin/。 */
const CLIENT_ONLY = process.argv.includes('--client')
/** 只构建 Admin UI（`npm run build:admin`）：跳过 App 那次 vite，也不碰 dist/client/。 */
const ADMIN_ONLY = process.argv.includes('--admin')
/** 本机 bin 直连，不绕 npx：npx 每次多一次包解析，发布构建里这是白付的钱。 */
const bin = (name) => path.join(ROOT, 'node_modules', '.bin',
  process.platform === 'win32' ? `${name}.cmd` : name)

/** Admin UI 入口与构建配置：两者齐备才构建（按需能力，见 vite.config.admin.ts 头注释）。 */
const ADMIN_ENTRY = 'admin.html'
const ADMIN_CONFIG = 'vite.config.admin.ts'

/** 半行缓冲：子进程的 data 事件不保证按行切分，直接写会把一行劈成两个前缀行。 */
const partial = new Map()
const children = new Set()

function emit(name, chunk) {
  let buffer = (partial.get(name) ?? '') + chunk.toString()
  const lines = buffer.split('\n')
  partial.set(name, lines.pop() ?? '')
  for (const line of lines) process.stdout.write(`[${name}] ${line}\n`)
}

function flush(name) {
  const rest = partial.get(name)
  partial.delete(name)
  if (rest) process.stdout.write(`[${name}] ${rest}\n`)
}

/** 父进程被 kill（发布取消 / Ctrl-C）时别把子进程留成孤儿。 */
let abortCode = 0
function forwardSignal(signal) {
  if (abortCode) return
  abortCode = signal === 'SIGINT' ? 130 : 143
  for (const child of children) child.kill(signal)
  // 挂上 SIGINT / SIGTERM 监听后 Node 的默认终止行为就失效了：只转发不退出的话，
  // 信号落在「两个阶段之间」（此时没有子进程可转发）就会被吞掉，父进程接着跑完甚至报成功。
  // 留一小段宽限让子进程自己收尾（vite 还会连带收掉它起的 esbuild），到点强制退出。
  setTimeout(() => process.exit(abortCode), 500)
}

/** 统一出口：被打断时用约定的 130 / 143，别报成一次普通的构建失败。 */
const bail = (code) => process.exit(abortCode || code)
process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

/**
 * 跑一组命令，返回失败项（空数组 = 全部成功）。
 * jobs: [{ name, cmd, args }]。
 * parallel=true：同时起进程，墙钟由最慢的一项决定（默认，给互不依赖的三项用）；
 * parallel=false：逐个跑，前一个失败就不再跑下一个（给有先后关系的 ensure-deps /
 * finalize 用——依赖没装齐时 tsc 报的是「模块解析错误」，会把真实原因盖掉）。
 */
async function run(jobs, { parallel = true } = {}) {
  const start = (job) => new Promise((resolve) => {
    const child = spawn(job.cmd, job.args, {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    })
    children.add(child)
    child.stdout.on('data', (chunk) => emit(job.name, chunk))
    child.stderr.on('data', (chunk) => emit(job.name, chunk))
    // spawn 自身失败（例如 bin 不存在）也要落到失败项：否则调用方会以为成功了。
    child.on('error', (error) => {
      emit(job.name, `failed to start: ${error.message}\n`)
      resolve({ name: job.name, code: 1 })
    })
    child.on('close', (code) => {
      children.delete(child)
      flush(job.name)
      resolve({ name: job.name, code: code ?? 1 })
    })
  })
  if (parallel) {
    const results = await Promise.all(jobs.map(start))
    return results.filter((result) => result.code !== 0)
  }
  const failed = []
  for (const job of jobs) {
    const result = await start(job)
    if (result.code !== 0) {
      failed.push(result)
      break
    }
  }
  return failed
}

if (CLIENT_ONLY && ADMIN_ONLY) {
  console.error('✗ --client 与 --admin 不能同时使用：只交付 APK 用 npm run build:client，'
    + '只交付后台用 npm run build:admin，两个产物都要就用 npm run build')
  bail(1)
}

const missing = ['ensure-deps.mjs', 'finalize-build.mjs'].filter((file) => !existsSync(path.join(SCRIPTS, file)))
if (missing.length) {
  console.error(`✗ 缺少构建脚本：${missing.join('、')}`)
  bail(1)
}

// 1. 依赖自愈：沙箱回收后 node_modules 丢失时自动重装。必须在 vite 之前，
//    且失败就不继续（理由见 run() 里 parallel=false 的注释）。
const deps = await run([
  { name: 'deps', cmd: process.execPath, args: [path.join(SCRIPTS, 'ensure-deps.mjs')] },
], { parallel: false })
if (deps.length) {
  console.error(`✗ 依赖未就绪（${deps.map((item) => item.name).join('、')}），构建中止`)
  bail(deps[0].code)
}

// 2. 默认两次构建并行：两个 vite 各写各的 outDir（dist/client/web 与 dist/admin
//    互不嵌套，emptyOutDir 不会互相清空）。类型检查不在这里，见文件头注释。
//    --client / --admin 时只留一项（见文件头 行为差异 3 / 4）。
const jobs = []
if (!ADMIN_ONLY) {
  jobs.push({ name: 'vite:app', cmd: bin('vite'), args: ['build'] })
}

const hasAdmin = existsSync(path.join(ROOT, ADMIN_ENTRY)) && existsSync(path.join(ROOT, ADMIN_CONFIG))
if (ADMIN_ONLY) {
  // 调用方明确要 Admin 产物：没有后台三件套就是用错了地方，直接失败（行为差异 4）。
  if (!hasAdmin) {
    console.error(`✗ npm run build:admin 需要工程根同时有 ${ADMIN_ENTRY} 与 ${ADMIN_CONFIG}——`
      + '没有后台的工程不需要它；只交付 APK 请用 npm run build:client')
    bail(1)
  }
  jobs.push({ name: 'vite:admin', cmd: bin('vite'), args: ['build', '--config', ADMIN_CONFIG] })
} else if (CLIENT_ONLY) {
  if (hasAdmin) {
    console.log('[vite:admin] --client：本次只构建 App UI，跳过 Admin（dist/admin/ 保持原样）')
  } else if (existsSync(ADMIN_OUT)) {
    // --client 不改动 dist/admin/，但后台三件套已经不全时那份产物是过期的：
    // 只提醒、不代删（--client 的语义就是"不碰 Admin"，删不删由调用方决定）。
    console.warn('[vite:admin] --client：无 admin 三件套，但 dist/admin/ 还在（上一轮的过期产物）——'
      + '若这次要发布静态站点，先删掉它或改跑 npm run build')
  }
} else if (hasAdmin) {
  jobs.push({ name: 'vite:admin', cmd: bin('vite'), args: ['build', '--config', ADMIN_CONFIG] })
} else if (existsSync(ADMIN_OUT)) {
  // 后台被删掉（三件套不齐）时，上一轮构建留下的 dist/admin/ 是过期产物：
  // 不清掉它会跟着 dist/ 一起被打包 / 部署，等于把已经删掉的后台又交付出去。
  rmSync(ADMIN_OUT, { recursive: true, force: true })
  console.log('[vite:admin] 无 admin 三件套，跳过构建并清除上一轮的 dist/admin/')
}

const failed = await run(jobs)
if (failed.length) {
  // 带足上下文：哪几步失败、退出码多少。tsc 与 vite 的原始报错已按前缀打出。
  console.error(`✗ 构建失败：${failed.map((item) => `${item.name}(exit ${item.code})`).join('、')}`)
  bail(failed[0].code)
}

// 3. 收尾：校验 manifest、拼装 dist/client/、重命名 dist/admin/index.html。
// 成功行由 finalize 自己打（它才知道这一趟到底产出了哪些目录），这里不重复。
// --client / --admin 原样透传：收尾脚本据此决定收尾哪一侧（见 finalize-build.mjs 头注释）。
const finalize = await run([
  {
    name: 'finalize',
    cmd: process.execPath,
    args: [
      path.join(SCRIPTS, 'finalize-build.mjs'),
      ...(CLIENT_ONLY ? ['--client'] : []),
      ...(ADMIN_ONLY ? ['--admin'] : []),
    ],
  },
], { parallel: false })
if (finalize.length) {
  console.error(`✗ 构建收尾失败（${finalize.map((item) => item.name).join('、')}）`)
  bail(finalize[0].code)
}
