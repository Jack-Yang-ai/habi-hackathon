/* =============================================================================
 * 构建收尾：把 dist/ 整理成"可直接交付"的形态
 *
 *   npm run build
 *     = node scripts/build.mjs              ← 编排：依赖自愈 → 并行跑下面三项 → 本脚本收尾
 *     + tsc --noEmit
 *     + vite build                          → dist/client/web/**
 *     + vite build --config vite.config.admin.ts → dist/admin/admin.html
 *     + node scripts/finalize-build.mjs     ← 本脚本
 *
 * `npm run build:client`（= build.mjs --client）只构建 App UI，本脚本收到 `--client`
 * 后不再要求 / 不再处理 dist/admin/（那是"发布静态站点"才需要的产物）；
 * `npm run build:admin`（= build.mjs --admin）只构建 Admin UI，本脚本收到 `--admin`
 * 后**整段跳过 App 侧**（capsule 校验、注释检查、dist/client/ 拼装），只收尾 dist/admin/。
 *
 * 本脚本做五件事：
 *   1. 校验 capsule/manifest.json（applicationId / entry / versionCode / permissions /
 *      orientation / appFunctions 路径）以及 manifest.version 与 src/shared/config/app.ts 的 APP_VERSION 是否一致；
 *   2. 校验产物里的 XML / HTML 注释不含两个连续横杠 `--`（非法注释，Android 打包会失败）；
 *   3. 把 capsule/ 下的 manifest.json、signing/、icon/（声明了 appFunctions 时还有 functions/）复制到 dist/client/，
 *      拼出壳侧要求的目录形态：dist/client/ = <applicationId>/ 的内容；
 *   4. 确保 dist/client/signing/capsule.p12 存在（缺失时自动生成调试证书）；
 *   5. 有后台时把 dist/admin/admin.html 重命名为 dist/admin/index.html，
 *      让该目录自成站点根（无后台工程——工程根无 admin.html——跳过）。
 *
 * 产物结构：
 *   dist/client/                 → 壳侧 bundle 目录内容（打进 APK）
 *   ├── manifest.json
 *   ├── signing/{capsule.p12,capsule.properties}
 *   ├── icon/ic_launcher_*.xml
 *   ├── functions/{contract.json,handlers.js}   （声明了 appFunctions 才有）
 *   └── web/{index.html,assets/**}
 *   dist/admin/                  → Admin UI 静态站点（整目录拷到线上）
 *   ├── index.html
 *   └── assets/**
 *
 * 两个目录互不引用，各自可独立部署；门禁 G40 会检查这一点。
 * ========================================================================== */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDebugSigning } from './gen-debug-signing.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const CAPSULE_DIR = path.join(ROOT, 'capsule')
/** 原子能力的契约与脚本（manifest.appFunctions 声明时才复制进产物） */
const FUNCTIONS_DIR = path.join(CAPSULE_DIR, 'functions')
const CLIENT_DIR = path.join(ROOT, 'dist', 'client')
const ADMIN_DIR = path.join(ROOT, 'dist', 'admin')
/** Admin 产物入口：vite 产出 admin.html，本脚本把它改成 index.html 让它自成站点根。 */
const ADMIN_ENTRY = path.join(ADMIN_DIR, 'admin.html')
const ADMIN_RENAMED = path.join(ADMIN_DIR, 'index.html')
/** Admin 是按需能力（spec 2026-09-30）：工程根没有 admin.html = 无后台项目。 */
const PROJECT_HAS_ADMIN = existsSync(path.join(ROOT, 'admin.html'))
/** 只交付 App UI（`npm run build:client`）：不校验、不改名 dist/admin/。 */
const CLIENT_ONLY = process.argv.includes('--client')
/** 只交付 Admin UI（`npm run build:admin`）：跳过全部 App 侧校验与拼装。 */
const ADMIN_ONLY = process.argv.includes('--admin')

if (CLIENT_ONLY && ADMIN_ONLY) {
  console.error('✗ --client 与 --admin 不能同时使用（两个产物都要就用 npm run build）')
  process.exit(1)
}

