import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/shared/lib/cn'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
}

/**
 * 应用内弹层：手机上从底部升起（bottom sheet），≥768px 居中显示。
 *
 * 什么时候用它而不是原生 showModal：
 *  - 需要自定义内容（表单、多选、富文本）时用本组件；
 *  - 只是「确认 / 取消」这类标准弹窗，App UI 里优先用原生 showModal（体验更贴近系统）。
 */
export function Dialog({ open, onClose, title, description, children, footer, className }: DialogProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-overlay/50 md:items-center"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          'w-full animate-dialog-in bg-surface text-surface-foreground shadow-lg',
          'rounded-t-xl pb-safe-bottom',
          'md:w-[min(92vw,520px)] md:rounded-xl md:pb-0',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 px-4 pt-4">
          <div>
            {title && <h2 className="text-title font-semibold">{title}</h2>}
            {description && <p className="mt-1 text-caption text-muted-foreground">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="-mr-1 flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent"
          >
            <X className="size-5" />
          </button>
        </div>
        {children && <div className="px-4 py-4">{children}</div>}
        {footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
      </div>
    </div>
  )
}
