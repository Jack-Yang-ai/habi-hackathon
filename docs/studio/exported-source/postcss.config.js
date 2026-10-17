import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

/*
 * svh / lvh / dvh 老内核兜底（构建期重写 CSS 值）：
 * 把 CSS 里出现的 `100dvh` / `33dvh` / `100svh` … 统一改写成 `calc(var(--1dvh, 1dvh) * 100)` 形式——
 * 原生支持的内核由 `var()` 无损回退到原生单位，老内核由 src/shared/native/viewport-units.ts
 * 写好的 `--1svh` / `--1dvh` / `--1lvh` 生效。于是 `h-dvh`、`h-[33dvh]`、`min-h-[50dvh]`
 * 等任意倍数值都自动兜底，组件里不用手写 calc（口径见 references/07-mobile-adaptation.md §1）。
 * 注意：只覆盖 CSS；行内样式（style={{ height: '33dvh' }}）不经过这里，整屏高度请用 class。
 */
const VIEWPORT_UNIT = /(?<![\w-])(\d*\.?\d+)(dvh|svh|lvh)(?![\w-])/g

const viewportUnitPolyfill = {
  postcssPlugin: 'viewport-unit-polyfill',
  Declaration(decl) {
    if (decl.prop.startsWith('--')) return // 不动自定义属性声明（如 --1dvh 自身的赋值）
    if (!/dvh|svh|lvh/.test(decl.value)) return
    // 幂等闸：PostCSS 在 decl.value 变化后会重跑 visitor，而重写结果里仍含 `var(--1…, 1…)`
    // 的回退值——不拦住的话会命中回退值里的 `1dvh` 无限膨胀（最终把构建挂死）。已重写过就跳过。
    if (decl.value.includes('var(--1')) return
    decl.value = decl.value.replace(
      VIEWPORT_UNIT,
      (_, num, unit) => `calc(var(--1${unit}, 1${unit}) * ${num})`,
    )
  },
}

export default {
  plugins: [
    tailwindcss,
    // 必须在 tailwindcss 之后：这样 Tailwind 生成的 `h-dvh` / `h-[33dvh]` 也会被重写
    viewportUnitPolyfill,
    autoprefixer,
  ],
}
