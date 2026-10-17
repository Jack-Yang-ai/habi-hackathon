/**
 * Tailwind 只负责把「语义 token」暴露成原子类，颜色字面值一律写在 src/shared/styles/tokens.css。
 * 新增颜色时先加 token，再在这里挂一次，禁止在组件里写死色值（如 bg-[#1a1a1a]）。
 *
 * 注：`svh` / `lvh` / `dvh` 这三档高度（Tailwind 默认自带）不需要在这里特化——它们在
 * 构建期由 postcss.config.js 的 viewport-unit 插件统一重写成老内核可用的 calc(var(--1…))，
 * 所以 `h-dvh`、`h-[33dvh]`、`min-h-[50dvh]` 等任意倍数值都自动兜底（口径见 references/07-mobile-adaptation.md §1）。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './admin.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'rgb(var(--background) / <alpha-value>)',
        foreground: 'rgb(var(--foreground) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          foreground: 'rgb(var(--surface-foreground) / <alpha-value>)',
          muted: 'rgb(var(--surface-muted) / <alpha-value>)',
        },
        // 设备背屏：深苔绿底 + 米白字（背屏只显示小伴的状态，不参与主界面配色）
        screen: {
          DEFAULT: 'rgb(var(--screen-surface) / <alpha-value>)',
          surface: 'rgb(var(--screen-surface) / <alpha-value>)',
          foreground: 'rgb(var(--screen-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'rgb(var(--muted) / <alpha-value>)',
          foreground: 'rgb(var(--muted-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'rgb(var(--primary) / <alpha-value>)',
          foreground: 'rgb(var(--primary-foreground) / <alpha-value>)',
          soft: 'rgb(var(--primary-soft) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'rgb(var(--secondary) / <alpha-value>)',
          foreground: 'rgb(var(--secondary-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          foreground: 'rgb(var(--accent-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
          foreground: 'rgb(var(--success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning) / <alpha-value>)',
          foreground: 'rgb(var(--warning-foreground) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          foreground: 'rgb(var(--danger-foreground) / <alpha-value>)',
        },
        border: 'rgb(var(--border) / <alpha-value>)',
        input: 'rgb(var(--input) / <alpha-value>)',
        ring: 'rgb(var(--ring) / <alpha-value>)',
        overlay: 'rgb(var(--overlay) / <alpha-value>)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        full: 'var(--radius-full)',
      },
      borderWidth: {
        // 发丝线：App UI 的分隔线用它（`border-hairline` / `border-b-hairline`），见 tokens.css 的 --hairline
        hairline: 'var(--hairline)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        caption: ['var(--text-caption)', { lineHeight: 'var(--leading-caption)' }],
        body: ['var(--text-body)', { lineHeight: 'var(--leading-body)' }],
        title: ['var(--text-title)', { lineHeight: 'var(--leading-title)' }],
        display: ['var(--text-display)', { lineHeight: 'var(--leading-display)' }],
      },
      spacing: {
        'safe-top': 'var(--safe-top)',
        'safe-bottom': 'var(--safe-bottom)',
        'safe-left': 'var(--safe-left)',
        'safe-right': 'var(--safe-right)',
        'navbar': 'var(--navbar-height)',
        'tabbar': 'var(--tabbar-height)',
      },
      minHeight: {
        tap: 'var(--tap-min)',
      },
      minWidth: {
        tap: 'var(--tap-min)',
      },
      screens: {
        xs: '375px',
      },
      transitionDuration: {
        fast: '120ms',
        base: '200ms',
      },
    },
  },
  plugins: [],
}
