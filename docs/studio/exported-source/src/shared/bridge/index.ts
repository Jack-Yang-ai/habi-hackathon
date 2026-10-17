/* =============================================================================
 * 业务代码唯一允许使用的原生调用入口
 *
 * 职责：
 *  1. 自动区分真机壳 / 浏览器 mock，业务无需分支；
 *  2. 把原生 reject 归一化成 BridgeError（error.code），业务按 code 分支；
 *  3. 剥掉 ok / errMsg 包装，只返回业务字段；
 *  4. 浏览器预览里把「原生能力缺口」上报给 DevServer（仅 dev，真机不上报）。
 *
 * 调用约定、错误语义与超时口径以 capsule-native-api 的 references/01-call-conventions.md 为准；
 * 单个接口的入参出参从它的 references/02-api-reference.md 跳到 references/api/ 下对应分册再查。
 * ========================================================================== */

import { reportNativeGap, reportPreviewHost, reportSimulatedApi } from './dev-report'
import { loadBridge, type BridgeHandle } from './loader'
import {
  BridgeError,
  type BridgeErrorCode,
  type BridgeMode,
  type NativeApiName,
  type NativeEventMap,
  type NativeEventName,
  type NativeLogLevel,
  type NativeParams,
  type NativeResult,
} from './types'

export type { BridgeErrorCode, BridgeMode } from './types'
export { BridgeError } from './types'

/**
 * 把原生失败归一化成错误码。
 *
 * 原生侧的 errMsg 固定是 `"<apiName>:fail <原因>"`，下面这些原因串是稳定契约，
 * 所以这里只匹配它们，不做模糊猜测 —— 猜错会把「用户取消」显示成「调用失败」。
 */
function normalizeError(apiName: string, error: unknown): BridgeError {
  if (error instanceof BridgeError) return error

  const raw = error as { errMsg?: string; message?: string } | undefined
  const text = raw?.errMsg || raw?.message || String(error)
  const reason = text.replace(/^[^:]*:\s*fail\s*/i, '')

  let code: BridgeErrorCode = 'unknown'
  if (/^cancel$/i.test(reason)) code = 'cancelled'
  else if (/bridge timeout/i.test(reason)) code = 'timeout'
  else if (/native bridge unavailable|not implemented|unsupported/i.test(reason))
    code = 'unsupported'
  else if (/privacy consent required/i.test(reason)) code = 'privacy'
  else if (/auth deny|permission denied|not authorized/i.test(reason)) code = 'denied'
  else if (/required|invalid|not found|no such|unavailable/i.test(reason)) code = 'not-found'

  return new BridgeError(code, apiName, text, error)
}

let currentMode: BridgeMode | undefined
let currentSdk: BridgeHandle['sdk'] | undefined

/**
 * 探测宿主并同步当前模式。
 * 浏览器预览（mock）下顺带把「这是模拟环境」告诉 DevServer —— 只在 dev 生效，
 * 真机（native）不产生任何开发期提示。
 */
async function resolveHandle(): Promise<BridgeHandle> {
  const handle = await loadBridge()
  currentMode = handle.mode
  currentSdk = handle.sdk
  if (handle.mode === 'mock') reportPreviewHost(handle.mode)
  return handle
}

/** 初始化宿主探测。App 启动时调用一次即可；未调用时首次 invoke 会自动初始化。 */
export async function initBridge(): Promise<BridgeMode> {
  const handle = await resolveHandle()
  return handle.mode
}

/** 当前宿主。未初始化时返回 undefined。 */
export function getBridgeMode(): BridgeMode | undefined {
  return currentMode
}

/**
 * 调用原生能力。成功返回业务字段（不含 ok / errMsg），失败抛 BridgeError。
 *
 * **不额外加 JS 侧超时**：SDK 只给定位 / 传感器 / 网络设了桥超时（档位见
 * capsule-native-api 的 references/01-call-conventions.md 硬性规则第 10 条），
 * 选图等人的接口会一直等；这里再包一层只会提前把还在系统选择器里的调用判死。
 */
export async function invokeNative<K extends NativeApiName>(
  apiName: K,
  params?: NativeParams<K>,
): Promise<NativeResult<K>> {
  const handle = await resolveHandle()

  try {
    const raw = await handle.sdk.invoke(apiName, params as unknown)
    const { ok: _ok, errMsg: _errMsg, ...rest } = raw as Record<string, unknown>
    // 预览里只能拿到模拟值的能力（拍照 / 扫码 / 定位等）：提醒去真机验收
    if (currentMode === 'mock') reportSimulatedApi(apiName)
    return rest as NativeResult<K>
  } catch (error) {
    const normalized = normalizeError(apiName, error)
    // 预览环境调不通 / 没有 mock 实现：上报给 DevServer 提醒去真机验证；真机不上报
    if (currentMode === 'mock') reportNativeGap(apiName, normalized.code, normalized.message)
    throw normalized
  }
}

/** 订阅原生事件，返回取消订阅函数。组件卸载时必须调用返回值。 */
export async function onNativeEvent<K extends NativeEventName>(
  channel: K,
  handler: (payload: NativeEventMap[K]) => void,
): Promise<() => void> {
  const handle = await resolveHandle()

  const wrapped = (payload: unknown) => handler(payload as NativeEventMap[K])
  handle.sdk.on(channel, wrapped)
  return () => handle.sdk.off?.(channel, wrapped)
}

/**
 * 能力探测：当前壳是否支持该接口。
 * mock 宿主一律返回 true —— 预览里没有真实壳，隐藏入口只会让页面看起来「缺功能」。
 */
export async function isNativeApiAvailable(apiName: NativeApiName | string): Promise<boolean> {
  const handle = await resolveHandle()
  if (handle.mode === 'mock') return true
  try {
    const { data } = await invokeNative('canIUse', { args: apiName })
    return data === true
  } catch {
    return false
  }
}

function writeLog(level: NativeLogLevel, tag: string, message: string, extra?: unknown): void {
  const log = currentSdk?.log
  if (log) {
    try {
      log(level, tag, message, extra)
    } catch {
      // 日志是 fire-and-forget，任何失败都不允许影响业务
    }
    return
  }
  // 浏览器预览里没有壳：回落到控制台，保证预览里也看得到
  const text = `[${tag}] ${message}`
  if (level === 'e') console.error(text, extra ?? '')
  else if (level === 'w') console.warn(text, extra ?? '')
  else console.info(text, extra ?? '')
}

/**
 * 日志出口：真机走 `capsule.log`（进容器日志目录），浏览器预览回落到 console。
 * 业务代码需要打日志时用它，不要直接 `console.log`（门禁 G31）。
 */
export const nativeLog = {
  v: (tag: string, message: string, extra?: unknown) => writeLog('v', tag, message, extra),
  d: (tag: string, message: string, extra?: unknown) => writeLog('d', tag, message, extra),
  i: (tag: string, message: string, extra?: unknown) => writeLog('i', tag, message, extra),
  w: (tag: string, message: string, extra?: unknown) => writeLog('w', tag, message, extra),
  e: (tag: string, message: string, extra?: unknown) => writeLog('e', tag, message, extra),
}
