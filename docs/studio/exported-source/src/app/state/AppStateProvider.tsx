/* =============================================================================
 * 小伴 · 应用状态
 *
 * 两条数据来源，界面上必须能一眼分辨：
 *   live —— 连线上记录服务（companionApi）。连不上就是离线：**不编造任何数据**，
 *           页面显示离线状态与空态。
 *   demo —— 用户显式打开的演示模式。所有内容由本文件用本地脚本生成，全局挂演示标记，
 *           每张卡片带「演示」徽标。
 *
 * 这里只管状态与调用顺序，不碰任何 UI 文案的排版。
 * ========================================================================== */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import {
  companionApi,
  offlineReasonOf,
  PORTION_OPTIONS,
  type ChatMessage,
  type CompanionAction,
  type CompanionState,
  type DeviceState,
  type Meal,
  type PortionFraction,
  type Post,
} from '@/shared/api/companionApi'
import { useToast } from '@/shared/ui/Toast'
import {
  DEMO_CHAT_REPLIES,
  DEMO_ESTIMATE,
  DEMO_IMAGE_PREFIX,
  demoPostAfterConfirm,
} from './demoContent'

export type Connection = 'loading' | 'online' | 'offline'
export type Source = 'live' | 'demo'

const EMPTY_STATE: CompanionState = {
  device: null,
  meals: [],
  posts: [],
  messages: [],
  companionAction: 'resting',
}

const DEMO_DEVICE: DeviceState = {
  connected: true,
  paused: false,
  name: '随身相机（演示设备）',
  voiceEnabled: false,
  lastSeenAt: new Date().toISOString(),
}

/** 演示模式开局的那句问候。属于演示内容，全局有演示标记兜底 */
const DEMO_GREETING: ChatMessage = {
  id: 'demo-greeting',
  role: 'companion',
  text: '我在小屋里。想说话随时说，不想说也没关系。',
  createdAt: new Date().toISOString(),
}

