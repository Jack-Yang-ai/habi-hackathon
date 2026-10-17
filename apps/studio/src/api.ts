import { emptyProfile, emptyState, type ViewState } from './model'
import { randomUuid } from './uuid'
import type { AppState, CaptureMetadata } from '../../../contracts/app'

export class ApiError extends Error {
  constructor(message: string, public status = 0) { super(message) }
}

/** Thrown when the service confirms the page already holds the current state. */
export class NotModified extends Error {
  constructor() { super('state unchanged') }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try { response = await fetch(`/api${path}`, options) }
  catch { throw new ApiError('暂时连不上本地服务，记录仍保留在设备端。') }
  // The service answers 304 when nothing changed; that is a successful poll, not an error.
  if (response.status === 304) throw new NotModified()
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) throw new ApiError('本地服务还未启动。', response.status)
  const body = await response.json()
  if (!response.ok) throw new ApiError(body.error?.message || body.message || '这次操作没有完成，请稍后重试。', response.status)
  return body as T
}

let stateEtag = ''

/** Returns null when the service says the page already has the current state. */
export async function getState(): Promise<ViewState | null> {
  try {
    const response = await fetch('/api/state', { headers: stateEtag ? { 'If-None-Match': stateEtag } : {} })
    if (response.status === 304) return null
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) throw new ApiError('本地服务还未启动。', response.status)
    stateEtag = response.headers.get('ETag') || ''
    const body = await response.json()
    if (!response.ok) throw new ApiError(body.error?.message || '这次操作没有完成，请稍后重试。', response.status)
    return normalizeState(body)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError('暂时连不上本地服务，记录仍保留在设备端。')
  }
}

export function post<T>(path: string, payload: unknown): Promise<T> {
  return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
}

// The service contract stays separate from the portable Studio view models.
export function normalizeState(value: unknown): ViewState {
  if (!value || typeof value !== 'object') return emptyState
  const state = ('state' in value ? value.state : value) as AppState
  const { device, config, companion } = state
  if (!device || !config || !companion) throw new ApiError('服务状态格式不匹配，请更新本地服务。')
  const awaitingReview = device.captureReview && ['waiting_photo', 'checking', 'waiting_retry', 'food_found'].includes(device.captureReview.status)
  const collectingScene = device.captureWindow || awaitingReview ? 'watching' : 'received'
  return {
    ...emptyState,
    profile: { ...emptyProfile, ...state.profile },
    meals: (state.meals || []).map((meal) => ({
      id: meal.id, title: meal.title === '待确认的一餐' && meal.status === 'confirmed' ? '已确认的一餐' : meal.title || '收到的一餐', capturedAt: meal.capturedAt || meal.createdAt,
      imageUrl: meal.imageUrl, captureIds: (meal.images || []).map(image => image.id), source: { esp32: '随身相机', phone: '手机拍摄', import: '手动上传' }[meal.source] || meal.source,
      portionFraction: meal.portionFraction, confirmed: meal.status === 'confirmed',
      analysisStatus: meal.analysis.status,
      plateCalorieRange: meal.analysis.calorieRange || undefined,
      consumedCalorieRange: meal.consumedCalorieRange || undefined,
      plateMacros: meal.analysis.macros || undefined,
      consumedMacros: meal.consumedMacros || undefined,
      version: meal.version, note: meal.note, foods: meal.analysis.foods.map(item => item.name),
      uncertainties: meal.analysis.uncertainties,
    })),
    // A first frame the review rejected has no meal, but the photo is still the user's; it is shown
    // as a moment instead of disappearing. The reason becomes one short line here.
    captures: (state.captures || []).map((capture) => ({
      id: capture.id, imageUrl: capture.imageUrl, source: capture.source === 'phone' ? '手机拍摄' : '随身相机',
      receivedAt: capture.receivedAt, capturedAt: capture.capturedAt || capture.receivedAt,
      review: capture.review ? capture.review.status : null,
      note: captureNote(capture.review?.status),
    })),
    posts: (state.posts || []).map((item) => ({
      id: item.id, kind: item.kind === 'shared-experience' ? 'meal' : 'story', title: '', content: item.body,
      createdAt: item.createdAt, replyCount: item.replies?.filter(reply => reply.role === 'user').length || 0,
      replies: item.replies?.map(reply => ({ id: reply.id, role: reply.role, content: reply.body, createdAt: reply.createdAt, source: reply.mode })),
    })),
    messages: (state.messages || []).map(item => ({ ...item, source: item.mode })),
    paused: device.paused,
    cameraConnected: device.cameraConnected,
    phoneConnected: device.phoneConnected,
    rearDisplay: device.rearDisplay,
    scene: companion.scene === 'collecting' ? collectingScene : companion.scene === 'listening' ? 'chatting' : companion.scene,
    analysisConfigured: config.analysisConfigured,
    chatMode: config.chatMode,
    companionDays: companion.companionDays,
    memoriesCount: companion.memoriesCount,
    captureMode: device.captureMode || 'signals',
    captureWindow: device.captureWindow || null,
    captureReview: device.captureReview || null,
    reminder: state.reminder || null,
    // The UI needs decisions, not transcript evidence or acoustic details.
    signals: (state.signals || []).map(signal => ({
      signalId: signal.signalId, stage: signal.stage, action: signal.action, reason: signal.reason,
      dryRun: signal.dryRun, receivedAt: signal.receivedAt,
    })),
    serverNowMs: Number.isFinite(Date.parse(state.now)) ? Date.parse(state.now) : Date.now(),
    receivedAtMs: Date.now(),
  }
}

export async function uploadImage(file: File): Promise<unknown> {
  const form = new FormData()
  form.append('image', file)
  const metadata: CaptureMetadata = { schema_version: 1, capture_id: randomUuid(), device_id: 'web-import',
    boot_id: randomUuid(), sequence: 1, captured_at: new Date().toISOString(), time_source: 'phone',
    uptime_ms: Math.round(performance.now()) }
  form.append('metadata', JSON.stringify(metadata))
  return request('/capture', { method: 'POST', body: form })
}

/** One line for a stored photo that has no meal: the review's verdict, said plainly. */
function captureNote(status?: string) {
  switch (status) {
    case 'no_food': return '这张里没有看到食物，先留着照片'
    case 'uncertain': return '这张没能看清，先留着照片'
    case 'failed': return '这次复核没跑完，照片还在'
    case 'cancelled': return '这次取景已取消，照片还在'
    case 'food_found':
    case 'complete': return '看到食物了，等你在对话里补充'
    case 'checking': return '正在检查这张里有没有食物'
    default: return '已经收好，还没有归到哪一餐'
  }
}
