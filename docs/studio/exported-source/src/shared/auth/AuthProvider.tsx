import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { User } from '@/shared/track'
import { signUp as signUpRequest, supabase } from '@/shared/track'
import { normalizeCNPhone } from '@/shared/auth/phone'
import { maybeDevAutoLogin } from '@/shared/auth/devAutoLogin'

/**
 * 登录 / 会话的唯一入口（必须在 `<AuthProvider>` 内用 `useAuth()` 取）。
 *
 * **默认（也是唯一）的登录方式是手机号双模式**：密码登录（`signInWithPassword`）+ 验证码登录（`signInWithOtp` / `verifyOtp`），
 * 未注册手机号在验证码登录时自动建号——不需要回头问用户"用哪种登录"。
 * 邮箱方法（`signInWithEmail` / `signUpWithEmail`）**只在用户明确要求邮箱登录时**才用，且排在成员表最后：
 * 不要因为名字看起来"通用"就选它们（口径见 app-creator-skill 的 `references/14-phone-otp.md`）。
 */
interface AuthContextValue {
  /** 当前登录用户；未登录或后端未启用时为 null */
  user: User | null
  /** 当前会话的 access token（调受保护云函数时放进 `Authorization` 头）；未登录时为 null */
  accessToken: string | null
  /** 首次会话读取是否完成（false 期间路由守卫不跳转，避免已登录用户刷新时闪登录页） */
  ready: boolean
  /** 应用后端是否已启用（supabase 客户端就绪）；false 时登录页显示开通提示而非表单 */
  available: boolean
  /** 手机号 + 密码登录（密码登录模式，**默认登录方式**）。成功返回 true；失败抛 Error（message 可直接展示） */
  signInWithPassword: (phone: string, password: string) => Promise<boolean>
  /** 给当前账号设置 / 修改密码（验证码建号后的首次设置、设置页改密都走它）。成功返回 true */
  setPassword: (password: string) => Promise<boolean>
  /** 发送短信验证码（验证码登录模式，**默认登录方式**；未注册手机号会自动建号）。成功返回 true；失败抛 Error */
  signInWithOtp: (phone: string) => Promise<boolean>
  /** 用短信验证码登录（未注册自动建号）。成功返回 true */
  verifyOtp: (phone: string, code: string) => Promise<boolean>
  /** 给当前账号绑定手机号：发送换绑验证码。成功返回 true */
  linkPhone: (phone: string) => Promise<boolean>
  /** 完成手机号绑定（校验 linkPhone 发出的验证码）。成功返回 true */
  confirmPhoneLink: (phone: string, code: string) => Promise<boolean>
  /** 设置昵称（trim 后 1–32 个字符）。昵称唯一存储在用户元数据（user_metadata.nickname）——平台管理台与 app 资料页都从这里读，不要另建表。成功返回 true；失败抛 Error（message 可直接展示） */
  updateNickname: (name: string) => Promise<boolean>
  /** 匿名登录（访客场景：不注册先建会话，如访客付费）。成功返回 true；服务未开通或平台禁用匿名登录时抛 Error */
  signInAnonymously: () => Promise<boolean>
  /** 登出（后端未启用时为 no-op） */
  signOut: () => Promise<void>
  /**
   * 邮箱 + 密码登录。
   * ⚠️ **备用形态，别默认用**：做登录走手机号双模式（`signInWithPassword` + `signInWithOtp` / `verifyOtp`），
   * 只有用户明确要求邮箱登录时才用本方法（口径见 app-creator-skill 的 `references/14-phone-otp.md`）。
   * 成功返回 true；失败抛 Error（message 可直接展示）
   */
  signInWithEmail: (email: string, password: string) => Promise<boolean>
  /**
   * 邮箱 + 密码注册（环境差异已由 track.signUp 封装）。
   * ⚠️ **备用形态，别默认用**：默认走手机号双模式——未注册手机号在验证码登录时自动建号，没有独立注册表单。
   * 成功返回 true；失败抛 Error
   */
  signUpWithEmail: (email: string, password: string) => Promise<boolean>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * 把 supabase 返回的常见 OTP 错误折成用户可读文案（频控 429 / 验证码校验失败）；其余原样透出，message 可直接展示。
 *
 * ⚠️ 验证码校验失败**不能**拆成「错误 / 过期」单边文案：Supabase（GoTrue）对「验证码不正确 / 已过期 / 不存在 /
 * 与手机号不匹配」统一返回同一个错误——`otp_expired`、"Token has expired or is invalid"（HTTP 403，服务端刻意合并、防枚举），
 * 客户端判不出具体原因，只能给两种情形都成立的合并文案。
 */
function otpErrorMessage(error: { message: string; code?: string; status?: number }): string {
  if (error.status === 429) return '发送太频繁，请稍后再试'
  if (error.code === 'otp_expired' || /expired/i.test(error.message)) {
    return '验证码不正确或已过期，请重新输入或重新获取'
  }
  return error.message
}

/** 会话与登录动作的唯一入口；必须在 <AuthProvider> 内使用。 */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth 必须在 <AuthProvider> 内使用')
  return value
}

