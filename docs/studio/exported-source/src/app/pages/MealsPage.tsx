/* =============================================================================
 * 饮食页 —— 照片到达之后的地方。
 *
 * 一次记录只有三步：照片到了 → 你确认份量 → 小伴收起来。
 * 没有"添加一餐"这类手工入口：这一页的东西全部来自随身相机，用户只做确认。
 *
 * 正常模式下没有照片就是空的（空态写清为什么空），
 * 只有用户在「变化」页显式打开演示模式时，才会出现模拟到达的按钮与演示插画。
 * ========================================================================== */

import { Camera } from 'lucide-react'

import { Button } from '@/shared/ui/Button'
import { EmptyState } from '@/shared/ui/Feedback'
import { usePageTitle } from '../layout/PageTitle'
import { MealCard } from '../components/meals/MealCard'
import { useAppState } from '../state/AppStateProvider'

export function MealsPage() {
  usePageTitle('饮食')

  const { meals, source, simulateCapture, connection, offlineReason } = useAppState()

  const isDemo = source === 'demo'
  const offline = connection === 'offline'
  const sorted = [...meals].sort((a, b) => b.capture.capturedAt.localeCompare(a.capture.capturedAt))
  const waiting = sorted.filter((meal) => meal.confirmation === null).length

  return (
    <div className="page">
      <p className="text-caption text-muted-foreground">
        照片到了，你只要说一句吃了多少。不用称重，也不用算热量。
      </p>

      {isDemo && (
        <section className="mt-3 rounded-lg border border-primary/40 bg-primary-soft p-3">
          <p className="text-caption text-primary">
            演示模式 · 这一页的照片与估算都是演示示意，不是你的真实记录
          </p>
          <Button className="mt-2" block onClick={simulateCapture}>
            模拟一张照片到达
          </Button>
        </section>
      )}

      {sorted.length === 0 ? (
        isDemo ? (
          <EmptyState
            className="mt-4"
            icon={Camera}
            title="等一张照片"
            description="点上面的按钮模拟一次拍照，看看小伴收到照片之后会怎么走。"
          />
        ) : (
          <EmptyState
            className="mt-4"
            icon={Camera}
            title="还没有照片"
            description={
              offline
                ? `${offlineReason ?? '还没连上记录服务'}。连上之后，随身相机拍到的照片会自动传到这里。`
                : '随身相机拍到的照片会自动传到这里。'
            }
            action={
              <p className="text-caption text-muted-foreground">
                想先看看完整流程，可以到「变化」页打开演示模式。
              </p>
            }
          />
        )
      ) : (
        <>
          <p className="mt-3 text-caption text-muted-foreground">
            {waiting > 0 ? `有 ${waiting} 餐在等你确认份量` : '这些都已确认，你可以随时改。'}
          </p>
          <div className="mt-2 space-y-3">
            {sorted.map((meal) => (
              <MealCard key={meal.id} meal={meal} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
