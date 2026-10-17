/* =============================================================================
 * 生成调试用签名证书：capsule/signing/capsule.p12
 *
 * 为什么需要它：打包 `<applicationId>.bundle` 时 `signing/` 是**必有**项，
 * 缺了会让 APK 构建直接报「没有签名文件」。`dist/` 不进版本库，所以每次
 * `npm run build` 都会由 scripts/finalize-build.mjs 调本脚本确保它存在。
 *
 * 密码 / 别名 / 有效期都从 capsule/signing/capsule.properties 读取，
 * 保证证书与 properties 永远一致（properties 是这两者的唯一来源）。
 *
 * 调试证书不能上架应用商店。拿到正式证书时，把 .p12/.jks 与对应 properties
 * 覆盖到 capsule/signing/ 即可，本脚本不会覆盖已存在的 capsule.p12。
 * ========================================================================== */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SIGNING_DIR = path.join(ROOT, 'capsule', 'signing')
const KEYSTORE = path.join(SIGNING_DIR, 'capsule.p12')
const PROPERTIES = path.join(SIGNING_DIR, 'capsule.properties')
const MANIFEST = path.join(ROOT, 'capsule', 'manifest.json')

const force = process.argv.includes('--force')

function readProperties(file) {
  const values = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const at = trimmed.indexOf('=')
    if (at === -1) continue
    values[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
  }
  return values
}

function resolveKeytool() {
  const candidates = [
    process.env.KEYTOOL,
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'keytool') : null,
    'keytool',
  ].filter(Boolean)
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-help'], { stdio: 'ignore' })
    if (!probe.error && probe.status === 0) return candidate
  }
  return null
}

export function ensureDebugSigning({ quiet = false } = {}) {
  if (existsSync(KEYSTORE) && !force) {
    if (!quiet) console.log('· 签名证书已存在，跳过生成：capsule/signing/capsule.p12')
    return true
  }
  if (!existsSync(PROPERTIES)) {
    console.error('✗ 缺少 capsule/signing/capsule.properties（storePassword / keyAlias / keyPassword）')
    return false
  }
  const keytool = resolveKeytool()
  if (!keytool) {
    console.error('✗ 找不到 keytool（JDK 未安装或不在 PATH 中），无法生成签名证书')
    console.error('  修复：安装 JDK，或直接把正式证书放到 capsule/signing/capsule.p12')
    return false
  }

  const { storePassword, keyAlias, keyPassword } = readProperties(PROPERTIES)
  if (!storePassword || !keyAlias || !keyPassword) {
    console.error('✗ capsule/signing/capsule.properties 缺字段：需要 storePassword / keyAlias / keyPassword')
    return false
  }
  const appName = JSON.parse(readFileSync(MANIFEST, 'utf8')).name ?? 'App'

  mkdirSync(SIGNING_DIR, { recursive: true })
  const result = spawnSync(
    keytool,
    [
      '-genkeypair',
      '-noprompt',
      '-keystore',
      KEYSTORE,
      '-storetype',
      'PKCS12',
      '-alias',
      keyAlias,
      '-keyalg',
      'RSA',
      '-keysize',
      '2048',
      '-validity',
      '36500',
      '-storepass',
      storePassword,
      '-keypass',
      keyPassword,
      '-dname',
      `CN=${appName}, O=StepX, C=CN`,
    ],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) {
    console.error('✗ keytool 生成签名证书失败')
    return false
  }
  if (!quiet) console.log('· 已生成调试签名证书：capsule/signing/capsule.p12（不可用于上架）')
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(ensureDebugSigning() ? 0 : 1)
}
