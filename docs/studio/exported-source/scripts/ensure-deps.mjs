/* =============================================================================
 * 依赖自愈：AI Builder 的沙箱容器可能随时被回收，项目重建后 node_modules/ 会整体丢失。
 * 这时 devServer / 构建 / 类型检查会报模块解析错误（Cannot find module / Failed to resolve import），
 * 很容易被误当成代码 bug。
 *
 * 本脚本被 dev / build / typecheck 前置调用（也在 npm run deps 里单独暴露）：
 *   - 依赖就绪 → 静默通过（不打扰 devServer 输出）；
 *   - 依赖缺失 / 过期（沙箱回收、lockfile 变新）→ 自动 npm install 后再继续。
 *
 * 并发安全：平台可能同时起 `build:client` 与 `build:admin`（两条命令各自前置调用本脚本），
 * 两个 npm install 同时写同一个 node_modules 会互相破坏，所以重装走一把**跨进程锁**
 * （锁放在系统临时目录、按工程路径取键）：抢到的装，没抢到的等它装完再复查一次。
 *
 * 用法：
 *   npm run deps      # 只做检查与按需重装
 * ========================================================================== */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const NODE_MODULES = path.join(ROOT, 'node_modules')
const LOCKFILE = path.join(ROOT, 'package-lock.json')
// npm 装完后会写这份隐藏指纹；它比 node_modules 目录本身更能说明"装完整了"
const INSTALLED_LOCK = path.join(NODE_MODULES, '.package-lock.json')
// 跨进程互斥锁。放系统临时目录而不是工程里：npm install 会清理 node_modules 下不认识的
// 目录，锁要是放在那里会被正在装的进程自己删掉；放工程根又会污染 git status。
// 键取工程绝对路径的摘要，同一工程的所有进程落到同一把锁上。
const LOCK_DIR = path.join(
  os.tmpdir(),
  `vibe-deps-${createHash('sha256').update(ROOT).digest('hex').slice(0, 16)}.lock`,
)
// 持锁进程被杀（沙箱回收 / 构建取消）会留下陈旧锁：超过这个年龄就当它已经死了，直接接管
const LOCK_STALE_MS = 15 * 60 * 1000
// 等待上限比"陈旧"阈值大一点：先给一次接管陈旧锁的机会，再判定为超时
const LOCK_WAIT_MS = LOCK_STALE_MS + 2 * 60 * 1000

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function mtime(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/** 判断依赖是否需要重装；返回原因字符串，就绪时返回 null */
function missingReason() {
  if (!existsSync(NODE_MODULES)) return 'node_modules 不存在'
  if (!existsSync(path.join(NODE_MODULES, '.bin', 'vite'))) return 'node_modules 不完整（缺少 vite）'
  if (existsSync(LOCKFILE) && mtime(LOCKFILE) > mtime(INSTALLED_LOCK) + 1000) {
    return 'package-lock.json 比已安装的依赖新'
  }
  return null
}

const reason = missingReason()
if (!reason) process.exit(0)

/** 主线程同步睡眠：等另一个进程装依赖时用（Atomics.wait 在 Node 主线程可用）。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** mkdir 是原子的：抢到锁返回 true，已被别人持有返回 false。 */
function tryLock() {
  try {
    mkdirSync(LOCK_DIR)
    return true
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    return false
  }
}

/**
 * 接管陈旧锁；真的删掉了一个陈旧锁才返回 true。
 * 先 stat 再删：stat 失败说明锁刚被持有者释放（下一个 mkdir 就能抢到），
 * 此时**不能**去删——那会把别人刚建好的锁误删。
 */
function takeOverStaleLock() {
  let age
  try {
    age = Date.now() - statSync(LOCK_DIR).mtimeMs
  } catch {
    return false
  }
  if (age <= LOCK_STALE_MS) return false
  try {
    rmSync(LOCK_DIR, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

const deadline = Date.now() + LOCK_WAIT_MS
while (!tryLock()) {
  // 接管成功后立刻重抢，不要在这一轮就把自己判超时
  if (takeOverStaleLock()) continue
  if (Date.now() > deadline) {
    console.error('\n✗ 等待另一个进程安装依赖超时（>17 分钟）。请确认没有卡住的构建，再重试。')
    process.exit(1)
  }
  sleepSync(500)
}

let failed = 0
try {
  // 抢到锁后再复查：等待期间另一个进程可能已经装好了，那就别再装一遍。
  if (!missingReason()) {
    console.log('· 依赖已由并发的另一个构建进程装好')
  } else {
    console.log(`· 依赖缺失（${reason}）——沙箱回收后属正常现象，正在重新安装...`)
    const result = spawnSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit' })
    if (result.status !== 0) failed = result.status ?? 1
    else console.log('· 依赖已就绪')
  }
} finally {
  // 必须在退出前解锁，否则后来的进程要等到锁超龄才能接管
  rmSync(LOCK_DIR, { recursive: true, force: true })
}

if (failed) {
  console.error('\n✗ 依赖安装失败。请检查网络后手动重试 `npm install`，再重新执行刚才的命令。')
  process.exit(failed)
}
