import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'

import { cn } from '@/shared/lib/cn'
import { useAppState } from '../state/AppStateProvider'
import { PageTitleProvider } from './PageTitle'
import { TabBar } from './TabBar'
import { TopBleedScrim } from './TopBleedScrim'

/** 一级（Tab）路由：不显示返回按钮，也不出现第二块底导航 */
const ROOT_ROUTES = new Set(['/', '/meals', '/changes'])

/**
 * App UI 外壳：可滚动内容区 + 按需出现的顶栏 + 底部三个导航。
 *
 * 顶栏只在当前页声明了标题时才渲染（`usePageTitle()`）；伙伴页刻意不声明标题，
 * 让小伴的小屋直接从状态栏下面开始，顶栏那一条留给场景。
 *
 * 演示模式是全局状态，开启时在**壳的最顶部**挂一条常驻标记——
 * 这样无论翻到哪一页，"现在看到的不是真实记录"都写在脸上，
 * 不需要每个页面各自解释一遍。它同时接管顶部安全区，顶栏与滚动容器的垫色随即让位。
 *
 * 内容区宽度上限 1040px：手机上一屏一列（这个上限不生效），桌面宽屏时伙伴页
 * 才有空间在右侧摆一台设备背屏模拟器。
 */
export function AppShell() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { source } = useAppState()
  const mainRef = useRef<HTMLElement>(null)
  const [pageTitle, setPageTitle] = useState<string>()
  const [topBleed, setTopBleed] = useState(false)

  const isRoot = ROOT_ROUTES.has(pathname)
  const hasHeader = pageTitle !== undefined
  const isDemo = source === 'demo'
  /** 演示标记条自己吃掉顶部安全区，其它 chrome 不再重复让位 */
  const safeTopTaken = isDemo

  // 「顶部穿透」与顶栏二选一：同时声明时穿透被顶栏盖住、不会生效——dev 环境提示一下，
  // 免得页面"声明了穿透却没效果"而排查不到原因（生产构建会整段移除）。
  useEffect(() => {
    if (import.meta.env.DEV && hasHeader && topBleed) {
      console.warn('[app-shell] 本页同时声明了顶栏标题与 useTopBleed()：要穿透就不要 usePageTitle()（顶栏会盖住穿透区）。')
    }
  }, [hasHeader, topBleed])

  return (
    <div className="mx-auto flex h-screen-dvh w-full max-w-[1040px] flex-col bg-background text-foreground">
      {isDemo && (
        <div role="status" className="z-30 shrink-0 bg-primary pt-safe-top">
          <p className="px-4 py-2 text-caption font-medium text-primary-foreground">
            演示模式 · 现在看到的都是演示示意，不是你的真实记录
          </p>
        </div>
      )}

      {hasHeader && (
        <header
          className={cn(
            'z-20 shrink-0 border-b border-border bg-surface/95 backdrop-blur',
            !safeTopTaken && 'pt-safe-top',
          )}
        >
          {/* px-4：与 .page 的内容左右对齐（1 个 4px 阶差都没有） */}
          <div className="flex min-h-12 items-center gap-2 px-4">
            {!isRoot && (
              <button
                type="button"
                onClick={() => navigate(-1)}
                aria-label="返回"
                className="-ml-2 flex size-11 items-center justify-center rounded-md text-foreground active:bg-accent"
              >
                <ChevronLeft className="size-6" />
              </button>
            )}
            <h1 className="flex-1 truncate text-title font-semibold">{pageTitle}</h1>
          </div>
        </header>
      )}

      {/* 无顶栏时顶部安全区由滚动容器垫成页面背景色；顶部穿透页（useTopBleed）与演示条存在时去掉垫色 */}
      <main
        ref={mainRef}
        className={cn(
          'min-h-0 flex-1 scroll-y',
          !hasHeader && !topBleed && !safeTopTaken && 'safe-top-backdrop',
        )}
      >
        <PageTitleProvider onChange={setPageTitle} onTopBleedChange={setTopBleed}>
          <Outlet />
        </PageTitleProvider>
      </main>

      {/* 穿透页：状态栏垫底渐变（随正文滚入渐显；换页时按 pathname 重挂载、重算浓度） */}
      {topBleed && !hasHeader && <TopBleedScrim key={pathname} scroller={mainRef} />}

      <TabBar />
    </div>
  )
}
