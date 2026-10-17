import { useEffect, useRef, type RefObject } from 'react'

/**
 * 顶部穿透页的「状态栏垫底渐变」：媒体滚走后，正文会从状态栏后面经过——
 * 没有垫底时，滚动中的文字会和状态栏图标叠在一起、辨认度骤降。
 *
 * 这一层固定在屏幕顶部，是「页面主体背景色 → 透明」的渐变（安全区那一条是实色，
 * 往下 ~20px 渐隐到透明）；浓度随**正文锚点**滚入状态栏而渐显：
 *   · 锚点还在状态栏之下（状态栏那一条还是纯媒体）→ 完全透明，不遮挡头图；
 *   · 锚点进入状态栏区域 → 随进入深度线性加深；
 *   · 锚点到达屏幕最顶（媒体已完全滚过）→ 达到最浓，此后保持。
 * 往回滚时对称地退掉，不依赖任何"滚过某个点就锁死"的状态。
 *
 * 由 `AppShell` 在穿透页自动挂载，页面不用写这一层。锚点取法（口径见 07 §2）：
 *   1. 滚动容器内标了 `data-top-bleed-content` 的元素（推荐：头部媒体之后的第一个正文块）；
 *   2. 找不到标记时，退回「滚动容器第一个子元素的下沿」（媒体在最前面的常规穿透页）。
 *
 * 实现要点：被动 scroll 监听（scroll 事件本身已按帧合流）+ 直接写 `style.opacity`——
 * 不触发 React 重渲染；每帧只做一次 rect 读 + 一次样式写；安全区高度只在挂载 / resize 时
 * 读一次，滚动帧内没有 getComputedStyle。
 */
export function TopBleedScrim({ scroller }: { scroller: RefObject<HTMLElement | null> }) {
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const scrollEl = scroller.current
    const layer = layerRef.current
    if (!scrollEl || !layer) return

    let safeTop = 0

    /** 安全区高度：只在挂载 / resize 时读，滚动帧内闭包复用 */
    const readSafeTop = () =>
      Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0

    const update = () => {
      if (safeTop <= 0) {
        layer.style.opacity = '0'
        return
      }
      const anchor = scrollEl.querySelector<HTMLElement>('[data-top-bleed-content]')
      const contentTop = anchor
        ? anchor.getBoundingClientRect().top
        : (scrollEl.firstElementChild?.getBoundingClientRect().bottom ?? safeTop)
      const progress = Math.min(Math.max((safeTop - contentTop) / safeTop, 0), 1)
      layer.style.opacity = String(progress)
    }

    /** resize 会改 --safe-top（旋屏）也会改内容几何：重读后立刻重算一次 */
    const remeasure = () => {
      safeTop = readSafeTop()
      update()
    }

    remeasure()
    scrollEl.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', remeasure)
    return () => {
      scrollEl.removeEventListener('scroll', update)
      window.removeEventListener('resize', remeasure)
    }
  }, [scroller])

  return (
    <div
      ref={layerRef}
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-30"
      style={{
        height: 'calc(var(--safe-top) + 20px)',
        background:
          'linear-gradient(to bottom, rgb(var(--background)) var(--safe-top), rgb(var(--background) / 0) 100%)',
        opacity: 0,
      }}
    />
  )
}
