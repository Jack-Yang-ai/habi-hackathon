import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'

/**
 * 分组容器。
 *
 * 刻意**不**带描边与阴影：移动端的分组靠"底色差（bg-background ↔ bg-surface）+ 间距 + 1px 分隔线"分层，
 * 而不是"圆角 + 描边 + 阴影"三件套（那样一眼就是网页卡片墙）。
 * 口径见 ui-design-skill 的 references/02-app-ui-mobile-h5.md §1 与 01-design-foundations.md §4；
 * 确实需要描边的场景，在调用处自己加 `border border-border`，不要改这里。
 */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-md bg-surface text-surface-foreground', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // flex-wrap：窄屏时让说明文字换到下一行，而不是把标题挤成两行
      className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 pt-4', className)}
      {...props}
    />
  )
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h2 className={cn('text-title font-semibold', className)}>{children}</h2>
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mt-1 text-caption text-muted-foreground', className)} {...props} />
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center justify-end gap-2 border-t border-border px-4 py-3', className)}
      {...props}
    />
  )
}
