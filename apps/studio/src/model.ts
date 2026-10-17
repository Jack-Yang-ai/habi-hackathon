import type { AppState, CaptureWindow as ApiCaptureWindow, CaptureReview as ApiCaptureReview, ContextSignal as ApiContextSignal, PersonalProfile } from '../../../contracts/app'

export type { PersonalProfile, MacroGrams } from '../../../contracts/app'
import type { MacroGrams } from '../../../contracts/app'
export const emptyProfile: PersonalProfile = { nickname: '', gender: 'undisclosed', age: null, heightCm: null, weightKg: null, goal: null, dietaryNotes: '', calorieTarget: null, updatedAt: null }

export type Scene = 'idle' | 'received' | 'watering' | 'resting' | 'chatting' | 'watching'
export type ContextSignal = Pick<ApiContextSignal, 'signalId' | 'stage' | 'action' | 'reason' | 'dryRun' | 'receivedAt'>
export type CaptureWindow = ApiCaptureWindow
export type CaptureReview = ApiCaptureReview
export type CompanionReminder = NonNullable<AppState['reminder']>

export type Meal = {
  id: string
  title: string
  capturedAt: string
  imageUrl?: string
  captureIds?: string[]
  source: string
  portionFraction: number | null
  confirmed: boolean
  analysisStatus: string
  plateCalorieRange?: { min: number; max: number }
  consumedCalorieRange?: { min: number; max: number }
  /** Whole-plate macro estimate and the share scaled by the user's portion. */
  plateMacros?: MacroGrams
  consumedMacros?: MacroGrams
  version?: number
  note?: string
  foods?: string[]
  uncertainties?: string[]
  demo?: boolean
}

export type Post = {
  id: string
  kind: 'meal' | 'story' | 'memory'
  title: string
  content: string
  createdAt: string
  replyCount: number
  replies?: ChatMessage[]
  demo?: boolean
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  source?: string
  mealId?: string | null
  mealProposal?: MealProposal | null
  /** Set on Habi's reply so it stays attached to the question it answered. */
  replyToId?: string | null
}

export type MealProposal = { mealId: string; expectedVersion: number; portionFraction: number | null; note: string }
export type MealDraft = { portion: number | null; note: string; expectedVersion: number; appliedProposalId?: string; expanded?: boolean }

/** A stored photo with no meal of its own: it still belongs to the user and is shown as a moment. */
export type KeptCapture = {
  id: string
  imageUrl: string
  source: string
  receivedAt: string
  capturedAt: string
  /** null while the review is still running. */
  review: string | null
  note: string
}

export type ViewState = {
  profile: PersonalProfile
  meals: Meal[]
  captures: KeptCapture[]
  posts: Post[]
  messages: ChatMessage[]
  paused: boolean
  cameraConnected: boolean
  phoneConnected: boolean
  rearDisplay: string
  scene: Scene
  analysisConfigured: boolean
  chatMode: string
  companionDays: number
  memoriesCount: number
  captureMode: string
  captureWindow: CaptureWindow | null
  captureReview: CaptureReview | null
  reminder: CompanionReminder | null
  signals: ContextSignal[]
  serverNowMs: number
  receivedAtMs: number
}

export const emptyState: ViewState = {
  profile: emptyProfile,
  meals: [], captures: [], posts: [], messages: [], paused: false, cameraConnected: false,
  phoneConnected: false, rearDisplay: 'unverified', scene: 'idle', analysisConfigured: false, chatMode: 'local-rules', companionDays: 0, memoriesCount: 0,
  captureMode: 'signals', captureWindow: null, captureReview: null, reminder: null, signals: [], serverNowMs: Date.now(), receivedAtMs: Date.now(),
}

type DemoSeed = [daysAgo: number, time: string, foods: string[], plate: [number, number], macros: [number, number, number], portion: number | null]
const demoSeeds: DemoSeed[] = [
  [5, '19:10', ['火锅', '肥牛', '蔬菜拼盘'], [1200, 1500], [60, 50, 90], .5],
  [3, '12:15', ['卤肉盖饭', '青菜'], [680, 820], [22, 110, 20], 1],
  [3, '19:05', ['清蒸鲈鱼', '米饭', '炒菠菜'], [560, 680], [36, 70, 14], 1],
  [2, '12:30', ['鸡胸沙拉', '全麦面包'], [380, 460], [34, 22, 16], 1],
  [2, '22:10', ['烤串', '烤馒头片'], [900, 1150], [46, 40, 60], .75],
  [1, '07:50', ['肉包', '豆浆'], [420, 520], [16, 64, 12], 1],
  [1, '12:20', ['牛肉面'], [700, 860], [32, 96, 24], .5],
  [1, '21:40', ['炸鸡', '可乐'], [620, 780], [28, 58, 38], 1],
  [0, '08:10', ['燕麦酸奶', '香蕉'], [380, 460], [14, 62, 9], 1],
  [0, '12:40', ['番茄炒蛋', '米饭', '蒜蓉青菜'], [620, 780], [24, 88, 22], null],
]