let idSeed = 0
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idSeed += 1)}`

/** 估算到达的延迟（演示用，模拟"照片先到、模型后到"） */
const DEMO_ESTIMATE_DELAY = 1400
/** 小伴收完照片后回到发呆状态的时间 */
const DEMO_ACTION_HOLD = 2800
/** 在线时的回取间隔：照片由设备推上来，App 侧定期取一次 */
const POLL_INTERVAL = 30_000

interface AppStateValue {
  connection: Connection
  offlineReason: string | null
  reconnect: () => void

  source: Source
  enterDemo: () => void
  exitDemo: () => void

  device: DeviceState | null
  meals: Meal[]
  posts: Post[]
  messages: ChatMessage[]
  companionAction: CompanionAction

  /** 演示模式：模拟一张照片到达 */
  simulateCapture: () => void
  confirmPortion: (mealId: string, fraction: PortionFraction) => Promise<void>
  sendMessage: (text: string, fromPostId?: string) => Promise<void>
  replyPost: (postId: string, text: string) => Promise<void>
  setPaused: (paused: boolean) => Promise<void>

  /** 正在提交的操作（按钮转圈用） */
  pending: string | null
}

const AppStateContext = createContext<AppStateValue | null>(null)

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<Source>('live')
  const [connection, setConnection] = useState<Connection>('loading')
  const [offlineReason, setOfflineReason] = useState<string | null>(null)
  const [state, setState] = useState<CompanionState>(EMPTY_STATE)
  const [pending, setPending] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  // 操作失败的提示统一走 Toast：写不出"把失败当成功"的假象，也不占页面版面
  const { toast } = useToast()
  const reportFailure = useCallback(
    (message: string) => toast({ title: message, tone: 'danger' }),
    [toast],
  )

  // 演示模式里的定时器（估算到达、动作回落），退出演示 / 卸载时统一清掉
  const timers = useRef<number[]>([])
  const clearTimers = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id))
    timers.current = []
  }, [])
  const later = useCallback(
    (fn: () => void, delay: number) => {
      const id = window.setTimeout(() => {
        timers.current = timers.current.filter((item) => item !== id)
        fn()
      }, delay)
      timers.current.push(id)
    },
    [],
  )
  useEffect(() => clearTimers, [clearTimers])

  /* ---------- live：拉取整体状态 ---------- */
  useEffect(() => {
    if (source !== 'live') return
    let cancelled = false
    setConnection('loading')
    companionApi.getState().then(
      (next) => {
        if (cancelled) return
        setState({ ...next, companionAction: next.companionAction ?? 'resting' })
        setConnection('online')
        setOfflineReason(null)
      },
      (error: unknown) => {
        if (cancelled) return
        // 失败就如实进入离线：设备状态、餐食、动态、对话一律留空，不用示例数据撑场面
        setState(EMPTY_STATE)
        setConnection('offline')
        setOfflineReason(offlineReasonOf(error) ?? '记录服务暂时没有响应')
      },
    )
    return () => {
      cancelled = true
    }
  }, [source, reloadNonce])

  const reconnect = useCallback(() => setReloadNonce((value) => value + 1), [])

  /* ---------- live：在线时定期回取 ----------
   * 照片是设备随时推上来的，不是用户手动录入的，所以页面得自己回去取一次。
   * 只在线时轮询；连不上就直接切离线，而不是把旧数据一直摆着当新数据。 */
  useEffect(() => {
    if (source !== 'live' || connection !== 'online') return
    const timer = window.setInterval(() => {
      companionApi.getState().then(
        (next) => setState({ ...next, companionAction: next.companionAction ?? 'resting' }),
        (error: unknown) => {
          setState(EMPTY_STATE)
          setConnection('offline')
          setOfflineReason(offlineReasonOf(error) ?? '记录服务暂时没有响应')
        },
      )
    }, POLL_INTERVAL)
    return () => window.clearInterval(timer)
  }, [source, connection])

  /* ---------- 演示模式 ---------- */
  const enterDemo = useCallback(() => {
    clearTimers()
    setSource('demo')
    setConnection('online')
    setOfflineReason(null)
    setState({
      device: DEMO_DEVICE,
      meals: [],
      posts: [],
      messages: [DEMO_GREETING],
      companionAction: 'resting',
    })
  }, [clearTimers])

  const exitDemo = useCallback(() => {
    clearTimers()
    setSource('live')
    setState(EMPTY_STATE)
    setConnection('loading')
  }, [clearTimers])

  /* ---------- 演示：模拟照片到达 ---------- */
  const simulateCapture = useCallback(() => {
    if (source !== 'demo') return
    const capturedAt = new Date().toISOString()
    const mealId = nextId('meal')
    const arrival: Meal = {
      id: mealId,
      capture: {
        capturedAt,
        imageUrl: `${DEMO_IMAGE_PREFIX}lunch`,
        deviceId: 'demo-cam-01',
        width: 1200,
        height: 900,
      },
      // 照片先到、模型后到：此刻还没有估算，界面必须显示「尚未估算」而不是编一个数字
      estimate: null,
      confirmation: null,
    }
    setState((prev) => ({ ...prev, meals: [arrival, ...prev.meals], companionAction: 'resting' }))

    later(() => {
      setState((prev) => ({
        ...prev,
        meals: prev.meals.map((meal) =>
          meal.id === mealId && meal.estimate === null
            ? { ...meal, estimate: { ...DEMO_ESTIMATE, createdAt: new Date().toISOString() } }
            : meal,
        ),
      }))
    }, DEMO_ESTIMATE_DELAY)
  }, [source, later])

  /* ---------- 用户确认份量 ---------- */
  const confirmPortion = useCallback(
    async (mealId: string, fraction: PortionFraction) => {
      const label = PORTION_OPTIONS.find((option) => option.value === fraction)?.label ?? ''
      const confirmedAt = new Date().toISOString()

      if (source === 'demo') {
        setState((prev) => {
          const meal = prev.meals.find((item) => item.id === mealId)
          const post = meal ? buildConfirmedPost(meal, label) : null
          return {
            ...prev,
            meals: prev.meals.map((item) =>
              item.id === mealId ? { ...item, confirmation: { portionFraction: fraction, confirmedAt } } : item,
            ),
            // 有事实依据才发动态：依据来自这一餐的拍摄时间与用户自己确认的份量
            posts: post ? [post, ...prev.posts] : prev.posts,
            companionAction: 'collecting',
          }
        })
        later(() => setState((prev) => ({ ...prev, companionAction: 'resting' })), DEMO_ACTION_HOLD)
        return
      }

      setPending(mealId)
      try {
        const updated = await companionApi.correctPortion(mealId, fraction)
        setState((prev) => ({
          ...prev,
          meals: prev.meals.map((item) => (item.id === mealId ? updated : item)),
        }))
      } catch (error) {
        reportFailure(offlineReasonOf(error) ?? '这次确认没能送出去，稍后再试一次')
      } finally {
        setPending(null)
      }
    },
    [source, later, reportFailure],
  )

  /* ---------- 说话 / 回应动态 ---------- */
  const sendMessage = useCallback(
    async (text: string, fromPostId?: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const mine: ChatMessage = {
        id: nextId('msg'),
        role: 'user',
        text: trimmed,
        createdAt: new Date().toISOString(),
        fromPostId,
      }

      if (source === 'demo') {
        const reply = DEMO_CHAT_REPLIES[Math.floor(Math.random() * DEMO_CHAT_REPLIES.length)]
        setState((prev) => ({
          ...prev,
          messages: [
            ...prev.messages,
            mine,
            {
              id: nextId('msg'),
              role: 'companion',
              text: reply,
              createdAt: new Date().toISOString(),
            },
          ],
          companionAction: 'thinking',
        }))
        later(() => setState((prev) => ({ ...prev, companionAction: 'resting' })), DEMO_ACTION_HOLD)
        return
      }

      setPending(mine.id)
      setState((prev) => ({ ...prev, messages: [...prev.messages, mine] }))
      try {
        const reply = await companionApi.sendChat(trimmed)
        setState((prev) => ({ ...prev, messages: [...prev.messages, reply] }))
      } catch (error) {
        reportFailure(offlineReasonOf(error) ?? '这句话没能送出，稍后再试一次')
      } finally {
        setPending(null)
      }
    },
    [source, later, reportFailure],
  )

  const replyPost = useCallback(
    async (postId: string, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const reply = {
        id: nextId('reply'),
        text: trimmed,
        createdAt: new Date().toISOString(),
        author: 'user' as const,
      }

      if (source === 'demo') {
        setState((prev) => ({
          ...prev,
          posts: prev.posts.map((post) =>
            post.id === postId ? { ...post, replies: [...post.replies, reply] } : post,
          ),
        }))
        // 回应动态即进入对话：这条回复同时落到对话里，之后可以接着聊
        await sendMessage(trimmed, postId)
        return
      }

      setPending(postId)
      try {
        const saved = await companionApi.replyToPost(postId, trimmed)
        setState((prev) => ({
          ...prev,
          posts: prev.posts.map((post) =>
            post.id === postId ? { ...post, replies: [...post.replies, saved] } : post,
          ),
        }))
        await sendMessage(trimmed, postId)
      } catch (error) {
        reportFailure(offlineReasonOf(error) ?? '这条回应没能送出，稍后再试一次')
      } finally {
        setPending(null)
      }
    },
    [source, sendMessage, reportFailure],
  )

  /* ---------- 暂停 / 恢复记录 ---------- */
  const setPaused = useCallback(
    async (paused: boolean) => {
      if (source === 'demo') {
        setState((prev) => (prev.device ? { ...prev, device: { ...prev.device, paused } } : prev))
        return
      }
      setPending('device-pause')
      try {
        const device = await companionApi.setDevicePaused(paused)
        setState((prev) => ({ ...prev, device }))
      } catch (error) {
        reportFailure(offlineReasonOf(error) ?? '没能切换暂停状态，稍后再试一次')
      } finally {
        setPending(null)
      }
    },
    [source, reportFailure],
  )

  const value = useMemo<AppStateValue>(
    () => ({
      connection,
      offlineReason,
      reconnect,
      source,
      enterDemo,
      exitDemo,
      device: state.device,
      meals: state.meals,
      posts: state.posts,
      messages: state.messages,
      companionAction: state.companionAction,
      simulateCapture,
      confirmPortion,
      sendMessage,
      replyPost,
      setPaused,
      pending,
    }),
    [
      connection,
      offlineReason,
      reconnect,
      source,
      enterDemo,
      exitDemo,
      state,
      simulateCapture,
      confirmPortion,
      sendMessage,
      replyPost,
      setPaused,
      pending,
    ],
  )

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
}

/** 用户确认份量之后，由那一餐生成的小伴动态 */
function buildConfirmedPost(meal: Meal, portionLabel: string): Post {
  const draft = demoPostAfterConfirm(portionLabel, meal.capture.capturedAt)
  return {
    id: nextId('post'),
    createdAt: new Date().toISOString(),
    action: draft.action,
    text: draft.text,
    basis: draft.basis,
    replies: [],
  }
}

export function useAppState(): AppStateValue {
  const value = useContext(AppStateContext)
  if (!value) throw new Error('useAppState 必须在 <AppStateProvider> 内使用')
  return value
}
