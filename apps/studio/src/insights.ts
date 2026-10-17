import type { MacroGrams, Meal, PersonalProfile } from './model'

const zone = 'Asia/Shanghai'

export function dayKey(iso: string | Date) {
  const date = iso instanceof Date ? iso : new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
}
export function hourOf(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const [h, m] = date.toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number)
  return h + m / 60
}
export function shiftDay(key: string, days: number) {
  const date = new Date(`${key}T12:00:00+08:00`)
  date.setUTCDate(date.getUTCDate() + days)
  return dayKey(date)
}
export function dayLabel(key: string, todayKey = dayKey(new Date())) {
  if (key === todayKey) return '今天'
  if (key === shiftDay(todayKey, -1)) return '昨天'
  const date = new Date(`${key}T12:00:00+08:00`)
  return date.toLocaleDateString('zh-CN', { timeZone: zone, month: 'numeric', day: 'numeric' }) + ' ' + date.toLocaleDateString('zh-CN', { timeZone: zone, weekday: 'short' })
}
export function weekdayShort(key: string) {
  return new Date(`${key}T12:00:00+08:00`).toLocaleDateString('zh-CN', { timeZone: zone, weekday: 'narrow' })
}

export function mealSlot(iso: string) {
  const hour = hourOf(iso)
  if (hour === null) return '一餐'
  if (hour < 4.5) return '夜宵'
  if (hour < 10.5) return '早餐'
  if (hour < 14.5) return '午餐'
  if (hour < 17) return '加餐'
  if (hour < 21) return '晚餐'
  return '夜宵'
}

/** Energy actually eaten: only meals whose portion is known and that have a model estimate. */
export function mealEnergy(meal: Meal) { return meal.consumedCalorieRange ?? null }
export function mid(range: { min: number; max: number }) { return Math.round((range.min + range.max) / 2) }

export type DayStat = {
  key: string
  meals: Meal[]
  estimated: number
  kcal: { min: number; max: number; mid: number } | null
  macros: MacroGrams | null
  macroMeals: number
}

export function dayStat(meals: Meal[], key: string): DayStat {
  const dayMeals = meals.filter(meal => dayKey(meal.capturedAt) === key).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt))
  const ranges = dayMeals.map(mealEnergy).filter((range): range is { min: number; max: number } => !!range)
  const macroList = dayMeals.map(meal => meal.consumedMacros).filter((item): item is MacroGrams => !!item)
  const sum = ranges.reduce((acc, range) => ({ min: acc.min + range.min, max: acc.max + range.max }), { min: 0, max: 0 })
  return {
    key, meals: dayMeals, estimated: ranges.length,
    kcal: ranges.length ? { ...sum, mid: mid(sum) } : null,
    macros: macroList.length ? macroList.reduce((acc, item) => ({ proteinG: acc.proteinG + item.proteinG, carbsG: acc.carbsG + item.carbsG, fatG: acc.fatG + item.fatG }), { proteinG: 0, carbsG: 0, fatG: 0 }) : null,
    macroMeals: macroList.length,
  }
}

export function macroShares(macros: MacroGrams) {
  const protein = macros.proteinG * 4, carbs = macros.carbsG * 4, fat = macros.fatG * 9
  const total = protein + carbs + fat
  if (!total) return null
  return { protein: protein / total, carbs: carbs / total, fat: fat / total }
}

/**
 * A daily energy reference. A user-set value always wins. Otherwise a light-activity estimate
 * (Mifflin–St Jeor × 1.35) is offered only when age, height and weight are all present.
 * Weight management uses a modest 400 kcal gap and never goes below the resting estimate.
 */
export function energyTarget(profile: PersonalProfile): { value: number; source: 'user' | 'suggested' } | null {
  if (profile.calorieTarget) return { value: profile.calorieTarget, source: 'user' }
  const suggested = suggestedTarget(profile)
  return suggested ? { value: suggested, source: 'suggested' } : null
}
export function suggestedTarget(profile: PersonalProfile) {
  const { age, heightCm, weightKg, gender, goal } = profile
  if (!age || !heightCm || !weightKg) return null
  const sex = gender === 'male' ? 5 : gender === 'female' ? -161 : -78
  const rest = 10 * weightKg + 6.25 * heightCm - 5 * age + sex
  let value = rest * 1.35
  if (goal === 'weight-management') value = Math.max(rest, value - 400)
  return Math.round(value / 50) * 50
}

export type Observation = { id: string; text: string; evidence: string }

function mealRef(meal: Meal) {
  const date = new Date(meal.capturedAt)
  return `${date.toLocaleDateString('zh-CN', { timeZone: zone, month: 'numeric', day: 'numeric' })} ${mealSlot(meal.capturedAt)}`
}
function refs(meals: Meal[]) {
  const list = meals.slice(0, 4).map(mealRef)
  return list.join('、') + (meals.length > 4 ? ` 等 ${meals.length} 餐` : '')
}

/** Calm, evidence-backed observations. No scores, no judgement, at most three. */
export function observations(meals: Meal[]): Observation[] {
  const result: Observation[] = []
  const late = meals.filter(meal => { const hour = hourOf(meal.capturedAt); return hour !== null && (hour >= 21 || hour < 4.5) })
  if (late.length >= 2) result.push({ id: 'late', text: `这段时间有 ${late.length} 餐在晚上九点以后。`, evidence: refs(late) })
  const withMacros = meals.filter(meal => meal.consumedMacros)
  if (withMacros.length >= 3) {
    const total = withMacros.reduce((acc, meal) => ({ proteinG: acc.proteinG + meal.consumedMacros!.proteinG, carbsG: acc.carbsG + meal.consumedMacros!.carbsG, fatG: acc.fatG + meal.consumedMacros!.fatG }), { proteinG: 0, carbsG: 0, fatG: 0 })
    const shares = macroShares(total)
    if (shares && shares.protein < .15) result.push({ id: 'protein', text: `蛋白质在这几餐里占得少一些，约 ${Math.round(shares.protein * 100)}% 的热量。想调整的话，加个蛋或一份豆制品就够。`, evidence: refs(withMacros) })
    else if (shares && shares.fat > .4) result.push({ id: 'fat', text: `这几餐的热量里，脂肪约占 ${Math.round(shares.fat * 100)}%，油多的菜可能不少。`, evidence: refs(withMacros) })
  }
  const partial = meals.filter(meal => meal.portionFraction !== null && meal.portionFraction < 1)
  if (partial.length >= 1) result.push({ id: 'partial', text: `有 ${partial.length} 餐你没有全部吃完，都按你说的实际食量算了。`, evidence: refs(partial) })
  const breakfastDays = new Set(meals.filter(meal => mealSlot(meal.capturedAt) === '早餐').map(meal => dayKey(meal.capturedAt)))
  const days = new Set(meals.map(meal => dayKey(meal.capturedAt)))
  if (days.size >= 3 && breakfastDays.size === 0) result.push({ id: 'breakfast', text: `记录过的 ${days.size} 天里还没有早餐，可能是没吃，也可能是没拍到。`, evidence: `${days.size} 天的记录` })
  return result.slice(0, 3)
}

export function formatKcal(value: number) { return value.toLocaleString('en-US') }
