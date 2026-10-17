/* =============================================================================
 * 安全区（状态栏 / 手势条）—— 全局唯一取值处
 *
 * 背景：H5 从屏幕最顶端铺到手势条区域（状态栏 / 手势条是透明底、内容作为背景），
 * 页面该"让出"还是"穿透"由设计决定，但**取值**不许页面各算各的。
 *
 * 启动时调用一次 `initSafeArea()`：读值 → 写全局 CSS 变量
 * `--safe-top` / `--safe-bottom` / `--safe-left` / `--safe-right`（px），页面布局只消费这四个变量：
 *  - 真机（含真机预览）：调壳的 `getSafeArea`，由壳按机型 / 全屏 / 横竖屏适配
 *    （left / right 是横屏刘海、侧边导航栏的占位）；
 *  - 浏览器 / 平台预览（假壳）：桥接层回落 mock，返回模拟值（见 bridge/mock.ts，
 *    随 `capsule/manifest.json` 的 fullscreen 与**横竖屏切换**变化）。
 *
 * 横竖屏切换：`initSafeArea()` 会一并监听视口变化（`resize` / `screen.orientation`），
 * 变化后**重新取一次**（真机走壳、预览走假壳）——页面不要自己再监听或重算。
 *
 * 其它：
 *  - tokens.css 里 `--safe-*` 还接了一层首帧兜底（壳写的 `--sat` 一族 / env()），
 *    拿不到壳值时先用它；
 *  - 画布 / 计算类场景要数值时用 `getSafeAreaInsets()`，与 CSS 变量同源；
 *  - 页面里**不要**直接 `invokeNative('getSafeArea')` 再自己算一遍——重复取值
 *    会和这里的变量不一致（布局与画布对不上）。
 * ========================================================================== */

import { invokeNative } from '@/shared/bridge'

/** 安全区（四个方向），单位 px（壳给的是 dp，1 dp = 1 CSS px） */
export interface SafeAreaInsets {
  /** 顶部：状态栏高度 */
  top: number
  /** 底部：导航条 / 手势条高度 */
  bottom: number
  /** 左侧：横屏刘海 / 侧边导航栏占位，竖屏通常为 0 */
  left: number
  /** 右侧：同 left */
  right: number
}

/** 把四边写进全局 CSS 变量（行内样式优先于 tokens.css 的兜底链） */
function applyInsets(insets: SafeAreaInsets): void {
  const root = document.documentElement
  const set = (name: string, value: number) => {
    if (Number.isFinite(value)) {
      root.style.setProperty(name, `${Math.max(0, Math.round(value))}px`)
    }
  }
  set('--safe-top', insets.top)
  set('--safe-bottom', insets.bottom)
  set('--safe-left', insets.left)
  set('--safe-right', insets.right)
}

/** 取一次当前安全区并落到 CSS 变量；读不到时保留兜底值、不抛错 */
async function refreshSafeArea(): Promise<void> {
  try {
    applyInsets(await invokeNative('getSafeArea'))
  } catch {
    // 壳未就绪 / 调用失败：保留 tokens.css 的兜底值，不打断
  }
}

/** 监听视口变化（横竖屏切换在 WebView / 浏览器里都表现为 resize / orientation change） */
function watchSafeArea(): void {
  let timer = 0
  const onChange = () => {
    window.clearTimeout(timer)
    // 旋屏时事件会连发多次：稍等布局稳定后重取一次
    timer = window.setTimeout(() => {
      void refreshSafeArea()
    }, 150)
  }
  window.addEventListener('resize', onChange)
  screen.orientation?.addEventListener?.('change', onChange)
}

let started = false

/**
 * 启动时调用一次（App 入口在渲染前调用；Admin 是独立部署的响应式 Web，不进壳、不调用）。
 * 读完当前值后持续监听视口变化，横竖屏切换时自动重取。读不到时不抛错、不阻塞：兜底链继续生效。
 */
export async function initSafeArea(): Promise<void> {
  if (started) return
  started = true
  await refreshSafeArea()
  watchSafeArea()
}

/**
 * 读当前生效的安全区数值（四边，px）。与 CSS 变量 `--safe-*` 同源，
 * 供画布 / 计算类场景使用；纯布局一律优先用 CSS 变量（`pt-safe-top` / `spacing.safe-*`）。
 */
export function getSafeAreaInsets(): SafeAreaInsets {
  const style = getComputedStyle(document.documentElement)
  const px = (name: string) => Number.parseFloat(style.getPropertyValue(name)) || 0
  return {
    top: px('--safe-top'),
    bottom: px('--safe-bottom'),
    left: px('--safe-left'),
    right: px('--safe-right'),
  }
}
