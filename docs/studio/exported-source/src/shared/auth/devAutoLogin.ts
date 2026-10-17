/* =============================================================================
 * Dev 后台免登（仅开发期 / 预览生效）—— 生产构建静态剔除
 *
 * 目的：Dev 模式（DevServer / 平台预览）下打开管理后台**免登录、无感、无报错**地进入，
 *       当前用户具备管理员权限。
 *
 * 为什么这样做：后台的读写由 Supabase RLS 与云函数按 `profiles.is_admin` 判定——
 *       仅隐藏登录页没有用，免登必须产出一个真实的管理员会话，并且这个账号在
 *       `profiles` 里**有自己的行**（`claim_admin()` 只改当前用户那一行）。
 *
 * 关键点：
 *  1. **匿名优先**：本地自托管栈已开匿名登录，`signInAnonymously()` 一次即成、**不产生
 *     失败请求**；云端未开匿名时再回退「邮箱注册 / 登录」。避免上一版"先密码登录/注册
 *     必然失败再兜底"打出一串 401/409 噪音。
 *  2. **记住成功方式**（localStorage）：首次成功后记住用的是匿名还是邮箱，后续直接按它走，
 *     不再试探。
 *  3. **补 profile 用 upsert(ignoreDuplicates)**：已存在时不再产生 409。
 *  4. **直接返回会话**（不是 boolean）：调用方一次性 `setUser/setReady`，避免"登录后再
 *     `getSession()` 会话尚未落盘 → 守卫短暂看到未登录 → 闪一下登录页"的竞态；并用模块级
 *     in-flight 去重（React StrictMode 双跑不重复登录）。
 *  5. 身份模型是**手机号**（`profiles.phone` 必填；`handle_new_user` 只镜像手机号）——
 *     匿名/邮箱注册都不会自动建 profile，所以这里显式补写（手机号用派生值 `+8600…`）。
 *  6. **管理员自领幂等且可重试**：`claim_admin` 出错（迁移未建好 / PostgREST schema cache 未刷新 /
 *     共享 dev 库暂时不可达）时**不记「已完成」**、下次进入再试；只有拿到无错结果才标记——
 *     否则一次失败就把 dev 后台永久卡在"没有权限"。`.upsert()` / `.rpc()` 不抛错，失败在 `error` 里，
 *     必须显式判 `error`（try/catch 包着等于把失败当成功）。
 *
 * 约束（门禁 G55 / 见 references/17-admin-dev-autologin.md）：
 *  1. 全程由 `import.meta.env.DEV` 守卫：生产构建会**静态剔除**本逻辑，线上产物不含它；
 *  2. 只作用于**后台入口**（`ui-scope=admin`）——App UI 与生产登录流程完全不受影响；
 *  3. 任何失败都**返回 null**，不抛错、不阻塞、不展示任何提示；
 *  4. URL 带 `?devlogin=0` 时跳过（回归真实登录）。
 * ========================================================================== */
import { shortCode, supabase, uiScope } from '@/shared/track'
import type { Session, User } from '@/shared/track'

const EMAIL_PREFIX = 'dev-admin+'
const METHOD_KEY = `__sb_dev_login_${shortCode || 'project'}__`
const ENSURED_KEY = `__sb_dev_admin_ensured_${shortCode || 'project'}__`

function readFlag(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}
function writeFlag(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // 忽略：localStorage 不可用不影响功能
  }
}

function isAnonymous(user: User): boolean {
  return (user as { is_anonymous?: boolean }).is_anonymous === true
}
/** 是否为「Dev 身份」：匿名的、或按项目短码派生的 dev 账号。真实用户登录不动。 */
function isDevIdentity(user: User): boolean {
  return isAnonymous(user) || (user.email ?? '').startsWith(EMAIL_PREFIX)
}
/** 由用户 id 派生一个不会与真实号码冲突的 dev 手机号（+8600 + 9 位）。 */
function syntheticPhone(uid: string): string {
  let h = 7
  for (let i = 0; i < uid.length; i += 1) h = (h * 31 + uid.charCodeAt(i)) >>> 0
  return `+8600${String(h % 1_000_000_000).padStart(9, '0')}`
}

