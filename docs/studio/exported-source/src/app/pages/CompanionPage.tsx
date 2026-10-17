/* =============================================================================
 * 伙伴页 —— App 的第一屏。
 *
 * 主视觉是小伴在窗边的小屋；下面是它**自己**发布的动态（每条都带事实依据，可回应）。
 * 手机上一屏一列；桌面宽屏时右侧多出一台设备背屏模拟器，显示小伴此刻的状态。
 *
 * 这里不做任何"今日目标 / 连续天数 / 打卡"类的东西——那是催促，不是陪伴。
 * ========================================================================== */

import { useNavigate } from 'react-router-dom'
import { MessageCircle } from 'lucide-react'

import { EmptyState } from '@/shared/ui/Feedback'
import { XiaobanScene } from '../components/companion/XiaobanScene'
import { BackScreenSimulator } from '../components/companion/BackScreenSimulator'
import { PostCard } from '../components/companion/PostCard'
import { ACTION_LABEL } from '../components/companion/XiaobanFigure'
import { useAppState } from '../state/AppStateProvider'

export function CompanionPage() {
  const { companionAction, posts, connection, offlineReason } = useAppState()
  const navigate = useNavigate()

  const offline = connection === 'offline'
  const caption =
    connection === 'loading'
      ? '正在找你的记录…'
      : offline
        ? offlineReason ?? '还没连上你的记录服务'
        : '照片到了小伴会自己去收，你不用管它。'

  return (
    <div className="page lg:max-w-[1040px]">
      <div className="lg:flex lg:items-start lg:gap-6">
        <div className="lg:min-w-0 lg:flex-1">
          <XiaobanScene action={companionAction} />

          <div className="mt-3">
            <p className="text-title font-medium">{ACTION_LABEL[companionAction]}</p>
            <p className="mt-1 text-caption text-muted-foreground">{caption}</p>
          </div>

          <button
            type="button"
            onClick={() => navigate('/chat')}
            className="mt-3 flex min-h-tap w-full items-center justify-center gap-2 rounded-md border border-border bg-surface text-body font-medium active:bg-accent"
          >
            <MessageCircle className="size-4" aria-hidden />
            和小伴说说话
          </button>

          <section className="mt-5">
            <h2 className="text-title font-medium">小伴的动态</h2>
            <p className="mt-1 text-caption text-muted-foreground">
              它想说话的时候才说，每条下面都写了它是从哪件事知道的。
            </p>

            {posts.length === 0 ? (
              <EmptyState
                className="mt-2 rounded-lg bg-surface"
                title="这里还空着"
                description={
                  offline
                    ? '连上记录服务之后，小伴收到照片时会在这里留一句话。'
                    : '小伴收到照片、或你确认完一餐之后，才会在这里留一句话。'
                }
              />
            ) : (
              <div className="mt-3 space-y-3">
                {posts.map((post) => (
                  <PostCard key={post.id} post={post} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* 背屏只存在于桌面宽屏：手机上一屏一列，不出现第二块屏 */}
        <BackScreenSimulator
          action={companionAction}
          connected={!offline && (connection === 'online')}
          className="hidden lg:sticky lg:top-6 lg:block lg:w-[248px] lg:shrink-0"
        />
      </div>
    </div>
  )
}
