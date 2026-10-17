/* =============================================================================
 * 变化页 —— 长期的那一点点不一样。
 *
 * 这一页只讲**已经有的事实**：记录里出现过什么、设备现在是什么状态。
 * 没有记录就是空态，不画曲线、不补默认值、不预测"照这样下去会怎样"——
 * 编出来的趋势比空白更伤人。
 * ========================================================================== */

import { Sprout } from 'lucide-react'

import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { EmptyState } from '@/shared/ui/Feedback'
import { Switch } from '@/shared/ui/Input'
import { usePageTitle } from '../layout/PageTitle'
import { useAppState } from '../state/AppStateProvider'

function dayLabel(key: string): string {
  const [, month, day] = key.split('-')
  return `${Number(month)}月${Number(day)}日`
}

export function ChangesPage() {
  usePageTitle('变化')

  const {
    meals,
    device,
    source,
    enterDemo,
    exitDemo,
    setPaused,
    pending,
    connection,
    offlineReason,
    reconnect,
  } = useAppState()

  const isDemo = source === 'demo'
  const offline = connection === 'offline'
  const connected = device?.connected ?? false
  const voiceEnabled = device?.voiceEnabled ?? false

  const confirmedCount = meals.filter((meal) => meal.confirmation !== null).length
  const byDay = new Map<string, number>()
  meals.forEach((meal) => {
    const key = meal.capture.capturedAt.slice(0, 10)
    byDay.set(key, (byDay.get(key) ?? 0) + 1)
  })
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7)

  return (
    <div className="page">
      <p className="text-caption text-muted-foreground">
        这里记录的是已经发生过的事。不催你，也不拿数字评判你吃了多少。
      </p>

      <section className="mt-4">
        <h2 className="text-title font-medium">记录里的变化</h2>

        {meals.length === 0 ? (
          <EmptyState
            className="mt-2 rounded-lg bg-surface px-5 py-4"
            icon={Sprout}
            title="还在等第一张照片"
            description="有真实记录之后，这里会告诉你记录出现在哪些日子，不用你天天盯着。"
          />
        ) : (
          <div className="mt-2 rounded-lg bg-surface p-3">
            <p className="text-body">
              已经记下 {meals.length} 餐，其中 {confirmedCount} 餐是你自己确认过份量的。
            </p>
            <ul className="mt-3 space-y-1.5">
              {days.map(([key, count]) => (
                <li key={key} className="flex items-center justify-between text-caption">
                  <span>{dayLabel(key)}</span>
                  <span className="text-muted-foreground">{count} 餐</span>
                </li>
              ))}
            </ul>
            {isDemo && <p className="mt-3 text-caption text-primary">以上是演示数据</p>}
          </div>
        )}
      </section>

      <section className="mt-5">
        <h2 className="text-title font-medium">设备</h2>

        <div className="mt-2 overflow-hidden rounded-lg bg-surface">
          <ul>
            <li className="list-row min-h-tap py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-body">随身相机</span>
                <span className="block text-caption text-muted-foreground">
                  {device?.name ?? (offline ? offlineReason ?? '无法获取设备状态' : '还不知道是哪一台')}
                </span>
              </span>
              <Badge tone={connected ? 'success' : 'neutral'}>{connected ? '已连接' : '未连接'}</Badge>
            </li>
            <li className="list-row min-h-tap py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-body">录音</span>
                <span className="block text-caption text-muted-foreground">
                  还没有接入，所以现在用不了
                </span>
              </span>
              <Badge tone={voiceEnabled ? 'success' : 'neutral'}>{voiceEnabled ? '已启用' : '未启用'}</Badge>
            </li>
            <li className="list-row min-h-tap py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-body">暂停记录</span>
                <span className="block text-caption text-muted-foreground">
                  {device?.paused ? '相机现在不会记录任何东西' : '随时可以停下来，停多久都行'}
                </span>
              </span>
              <Switch
                checked={device?.paused ?? false}
                disabled={!device || pending === 'device-pause'}
                onChange={(next) => void setPaused(next)}
              />
            </li>
          </ul>
        </div>

        {offline && (
          <Button variant="outline" block className="mt-2" onClick={reconnect}>
            重新连接
          </Button>
        )}
      </section>

      <section className="mt-5">
        <h2 className="text-title font-medium">演示模式</h2>
        <p className="mt-1 text-caption text-muted-foreground">
          打开后可以用小伴自带的演示插画和示例内容走一遍完整流程，先看看它是什么样子。
          演示内容全部带标记，不会混进你的真实记录。
        </p>
        <div className="mt-2 rounded-lg bg-surface p-3">
          <Switch
            checked={isDemo}
            onChange={(next) => (next ? enterDemo() : exitDemo())}
            label={isDemo ? '演示模式已打开' : '打开演示模式'}
          />
        </div>
      </section>

      {/*
        开发预览专用的源码下载入口。
        由 import.meta.env.DEV 守卫 + vite.config.ts 的 sourceArchivePlugin（apply: 'serve'）两头把关：
        生产构建里这段整块被静态剔除，打包产物里既没有这个链接、也没有这个端点。
      */}
      {import.meta.env.DEV && (
        <section className="mt-5 border-t-hairline border-border pt-4">
          <a
            href={`${import.meta.env.BASE_URL}__ai-builder/source-archive.tar.gz`}
            target="_blank"
            rel="noopener"
            className="flex min-h-tap items-center justify-center rounded-md border border-border bg-surface text-body font-medium active:bg-accent"
          >
            下载完整源码（.tar.gz）
          </a>
          <p className="mt-2 text-caption text-muted-foreground">
            仅开发预览可见，发布产物里没有这个入口。归档是点的时候现场打的，已排除依赖、构建产物、
            环境变量与签名证书。
          </p>
        </section>
      )}
    </div>
  )
}
