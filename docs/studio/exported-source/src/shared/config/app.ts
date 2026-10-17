/**
 * 应用级常量。
 *
 * 新增全局常量（应用名、版本号、默认分页大小等）放这里，不要散落在各页面里。
 */
export const APP_NAME = '小伴'

export const APP_VERSION = '0.1.0'

/**
 * 文档标题兜底：页面未声明标题时使用。
 *
 * 伙伴页刻意不声明顶栏标题（小屋直接从状态栏下面开始），所以启动与回到伙伴页时，
 * `document.title` 就是这里的值。其它页面用 `usePageTitle()` 声明标题后随之更新
 * （见 src/app/layout/PageTitle.tsx）；没有页面声明时回到本兜底值。
 */
export const DOC_TITLE_FALLBACK = '小伴'
