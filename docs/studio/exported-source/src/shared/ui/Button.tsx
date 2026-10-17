import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/shared/lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'danger-ghost'
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:brightness-110',
  secondary: 'bg-secondary text-secondary-foreground hover:brightness-[0.97]',
  outline: 'border border-border bg-surface text-surface-foreground hover:bg-accent',
  ghost: 'text-foreground hover:bg-accent hover:text-accent-foreground',
  // danger：红底实心，只给"确认弹窗里的一次性决策"用（如确认删除）。
  danger: 'bg-danger text-danger-foreground hover:brightness-110',
  // danger-ghost：红字 + 淡红底反馈，页面 / 列表里的破坏性入口默认用它（克制，不抢主行动）。
  // 口径见 ui-design-skill 的 references/02-app-ui-mobile-h5.md §5。
  'danger-ghost': 'text-danger hover:bg-danger/10 active:bg-danger/20',
}

const SIZES: Record<ButtonSize, string> = {
  // sm（36px）是鼠标场景的尺寸，只在 Admin UI 等桌面界面用；
  // App UI（`src/app/**`）一律用 md(44) / lg(52)，保证可点区域 ≥44px（见 07-mobile-adaptation.md §3）。
  sm: 'h-9 px-3 text-caption rounded-md',
  md: 'min-h-tap px-4 text-body rounded-md',
  lg: 'min-h-[52px] px-5 text-title rounded-md',
  icon: 'size-11 rounded-md',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  /** 占满一行 */
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading = false, block = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // loading 时禁用，避免重复触发原生调用（选图、扫码这类会重复弹窗）
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 font-medium',
        'transition-[transform,background-color,filter] duration-fast',
        // 触摸反馈：按下轻微缩放，配合原生 haptic 使用
        'active:scale-[0.97]',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  )
})
