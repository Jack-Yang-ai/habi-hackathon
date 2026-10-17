/* =============================================================================
 * 开发期原生能力缺口上报 —— 只在 dev 生效，真机与生产产物里是空实现
 *
 * 为什么需要它：平台预览与本地 `npm run dev` 都跑在浏览器里，没有 App 壳。
 * 原生能力要么由 mock 模拟、要么根本没实现，开发者很容易把「预览里能跑」
 * 误当成「真机没问题」。这里把「预览环境」与「能力缺口」回传到 Vite DevServer，
 * 由 DevServer 打印到终端，提醒开发者去真机验证。
 *
 * 约束（对应 02-iterability-contract.md 的 C14）：
 *  1. 整个上报由 `import.meta.env.DEV` 守卫：生产构建会被静态剔除，
 *     真机（native 宿主）与线上产物都不会产生任何上报；
 *  2. 上报失败必须静默吞掉，绝不能影响业务；
 *  3. 同一条信息只上报一次，避免刷屏。
 *
 * dev 下的两种预览（见 06-js-bridge.md）：
 *  · 在线预览：浏览器直接开 DevServer —— 没有壳，SDK 不可达，走 mock，会有提示；
 *  · 真机预览：App 壳指向 DevServer —— 壳在页面加载时提供 capsule SDK，探测通过后走 native，
 *    **不会有任何提示**。真机预览里若仍看到"浏览器预览"的提示，说明壳没提供 SDK
 *    （多半用的不是支持端能力的壳）。
 *
 * 本文件**不列任何原生能力清单**：能模拟哪些接口由 mock.ts 的 SIMULATED_APIS 决定，
 * 能力的完整清单与规格一律以 capsule-native-api Skill 为准。
 * ========================================================================== */

import { SIMULATED_APIS } from './mock'

/** DevServer 上报端点；由 vite.config.ts 中 `apply: 'serve'` 的中间件提供 */
const REPORT_ENDPOINT = '/__ai-builder/native-report'

const DEV = import.meta.env.DEV
const sent = new Set<string>()

interface NativeReport {
  level: 'notice' | 'warn'
  /** 去重键 */
  key: string
  message: string
  detail?: string
}

function report(entry: NativeReport): void {
  if (!DEV || sent.has(entry.key)) return
  sent.add(entry.key)

  if (entry.level === 'warn') console.warn(`[native] ${entry.message}`, entry.detail ?? '')
  else console.info(`[native] ${entry.message}`)

  try {
    void fetch(REPORT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // 上报只是开发期辅助手段，任何失败都不允许影响业务
  }
}

/** 预览宿主说明：整个 dev 会话只提示一次 */
export function reportPreviewHost(mode: string): void {
  report({
    level: 'notice',
    key: 'host:preview',
    message: `当前宿主为 ${mode}（浏览器预览，没有 App 壳）：原生能力为模拟实现，真机行为必须在 App 壳内验证。`,
    detail:
      '若你正用 App 壳连本 DevServer 做真机预览，出现本提示说明 capsule SDK 没加载成功——SDK 由壳提供，请确认用的是支持端能力的 App 壳。',
  })
}

/** 调用了只能模拟的能力：能跑通，但结果是假的 */
export function reportSimulatedApi(apiName: string): void {
  if (!SIMULATED_APIS.has(apiName)) return
  report({
    level: 'notice',
    key: `simulated:${apiName}`,
    message: `原生能力 ${apiName} 在预览环境返回的是模拟数据，需要到真机验收。`,
  })
}

/** 原生能力调不通 / 缺少 mock 实现 */
export function reportNativeGap(apiName: string, code: string, reason: string): void {
  report({
    level: 'warn',
    key: `gap:${apiName}`,
    message: `原生能力 ${apiName} 在预览环境不可用（${code}），需要到真机验证。`,
    detail: reason,
  })
}
