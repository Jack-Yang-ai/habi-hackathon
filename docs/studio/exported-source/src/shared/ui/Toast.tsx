import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import { cn } from '@/shared/lib/cn'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastOptions {
  title: string
  description?: string
  tone?: ToastTone
  /** 毫秒；0 表示不自动关闭 */
  duration?: number
}

interface ToastItem extends Required<Omit<ToastOptions, 'description'>> {
  id: number
  description?: string
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastContextValue>({ toast: () => undefined, dismiss: () => undefined })

const TONE_ICON = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
} as const

const TONE_CLASS = {
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
} as const

/**
 * 应用内 Toast。
 *
 * App UI 里的「轻提示」优先用原生 `showToast`（更贴近系统、性能更好）；
 * 本组件用于：管理后台（PC，无原生壳）、需要带描述/图标的富提示、以及原生接口不可用时的降级。
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = (nextId.current += 1)
      const item: ToastItem = {
        id,
        title: options.title,
        description: options.description,
        tone: options.tone ?? 'info',
        duration: options.duration ?? 2600,
      }
      setItems((prev) => [...prev.slice(-2), item])
      if (item.duration > 0) window.setTimeout(() => dismiss(id), item.duration)
    },
    [dismiss],
  )

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss }), [toast, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex flex-col items-center gap-2 px-4 pt-safe-top md:items-end md:px-6"
        role="status"
        aria-live="polite"
      >
        {items.map((item) => {
          const Icon = TONE_ICON[item.tone]
          return (
            <div
              key={item.id}
              className={cn(
                'animate-slide-up pointer-events-auto flex w-full max-w-sm items-start gap-2.5',
                'rounded-md border border-border bg-surface p-3 shadow-md',
              )}
            >
              <Icon className={cn('mt-0.5 size-4 shrink-0', TONE_CLASS[item.tone])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium">{item.title}</p>
                {item.description && (
                  <p className="mt-0.5 break-words text-caption text-muted-foreground">{item.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="-m-2 flex size-11 shrink-0 items-center justify-center rounded text-muted-foreground active:bg-accent"
                aria-label="关闭提示"
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  return useContext(ToastContext)
}
