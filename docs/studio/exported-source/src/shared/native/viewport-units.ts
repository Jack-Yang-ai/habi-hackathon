/* =============================================================================
 * 视口单位 polyfill：svh / lvh / dvh（低版本浏览器内核兜底）
 *
 * 现代浏览器原生支持 `svh` / `lvh` / `dvh`；老内核（Chrome < 108、Safari < 15.4 等）不认这三个单位，
 * 于是 Tailwind 的 `h-dvh` / `min-h-dvh` / `h-svh` …（以及 `.h-screen-dvh`）会整条失效。
 *
 * 做法：在 `:root` 上写三个自定义属性 `--1svh` / `--1dvh` / `--1lvh`（各 = 1 个对应单位的高度，px），
 * CSS 用 `calc(var(--1dvh, 1dvh) * N)` 消费：
 *   · **支持原生单位的浏览器**：`--1dvh` 留空，`var()` 回退到原生 `1dvh` → 无损走原生；
 *   · **不支持的老内核**：本脚本填入实测值 → `calc(实测 px * N)` 生效。
 * 视口变化（resize / 旋屏 / 软键盘）时重算。纯兜底：不改任何布局逻辑、不依赖端能力。
 *
 * 参考 https://github.com/joppuyo/large-small-dynamic-viewport-units-polyfill （MIT）。
 * 与上游的差异：**不限定移动端 UA**（老桌面内核同样需要兜底）；其余算法保持一致。
 * ========================================================================== */

function supportsNativeViewportUnits(): boolean {
  const css = typeof CSS !== 'undefined' ? CSS : undefined
  return Boolean(
    css?.supports &&
      css.supports('height: 100svh') &&
      css.supports('height: 100dvh') &&
      css.supports('height: 100lvh'),
  )
}

/** 量一次当前视口，写回 `--1svh` / `--1dvh` / `--1lvh`。 */
function measure(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  // svh = 小视口（浏览器顶底栏都在时的高度）→ documentElement.clientHeight；
  // dvh = 动态视口（当前可视高度）→ window.innerHeight。
  root.style.setProperty('--1svh', `${document.documentElement.clientHeight * 0.01}px`)
  root.style.setProperty('--1dvh', `${window.innerHeight * 0.01}px`)
  // lvh = 大视口（顶底栏都收起时）：用一个 fixed 的 100vh 元素量一次，量完即删。
  if (document.body) {
    const probe = document.createElement('div')
    probe.style.cssText =
      'position:fixed;left:0;top:0;bottom:0;width:1px;height:100vh;visibility:hidden;pointer-events:none'
    document.body.appendChild(probe)
    const large = probe.clientHeight
    probe.remove()
    root.style.setProperty('--1lvh', `${large * 0.01}px`)
  }
}

/**
 * 初始化视口单位兜底。**原生支持则什么都不做**（零副作用、零开销）。
 * 在 App UI 入口渲染前调用一次即可（见 `src/app/main.tsx`）。
 */
export function initViewportUnitsPolyfill(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  if (supportsNativeViewportUnits()) return

  let frame = 0
  const schedule = (): void => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(measure)
  }

  measure()
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', measure, { once: true })
  }
  window.addEventListener('resize', schedule, { passive: true })
  window.addEventListener('orientationchange', schedule, { passive: true })
  // 软键盘弹出 / 地址栏收放会改可视高度：优先跟 visualViewport（有则加）。
  window.visualViewport?.addEventListener('resize', schedule, { passive: true })
}
