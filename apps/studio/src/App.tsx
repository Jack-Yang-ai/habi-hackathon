import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowUp, BarChart3, Camera, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, CloudOff, CornerLeftDown, ImagePlus, Leaf, LoaderCircle, MessageCircle, Pause, Play, Plus, Settings2, ShieldCheck, Sparkles, Trash2, UserRound, Waves, Wifi, WifiOff, X } from 'lucide-react'
import { FoodIllustration } from './Companion'
import { Habi } from './Habi'
import { Insights, TodayStrip } from './InsightsPage'
import { RearDisplay } from './RearDisplay'
import { ProfileForm, profileGoals, profileInitial } from './Profile'
import { MealTray, TimelineMeal, portionOptions, portionText } from './Timeline'
import { applyPortion, createDemoState, emptyState, makeDemoMeal, timeLabel, type KeptCapture, type ChatMessage, type Meal, type MealDraft, type MealProposal, type PersonalProfile, type Scene, type ViewState } from './model'
import { ApiError, getState, normalizeState, post, uploadImage } from './api'
import { dayKey, dayLabel, macroShares, mealSlot, mid } from './insights'
import { localPhotoReady, nativeCameraLabel, nativeCommandLabel, readLocalPhoto, nativeDecisionLabel, nativeMealSignal, nativeMealSignalLabel, nativePipelineLabel, nativeRecordingControlsAvailable, nativeSignalLabel, nativeWakeLabel, readNativeCapabilities, requestNativeRecording, requestNativeRearScene, type NativeCapabilities } from './native'
import { estimatedServerNow, signalPresentation } from './signals'
import { randomUuid } from './uuid'
import { explicitPortion } from '../../../services/api/src/meal-draft.mjs'

type Page = 'home' | 'insights'
type Sheet = 'settings' | 'rear' | 'profile' | null
type LocalPhoto = { id: string; imageUrl: string; capturedAt: string; phase?: string }
type Item = { kind: 'message'; at: number; message: ChatMessage }
  | { kind: 'meal'; at: number; meal: Meal }
  /** A stored photo with no meal of its own: it belongs in the conversation at its own time. */
  | { kind: 'kept'; at: number; capture: KeptCapture }
  | { kind: 'local'; at: number; photo: LocalPhoto }
const TIMELINE_DAYS = 7
// The service refuses anything older, so the affordance never promises more than the API allows.

