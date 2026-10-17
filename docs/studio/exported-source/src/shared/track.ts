/**
 * 平台内置后端（Supabase）客户端 —— 应用访问云端数据的唯一入口。
 *
 * 连接信息由平台在运行时注入（预览写进 .env.local、发布打进构建产物）。
 * **不要**在业务代码里硬编码地址或密钥，也不要再新建第二个客户端——
 * 后端怎么用、表结构怎么建、云函数怎么写，见 `platform-supabase` Skill。
 *
 * App UI 与 Admin UI 的登录态彼此隔离：客户端按入口 HTML 的 `ui-scope` 使用不同的
 * auth storageKey，同一个 origin 下也不会「前台登录、后台跟着登录」（见下方 uiScope）。
 *
 * 常用导出：
 *   supabase                 数据读写（受行级权限约束）；应用后端未启用时为 null
 *   callFunction(name, init) 调用平台云函数
 *   signUp(email, password)  邮箱注册（**备用形态**：做登录默认走手机号双模式，
 *                            见 src/shared/auth/ 的 useAuth()；用户明确要求邮箱时才用）
 *   track(name, props)       写平台埋点表（events）
 *   shortCode                项目短码（按应用隔离 localStorage 等本地状态）
 */
import { createClient } from '@supabase/supabase-js'

// 取址：预览环境注入 VITE_SUPABASE_BASE（走同源代理，桌面 / 局域网 / 手机扫码都对），
// 发布产物注入 VITE_SUPABASE_URL（绝对地址）。差异收在这里，业务代码不用感知。
const env = import.meta.env
const base: string = env.VITE_SUPABASE_BASE ?? ''
const absoluteUrl: string = env.VITE_SUPABASE_URL ?? ''
const url = base ? `${window.location.origin}${base}` : absoluteUrl || `${window.location.origin}/supabase`
const anonKey: string = env.VITE_SUPABASE_ANON_KEY ?? ''

/** 手机号登录是否可用：后端已启用（anonKey 已注入）即可用。
 *  预览（注入 VITE_SUPABASE_BASE，走同源代理）与发布产物（注入 VITE_SUPABASE_URL 绝对地址）
 *  都是同一个后端，都支持 volcsms 短信——不要按地址形态判断，否则会把预览误判为不可用。 */
export const otpAvailable = Boolean(anonKey)

const schema: string = env.VITE_SUPABASE_SCHEMA ?? ''

/** 项目短码：平台注入 VITE_PROJECT_CODE；早期环境没有时从 schema 名反推。 */
export const shortCode: string =
  env.VITE_PROJECT_CODE || schema.replace(/^proj_/, '').replace(/_(dev|prod)$/, '')

/**
 * 登录态作用域：读入口 HTML 上的 `<meta name="ui-scope">`（App UI 是 `app`、Admin UI 是 `admin`）。
 *
 * App UI 与 Admin UI 可能同源部署（平台预览、挂同一站点的子路径）——若共用同一个
 * localStorage key，前台登录后后台会跟着登录。这里按作用域给 auth 换 storageKey，
 * 让两套 UI 的会话彼此独立（同源也不串号）。入口 HTML 的 ui-scope 不要删、不要改错。
 */
export const uiScope: 'app' | 'admin' =
  typeof document !== 'undefined' &&
  document.querySelector('meta[name="ui-scope"]')?.getAttribute('content') === 'admin'
    ? 'admin'
    : 'app'

/** 平台客户端单例。应用后端尚未启用（连接信息未注入）时为 null，页面要处理这种情况。 */
export const supabase = anonKey
  ? createClient(url, anonKey, {
      ...(schema ? { db: { schema } } : {}),
      // 会话按「项目短码 + UI 作用域」隔离：App UI 与 Admin UI 不复用同一个登录态
      auth: { storageKey: `sb-${shortCode || 'project'}-${uiScope}-auth` },
    })
  : null

/**
 * 调用平台云函数。函数名会自动带上项目前缀——不要手拼 `/functions/v1` 之类的地址。
 *
 * 应用刚创建、函数还没部署完时，容器返回 500（InvalidWorkerCreation 特征）：
 * 幂等请求（GET / HEAD）等 3 秒自动重试一次；其余请求可能已产生副作用，不重试，
 * 换成一句可读的 503。
 */
export async function callFunction(name: string, init?: RequestInit): Promise<Response> {
  const endpoint = `${url}/functions/v1/${shortCode}-${name}`
  const isNotDeployed = (body: string): boolean =>
    body.includes('InvalidWorkerCreation') || body.includes('could not find an appropriate entrypoint')

  // 读过的 Response 体不能原样返回，用 body 重建；非「未部署」的 500 原样透传（不吞函数自己的报错）
  const probe = async (res: Response): Promise<{ notDeployed: boolean; resp: Response }> => {
    if (res.status !== 500) return { notDeployed: false, resp: res }
    const body = await res.text()
    if (!isNotDeployed(body)) {
      return { notDeployed: false, resp: new Response(body, { status: 500, headers: { 'Content-Type': 'application/json' } }) }
    }
    return {
      notDeployed: true,
      resp: new Response(JSON.stringify({ error: '服务正在初始化，请稍候几秒后重试' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    }
  }

  const first = await probe(await fetch(endpoint, init))
  if (!first.notDeployed) return first.resp
  const method = (init?.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return first.resp // 可能有副作用，不自动重试
  await new Promise((resolve) => setTimeout(resolve, 3000))
  return (await probe(await fetch(endpoint, init))).resp
}

/** 注册（邮箱 + 密码，**备用形态**：做登录默认走手机号双模式，见 src/shared/auth/；用户明确要求邮箱时才用）。环境差异（预览共享用户池需要归属标记）收在这里，业务代码直接调。 */
export async function signUp(email: string, password: string) {
  if (!supabase) throw new Error('服务开通中，请稍后再试')
  return supabase.auth.signUp({
    email,
    password,
    ...(base ? { options: { data: { app_id: shortCode } } } : {}),
  })
}

/** 写平台埋点表（失败静默：埋点不影响业务；后端未启用时自动跳过）。 */
export async function track(name: string, props: Record<string, unknown> = {}): Promise<void> {
  try {
    await supabase?.from('events').insert({ name, props })
  } catch {
    // 静默
  }
}

export type { Session, User } from '@supabase/supabase-js'

// 启动埋点：应用打开事件（平台统计日活的数据基础）
void track('app_open', { path: window.location.pathname })
