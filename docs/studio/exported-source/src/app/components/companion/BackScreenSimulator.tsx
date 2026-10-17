/* =============================================================================
 * 设备背屏模拟器 —— 桌面宽屏时显示在伙伴页右侧。
 *
 * 背屏的职责只有一件：**让小伴的生活状态被看见**。
 * 它不显示记录数字、不显示文章摘要、不推送待办——所以这里只有小伴和一句状态词。
 * 手机（单栏）下整个组件都不渲染，页面保持一屏一列。
 * ========================================================================== */

import type { CompanionAction } from '@/shared/api/companionApi'
import { cn } from '@/shared/lib/cn'
import { ACTION_LABEL, XiaobanFigure } from './XiaobanFigure'

export function BackScreenSimulator({
  action,
  connected,
  className,
}: {
  action: CompanionAction
  connected: boolean
  className?: string
}) {
  return (
    <section className={cn('w-full', className)} aria-label="设备背屏预览">
      <p className="text-caption text-muted-foreground">设备背屏 · 预览</p>

      <div className="mt-2 rounded-xl bg-foreground p-3">
        <div className="relative flex aspect-[3/5] flex-col items-center justify-center overflow-hidden rounded-lg bg-screen-surface">
          {/* 小伴身后的一圈微光，像窗缝里漏进来的那一点亮 */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse at 50% 42%, rgb(var(--companion-glow) / 0.55) 0%, transparent 62%)',
            }}
          />
          <XiaobanFigure
            action={connected ? action : 'sleeping'}
            className={cn('relative w-3/5', !connected && 'opacity-40')}
          />
          <p className="relative mt-4 px-5 text-center text-caption text-screen-foreground">
            {connected ? ACTION_LABEL[action] : '还没连上设备'}
          </p>
        </div>
      </div>

      <p className="mt-2 text-caption text-muted-foreground">
        背屏只显示小伴此刻在做什么，不推送数字，也不催你。
      </p>
    </section>
  )
}