function demoTime(daysAgo: number, time: string) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
  const date = new Date(`${today}T${time}:00+08:00`)
  date.setUTCDate(date.getUTCDate() - daysAgo)
  // Keep today's samples in the past so the timeline reads naturally at any hour.
  const latest = Date.now() - (time < '10:00' ? 3 : 1) * 3600_000
  return new Date(daysAgo === 0 ? Math.min(date.getTime(), latest) : date.getTime()).toISOString()
}

/** Clearly labelled sample data: lets the conversation and analysis be explored without real records. */
export function createDemoState(): ViewState {
  const meals: Meal[] = demoSeeds.map(([daysAgo, time, foods, plate, [proteinG, carbsG, fatG], portion], index) => {
    const plateMacros = { proteinG, carbsG, fatG }
    const scale = (value: number) => Math.round(value * (portion ?? 0))
    return { id: `demo-meal-${index}`, title: foods.join('、'), capturedAt: demoTime(daysAgo, time), source: '演示相机', portionFraction: portion, confirmed: portion !== null,
      analysisStatus: 'ready', version: 1, demo: true, foods, plateCalorieRange: { min: plate[0], max: plate[1] }, plateMacros,
      consumedCalorieRange: portion === null ? undefined : { min: scale(plate[0]), max: scale(plate[1]) },
      consumedMacros: portion === null ? undefined : { proteinG: scale(proteinG), carbsG: scale(carbsG), fatG: scale(fatG) },
      uncertainties: ['演示数据，不是真实识别结果'] }
  }).sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))
  const breakfast = meals.find(meal => meal.id === 'demo-meal-8')!
  const lunch = meals.find(meal => meal.id === 'demo-meal-9')!
  const after = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString()
  return {
    ...emptyState,
    cameraConnected: true,
    phoneConnected: true,
    scene: 'idle',
    serverNowMs: Date.now(), receivedAtMs: Date.now(),
    profile: { ...emptyProfile, nickname: '小林', gender: 'female', age: 31, heightCm: 163, weightKg: 78, goal: 'weight-management' },
    meals,
    messages: [
      { id: 'demo-a1', role: 'assistant', content: '早餐收好了。燕麦配香蕉，挺顶饱的。', createdAt: after(breakfast.capturedAt, 2), source: 'demo', mealId: null },
      { id: 'demo-u1', role: 'user', content: '中午在公司楼下吃的', createdAt: after(lunch.capturedAt, 3), source: 'user', mealId: lunch.id },
      { id: 'demo-a2', role: 'assistant', content: '看到了，番茄炒蛋配米饭。吃了多少？在下面点一下，或者直接告诉我。', createdAt: after(lunch.capturedAt, 3.2), source: 'demo', mealId: lunch.id, replyToId: 'demo-u1' },
      // Recent enough to sit at the end of the demo conversation.
      { id: 'demo-u2', role: 'user', content: '刚吃完，有点撑', createdAt: new Date(Date.now() - 45000).toISOString(), source: 'user', mealId: null },
      { id: 'demo-a3', role: 'assistant', content: '吃撑了先慢慢走走，不用急着记什么。', createdAt: new Date(Date.now() - 43000).toISOString(), source: 'demo', mealId: null, replyToId: 'demo-u2' },
    ],
  }
}

export function makeDemoMeal(): Meal {
  return { id: `demo-meal-${Date.now()}`, title: '刚收到的一餐', capturedAt: new Date().toISOString(),
    source: '演示相机', portionFraction: null, confirmed: false, analysisStatus: 'ready', version: 1, demo: true,
    foods: ['照烧鸡腿饭', '海带汤'], plateCalorieRange: { min: 650, max: 820 }, plateMacros: { proteinG: 30, carbsG: 92, fatG: 20 },
    uncertainties: ['演示数据，不是真实识别结果'] }
}

/** Demo helper: re-scale a meal's estimate to a newly chosen portion. */
export function applyPortion(meal: Meal, portion: number): Meal {
  const scale = <T extends { proteinG: number; carbsG: number; fatG: number }>(value: T) => ({ proteinG: Math.round(value.proteinG * portion), carbsG: Math.round(value.carbsG * portion), fatG: Math.round(value.fatG * portion) })
  return { ...meal, portionFraction: portion,
    consumedCalorieRange: meal.plateCalorieRange ? { min: Math.round(meal.plateCalorieRange.min * portion), max: Math.round(meal.plateCalorieRange.max * portion) } : meal.consumedCalorieRange,
    consumedMacros: meal.plateMacros ? scale(meal.plateMacros) : meal.consumedMacros }
}

export function timeLabel(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '刚刚' : date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })
}