/** 补写自己的 profile 行（幂等，upsert 已存在不报错）+ 无管理员时自领管理员。 */
async function ensureDevAdmin(user: User): Promise<void> {
  if (!supabase) return
  if (readFlag(ENSURED_KEY) === user.id) return

  // ⚠️ supabase-js 的 `.upsert()` / `.rpc()` **不会抛错**，错误在返回值的 `error` 里——
  // 用 try/catch 包着等于把失败当成功。这里显式看 `error`。
  // 补 profile：这是 claim_admin 能找到"当前用户那一行"的前提；没补上就先不 claim，下次再来。
  const upserted = await supabase
    .from('profiles')
    .upsert(
      { id: user.id, phone: syntheticPhone(user.id) },
      { onConflict: 'id', ignoreDuplicates: true },
    )
  if (upserted.error) return

  // 自领管理员。**只有拿到无错结果才记「已完成」**：
  // claim_admin 没建好（迁移未应用 / PostgREST schema cache 未刷新）或共享 dev 库暂时不可达
  // 都会在 error 里——一次性失败若被永久记住，之后刷新也永远不会再试，dev 后台就卡在"没有权限"。
  const { error } = await supabase.rpc('claim_admin')
  if (error) return
  writeFlag(ENSURED_KEY, user.id)
}

async function anonymousSession(): Promise<Session | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase.auth.signInAnonymously()
    return error ? null : data.session
  } catch {
    return null
  }
}

async function passwordSession(email: string, password: string): Promise<Session | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    return error ? null : data.session
  } catch {
    return null
  }
}

async function signUpSession(email: string, password: string): Promise<Session | null> {
  if (!supabase) return null
  const base: string = import.meta.env.VITE_SUPABASE_BASE ?? ''
  try {
    // 预览是共享用户池，注册要带 app_id 归属标记（与 track.ts 的 signUp 一致）
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      ...(base ? { options: { data: { app_id: shortCode } } } : {}),
    })
    return error ? null : data.session
  } catch {
    return null
  }
}

async function run(): Promise<Session | null> {
  if (!supabase) return null

  const existing = await supabase.auth.getSession()
  if (existing.data.session) {
    if (isDevIdentity(existing.data.session.user)) await ensureDevAdmin(existing.data.session.user)
    return existing.data.session
  }

  const email = `${EMAIL_PREFIX}${shortCode || 'project'}@ai-builder.local`
  const password = `ai-builder-dev-${shortCode || 'project'}`

  // 按记住的方式排优先级；没有记忆（首次）时匿名优先
  const saved = readFlag(METHOD_KEY)
  const attempts: Array<() => Promise<Session | null>> =
    saved === 'email'
      ? [() => passwordSession(email, password), anonymousSession, () => signUpSession(email, password)]
      : [anonymousSession, () => signUpSession(email, password), () => passwordSession(email, password)]

  let session: Session | null = null
  for (const attempt of attempts) {
    session = await attempt()
    if (session) break
  }
  if (!session) return null

  writeFlag(METHOD_KEY, isAnonymous(session.user) ? 'anon' : 'email')
  await ensureDevAdmin(session.user)
  return session
}

let inflight: Promise<Session | null> | null = null

/**
 * 尝试 dev 后台免登；返回建立好的会话（失败返回 null）。
 * 仅在 `vite dev` + 后台入口生效；其它情况立即返回 null（不产生任何副作用）。
 */
export function maybeDevAutoLogin(): Promise<Session | null> {
  if (!import.meta.env.DEV) return Promise.resolve(null)
  if (uiScope !== 'admin' || !supabase) return Promise.resolve(null)
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('devlogin') === '0') {
    return Promise.resolve(null)
  }
  if (!inflight) inflight = run().catch(() => null)
  return inflight
}
