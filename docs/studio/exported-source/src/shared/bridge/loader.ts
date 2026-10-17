/* =============================================================================
 * 宿主探测：判断当前跑在真机 App 壳里，还是浏览器预览里
 *
 * 判定标准是「探测调用能不能成功」，不是「脚本有没有加载成功」——
 * 浏览器里脚本能加载，但 invoke 会失败。
 *
 * 关于 capsule SDK：源工程 index.html **不**静态引入它——浏览器 / 平台预览没有这个文件，
 * 直接写会 404。它由构建期插件（vite.config.ts 的 capsuleSdkInjectPlugin）写进产物 HTML
 * （`<script src="/sdk/capsule.js">`，跟随当前页面主机，只在壳内可达），加载成功即挂出
 * `window.capsule`。这里只做探测与回落，不注入、不改写 SDK。
 * ========================================================================== */

import { createMockSdk } from './mock'
import type { BridgeMode, CapsuleSdk } from './types'

const PROBE_TIMEOUT = 1500

declare global {
  interface Window {
    capsule?: CapsuleSdk
  }
}

export interface BridgeHandle {
  mode: BridgeMode
  sdk: CapsuleSdk
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timeout`)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function probeNative(sdk: CapsuleSdk): Promise<boolean> {
  try {
    await withTimeout(sdk.invoke('canIUse', { args: 'getSystemInfo' }), PROBE_TIMEOUT, 'canIUse')
    return true
  } catch {
    return false
  }
}

function forcedMode(): BridgeMode | undefined {
  const param = new URLSearchParams(window.location.search).get('bridge')
  if (param === 'mock' || param === 'native') return param
  return undefined
}

let cached: Promise<BridgeHandle> | undefined

/** 探测并缓存宿主。多次调用只探测一次。 */
export function loadBridge(): Promise<BridgeHandle> {
  if (cached) return cached

  cached = (async (): Promise<BridgeHandle> => {
    const forced = forcedMode()
    if (forced === 'mock') return { mode: 'mock', sdk: createMockSdk() }

    const sdk = window.capsule
    if (!sdk || typeof sdk.invoke !== 'function') {
      // 壳没注入 SDK = 不在壳里（浏览器预览 / 平台预览），走 mock
      return { mode: 'mock', sdk: createMockSdk() }
    }

    const isNative = forced === 'native' ? true : await probeNative(sdk)
    return isNative ? { mode: 'native', sdk } : { mode: 'mock', sdk: createMockSdk() }
  })()

  return cached
}