/** 壳提供的桥接 SDK：用站点根路径，跟随当前页面主机（判据见 references/10-webview-runtime.md）。 */
const CAPSULE_SDK_SRC = '/sdk/capsule.js'
/**
 * 构建期由 vite.config.ts 的 capsuleSdkInjectPlugin 注入，这里校验它确实落到了产物上。
 * SDK 必须真的挂在 `<script src>` 上——只写在注释里不算（判之前会先剥离注释）。
 */
const CAPSULE_SDK_TAG = new RegExp(
  `<script\\b[^>]*\\bsrc\\s*=\\s*["']${CAPSULE_SDK_SRC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
  'i',
)

/** 构建期合法权限值，改动前请先核对 builder-app-packaging 的产物规格（references/01-artifact-spec.md） */
const BUILD_TIME_PERMISSIONS = [
  'camera',
  'flashlight',
  'album',
  'location',
  'contact',
  'bluetooth',
  'record',
]

const failures = []

function fail(message) {
  failures.push(message)
}

function info(message) {
  console.log(`· ${message}`)
}

/** 有问题就直接失败，不要产出半成品（App 侧与 Admin 侧两条收尾路径共用）。 */
function reportFailures() {
  if (failures.length === 0) return
  console.error('\n✗ 构建收尾失败：')
  for (const message of failures) console.error(`  · ${message}`)
  console.error('')
  process.exit(1)
}

/**
 * Admin 产物就绪性。
 * required=true（`--admin`：调用方明确要它）→ 必须存在；
 * required=false（默认路径）→ 只在「工程有 admin.html」时要求（按需能力，spec 2026-09-30）。
 * `--client` 走不到这里：那次交付根本不含 Admin。
 */
function checkAdminArtifact(required) {
  if (!required && !PROJECT_HAS_ADMIN) return
  if (!existsSync(ADMIN_ENTRY) && !existsSync(ADMIN_RENAMED)) {
    fail('缺少 dist/admin/admin.html（Admin UI 构建产物）')
  }
}

/** 模板本体（未被脚手架替换过）里会保留 `p_fe2def065fda0280` 这类占位符，此时跳过对应校验 */
const isPlaceholder = (value) => typeof value === 'string' && value.includes('{{')

/** 递归列出目录下指定扩展名的文件（目录不存在时返回空数组） */
function listFiles(dir, exts) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, exts))
    else if (exts.includes(path.extname(entry.name))) out.push(full)
  }
  return out
}

/**
 * XML / HTML 的注释体不允许含两个连续横杠 `--`（非法注释），
 * Android 打包（aapt）解析到会直接失败——典型来源是注释里写了 CSS 变量名 `--brand-600`。
 * 口径见 builder-app-packaging 的产物规格（references/01-artifact-spec.md）。
 */
function findIllegalComments(files) {
  const offenders = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    let from = 0
    while (from < text.length) {
      const open = text.indexOf('<!--', from)
      if (open === -1) break
      const close = text.indexOf('-->', open + 4)
      if (close === -1) break
      if (text.slice(open + 4, close).includes('--')) {
        offenders.push(`${path.relative(ROOT, file)}:${text.slice(0, open).split('\n').length}`)
      }
      from = close + 3
    }
  }
  return offenders
}

/* --- 只收尾 Admin（`npm run build:admin`）---------------------------------- *
 * 调用方要的就是 dist/admin/：App 侧（capsule 校验 / 注释检查 / dist/client/ 拼装）
 * 整段跳过——这次交付里没有 APK bundle，校验它既没意义，还会让 Admin 构建因为 App 侧
 * 的问题而失败；拆成两条命令的意义正是两边互不牵连（见文件头注释）。 */

if (ADMIN_ONLY) {
  checkAdminArtifact(true)
  reportFailures()

  rmSync(ADMIN_RENAMED, { force: true })
  renameSync(ADMIN_ENTRY, ADMIN_RENAMED)
  info('dist/admin/index.html 就绪（已把 admin.html 重命名为 index.html）')
  console.log('✓ 构建完成：dist/admin/（Admin UI 站点）；本次为 --admin，未构建 App UI')
  process.exit(0)
}

/* --- 1. 校验 capsule/manifest.json --------------------------------------- */

const manifestPath = path.join(CAPSULE_DIR, 'manifest.json')
if (!existsSync(manifestPath)) {
  fail('缺少 capsule/manifest.json')
}

let manifest = {}
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`capsule/manifest.json 不是合法 JSON：${error.message}`)
  }

  if (!manifest.applicationId) fail('manifest.applicationId 必填')
  if (!manifest.name) fail('manifest.name 必填')
  if (!manifest.version) fail('manifest.version 必填')
  if (!Number.isInteger(manifest.versionCode) || manifest.versionCode < 1) {
    fail(`manifest.versionCode 必须是正整数，当前：${JSON.stringify(manifest.versionCode)}`)
  }
  if (!manifest.description) fail('manifest.description 必填')
  // 应用运行方向的**唯一来源**（capability.json 不再重复登记）：portrait 锁竖屏 /
  // landscape 锁横屏 / auto 已适配横竖屏、不锁定不补偿。打包时由壳在原生层按本字段锁定、
  // 平台预览也按它限制横竖屏切换，H5 侧不做任何方向补偿。
  if (manifest.orientation !== 'portrait' && manifest.orientation !== 'landscape' && manifest.orientation !== 'auto') {
    fail(`manifest.orientation 只能是 portrait / landscape / auto（应用运行方向的唯一来源），当前：${JSON.stringify(manifest.orientation)}`)
  }
  if ('fullscreen' in manifest && typeof manifest.fullscreen !== 'boolean') {
    fail('manifest.fullscreen 若填写，必须是布尔值')
  }

  const permissions = manifest.permissions ?? []
  if (!Array.isArray(permissions)) {
    fail('manifest.permissions 必须是字符串数组')
  } else {
    const unknown = permissions.filter((value) => !BUILD_TIME_PERMISSIONS.includes(value))
    if (unknown.length > 0) {
      fail(`manifest.permissions 含非法值：${unknown.join(', ')}（合法值：${BUILD_TIME_PERMISSIONS.join(' / ')}）`)
    }
  }

  // 原子能力（可选）：契约与脚本只能放在 capsule/functions/（构建只复制这个目录）。
  // 契约内容的完整校验在 library/app-functions 的 check-functions.mjs，平台打包时壳会再校验一次。
  if ('appFunctions' in manifest) {
    for (const [key, ext] of [['contract', '.json'], ['entry', '.js']]) {
      const rel = manifest.appFunctions?.[key]
      const inside = typeof rel === 'string' && rel.startsWith('functions/') && !/[\\:]/.test(rel)
        && rel.split('/').every((part) => part && !part.startsWith('.'))
      if (!inside || !rel.endsWith(ext)) {
        fail(`manifest.appFunctions.${key} 必须是 capsule/functions/ 下的 ${ext} 文件，当前：${JSON.stringify(rel)}`)
      } else if (!existsSync(path.join(CAPSULE_DIR, rel))) {
        fail(`manifest.appFunctions.${key}「${rel}」在 capsule/ 下不存在`)
      }
    }
  } else if (existsSync(FUNCTIONS_DIR)) {
    console.log('⚠ capsule/functions/ 存在，但 capsule/manifest.json 没有声明 appFunctions：原子能力不会打进产物')
  }

  // 版本号必须与页面里展示的版本一致，避免"APK 显示 0.1.0、设置页显示 1.2.0"
  const appConfigPath = path.join(ROOT, 'src', 'shared', 'config', 'app.ts')
  if (existsSync(appConfigPath)) {
    const matched = /APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(readFileSync(appConfigPath, 'utf8'))
    if (matched && matched[1] !== manifest.version) {
      fail(`版本号不一致：capsule/manifest.json 的 version 是 ${manifest.version}，src/shared/config/app.ts 的 APP_VERSION 是 ${matched[1]}——请同步为同一个值`)
    }
  }
}

if (isPlaceholder(manifest.applicationId) || isPlaceholder(manifest.name)) {
  console.log(
    '⚠ capsule/manifest.json 仍含未替换的占位符（模板本体）：脚手架生成的工程应已替换成真实 applicationId',
  )
}

/* --- 2. 校验两个构建产物 -------------------------------------------------- */

const appEntry = path.join(CLIENT_DIR, 'web', 'index.html')
if (!existsSync(appEntry)) {
  fail('缺少 dist/client/web/index.html（App UI 构建产物）')
} else {
  // 只看真实的资源引用：注释里的字符串不算数（否则"删掉 script、只留注释"也能过）
  const html = readFileSync(appEntry, 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  if (html.includes('appassets.capsule.app')) {
    fail('dist/client/web/index.html 仍引用已停用的 appassets.capsule.app，桥接 SDK 请用 /sdk/capsule.js')
  }
  if (!CAPSULE_SDK_TAG.test(html)) {
    fail('dist/client/web/index.html 里没有原生桥接 SDK（/sdk/capsule.js）——本应由构建期注入，'
      + '检查 vite.config.ts 的 capsuleSdkInjectPlugin 是否还在 plugins 里')
  }
}

// Admin 是按需能力（spec 2026-09-30）：工程根没有 admin.html = 无后台项目，
// 不要求 dist/admin 产物；有 admin.html 的工程，产物缺失仍是构建失败。
// `--client`（只打 App）时这次交付根本不含 Admin，不做这项要求。
if (!CLIENT_ONLY) checkAdminArtifact(false)

/* --- 3. 校验 entry 指向的文件真实存在 ------------------------------------ */

if (manifest.entry) {
  const entryFile = path.join(CLIENT_DIR, manifest.entry)
  if (!existsSync(entryFile)) {
    fail(`manifest.entry「${manifest.entry}」在 dist/client/ 下不存在`)
  }
}

/* --- 4. 校验 XML / HTML 注释不含 `--`（否则 Android 打包失败） ------------ */

const commentOffenders = findIllegalComments([
  ...listFiles(path.join(CAPSULE_DIR, 'icon'), ['.xml']),
  ...listFiles(path.join(CLIENT_DIR, 'web'), ['.html']),
])
if (commentOffenders.length > 0) {
  fail(
    `XML / HTML 注释里出现两个连续横杠（--），Android 打包会直接失败：\n      ${commentOffenders.join('\n      ')}\n` +
      '      改工程里的源文件（图标注释在 capsule/icon/*.xml、页面注释在 index.html），把 `--` 去掉或改写该注释，再重新构建',
  )
}

/* --- 5. 有问题就直接失败，不要产出半成品 --------------------------------- */

reportFailures()

/* --- 6. 拼装 dist/client/ = <applicationId>/ 的内容 ---------------------- */

mkdirSync(CLIENT_DIR, { recursive: true })
cpSync(manifestPath, path.join(CLIENT_DIR, 'manifest.json'))

const signingDir = path.join(CAPSULE_DIR, 'signing')
if (!existsSync(signingDir)) {
  console.error('✗ 缺少 capsule/signing/（打包 APK 的签名证书目录）')
  process.exit(1)
}
if (!ensureDebugSigning({ quiet: true })) process.exit(1)
cpSync(signingDir, path.join(CLIENT_DIR, 'signing'), {
  recursive: true,
  // 跳过 .gitkeep 这类占位文件，别把它们带进 bundle
  filter: (src) => !path.basename(src).startsWith('.'),
})

const iconDir = path.join(CAPSULE_DIR, 'icon')
if (existsSync(iconDir)) {
  cpSync(iconDir, path.join(CLIENT_DIR, 'icon'), { recursive: true })
} else {
  info('capsule/icon/ 不存在，桌面将使用壳默认图标')
}

rmSync(path.join(CLIENT_DIR, 'functions'), { recursive: true, force: true })
if (manifest.appFunctions) {
  cpSync(FUNCTIONS_DIR, path.join(CLIENT_DIR, 'functions'), {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith('.'),
  })
  info('已复制 capsule/functions/（原子能力的契约与脚本）')
}

info(`dist/client/ 就绪（applicationId=${manifest.applicationId}，version=${manifest.version}）`)

/* --- 7. dist/admin/ 自成站点根 ------------------------------------------- */

if (!CLIENT_ONLY && existsSync(ADMIN_ENTRY)) {
  rmSync(ADMIN_RENAMED, { force: true })
  renameSync(ADMIN_ENTRY, ADMIN_RENAMED)
  info('dist/admin/index.html 就绪（已把 admin.html 重命名为 index.html）')
}

/* --- 8. 完成 -------------------------------------------------------------- */

if (CLIENT_ONLY) {
  console.log('✓ 构建完成：dist/client/（壳侧 bundle 内容）；本次为 --client，未构建 Admin UI')
} else {
  console.log('✓ 构建完成：dist/client/（壳侧 bundle 内容）、dist/admin/（Admin UI 站点）')
}
