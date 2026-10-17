/* =============================================================================
 * 一餐的卡片。
 *
 * 这张卡片要同时装下三种**来源完全不同**的信息，所以刻意把它们分成三节、
 * 各带自己的标签，谁也不许冒充谁：
 *   相机记录   —— 设备拍到的原始事实（时间、原图、设备），不含任何推断。
 *   AI 估算    —— 模型对照片的看法。模型没接入 / 还没跑完时显示「尚未估算」，
 *                 **绝不填一个看起来合理的数字**。
 *   你的确认   —— 只有用户自己点过才有值。
 *
 * 份量确认（全部 / 吃了一半 / 少量）走这里，不改动照片与估算。
 * ========================================================================== */

import { useState } from 'react'
import { Bot, Camera, CircleCheck, ImageOff } from 'lucide-react'

import { PORTION_OPTIONS, type Meal, type PortionFraction } from '@/shared/api/companionApi'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { cn } from '@/shared/lib/cn'
import { formatDateTime } from '@/shared/lib/format'
import { useAppState } from '../../state/AppStateProvider'
import { isDemoImage } from '../../state/demoContent'
import { DemoMealIllustration } from './DemoMealIllustration'

export function MealCard({ meal, className }: { meal: Meal; className?: string }) {
  const { source, confirmPortion, pending } = useAppState()
  const [editing, setEditing] = useState(meal.confirmation === null)
  const [portion, setPortion] = useState<PortionFraction | undefined>(meal.confirmation?.portionFraction)

  const isDemo = source === 'demo'
  const confirmed = meal.confirmation !== null
  const busy = pending === meal.id

  const portionLabel = (value: PortionFraction | undefined) =>
    PORTION_OPTIONS.find((option) => option.value === value)?.label ?? ''

  const submit = async () => {
    if (portion === undefined) return
    await confirmPortion(meal.id, portion)
    setEditing(false)
  }

  return (
    <article className={cn('overflow-hidden rounded-lg bg-surface', className)}>
      <div className="relative aspect-[4/3] w-full bg-surface-muted">
        {meal.capture.imageUrl && !isDemoImage(meal.capture.imageUrl) ? (
          <img
            src={meal.capture.imageUrl}
            alt={`${formatDateTime(meal.capture.capturedAt)} 拍下的一餐`}
            className="size-full object-cover"
          />
        ) : isDemoImage(meal.capture.imageUrl) ? (
          <DemoMealIllustration />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <ImageOff className="size-6" aria-hidden />
            <p className="text-caption">照片暂时读不出来</p>
          </div>
        )}

        <div className="absolute left-3 top-3 flex gap-2">
          {isDemo && <Badge tone="primary">演示</Badge>}
          {confirmed ? <Badge tone="success">已确认</Badge> : <Badge tone="warning">等待你确认</Badge>}
        </div>
      </div>

      <div className="p-3">
        {/* ---- 相机记录：设备的原始事实 ---- */}
        <section>
          <h3 className="flex items-center gap-1.5 text-caption font-medium text-muted-foreground">
            <Camera className="size-3.5" aria-hidden />
            相机记录
          </h3>
          <p className="mt-1 text-body">{formatDateTime(meal.capture.capturedAt, true)} 拍下</p>
          <p className="mt-0.5 text-caption text-muted-foreground">
            {meal.capture.deviceId ? `来自随身相机 · ${meal.capture.deviceId}` : '来自随身相机'}
            {meal.capture.width && meal.capture.height
              ? ` · 原图 ${meal.capture.width}×${meal.capture.height}`
              : ''}
          </p>
        </section>

        {/* ---- AI 估算 ---- */}
        <section className="mt-3 border-t-hairline border-border pt-3">
          <h3 className="flex items-center gap-1.5 text-caption font-medium text-muted-foreground">
            <Bot className="size-3.5" aria-hidden />
            AI 估算
          </h3>
          {meal.estimate ? (
            <div className="mt-1">
              <p className="text-body">{meal.estimate.summary}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                {meal.estimate.items.map((item) => (
                  <span
                    key={item}
                    className="rounded-full bg-surface-muted px-2 py-0.5 text-caption text-muted-foreground"
                  >
                    {item}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-caption text-muted-foreground">
                {meal.estimate.kcal === null ? '热量未提供' : `约 ${meal.estimate.kcal} 千卡`}
                {' · '}
                {meal.estimate.model}
              </p>
            </div>
          ) : (
            <div className="mt-1">
              <p className="text-body text-muted-foreground">尚未估算</p>
              <p className="mt-0.5 text-caption text-muted-foreground">
                照片已经存好了。模型还没接入或还没跑完，小伴不会替你猜这一餐有多少。
              </p>
            </div>
          )}
        </section>

        {/* ---- 用户确认 ---- */}
        <section className="mt-3 border-t-hairline border-border pt-3">
          <h3 className="flex items-center gap-1.5 text-caption font-medium text-muted-foreground">
            <CircleCheck className="size-3.5" aria-hidden />
            你的确认
          </h3>

          {editing ? (
            <>
              <p className="mt-1 text-body">这一份你吃了多少？</p>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {PORTION_OPTIONS.map((option) => {
                  const active = portion === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setPortion(option.value)}
                      className={cn(
                        'min-h-tap rounded-md border px-2 text-body transition-colors duration-fast active:scale-[0.98]',
                        active
                          ? 'border-primary bg-primary-soft font-medium text-primary'
                          : 'border-border bg-surface text-surface-foreground',
                      )}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
              <p className="mt-1.5 text-caption text-muted-foreground">
                {PORTION_OPTIONS.find((option) => option.value === portion)?.hint ?? '选一个最接近的就好'}
              </p>
              <Button block className="mt-3" loading={busy} disabled={portion === undefined} onClick={submit}>
                {confirmed ? '更新这一餐' : '确认这一餐'}
              </Button>
            </>
          ) : (
            <>
              <p className="mt-1 text-body">
                你确认的是「{portionLabel(meal.confirmation?.portionFraction)}」
              </p>
              <p className="mt-0.5 text-caption text-muted-foreground">
                {meal.confirmation ? formatDateTime(meal.confirmation.confirmedAt, true) : ''} 由你自己确认
              </p>
              <Button variant="outline" className="mt-2" onClick={() => setEditing(true)}>
                改一下
              </Button>
            </>
          )}
        </section>
      </div>
    </article>
  )
}
