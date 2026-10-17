import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react'

import { DOC_TITLE_FALLBACK } from '@/shared/config/app'

type SetPageTitle = (title: string | undefined) => void
type SetTopBleed = (bleed: boolean) => void

const PageTitleContext = createContext<SetPageTitle>(() => undefined)
const TopBleedContext = createContext<SetTopBleed>(() => undefined)

/**
 * 页面级 chrome 的注册中心：`AppShell` 持有状态，页面用 `usePageTitle()` 声明标题、
 * 用 `useTopBleed()` 声明「顶部穿透」（页面级例外，默认不开）。
 *
 * `AppShell` **只在标题有值时才渲染顶栏**——所以「不声明标题」= 这一页没有顶栏
 * （不需要顶栏的页面，比如初始占位页，就不声明；初始态因此不会先冒出一条空顶栏）。
 * 标题可以跟数据 / 路由参数联动，细则见 references/04-routing.md §2。
 */
export function PageTitleProvider({
  onChange,
  onTopBleedChange,
  children,
}: {
  onChange: SetPageTitle
  onTopBleedChange: SetTopBleed
  children: ReactNode
}) {
  return (
    <PageTitleContext.Provider value={onChange}>
      <TopBleedContext.Provider value={onTopBleedChange}>{children}</TopBleedContext.Provider>
    </PageTitleContext.Provider>
  )
}

/**
 * 在页面组件顶部调用一次，声明本页的顶栏标题。
 * 同时把 `document.title` 同步成本页标题（平台推荐用它表达页面标题，见 capsule-native-api 的 UI 分册）。
 * 卸载时自动清空（不会把上一页的标题留到下一屏）；标题过长时由顶栏自己截断。
 *
 * 用 `useLayoutEffect` 而不是 `useEffect`：标题要在浏览器绘制前写入，
 * 否则声明了标题的页面会先以"无顶栏"绘制一帧、再补出顶栏，产生跳动。
 */
export function usePageTitle(title: string) {
  const setTitle = useContext(PageTitleContext)

  useLayoutEffect(() => {
    setTitle(title)
    document.title = title
    return () => {
      setTitle(undefined)
      document.title = DOC_TITLE_FALLBACK
    }
  }, [setTitle, title])
}

/**
 * 在页面组件顶部调用一次，声明这一页「顶部穿透」：滚动容器不再把顶部安全区垫成页面背景色，
 * 状态栏区域**透出页面内容**——顶部是全出血媒体的二级页用它（banner 图 / 图集 / 封面）。
 *
 * 媒体自己贴到屏幕最顶；叠在媒体上的控件（返回按钮等）用 `top-safe-top` 自己避开状态栏。
 * 媒体滚走后，正文经过状态栏区域时框架会加一层「页面背景色 → 透明」的渐变垫底
 * （`TopBleedScrim`，随正文滚入渐显）——在**头部媒体之后的第一个正文块**上标
 * `data-top-bleed-content` 作为渐显锚点（不标时退回滚动容器第一个子元素的下沿）。
 * （完整样例见 assets/demo-pages/app/BannerDetailPage.tsx，口径见 references/07-mobile-adaptation.md §2）
 *
 * 默认不开：普通页面保持不透明底，滚动内容不会从状态栏后面透出来。**声明了顶栏的页面不要调**
 * （顶栏会盖住穿透区）。用 `useLayoutEffect`：穿透要在绘制前生效，避免先闪一帧"垫色"再穿透；
 * 卸载时自动恢复默认。
 */
export function useTopBleed() {
  const setTopBleed = useContext(TopBleedContext)

  useLayoutEffect(() => {
    setTopBleed(true)
    return () => setTopBleed(false)
  }, [setTopBleed])
}