/**
 * 认证 Provider：会话读取 / 订阅 / 登录动作全部收在这个文件里。
 * 登录方式变更（换手机号、OAuth 等）只改这里，登录页与路由守卫不动。
 *
 * 会话**按入口 UI 作用域隔离**（App UI 与 Admin UI 不共用登录态）：底层 `supabase`
 * 客户端按入口 HTML 的 `ui-scope` 使用不同的 auth storageKey，见 `src/shared/track.ts`。
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!supabase) {
      // 后端未启用：没有会话可读，直接就绪；available=false 交给登录页提示
      setReady(true)
      return
    }
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession()
        // Dev 后台免登（生产构建静态剔除）：**无会话时建立会话、已有 dev 会话时补 / 重试管理员**；
        // 它不接管（非 dev / 非后台 / `?devlogin=0`）时回落到已读到的会话。
        // 不能只在"没有会话"时调用——那样首次 claim 失败后（如迁移还没应用），刷新已经带上会话，
        // 就再也不会重试，dev 后台会永久停在"没有权限"。
        const session = (await maybeDevAutoLogin()) ?? data.session
        setUser(session?.user ?? null)
        setAccessToken(session?.access_token ?? null)
      } catch {
        setUser(null)
        setAccessToken(null)
      } finally {
        setReady(true)
      }
    })()
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setAccessToken(session?.access_token ?? null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  /** 手机号相关动作的公共前置：校验后端可用并返回客户端（顺带让 TS 收窄，不必用非空断言） */
  const requireBackend = (): NonNullable<typeof supabase> => {
    if (!supabase) throw new Error('应用后端尚未启用，无法使用手机号登录')
    return supabase
  }
  const normalizePhone = (phone: string) => {
    const p = normalizeCNPhone(phone)
    if (!p) throw new Error('请输入 11 位大陆手机号')
    return p
  }
  const normalizeCode = (code: string) => {
    const c = (code || '').replace(/\D/g, '')
    if (c.length !== 6) throw new Error('请输入 6 位验证码')
    return c
  }

  const signInWithPassword = useCallback(async (phone: string, password: string) => {
    const sb = requireBackend()
    if (!password) throw new Error('请输入密码')
    const { error } = await sb.auth.signInWithPassword({ phone: normalizePhone(phone), password })
    if (error) throw new Error(error.message)
    return true
  }, [])

  const setPassword = useCallback(async (password: string) => {
    const sb = requireBackend()
    if (!password) throw new Error('请输入密码')
    const { error } = await sb.auth.updateUser({ password })
    if (error) throw new Error(error.message)
    return true
  }, [])

  const signInWithOtp = useCallback(async (phone: string) => {
    const sb = requireBackend()
    const { error } = await sb.auth.signInWithOtp({
      phone: normalizePhone(phone),
      options: { shouldCreateUser: true },
    })
    if (error) throw new Error(otpErrorMessage(error))
    return true
  }, [])

  const verifyOtp = useCallback(async (phone: string, code: string) => {
    const sb = requireBackend()
    const { error } = await sb.auth.verifyOtp({
      phone: normalizePhone(phone), token: normalizeCode(code), type: 'sms',
    })
    if (error) throw new Error(otpErrorMessage(error))
    return true
  }, [])

  const linkPhone = useCallback(async (phone: string) => {
    const sb = requireBackend()
    const { error } = await sb.auth.updateUser({ phone: normalizePhone(phone) })
    if (error) throw new Error(otpErrorMessage(error))
    return true
  }, [])

  const confirmPhoneLink = useCallback(async (phone: string, code: string) => {
    const sb = requireBackend()
    const { error } = await sb.auth.verifyOtp({
      phone: normalizePhone(phone), token: normalizeCode(code), type: 'phone_change',
    })
    if (error) throw new Error(otpErrorMessage(error))
    return true
  }, [])

  const updateNickname = useCallback(async (name: string) => {
    if (!supabase) throw new Error('服务开通中，暂时无法修改昵称')
    const trimmed = (name || '').trim()
    if (trimmed.length < 1 || trimmed.length > 32) {
      throw new Error('昵称长度需在 1–32 个字符之间')
    }
    const { error } = await supabase.auth.updateUser({ data: { nickname: trimmed } })
    if (error) throw new Error(error.message)
    return true
  }, [])

  /** ⚠️ 备用形态：邮箱登录，只在用户明确要求邮箱时才用——默认走上面的手机号双模式 */
  const signInWithEmail = useCallback(async (email: string, password: string) => {
    if (!supabase) throw new Error('服务开通中，暂时无法登录')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw new Error(error.message)
    return true
  }, [])

  /** ⚠️ 备用形态：邮箱注册，同 signInWithEmail */
  const signUpWithEmail = useCallback(async (email: string, password: string) => {
    const { data, error } = await signUpRequest(email, password)
    if (error) throw new Error(error.message)
    return Boolean(data.user)
  }, [])

  const signInAnonymously = useCallback(async () => {
    if (!supabase) throw new Error('服务开通中，暂时无法登录')
    const { data, error } = await supabase.auth.signInAnonymously()
    if (error) throw new Error(error.message)
    return Boolean(data.user)
  }, [])

  const signOut = useCallback(async () => {
    await supabase?.auth.signOut()
  }, [])

  const value = useMemo(
    () => ({ user, accessToken, ready, available: Boolean(supabase), signInWithPassword, setPassword, signInWithOtp, verifyOtp, linkPhone, confirmPhoneLink, updateNickname, signInAnonymously, signOut, signInWithEmail, signUpWithEmail }),
    [user, accessToken, ready, signInWithPassword, setPassword, signInWithOtp, verifyOtp, linkPhone, confirmPhoneLink, updateNickname, signInAnonymously, signOut, signInWithEmail, signUpWithEmail],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