function App() {
  const [page, setPageState] = useState<Page>('home')
  const [demo, setDemo] = useState(new URLSearchParams(location.search).get('demo') === '1')
  const [state, setState] = useState<ViewState>(demo ? createDemoState : () => emptyState)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [rearPreview, setRearPreview] = useState<Scene | null>(null)
  const [profileOrigin, setProfileOrigin] = useState<'settings' | null>(null)
  const [profileDraft, setProfileDraft] = useState<PersonalProfile | null>(null)
  const [selectedMealId, setSelectedMealId] = useState<string | null>(null)
  const [chatMealId, setChatMealId] = useState<string | null>(null)
  const [chatFailure, setChatFailure] = useState('')
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [plusOpen, setPlusOpen] = useState(false)
  const [portion, setPortion] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [detailVersion, setDetailVersion] = useState(1)
  const [analyzeConsent, setAnalyzeConsent] = useState(false)
  const [confirmRecall, setConfirmRecall] = useState(false)
  const [activeRecallId, setActiveRecallId] = useState('')
  const [keptCapture, setKeptCapture] = useState<KeptCapture | null>(null)
  const [confirmCapture, setConfirmCapture] = useState(false)
  const [confirmCaptureId, setConfirmCaptureId] = useState('')
  const [serviceToken, setServiceToken] = useState('')
  const [native, setNative] = useState<NativeCapabilities | null>(null)
  const [dismissedSignal, setDismissedSignal] = useState<string | null>(null)
  const [cue, setCue] = useState(0)
  const [localPhotos, setLocalPhotos] = useState<LocalPhoto[]>([])
  const handedOverCaptures = useRef(new Set<string>())
  const [, advanceSignalClock] = useState(0)
  const lastOpener = useRef<HTMLElement | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pageScroll = useRef<Record<Page, number>>({ home: 0, insights: 0 })
  const stickToBottom = useRef(true)
  const mealDrafts = useRef(new Map<string, MealDraft>())
  const trayDrafts = useRef(new Map<string, MealDraft>())
  const chatDrafts = useRef(new Map<string, string>())
  const chatContext = useRef('global')
  const profileSession = useRef(0)
  const latestProfileDraft = useRef(profileDraft)
  latestProfileDraft.current = profileDraft
  const returningToSettings = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const cameraInput = useRef<HTMLInputElement>(null)
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const pendingChat = useRef(new Map<string, { message: string; clientMessageId: string }>())
  const seen = useRef({ meals: -1, replies: -1 })
  const knownMeals = useRef(new Set<string>())

  const selectedMeal = state.meals.find(meal => meal.id === selectedMealId)
  const scene: Scene = state.scene
  const pendingMeals = useMemo(() => state.meals.filter(meal => !meal.confirmed).sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt)), [state.meals])
  const chatMeal = state.meals.find(meal => meal.id === chatMealId)
  const proposedMessage = chatMealId ? [...state.messages].reverse().find(message => message.mealProposal?.mealId === chatMealId) : undefined
  const signalView = signalPresentation(state)
  const signalCard = !demo && connected && signalView.card?.key !== dismissedSignal ? signalView.card : null
  const rearUsesSystemAnimations = !demo && state.phoneConnected && state.rearDisplay === 'adb-relay'
  const rearUsesNativeFrames = !demo && native?.rear_display?.backend === 'vendor-custom'
  const rearNativeReady = !demo && native?.rear_display?.vendor_control_available === true
  const live = demo || connected
  const thinking = busy === 'chat'

  const { items, hiddenOlder } = useMemo(() => {
    const cutoff = Date.parse(`${dayKey(new Date(Date.now() - (TIMELINE_DAYS - 1) * 86400_000))}T00:00:00+08:00`)
    // A stored photo is a moment like any other, so it is sorted with the conversation instead of
    // being pinned to the top: the newest thing has to be the last thing.
    const usedInMeal = new Set(state.meals.map(meal => meal.imageUrl).filter(Boolean))
    const previews = demo ? [] : localPhotos
    const all: Item[] = [
      ...state.messages.map(message => ({ kind: 'message' as const, at: Date.parse(message.createdAt), message })),
      ...state.meals.map(meal => ({ kind: 'meal' as const, at: Date.parse(meal.capturedAt), meal })),
      // Newest few only: a rejected photo is worth keeping in view, not worth burying the
      // conversation under, and the service sends them newest first.
      ...state.captures.filter(capture => !usedInMeal.has(capture.imageUrl) && !previews.some(photo => photo.id === capture.id)).slice(0, 6)
        .map(capture => ({ kind: 'kept' as const, at: Date.parse(capture.capturedAt), capture })),
      ...previews.filter(photo => !state.meals.some(meal => meal.captureIds?.includes(photo.id)))
        .map(photo => ({ kind: 'local' as const, at: Date.parse(photo.capturedAt), photo })),
    ].filter(item => Number.isFinite(item.at)).sort((a, b) => a.at - b.at)
    const recent = all.filter(item => item.at >= cutoff || item.kind === 'local' || (item.kind === 'meal' && !item.meal.confirmed) || (item.kind === 'kept' && !item.capture.review))
    return { items: recent, hiddenOlder: all.length - recent.length }
  }, [state.messages, state.meals, state.captures, localPhotos, demo])

  const phoneTask = native?.phone_camera
  // A meal only counts as being looked at while the answer can still be on its way. An old photo whose
  // check never landed must not pin the header on "recognizing" forever.
  const checkingAgeLimitMs = 3 * 60_000
  const recognizing = phoneTask?.phase === 'capturing' || phoneTask?.phase === 'uploading' || phoneTask?.phase === 'checking'
    || state.meals.some(meal => meal.analysisStatus === 'pending' && state.serverNowMs - Date.parse(meal.capturedAt) < checkingAgeLimitMs)
  const status = !live ? '连接断开，记录都还在' : thinking ? '在想…' : recognizing ? '在认刚收到的照片' : scene === 'watching' ? '在留意这一餐' : scene === 'resting' ? '在休息' : state.paused ? '自动拍照已暂停' : pendingMeals.length ? `${pendingMeals.length} 餐等你补充` : scene === 'received' ? '收好了' : '在这里'

  function rememberOpener(target: EventTarget) { if (!sheet && !selectedMealId && target instanceof Element) { const button = target.closest<HTMLElement>('button, a'); if (button) lastOpener.current = button } }
  function setPage(next: Page) {
    setPlusOpen(false)
    if (next === page) { scroller.current?.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); return }
    if (next === 'insights' && !history.state?.habiPage) history.pushState({ ...history.state, habiPage: 'insights' }, '')
    setPageState(next)
  }
  function openProfile(origin: 'settings' | null = null) { profileSession.current++; setProfileOrigin(origin); setSheet('profile') }
  function closeProfile() { profileSession.current++; returningToSettings.current = profileOrigin === 'settings'; setSheet(profileOrigin) }
  function choosePortion(value: number) { setPortion(value); if (selectedMeal) mealDrafts.current.set(selectedMeal.id, { portion: value, note, expectedVersion: detailVersion }) }
  function changeMealNote(value: string) { setNote(value); if (selectedMeal) mealDrafts.current.set(selectedMeal.id, { portion, note: value, expectedVersion: detailVersion }) }
  /** Same saved photo and capture ID; the phone never reshoots for a retry. */
  function retryLocalPhoto() {
    try {
      const receipt = JSON.parse(window.EchoDevice?.retryLocalPhoto?.() ?? 'null') as { accepted?: boolean } | null
      if (receipt?.accepted) notify('正在补传这张照片。')
      else window.EchoDevice?.openDeviceSettings?.()
    } catch { notify('手机没有接受补传，请在设备面板里重试。') }
  }
  /** Hides the preview only; the original stays saved on the phone and can be retried from the device panel. */
  function dismissLocalPhoto(id: string) {
    handedOverCaptures.current.add(id)
    setLocalPhotos(current => current.filter(photo => photo.id !== id))
    if (id === localCaptureId) try { window.EchoDevice?.dismissLocalPhoto?.() } catch { /* The page already hid it. */ }
  }

  useEffect(() => {
    if (!plusOpen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPlusOpen(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [plusOpen])
  useEffect(() => { if (chatMealId || page !== 'home') setPlusOpen(false) }, [chatMealId, page])
  useEffect(() => {
    const viewport = window.visualViewport
    const resize = () => document.documentElement.style.setProperty('--app-viewport-height', `${viewport?.height || innerHeight}px`)
    resize(); viewport?.addEventListener('resize', resize); window.addEventListener('resize', resize)
    return () => { viewport?.removeEventListener('resize', resize); window.removeEventListener('resize', resize) }
  }, [])
  useEffect(() => {
    if (sheet !== 'settings' || !returningToSettings.current) return
    returningToSettings.current = false
    const frame = requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.profile-entry')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [sheet])
  useEffect(() => { if (sheet !== 'rear') setRearPreview(null) }, [sheet])
  useEffect(() => {
    if (demo || !connected || !native?.rear_display?.diagnostics_granted || native.rear_display.enabled === false) return
    try { requestNativeRearScene(state.scene) } catch { /* The settings panel presents the native observation. */ }
  }, [demo, connected, state.scene, !!native?.rear_display?.diagnostics_granted, native?.rear_display?.enabled])

  async function refresh(silent = false) {
    if (demo) return
    try {
      // A null answer means the service confirmed the page is already current, which is the
      // normal result of polling and must not be treated as a failed connection.
      const next = await getState()
      if (next) setState(next)
      setConnected(true)
    }
    catch (error) { setConnected(false); if (!silent) notify(error instanceof Error ? error.message : '暂时连接不上服务。') }
  }
  useEffect(() => {
    if (demo) return
    let active = true
    const load = async () => {
      try {
        const next = await getState()
        if (!active) return
        if (next) setState(next)
        setConnected(true)
      } catch { if (active) setConnected(false) }
    }
    void load()
    // The poll is a fallback for changes the page cannot see; it is cheap because unchanged answers
    // are a 304 with no body.
    const timer = window.setInterval(load, 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [demo])
  useEffect(() => {
    if (demo) { setNative(null); return }
    const read = () => setNative(readNativeCapabilities())
    read(); window.addEventListener('echo-device-event', read)
    const timer = window.setInterval(read, 2000)
    return () => { window.removeEventListener('echo-device-event', read); window.clearInterval(timer) }
  }, [demo])
  // Keep each committed preview until its own server record and decoded remote photo can take over.
  const localCaptureId = native?.phone_camera?.capture_id ?? ''
  useEffect(() => {
    if (demo || !localCaptureId || handedOverCaptures.current.has(localCaptureId)) return
    const camera = native?.phone_camera
    const existing = localPhotos.find(photo => photo.id === localCaptureId)
    const imageUrl = existing?.imageUrl || (localPhotoReady(camera) ? readLocalPhoto(camera?.local_photo) : null)
    if (!imageUrl) return
    if (existing && existing.phase === camera?.phase) return
    if (!existing) {
      // The photo the user just took is the newest moment: bring the conversation to it.
      setPageState('home')
      stickToBottom.current = true
    }
    setLocalPhotos(current => {
      const photo = current.find(item => item.id === localCaptureId)
      return photo
        ? current.map(item => item.id === localCaptureId ? { ...item, phase: camera?.phase } : item)
        : [...current, { id: localCaptureId, imageUrl, capturedAt: new Date().toISOString(), phase: camera?.phase }]
    })
  }, [demo, localCaptureId, native?.phone_camera, localPhotos])
  // Decodes outlive effect re-runs: every poll answer re-runs this, and a cleanup must not discard
  // a decode that is about to hand the preview over.
  const handoverLoading = useRef(new Set<string>())
  useEffect(() => {
    if (demo || !connected || !localPhotos.length) return
    const loading = handoverLoading.current
    const load = () => {
      for (const photo of localPhotos) {
        if (loading.has(photo.id) || handedOverCaptures.current.has(photo.id)) continue
        const meal = state.meals.find(item => item.captureIds?.includes(photo.id))
        const capture = state.captures.find(item => item.id === photo.id && (!item.review || ['complete', 'no_food', 'uncertain', 'failed', 'cancelled'].includes(item.review)))
        const imageUrl = meal?.imageUrl || capture?.imageUrl
        if (!imageUrl) continue
        loading.add(photo.id)
        const image = new Image()
        image.src = imageUrl
        void image.decode().then(() => {
          if (!image.naturalWidth) return
          handedOverCaptures.current.add(photo.id)
          setLocalPhotos(current => current.filter(item => item.id !== photo.id || item.imageUrl !== photo.imageUrl))
        }).catch(() => { /* A failed load keeps the preview; unchanged server state can retry too. */ })
          .finally(() => loading.delete(photo.id))
      }
    }
    load()
    const timer = window.setInterval(load, 3000)
    return () => window.clearInterval(timer)
  }, [demo, connected, localPhotos, state.meals, state.captures])
  // The upload answers before the next poll would notice it, so the bridge prompts that read.
  useEffect(() => {
    if (demo || !native?.phone_camera) return
    if (native.phone_camera.uploaded !== true && native.phone_camera.phase !== 'review_pending') return
    void refresh(true)
  }, [demo, native?.phone_camera?.capture_id, native?.phone_camera?.uploaded, native?.phone_camera?.phase])
  useEffect(() => {
    if (!signalView.card) return
    const remaining = signalView.card.expiresAtMs - estimatedServerNow(state)
    if (remaining <= 0) return
    const timer = window.setTimeout(() => advanceSignalClock(value => value + 1), Math.min(remaining + 20, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [signalView.card?.expiresAtMs, state.serverNowMs, state.receivedAtMs])
  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 4500); return () => window.clearTimeout(timer) } }, [toast])

  // A photo that arrives from the camera, the ESP32 or another device opens its own supplement tray,
  // so the user never has to hunt for it in the timeline.
  useEffect(() => {
    const first = knownMeals.current.size === 0
    const fresh = state.meals.filter(meal => !knownMeals.current.has(meal.id) && !meal.confirmed)
    knownMeals.current = new Set(state.meals.map(meal => meal.id))
    if (first || !fresh.length || chatMealId) return
    const newest = [...fresh].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0]
    chatContext.current = `meal:${newest.id}`
    setChatInput(chatDrafts.current.get(chatContext.current) || '')
    setChatMealId(newest.id)
    if (page === 'home') stickToBottom.current = true
  }, [state.meals])

  // Habi notices new photos and replies.
  useEffect(() => {
    const replies = state.messages.filter(message => message.role === 'assistant').length
    const meals = state.meals.length
    if (seen.current.meals >= 0 && (replies > seen.current.replies || meals > seen.current.meals)) setCue(value => value + 1)
    seen.current = { meals, replies }
  }, [state.messages.length, state.meals.length])

  // Conversation stays pinned to the latest moment unless the reader scrolled up.
  const serverItemCount = state.messages.length + state.meals.length + state.captures.length
  useLayoutEffect(() => {
    if (page !== 'home' || !stickToBottom.current) return
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [serverItemCount, localPhotos.length, page, thinking, chatMealId, !!signalCard, chatFailure])

  useEffect(() => {
    if (selectedMeal) { const draft = mealDrafts.current.get(selectedMeal.id); setPortion(draft ? draft.portion : selectedMeal.portionFraction); setNote(draft ? draft.note : selectedMeal.note || ''); setDetailVersion(draft ? draft.expectedVersion : selectedMeal.version || 1); setAnalyzeConsent(false); setConfirmRecall(false) }
  }, [selectedMealId])
  useEffect(() => {
    if (!sheet && !selectedMealId) return
    const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (sheet === 'profile') closeProfile(); else setSheet(null); setSelectedMealId(null) } }
    document.addEventListener('keydown', listener)
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', listener); document.body.style.overflow = '' }
  }, [sheet, selectedMealId, profileOrigin])
  // Switching pages restores that page's own scroll; the conversation stays pinned to the latest message.
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    if (page === 'home' && stickToBottom.current) node.scrollTo({ top: node.scrollHeight, behavior: 'instant' })
    else node.scrollTo({ top: pageScroll.current[page], behavior: 'instant' })
  }, [page])
  useEffect(() => {
    const back = () => { if (!history.state?.habiPage) setPageState('home') }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [])

  function notify(message: string) { setToast(message) }
  function changeDemo(enabled: boolean) {
    setProfileDraft(null); setProfileOrigin(null); profileSession.current++; mealDrafts.current.clear(); trayDrafts.current.clear(); chatDrafts.current.clear(); pendingChat.current.clear(); setChatInput(''); setChatMealId(null); setChatFailure('')
    setDemo(enabled); setState(enabled ? createDemoState() : emptyState); setSelectedMealId(null); setSheet(null); setConnected(false); setPageState('home'); stickToBottom.current = true; seen.current = { meals: -1, replies: -1 }
    const url = new URL(location.href)
    if (enabled) url.searchParams.set('demo', '1'); else url.searchParams.delete('demo')
    history.replaceState({}, '', url)
    notify(enabled ? '已进入演示，所有示例都不会写入真实记录。' : '已退出演示，返回真实记录。')
  }
  async function action(key: string, operation: () => Promise<void>) {
    if (busy) return
    setBusy(key)
    try { await operation() }
    catch (error) { if (key !== 'chat') notify(error instanceof ApiError || error instanceof Error ? error.message : '这次操作没有完成。') }
    finally { setBusy('') }
  }
  async function togglePause() {
    if (demo) { setState(current => ({ ...current, paused: !current.paused, scene: current.paused ? 'idle' : 'resting' })); return }
    const willPause = !state.paused
    await action('pause', async () => {
      // The mutation already answers with the new state, so the page does not poll for it again.
      const result = await post<{ paused: boolean; state: unknown }>('/device/pause', { paused: willPause })
      setState(normalizeState(result.state)); setConnected(true)
      notify(willPause ? '已请求暂停自动拍照与识别，已拍照片仍可补传。' : '已开启自动拍照与识别，触发的首图会送 Step 视觉检查。')
    })
  }
  async function toggleRecording() {
    if (demo || !native) return
    const start = native.recording?.recording !== true
    await action('recording', async () => {
      requestNativeRecording(start)
      setNative(readNativeCapabilities())
      notify(start ? '请在手机弹窗确认开始，录音状态以原生回读为准。' : '已请求停止录音与自动拍照，请以原生回读为准。')
    })
  }
  function addPhoto(source: 'camera' | 'library') {
    setPlusOpen(false)
    if (demo) { demoCapture(); return }
    ;(source === 'camera' ? cameraInput : fileInput).current?.click()
  }
  function demoCapture() {
    if (state.paused) { notify('现在是暂停状态，恢复后再试试。'); return }
    const meal = makeDemoMeal()
    stickToBottom.current = true
    setState(current => ({ ...current, meals: [meal, ...current.meals], scene: 'received' }))
    bindMeal(meal)
  }
  async function onFile(input: HTMLInputElement) {
    const file = input.files?.[0]
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { notify('请选择 JPG、PNG 或 WebP 图片。'); input.value = ''; return }
    if (file.size > 8 * 1024 * 1024) { notify('图片超过 8 MB，请选择较小的图片。'); input.value = ''; return }
    if (demo) { notify('演示模式使用示例插画。上传真实照片请先退出演示。'); input.value = ''; return }
    stickToBottom.current = true
    await action('upload', async () => {
      // The upload answers with the state that already includes the new photo and its draft.
      const result = await uploadImage(file) as { state: unknown }
      const next = normalizeState(result.state); setState(next); setConnected(true)
      const newest = [...next.meals].sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0]
      if (!newest) return
      // A photo the user chose to take is the moment they want to see, and the card itself carries the
      // progress. The supplement tray must be opened by the user, never pushed on them right after a
      // shot: that only ever produced a confirmation the user did not mean to give.
      // Pausing the automatic camera says nothing about this photo, so it must not gate the check.
      if (next.analysisConfigured) {
        notify('照片已收进对话，正在识别…')
        await analyzePhoto(newest.id)
      } else notify('照片已收进对话。想估算热量，点开这张照片就好。')
    })
    input.value = ''
  }
  async function saveMeal(confirm: boolean) {
    if (!selectedMeal) return
    if (portion === null) { notify('先选一下这餐吃了多少。'); return }
    if (demo) {
      mealDrafts.current.delete(selectedMeal.id)
      setState(current => ({ ...current, scene: 'received', meals: current.meals.map(item => item.id === selectedMeal.id ? { ...applyPortion(item, portion), note, confirmed: confirm || item.confirmed, version: (item.version || 0) + 1 } : item) }))
      if (confirm) { setSelectedMealId(null); if (chatMealId === selectedMeal.id) unbindMeal() }
      notify(confirm ? (selectedMeal.confirmed ? '演示修改已保存。' : '演示记录已确认。') : '演示份量已更新。')
      return
    }
    await action('meal', async () => {
      try {
        const result = await post<{ state: unknown }>(`/meals/${selectedMeal.id}/${confirm && !selectedMeal.confirmed ? 'confirm' : 'correction'}`, { portionFraction: portion, note, expectedVersion: detailVersion })
        setState(normalizeState(result.state)); setConnected(true)
      }
      catch (error) { if (error instanceof ApiError && error.status === 409) await refresh(true); throw error }
      mealDrafts.current.delete(selectedMeal.id)
      if (confirm) { setSelectedMealId(null); if (chatMealId === selectedMeal.id) unbindMeal(); notify(selectedMeal.confirmed ? '修改已保存。' : '这餐收好了。') }
      else notify('份量与备注已保存。')
    })
  }
  // Non-throwing: an estimate that fails must never fail the upload that already succeeded.
  async function analyzePhoto(mealId: string) {
    try {
      const result = await post<{ state: unknown }>(`/meals/${mealId}/analyze`, { consentToUpload: true })
      setState(normalizeState(result.state)); setConnected(true)
    } catch (error) { notify(error instanceof Error ? error.message : '这张照片的识别没有完成，点开可以再试。') }
  }
  async function analyzeMeal() {
    if (!selectedMeal || !analyzeConsent || !state.analysisConfigured) return
    await action('analyze', async () => {
      const result = await post<{ state: unknown }>(`/meals/${selectedMeal.id}/analyze`, { consentToUpload: true })
      setState(normalizeState(result.state)); setConnected(true); setAnalyzeConsent(false)
      notify('估算好了，看看食物和不确定的地方。')
    })
  }
  function switchContext(next: string) {
    chatContext.current = next
    setChatInput(chatDrafts.current.get(next) || ''); setChatFailure('')
  }
  function bindMeal(meal: Meal) {
    setPageState('home'); setChatMealId(meal.id); switchContext(`meal:${meal.id}`)
    stickToBottom.current = true
  }
  function unbindMeal() { setChatMealId(null); switchContext('global') }
  function updateChatInput(value: string) {
    chatDrafts.current.set(chatContext.current, value); setChatInput(value)
    const node = composerInput.current
    if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 132)}px` }
  }
  function clearSentChat(context: string, message: string) {
    if (chatDrafts.current.get(context)?.trim() === message) chatDrafts.current.delete(context)
    if (chatContext.current === context) { setChatInput(current => current.trim() === message ? '' : current); requestAnimationFrame(() => { if (composerInput.current) composerInput.current.style.height = 'auto' }) }
  }
  async function sendChat(event?: FormEvent) {
    event?.preventDefault()
    const message = chatInput.trim()
    if (!message || busy) return
    // A clear portion with exactly one recent pending meal is about that meal.
    let mealId = chatMealId
    if (!mealId && explicitPortion(message) !== null) {
      const recent = pendingMeals.filter(meal => Date.now() - Date.parse(meal.capturedAt) < 6 * 3600_000)
      if (recent.length === 1) { mealId = recent[0].id; chatDrafts.current.set(`meal:${mealId}`, message); setChatMealId(mealId); chatContext.current = `meal:${mealId}`; chatDrafts.current.delete('global') }
    }
    const context = chatContext.current
    const meal = state.meals.find(item => item.id === mealId)
    stickToBottom.current = true
    if (demo) {
      clearSentChat(context, message)
      const mealProposal: MealProposal | null = meal && !meal.confirmed ? { mealId: meal.id, expectedVersion: meal.version || 1, portionFraction: explicitPortion(message), note: message } : null
      const reply = mealProposal ? (mealProposal.portionFraction !== null ? '好，我按你说的填在下面了，你确认一下就行。' : '记下这句了。吃了多少，在下面点一下。') : message.includes('累') ? '今天辛苦了。想说的话，可以慢慢说。' : '我在，接着说吧。'
      const now = Date.now()
      setState(current => ({ ...current, scene: 'chatting', messages: [...current.messages,
        { id: `demo-user-${now}`, role: 'user', content: message, createdAt: new Date(now).toISOString(), source: 'user', mealId },
        { id: `demo-assistant-${now}`, role: 'assistant', content: reply, createdAt: new Date(now + 1).toISOString(), source: 'demo', mealId, mealProposal }] }))
      return
    }
    setChatFailure('')
    await action('chat', async () => {
      try {
        if (pendingChat.current.get(context)?.message !== message) pendingChat.current.set(context, { message, clientMessageId: randomUuid() })
        const result = await post('/chat', { message, clientMessageId: pendingChat.current.get(context)!.clientMessageId, ...(mealId ? { mealId } : {}) })
        pendingChat.current.delete(context)
        setState(normalizeState(result)); setConnected(true); clearSentChat(context, message)
      } catch (error) {
        if (chatContext.current === context) setChatFailure(error instanceof Error ? error.message : '这句话没有送达，请重试。')
        throw error
      }
    })
  }
  /** Withdrawing a record the user created is allowed at any time; the confirmation lives in the sheet. */
  async function recallMeal(meal: Meal) {
    if (!meal) return
    const finish = () => { setSelectedMealId(null); setConfirmRecall(false); if (chatMealId === meal.id) unbindMeal(); notify('已撤回这一餐，照片也一起删掉了。') }
    if (demo) {
      setState(current => ({ ...current, meals: current.meals.filter(item => item.id !== meal.id), messages: current.messages.filter(item => item.mealProposal?.mealId !== meal.id) }))
      finish()
      return
    }
    // The recall itself is decided on this device, so it takes effect here first: the record and its
    // photo disappear at once, the sheet closes, and only then does the service catch up.
    const snapshot = state
    const recalled = {
      ...snapshot,
      meals: snapshot.meals.filter(item => item.id !== meal.id),
      posts: snapshot.posts.filter(item => item.id !== `meal-confirmed-${meal.id}`),
      messages: snapshot.messages.filter(item => item.mealProposal?.mealId !== meal.id && item.mealId !== meal.id),
    }
    setBusy('recall-meal')
    setState(recalled)
    finish()
    try {
      setState(normalizeState(await post(`/meals/${meal.id}/recall`, {})))
      setConnected(true)
    } catch (error) {
      // Nothing was confirmed until the service agreed, so a failed recall puts the record back and
      // says so instead of leaving the page showing a deletion that never happened.
      setState(snapshot)
      notify(error instanceof Error ? error.message : '这次撤回没有送到服务，记录已经放回原处。')
    } finally { setBusy('') }
  }
  /** A stored photo is the user's own record, so deleting it takes effect here first. */
  async function recallCapture(capture: KeptCapture) {
    const snapshot = state
    setBusy('recall-capture')
    setState({ ...snapshot, captures: snapshot.captures.filter(item => item.id !== capture.id) })
    setKeptCapture(null)
    setConfirmCapture(false)
    try {
      setState(normalizeState(await post(`/captures/${capture.id}/recall`, {})))
      setConnected(true)
      notify('这张照片已经删掉了。')
    } catch (error) {
      setState(snapshot)
      notify(error instanceof Error ? error.message : '这次删除没有送到服务，照片已经放回原处。')
    } finally { setBusy('') }
  }
  async function confirmTrayMeal(meal: Meal, draft: MealDraft) {
    if (draft.portion === null) return
    if (demo) {
      if (meal.confirmed || meal.version !== draft.expectedVersion) return
      setState(current => ({ ...current, scene: 'received', meals: current.meals.map(item => item.id === meal.id ? { ...applyPortion(item, draft.portion!), confirmed: true, note: draft.note, version: (item.version || 1) + 1 } : item) }))
      trayDrafts.current.delete(meal.id); unbindMeal(); return
    }
    await action('inline-meal', async () => {
      try {
        const result = await post(`/meals/${meal.id}/confirm`, { portionFraction: draft.portion, note: draft.note, expectedVersion: draft.expectedVersion })
        setState(normalizeState(result)); setConnected(true); trayDrafts.current.delete(meal.id); unbindMeal()
      } catch (error) { if (error instanceof ApiError && error.status === 409) await refresh(true); throw error }
    })
  }
  async function connectService(event: FormEvent) {
    event.preventDefault()
    await action('connect', async () => { await post('/session', { token: serviceToken }); setServiceToken(''); await refresh(true); notify('已连接到你的本地服务。') })
  }
  async function saveProfile(profile: PersonalProfile) {
    const session = profileSession.current
    if (demo) { setState(current => ({ ...current, profile: { ...profile, updatedAt: new Date().toISOString() } })); setProfileDraft(null); closeProfile(); notify('演示资料已保存，仅在本次演示中保留。'); return }
    await action('profile', async () => {
      const { updatedAt: _updatedAt, ...fields } = profile
      const result = await post<{ profile: PersonalProfile }>('/profile', fields)
      setState(current => ({ ...current, profile: result.profile }))
      if (session === profileSession.current && (!latestProfileDraft.current || JSON.stringify(latestProfileDraft.current) === JSON.stringify(profile))) { setProfileDraft(null); closeProfile() }
      notify('个人资料已保存。')
    })
  }

  const empty = items.length === 0
  let lastDay = ''

  return <div className="shell" onClickCapture={event => rememberOpener(event.target)} onFocusCapture={event => rememberOpener(event.target)}>
    <main className={`app page-${page}`} data-habi-app="ready" data-habi-conversation={page !== 'home' || chatMeal ? 'open' : undefined} inert={!!sheet || !!selectedMealId}>
      {demo && <div className="demo-banner"><span><Sparkles size={12}/>演示模式 · 示例数据不写入真实记录</span><button onClick={() => changeDemo(false)}>退出</button></div>}

      <header className="topbar">
        {page === 'home'
          ? <div className="presence"><Habi scene={thinking ? 'chatting' : scene} cue={cue} thinking={thinking} size={48}/><span><strong>Habi</strong><small aria-live="polite">{status}</small></span></div>
          : <h1 className="page-title">饮食分析</h1>}
        <nav className="top-actions" aria-label="设置与资料">
          <button className="icon-btn" onClick={() => setSheet('settings')} aria-label="设备与设置"><Settings2 size={19}/></button>
          <button className="avatar-btn" onClick={() => openProfile()} aria-label="个人资料">{profileInitial(state.profile.nickname) || <UserRound size={17}/>}</button>
        </nav>
      </header>

      {!demo && !connected && <div className="offline"><CloudOff size={14}/><span>本地服务未连接</span><button onClick={() => void refresh()}>重试</button></div>}

      <div className={`feed ${empty && page === 'home' ? 'is-empty' : ''}`} ref={scroller} onScroll={event => { const node = event.currentTarget; pageScroll.current[page] = node.scrollTop; if (page === 'home') stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120 }}>
      {page === 'home' && <>
          <TodayStrip meals={state.meals} profile={state.profile} onOpen={() => setPage('insights')}/>
          {hiddenOlder > 0 && <button className="older" onClick={() => setPage('insights')}>更早的 {hiddenOlder} 条记录在分析里<ChevronRight size={13}/></button>}
          {empty && <div className="first-moment">
            <Habi scene={scene} size={104}/>
            <p className="habi-line big">{greeting()}{state.profile.nickname ? `，${state.profile.nickname}` : ''}。</p>
            <p className="habi-line muted">吃饭前拍一张，或者直接告诉我你吃了什么。</p>
            <span className="first-hint"><CornerLeftDown size={14}/>左下角的 ＋ 可以拍照或上传</span>
          </div>}
          <ol className="thread" role="log" aria-label="和 Habi 的对话与餐食" aria-live="polite" aria-relevant="additions">
            {items.map(item => {
              const key = dayKey(new Date(item.at))
              const divider = key !== lastDay ? <li className="day-divider" key={`d-${key}`}><span>{dayLabel(key)}</span></li> : null
              lastDay = key
              if (item.kind === 'local') {
                const phase = item.photo.phase
                const stranded = phase === 'failed' || phase === 'stopped' || phase === 'review_pending'
                // The recognition window is a task the user is waiting on, so it gets a live pill and
                // copy that says what is running, not a card that reads like nothing is happening.
                const working = phase === 'capturing' || phase === 'uploading' || phase === 'checking'
                const settledNoFood = phase === 'no_food' || phase === 'uncertain'
                const liveTask = item.photo.id === localCaptureId ? phoneTask : undefined
                const reviewFailed = phase === 'failed' && liveTask?.uploaded === true
                const failureReason = (reviewFailed || settledNoFood) && item.photo.id === localCaptureId
                  ? liveTask?.review?.reason || liveTask?.detail || (reviewFailed ? '识别暂时没有完成，原图还在手机上。' : nativeCameraLabel(phase)) : null
                const canRetry = stranded && item.photo.id === localCaptureId
                return [divider, <li className="row row-meal" key={`local-${item.photo.id}`}>
                  <article className="t-meal t-meal-open" data-local-capture={item.photo.id}>
                    <span className="t-meal-photo"><img src={item.photo.imageUrl} alt="刚拍的照片"/><span className="photo-tag">刚拍的 · 手机上</span></span>
                    <div className="t-meal-body">
                      <div className="t-meal-head"><span className="t-meal-slot">{mealSlot(item.photo.capturedAt)} · {timeLabel(item.photo.capturedAt)}</span>
                        <span className={`pill pill-warm ${working ? 'pill-task' : ''}`}>{working ? <><LoaderCircle size={12} className="spin"/>{nativeCameraLabel(phase)}</> : stranded || settledNoFood ? nativeCameraLabel(phase) : '照片已保留'}</span></div>
                      <h3>{working ? phase === 'checking' ? '正在识别这是什么…' : '照片正在传给 Habi…'
                        : phase === 'review_pending' ? '照片传上去了，结果还没查到'
                        : settledNoFood ? phase === 'no_food' ? '这张没有看到食物' : '这张拍得不太清楚'
                        : reviewFailed ? '这张照片识别没有完成'
                        : stranded ? '这张照片还没传上去' : '这张照片先给你看'}</h3>
                      <p className="t-meal-kcal-line">{working ? phase === 'checking' ? '识别好了这里会自动更新，不用等着' : '原图在手机上，传完会自动开始识别'
                        : failureReason ?? (stranded ? '原图保存在手机上，可以补传，不会重拍' : '已存在手机上，等待服务照片加载完成')}</p>
                      {(stranded || settledNoFood) && <div className="local-photo-actions">
                        {canRetry && <button className="btn-secondary" onClick={retryLocalPhoto}>{reviewFailed ? '再试一次' : phase === 'review_pending' ? '查询结果' : '补传'}</button>}
                        <button className="btn-secondary" onClick={() => dismissLocalPhoto(item.photo.id)}>不显示了</button>
                      </div>}
                    </div>
                  </article>
                </li>]
              }
              if (item.kind === 'meal') {
                const preview = localPhotos.find(photo => item.meal.captureIds?.includes(photo.id))
                const meal = preview ? { ...item.meal, imageUrl: preview.imageUrl } : item.meal
                const matchingCaptureId = preview?.id || meal.captureIds?.find(id => handedOverCaptures.current.has(id))
                return [divider, <li key={matchingCaptureId ? `local-${matchingCaptureId}` : meal.id} className="row row-meal"><TimelineMeal meal={meal} active={chatMealId === meal.id} onSupplement={() => bindMeal(item.meal)} onOpen={() => setSelectedMealId(meal.id)}/></li>]
              }
              if (item.kind === 'kept') {
                const capture = item.capture
                return [divider, <li key={capture.id} className="row row-meal">
                  <article className="t-meal t-meal-open kept-capture" data-kept-capture={capture.id}>
                    <button className="t-meal-photo" onClick={() => setKeptCapture(capture)} aria-label="查看这张照片">
                      <img src={capture.imageUrl} alt="相册里还没有归到某一餐的照片"/><span className="photo-tag">{capture.source}</span>
                    </button>
                    <div className="t-meal-body">
                      <div className="t-meal-head"><span className="t-meal-slot">{mealSlot(capture.capturedAt)} · {timeLabel(capture.capturedAt)}</span><button className="capture-row-delete" onClick={() => setConfirmCaptureId(capture.id)} disabled={!!busy} aria-label="删除这张照片"><Trash2 size={15}/></button></div>
                      <p className="t-meal-kcal-line">{capture.note}</p>
                      {confirmCaptureId === capture.id && <div className="recall-confirm" role="alertdialog" aria-label="确认删除这张照片">
                        <p>删除后这张照片从记录里消失，恢复不了。</p>
                        <div><button className="btn-secondary" onClick={() => setConfirmCaptureId('')} disabled={!!busy}>保留</button><button className="btn-danger" onClick={() => void recallCapture(capture)} disabled={!!busy}>{busy === 'recall-capture' ? <LoaderCircle size={16} className="spin"/> : <Trash2 size={16}/>}删除</button></div>
                      </div>}
                    </div>
                  </article>
                </li>]
              }
              const message = item.message
              const ref = message.role === 'user' && message.mealId ? state.meals.find(meal => meal.id === message.mealId) : null
              return [divider, <li key={message.id} className={`row row-${message.role}`}>
                {ref && <span className="msg-ref">关于{mealSlot(ref.capturedAt)} {timeLabel(ref.capturedAt)}</span>}
                <p className="msg">{message.content}</p>
                {message.role === 'assistant' && message.source !== 'model' && <small className="msg-source">{demo ? '演示回复' : '本地规则回复'}</small>}
              </li>]
            })}
            {thinking && <li className="row row-assistant"><span className="typing" role="status" aria-label="Habi 正在回应"><i/><i/><i/></span></li>}
          </ol>
          {busy === 'upload' && <p className="feed-status"><LoaderCircle size={14} className="spin"/>正在收好这张照片…</p>}
          {signalCard && <section className={`notice notice-${signalCard.kind}`} aria-label={signalCard.label}>
            <span className="notice-icon">{signalCard.kind === 'window' ? <Camera size={16}/> : <Leaf size={16}/>}</span>
            <div><strong>{signalCard.title}</strong><p>{signalCard.body}</p><small>{signalCard.meta}</small></div>
            {signalCard.kind === 'reminder' ? <button className="icon-btn" onClick={() => setDismissedSignal(signalCard.key)} aria-label="收起这条提醒"><X size={14}/></button> : <button className="chip" onClick={togglePause} disabled={!!busy}><Pause size={12}/>暂停</button>}
          </section>}
          {chatFailure && <div className="send-failed" role="alert"><p>{chatFailure} 输入已保留。</p><button onClick={() => void sendChat()} disabled={!!busy || !chatInput.trim()}>重新发送</button></div>}
      </>}
      {page === 'insights' && <Insights meals={state.meals} profile={state.profile} demo={demo} recalling={busy === 'recall-meal' ? activeRecallId : ''} onMeal={meal => setSelectedMealId(meal.id)} onRecall={meal => { setActiveRecallId(meal.id); return recallMeal(meal).finally(() => setActiveRecallId('')) }} onProfile={() => openProfile()}/>}
      </div>

      {page === 'home' && <footer className="composer-dock">
          {chatMeal && !chatMeal.confirmed && <MealTray key={chatMeal.id} meal={chatMeal} initialDraft={trayDrafts.current.get(chatMeal.id)} proposal={proposedMessage?.mealProposal} proposalId={proposedMessage?.id} busy={busy === 'inline-meal'} canSave={live}
            others={pendingMeals.filter(meal => meal.id !== chatMeal.id).length}
            onDraft={draft => trayDrafts.current.set(chatMeal.id, draft)} onConfirm={draft => confirmTrayMeal(chatMeal, draft)} onDetails={() => setSelectedMealId(chatMeal.id)} onClose={unbindMeal}
            onNext={() => { const next = pendingMeals.find(meal => meal.id !== chatMeal.id); if (next) bindMeal(next) }}/>}
          <form className="composer" onSubmit={event => void sendChat(event)}>
            <div className="plus-wrap">
              <button type="button" className={`composer-action plus ${plusOpen ? 'open' : ''}`} data-habi-collapse={plusOpen ? '' : undefined} onClick={() => setPlusOpen(open => !open)} aria-expanded={plusOpen} aria-haspopup="menu" aria-label="添加餐食照片" disabled={busy === 'upload'}><Plus size={22}/></button>
              {plusOpen && <>
                <button className="photo-scrim" aria-label="收起添加菜单" onClick={() => setPlusOpen(false)}/>
                <div className="photo-menu" role="menu" aria-label="添加餐食照片">
                  <button role="menuitem" autoFocus onClick={() => addPhoto('camera')}><span className="photo-menu-icon camera"><Camera size={18}/></span><span><strong>打开相机</strong><small>拍完直接收进对话</small></span></button>
                  <button role="menuitem" onClick={() => addPhoto('library')}><span className="photo-menu-icon"><ImagePlus size={18}/></span><span><strong>上传照片</strong><small>从相册或文件里选</small></span></button>
                </div>
              </>}
            </div>
            <textarea ref={composerInput} rows={1} enterKeyHint="send" aria-label="和 Habi 说句话" value={chatInput}
              onChange={event => updateChatInput(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendChat() } }}
              placeholder={chatMeal && !chatMeal.confirmed ? '说说这餐，比如：一半，汤没喝' : '和 Habi 说点什么…'} maxLength={chatMealId ? 1000 : 2000}/>
            <button type="submit" className="send" aria-label="发送" disabled={!chatInput.trim() || !!busy || !live}><ArrowUp size={18}/></button>
          </form>
          {(demo || (connected && state.chatMode !== 'model')) && <p className="composer-mode">{demo ? '演示 · 本地规则回复' : '自由对话暂未连接，可补充餐食'}</p>}
      </footer>}

      <nav className="bottom-nav" aria-label="主要页面">
        <button className={`nav-button ${page === 'home' ? 'active' : ''}`} aria-current={page === 'home' ? 'page' : undefined} onClick={() => setPage('home')}><MessageCircle size={20}/><span>对话</span></button>
        <button className={`nav-button ${page === 'insights' ? 'active' : ''}`} aria-current={page === 'insights' ? 'page' : undefined} onClick={() => setPage('insights')}><BarChart3 size={20}/><span>分析</span></button>
      </nav>

      <input type="file" accept="image/jpeg,image/png,image/webp" ref={fileInput} onChange={event => void onFile(event.currentTarget)} hidden aria-label="从相册选择餐食照片"/>
      <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" ref={cameraInput} onChange={event => void onFile(event.currentTarget)} hidden aria-label="拍摄餐食照片"/>
    </main>

    {selectedMeal && <SheetPanel restoreFocus={lastOpener.current} title="这一餐" onClose={() => setSelectedMealId(null)} className="meal-sheet">
      <div className="sheet-scroll">
        <div className="detail-photo">{selectedMeal.imageUrl ? <img src={selectedMeal.imageUrl} alt="这餐原始照片"/> : <FoodIllustration/>}<span className="photo-tag">{selectedMeal.demo ? '演示插画' : '原始照片'}</span></div>
        <div className="detail-head"><span>{mealSlot(selectedMeal.capturedAt)} · {timeLabel(selectedMeal.capturedAt)} · {selectedMeal.source}</span><span className={`pill ${selectedMeal.confirmed ? 'pill-ok' : 'pill-warm'}`}>{selectedMeal.confirmed ? '已确认' : '待确认'}</span></div>
        <h2 className="detail-title">{selectedMeal.foods?.length ? selectedMeal.foods.join('、') : selectedMeal.title}</h2>
        {detailVersion !== selectedMeal.version && <div className="tray-stale" role="status"><p>这餐已有更新：{portionText(selectedMeal.portionFraction)}{selectedMeal.note ? `，${selectedMeal.note}` : ''}</p><button onClick={() => { setDetailVersion(selectedMeal.version || 1); mealDrafts.current.set(selectedMeal.id, { portion, note, expectedVersion: selectedMeal.version || 1 }) }}>保留补充，按最新记录核对</button></div>}
        <NutritionPanel meal={selectedMeal}/>
        <fieldset className="detail-field"><legend>实际吃了多少</legend><div className="portion-seg" role="radiogroup">{portionOptions.map(item => <button type="button" role="radio" key={item.value} aria-checked={portion === item.value} onClick={() => choosePortion(item.value)}>{item.label}</button>)}</div></fieldset>
        <label className="detail-field" htmlFor="meal-note"><span className="legend">备注<small>选填</small></span><textarea id="meal-note" value={note} onChange={event => changeMealNote(event.target.value)} placeholder="比如：饭剩了一半，汤没有喝" maxLength={1000} rows={2}/></label>
        {state.analysisConfigured && !demo ? <div className="consent"><label><input type="checkbox" checked={analyzeConsent} onChange={event => setAnalyzeConsent(event.target.checked)}/><span>同意把这张照片发送到已配置的模型服务做估算。</span></label><button className="btn-secondary" disabled={!analyzeConsent || !!busy} onClick={analyzeMeal}>{busy === 'analyze' ? <LoaderCircle className="spin" size={15}/> : <Sparkles size={15}/>}{selectedMeal.plateCalorieRange ? '重新估算' : '估算这张照片'}</button></div>
          : <p className="fine-print"><CircleHelp size={13}/>{demo ? '演示数据不调用模型。' : '模型尚未配置，照片和你的补充仍会保存。'}</p>}
        <div className="recall-meal">
          {!confirmRecall
            ? <button className="recall-link" onClick={() => setConfirmRecall(true)}><Trash2 size={14}/>撤回这一餐</button>
            : <div className="recall-confirm" role="alertdialog" aria-label="确认撤回这一餐">
              <p>撤回后，这一餐和它的照片会一起从记录里消失，恢复不了。你的聊天记录不受影响。</p>
              <div><button className="btn-secondary" onClick={() => setConfirmRecall(false)} disabled={!!busy}>保留</button><button className="btn-danger" onClick={() => void recallMeal(selectedMeal)} disabled={!!busy}>{busy === 'recall-meal' ? <LoaderCircle size={16} className="spin"/> : <Trash2 size={16}/>}撤回</button></div>
            </div>}
        </div>
      </div>
      <div className="sheet-actions">{!selectedMeal.confirmed && <button className="btn-secondary" onClick={() => void saveMeal(false)} disabled={!!busy || portion === null || detailVersion !== selectedMeal.version}>只保存</button>}<button className="btn-primary" onClick={() => void saveMeal(true)} disabled={!!busy || portion === null || detailVersion !== selectedMeal.version}>{busy === 'meal' ? <LoaderCircle className="spin" size={16}/> : <CheckCheck size={16}/>}{selectedMeal.confirmed ? '保存修改' : '确认这一餐'}</button></div>
    </SheetPanel>}

    {sheet === 'profile' && <SheetPanel restoreFocus={lastOpener.current} title="个人资料" onClose={closeProfile} className="profile-sheet"><ProfileForm profile={state.profile} initialDraft={profileDraft} onDraftChange={setProfileDraft} busy={!!busy} demo={demo} canSave={live} onSave={saveProfile}/></SheetPanel>}

    {sheet === 'settings' && <SheetPanel restoreFocus={lastOpener.current} title="设置" onClose={() => setSheet(null)} className="settings-sheet"><div className="sheet-scroll settings">
      <button className="profile-entry" onClick={() => openProfile('settings')}><span className="avatar-btn big">{profileInitial(state.profile.nickname) || <UserRound size={20}/>}</span><span><strong>{state.profile.nickname || '完善个人资料'}</strong><small>{profileGoals.find(goal => goal.value === state.profile.goal)?.label || '让 Habi 多了解你一点'}</small></span><ChevronRight size={17}/></button>
      {!demo && !connected && <form className="service-connect" onSubmit={event => void connectService(event)}><label htmlFor="service-token">连接到你的服务</label><p>服务启用了访问保护时，输入服务端配置的连接口令。口令只用于本次连接，不保存在页面中。</p><div><input id="service-token" type="password" value={serviceToken} onChange={event => setServiceToken(event.target.value)} placeholder="本地服务连接口令" autoComplete="off"/><button type="submit" className="btn-primary" disabled={!serviceToken || !!busy}>{busy === 'connect' ? '连接中…' : '连接'}</button></div></form>}
      <h3 className="group-title">记录方式</h3>
      <div className="group">
        <button className="switch-row" role="switch" aria-label="自动拍照与识别" aria-checked={!state.paused} aria-describedby="auto-capture-description" onClick={togglePause} disabled={!!busy || !live}><span><strong>自动拍照与识别</strong><small id="auto-capture-description">{state.paused ? '已暂停，准备好时可以开启' : '用餐线索触发时先拍一张，送 Step 检查有没有食物；有才补拍，吃了多少仍由你确认。'}{!demo && !state.analysisConfigured ? ' 照片分析尚未连接。' : ''}</small></span><span className={`toggle ${!state.paused ? 'on' : ''}`}><i/></span></button>
        {native && !demo && <div className="switch-row static"><span><strong>{native.recording?.recording ? '正在手机上聆听' : '手机聆听未开启'}</strong><small>开启后可以在后台说“哈比记录”拍照，录音留在手机。</small></span><button className="btn-secondary small" onClick={() => void toggleRecording()} disabled={!!busy || !!native.recording?.stopping || !nativeRecordingControlsAvailable()}>{native.recording?.recording ? '停止' : '开启'}</button></div>}
        {native && !demo && typeof window.EchoDevice?.setRearEnabled === 'function' && <button className="switch-row" role="switch" aria-label="Habi 自定义背屏" aria-checked={!!native.rear_display?.diagnostics_granted && native.rear_display.enabled !== false} disabled={!native.rear_display?.diagnostics_granted} onClick={() => { window.EchoDevice?.setRearEnabled?.(native.rear_display?.enabled === false); setNative(readNativeCapabilities()) }}><span><strong>Habi 背屏</strong><small>{native.rear_display?.diagnostics_granted ? native.rear_display.enabled === false ? '已停用' : '状态变化时显示约 8 秒' : '设备调试诊断权限尚未配置'}{native.rear_display?.phase === 'cleanup-pending' ? ' · 上次图案恢复尚未确认' : ''}</small></span><span className={`toggle ${native.rear_display?.diagnostics_granted && native.rear_display.enabled !== false ? 'on' : ''}`}><i/></span></button>}
        <button className="link-row" onClick={() => setSheet('rear')}><Waves size={17}/><span>背屏上的 Habi<small>点阵设计预览</small></span><ChevronRight size={16}/></button>
      </div>
      <h3 className="group-title">现在可用</h3>
      <div className="group">
        <StatusRow icon={<MessageCircle size={17}/>} title="日常对话" detail={demo ? '演示使用本地规则回复' : state.chatMode === 'model' ? '可以直接和 Habi 聊' : '餐食补充可用，自由对话暂未连接'} value={demo ? '演示' : state.chatMode === 'model' ? '可用' : '待连接'} active={!demo && state.chatMode === 'model'}/>
        <StatusRow icon={<ImagePlus size={17}/>} title="照片估算" detail="热量、碳水、蛋白质、脂肪的照片估算" value={demo ? '演示' : state.analysisConfigured ? '可用' : '待连接'} active={!demo && state.analysisConfigured}/>
      </div>
      <details className="diagnostics"><summary>设备诊断<ChevronDown size={15}/></summary>
        {native && !demo && <NativeAudioPanel native={native} busy={!!busy} onToggle={() => void toggleRecording()}/>}
        <div className="group">
          {native?.phone_camera && !demo && <StatusRow icon={<Camera size={17}/>} title="手机后置相机" detail={`${native.phone_camera.voice_armed ? '后台聆听已开启，可说“哈比记录”' : '添加照片时可选择拍摄'} · ${nativeCameraLabel(native.phone_camera.phase)}`} value={native.phone_camera.voice_armed ? '语音拍照开启' : '手动可用'} active={native.phone_camera.voice_armed}/>}
          <StatusRow icon={<Camera size={17}/>} title="随身相机" detail={demo ? '演示设备，不代表硬件已接入' : 'ESP32-S3 · 等待真实心跳'} value={demo ? '演示' : state.cameraConnected ? '已连接' : '未连接'} active={state.cameraConnected}/>
          <StatusRow icon={state.phoneConnected ? <Wifi size={17}/> : <WifiOff size={17}/>} title="手机连接" detail="本地服务中的设备状态" value={demo ? '演示' : state.phoneConnected ? '已连接' : '未连接'} active={state.phoneConnected}/>
          <StatusRow icon={<Waves size={17}/>} title="背屏" detail={rearNativeReady ? '手机直接提交 Habi 静态帧 · 每次约 8 秒' : rearUsesNativeFrames ? native?.rear_display?.error || '等待手机背屏接口回读' : rearUsesSystemAnimations ? '调用系统内置眼睛表情 · 依赖 USB 与电脑' : 'Habi 点阵设计预览，非实机回读'} value={rearNativeReady ? native?.rear_display?.native_rendering ? '正在显示' : '手机直连' : rearUsesSystemAnimations ? '内置动作联调' : demo ? '设计预览' : '待连接'} active={rearNativeReady || rearUsesSystemAnimations}/>
          <StatusRow icon={<MessageCircle size={17}/>} title="长时录音" detail={demo ? '演示不启动录音' : !native ? '浏览器未连接手机原生录音' : native.recording?.recording ? `已保存 ${native.recording.segments ?? '—'} 段，音频留在本机` : native.recording?.started_at ? '本次录音已停止' : '手机录音尚未开启'} value={demo ? '演示未启用' : !native ? '设备版可用' : native.recording?.stopping ? '停止中' : native.recording?.recording ? '录音中' : '未录音'} active={!demo && native?.recording?.recording === true}/>
          {native && !demo && <StatusRow icon={<ShieldCheck size={17}/>} title="手机原生桥" detail={`${native.model || '当前设备'} · 只读能力检测`} value={native.rootAvailable ? '已有 root' : native.root === 'unavailable' ? 'root 不可用' : 'root 待检查'}/>}
          <StatusRow icon={<Leaf size={17}/>} title="进食线索" detail={demo ? '演示不伪造本地语音或上下文信号' : !connected ? '连接后同步' : signalView.detail} value={demo ? '演示未使用' : !connected ? '待同步' : signalView.status}/>
          <StatusRow icon={<Sparkles size={17}/>} title="照片分析" detail={demo ? '演示不发送照片到模型' : '自动触发首图送 Step 检查；你拍的照片也会自动送 Step 识别'} value={state.analysisConfigured ? '已配置' : '待配置'} active={state.analysisConfigured}/>
        </div>
        {native && !demo && typeof window.EchoDevice?.openDeviceSettings === 'function' && <button className="link-row" onClick={() => window.EchoDevice?.openDeviceSettings?.()}><Settings2 size={17}/><span>设备连接设置</span><ChevronRight size={16}/></button>}
      </details>
      <p className="fine-print"><ShieldCheck size={13}/>照片与补充保存在本地服务。密钥仅在服务端配置，背屏不展示体重或饮食详情。</p>
      <button className="link-row demo-row" onClick={() => changeDemo(!demo)}><Sparkles size={17}/><span>{demo ? '退出演示' : '看看演示'}<small>{demo ? '回到真实记录' : '用示例数据体验对话和分析，不写入真实记录'}</small></span><ChevronRight size={16}/></button>
    </div></SheetPanel>}

    {keptCapture && <SheetPanel restoreFocus={lastOpener.current} title="这张照片" onClose={() => { setKeptCapture(null); setConfirmCapture(false) }} className="meal-sheet">
      <div className="sheet-scroll">
        <div className="detail-photo"><img src={keptCapture.imageUrl} alt="这张照片的原图"/><span className="photo-tag">{keptCapture.source}</span></div>
        <div className="detail-head"><span>{mealSlot(keptCapture.capturedAt)} · {timeLabel(keptCapture.capturedAt)}</span><span className="pill">没有记成一餐</span></div>
        <p className="detail-title">这张照片留着</p>
        <p className="fine-print">{keptCapture.note}。它没有被算成任何一餐，也不会影响你的热量记录。</p>
        <div className="detail-actions">
          {!confirmCapture
            ? <button className="recall-link" onClick={() => setConfirmCapture(true)}><Trash2 size={14}/>删除这张照片</button>
            : <div className="recall-confirm" role="alertdialog" aria-label="确认删除这张照片">
              <p>删除后这张照片从记录和磁盘上一并消失，恢复不了。已经记成一餐的部分不受影响。</p>
              <div><button className="btn-secondary" onClick={() => setConfirmCapture(false)} disabled={!!busy}>保留</button><button className="btn-danger" onClick={() => void recallCapture(keptCapture)} disabled={!!busy}>{busy === 'recall-capture' ? <LoaderCircle size={16} className="spin"/> : <Trash2 size={16}/>}删除</button></div>
            </div>}
        </div>
      </div>
    </SheetPanel>}
    {sheet === 'rear' && <SheetPanel restoreFocus={lastOpener.current} title="背屏上的 Habi" onClose={() => { setSheet(null); setRearPreview(null) }} className="rear-sheet"><div className="sheet-scroll rear-content"><span className="pill">设计预览 · 非实机回读</span><RearDisplay scene={rearPreview || scene}/><p className="rear-copy">{rearNativeReady ? '手机已接入同源 Habi 静态帧。' : rearUsesSystemAnimations ? '当前真机使用系统内置眼睛表情。' : '图案与动作仍需设备接入验证。'}</p><div className="rear-scenes" role="group" aria-label="背屏预览状态">{([['idle', '陪伴'], ['watching', '留意'], ['received', '收好'], ['chatting', '聆听'], ['watering', '轻摆'], ['resting', '休息']] as const).map(([value, label]) => <button key={value} aria-pressed={(rearPreview || scene) === value} onClick={() => setRearPreview(value)}>{(rearPreview || scene) === value && <Check size={13}/>}{label}</button>)}</div>{native && !demo && <button className="btn-primary" disabled={!native.rear_display?.diagnostics_granted || native.rear_display.enabled === false} onClick={() => { try { requestNativeRearScene(rearPreview || scene) } catch (error) { notify(error instanceof Error ? error.message : '背屏请求未完成') } }}>显示到手机背屏</button>}<dl className="rear-spec"><dt>设计规格</dt><dd>17 × 23 单色点阵 · 静态状态切换</dd><dt>手机直连</dt><dd>{rearNativeReady ? '已接入 · 无需电脑中继' : native?.rear_display?.diagnostics_granted ? '等待首次提交与设备回读' : '需完成设备接入配置'}</dd><dt>系统动作</dt><dd>{rearUsesSystemAnimations ? 'USB 内置动画可用' : '通知与系统保护策略优先'}</dd></dl></div></SheetPanel>}

    {toast && <div className={`toast ${page === 'home' ? 'above-dock' : ''}`} role="status"><span>{toast}</span><button onClick={() => setToast('')} aria-label="关闭提示"><X size={14}/></button></div>}
  </div>
}

function greeting() {
  const hour = Number(new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }))
  return hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
}

function NutritionPanel({ meal }: { meal: Meal }) {
  const range = meal.consumedCalorieRange ?? meal.plateCalorieRange
  const macros = meal.consumedMacros ?? meal.plateMacros
  const shares = macros ? macroShares(macros) : null
  return <section className="nutrition">
    <div className="nutrition-top">
      <div>{range ? <><b>{mid(range)}</b><small>kcal</small></> : <span className="muted">热量尚未估算</span>}</div>
      <span className="pill">{meal.consumedCalorieRange ? '按食量' : meal.plateCalorieRange ? '整份估算' : meal.analysisStatus === 'pending' ? '估算中' : '未估算'}</span>
    </div>
    {range && <p className="nutrition-range">区间 {range.min}–{range.max} kcal{meal.consumedCalorieRange && meal.plateCalorieRange ? ` · 整份 ${meal.plateCalorieRange.min}–${meal.plateCalorieRange.max}` : ''}</p>}
    {macros && shares && <ul className="macro-list compact">{([['carbsG', 'carbs', '碳水', 'm-carbs'], ['proteinG', 'protein', '蛋白质', 'm-protein'], ['fatG', 'fat', '脂肪', 'm-fat']] as const).map(([key, share, label, className]) => <li key={key} className={className}><i/><span>{label}</span><b>{Math.round(macros[key])}<small>g</small></b><em>{Math.round(shares[share] * 100)}%</em></li>)}</ul>}
    {!!meal.uncertainties?.length && <p className="nutrition-note">{meal.uncertainties.join('；')}</p>}
  </section>
}

function NativeAudioPanel({ native, busy, onToggle }: { native: NativeCapabilities; busy: boolean; onToggle: () => void }) {
  const recording = native.recording
  const pipeline = recording?.pipeline
  const voice = native.voice_trigger ?? recording?.voice_trigger
  const modelsReady = pipeline?.models_ready ?? recording?.asr_connected
  const stopping = recording?.stopping || pipeline?.phase === 'stopping'
  const transcript = pipeline?.last_transcript?.trim()
  const decision = nativeDecisionLabel(pipeline?.last_decision?.stage)
  const mealSignal = nativeMealSignal(pipeline)
  const mealLabel = nativeMealSignalLabel(mealSignal)
  const error = recording?.error || pipeline?.last_error || pipeline?.last_network_error
  const count = (value?: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : '—'
  return <section className="native-panel" aria-label="手机本地感知状态">
    <div className="native-head"><strong>SenseVoice / Decider</strong><span>{nativePipelineLabel(pipeline)}</span></div>
    <p className="native-sub">{modelsReady ? '本地模型已就绪' : pipeline?.phase === 'loading_models' || pipeline?.phase === 'starting' ? '正在加载手机本地模型' : '本地模型尚未就绪'} · 音频不上传</p>
    {voice && <div className="native-block"><small>哈比 · 本地唤醒</small><p>{nativeWakeLabel(voice.phase)}</p><small>{voice.kws_ready && voice.asr_ready ? '唤醒与短句确认已就绪' : '等待本地模型就绪'} · 只叫“哈比”不会拍照</small>{(voice.error || voice.last_error) && <p role="status">{(voice.error || voice.last_error)?.slice(0, 240)}</p>}</div>}
    <dl className="native-counts">
      <div><dt>已处理</dt><dd>{count(pipeline?.processed_chunks)}</dd></div>
      <div><dt>线索</dt><dd>{count(pipeline?.submitted_signals)}</dd></div>
      <div><dt>待处理</dt><dd>{count(pipeline?.queued_chunks)}</dd></div>
      <div><dt>失败</dt><dd>{count(pipeline?.failed_chunks)}</dd></div>
      <div><dt>未处理</dt><dd>{count(pipeline?.dropped_chunks)}</dd></div>
    </dl>
    <div className="native-block"><small>最近用餐线索</small><p>{mealLabel || '尚无用餐线索回执'}</p>{mealLabel && <small>动作：{nativeSignalLabel(mealSignal?.action)}</small>}</div>
    {transcript && <div className="native-block"><small>最近一句转写</small><p>{transcript.slice(0, 500)}</p></div>}
    <details className="native-more"><summary>推理诊断</summary><p>Decider：{decision || '暂无原始候选'}</p><p>最近一句动作：{nativeSignalLabel(pipeline?.last_signal?.action)}</p></details>
    {error && <p className="native-error" role="status">处理提示：{error.slice(0, 240)}</p>}
    {native.phone_camera && <div className="native-block"><small>手机语音拍照</small><p>{nativeCameraLabel(native.phone_camera.phase)}</p>{native.phone_camera.error && <small>{native.phone_camera.error.slice(0, 240)}</small>}</div>}
    {voice && <div className="native-block"><small>最近一次口令</small><p role="status">{nativeCommandLabel(voice.last_command)}</p><small>已拍成 {count(voice.command_count)} 次 · 只叫“哈比”不会拍照</small></div>}
    <button className={recording?.recording ? 'btn-secondary' : 'btn-primary'} onClick={onToggle} disabled={busy || !!stopping || !nativeRecordingControlsAvailable()}>{stopping ? <LoaderCircle size={14} className="spin"/> : recording?.recording ? <Pause size={14}/> : <Play size={14}/>} {stopping ? '正在停止…' : recording?.recording ? '停止录音与语音拍照' : '开启聆听与语音拍照'}</button>
    <p className="native-sub">可以说“哈比记录”，也可以先叫“哈比”，6 秒内说“记录”。状态每 2 秒回读。</p>
  </section>
}
function StatusRow({ icon, title, detail, value, active = false }: { icon: ReactNode; title: string; detail: string; value: string; active?: boolean }) { return <div className="status-row"><span className="status-icon">{icon}</span><span><strong>{title}</strong><small>{detail}</small></span><span className={`status-value ${active ? 'on' : ''}`}>{value}</span></div> }

function SheetPanel({ title, onClose, className = '', children, restoreFocus }: { title: string; onClose: () => void; className?: string; children: ReactNode; restoreFocus?: HTMLElement | null }) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = restoreFocus || document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => previous?.focus()
  }, [])
  const cancel = className === 'profile-sheet' || className === 'meal-sheet'
  return <div className="sheet-overlay" onClick={onClose}><section ref={panel} className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()} onKeyDown={event => {
    if (event.key !== 'Tab') return
    const elements = panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')
    if (!elements?.length) return
    const first = elements[0], last = elements[elements.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }}><span className="sheet-grabber" aria-hidden="true"/><header className="sheet-head"><button className="sheet-dismiss" onClick={onClose}>{cancel ? '取消' : '完成'}</button><h2>{title}</h2><span/></header>{children}</section></div>
}

export default App
