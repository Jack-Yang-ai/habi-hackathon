import { useEffect, useState } from 'react'
import { Check, ChevronRight, LoaderCircle, Utensils, X } from 'lucide-react'
import { FoodIllustration } from './Companion'
import { timeLabel, type Meal, type MealDraft, type MealProposal } from './model'
import { mealSlot, mid } from './insights'

export function MealThumbnail({ meal, size = 'md' }: { meal: Meal; size?: 'sm' | 'md' | 'lg' }) {
  return <span className={`meal-thumb thumb-${size}`}>{meal.imageUrl ? <img src={meal.imageUrl} alt="这餐的原始照片"/> : meal.demo ? <FoodIllustration small/> : <Utensils size={18}/>}</span>
}

export function mealDate(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '时间待确认' : date.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric' }) + ' · ' + timeLabel(iso)
}

export function portionText(portion: number | null) {
  return portion === null ? '食量待补充' : portion === 1 ? '全部吃完' : portion === .5 ? '吃了一半' : portion === .25 ? '约四分之一' : portion === 0 ? '没有吃' : `约 ${Math.round(portion * 100)}%`
}

export function kcalText(meal: Meal) {
  if (meal.consumedCalorieRange) return `${meal.consumedCalorieRange.min}–${meal.consumedCalorieRange.max} kcal`
  if (meal.plateCalorieRange) return `整份 ${meal.plateCalorieRange.min}–${meal.plateCalorieRange.max} kcal`
  return meal.analysisStatus === 'pending' ? '正在估算…' : '热量未估算'
}

export const portionOptions = [{ value: 1, label: '全部' }, { value: .5, label: '一半' }, { value: .25, label: '一点' }, { value: 0, label: '没吃' }]

/** The meal as it appears in the conversation. Its state changes in place; it never spawns another card. */
export function TimelineMeal({ meal, active, onSupplement, onOpen }: { meal: Meal; active: boolean; onSupplement: () => void; onOpen: () => void }) {
  const range = meal.consumedCalorieRange ?? meal.plateCalorieRange
  if (meal.confirmed) return <button className="t-meal t-meal-done" onClick={onOpen} data-meal-id={meal.id}>
    <MealThumbnail meal={meal} size="sm"/>
    <span className="t-meal-text"><strong>{meal.foods?.length ? meal.foods.slice(0, 3).join('、') : meal.title}</strong><small>{mealSlot(meal.capturedAt)} · {portionText(meal.portionFraction)}{meal.demo ? ' · 演示' : ''}</small></span>
    <span className="t-meal-kcal">{meal.consumedCalorieRange ? <><b>{mid(meal.consumedCalorieRange)}</b><small>kcal</small></> : <Check size={16}/>}</span>
  </button>
  return <article className={`t-meal t-meal-open ${active ? 'is-active' : ''}`} data-meal-id={meal.id}>
    <button className="t-meal-photo" onClick={onOpen} aria-label="查看这餐的照片与估算"><MealThumbnail meal={meal} size="lg"/>{meal.demo && <span className="photo-tag">演示插画</span>}</button>
    <div className="t-meal-body">
      <div className="t-meal-head"><span className="t-meal-slot">{mealSlot(meal.capturedAt)} · {timeLabel(meal.capturedAt)}</span><span className={`pill pill-warm ${meal.analysisStatus === 'pending' ? 'pill-task' : ''}`}>{meal.analysisStatus === 'pending' ? <><LoaderCircle size={12} className="spin"/>识别中</> : '待你确认'}</span></div>
      <h3>{meal.foods?.length ? meal.foods.slice(0, 4).join('、') : meal.analysisStatus === 'pending' ? <><LoaderCircle size={15} className="spin"/>正在看这是什么…</> : meal.title}</h3>
      <p className="t-meal-kcal-line">{range ? <><b>{range.min}–{range.max}</b> kcal · {meal.consumedCalorieRange ? '按食量' : '整份估算'}</> : kcalText(meal)}</p>
      {!active && <button className="t-meal-action" onClick={onSupplement}>吃了多少？<ChevronRight size={15}/></button>}
      {active && <span className="t-meal-hint">在下方补充</span>}
    </div>
  </article>
}

/** Pinned above the composer while one meal is being supplemented. */
export function MealTray({ meal, initialDraft, proposal, proposalId, busy, canSave, others, onDraft, onConfirm, onDetails, onClose, onNext }: {
  meal: Meal; initialDraft?: MealDraft; proposal?: MealProposal | null; proposalId?: string; busy: boolean; canSave: boolean; others: number
  onDraft: (draft: MealDraft) => void; onConfirm: (draft: MealDraft) => Promise<void>; onDetails: () => void; onClose: () => void; onNext: () => void
}) {
  const [draft, setDraft] = useState<MealDraft>(() => initialDraft || (proposal ? { portion: proposal.portionFraction, note: proposal.note, expectedVersion: proposal.expectedVersion, appliedProposalId: proposalId } : { portion: meal.portionFraction, note: meal.note || '', expectedVersion: meal.version || 1 }))
  useEffect(() => {
    if (!proposal || meal.confirmed || draft.appliedProposalId === proposalId) return
    const next = { portion: proposal.portionFraction, note: proposal.note, expectedVersion: proposal.expectedVersion, appliedProposalId: proposalId }
    setDraft(next); onDraft(next)
  }, [proposalId])
  function update(next: MealDraft) { setDraft(next); onDraft(next) }
  const stale = draft.expectedVersion !== meal.version
  const fromHabi = !!proposal && draft.appliedProposalId === proposalId && draft.portion !== null
  const range = meal.plateCalorieRange
  const preview = range && draft.portion !== null ? `${Math.round(range.min * draft.portion)}–${Math.round(range.max * draft.portion)} kcal` : null
  return <section className="tray" aria-label="补充这餐食量" tabIndex={-1} data-meal-id={meal.id}>
    <header className="tray-head">
      <button className="tray-meal" onClick={onDetails}><MealThumbnail meal={meal} size="sm"/><span><strong>{fromHabi ? 'Habi 听到的是' : '这餐吃了多少？'}</strong><small>{mealSlot(meal.capturedAt)} · {timeLabel(meal.capturedAt)}{meal.demo ? ' · 演示' : ''}</small></span></button>
      <button className="icon-btn" data-habi-collapse onClick={onClose} aria-label="先不补充这餐"><X size={17}/></button>
    </header>
    <div className="portion-seg" role="radiogroup" aria-label="实际食量">{portionOptions.map(item => <button key={item.value} role="radio" aria-checked={draft.portion === item.value} onClick={() => update({ ...draft, portion: item.value })}>{item.label}</button>)}</div>
    {draft.note && <p className="tray-note">“{draft.note}”<span>原话会作为备注保留</span></p>}
    {stale && <div className="tray-stale" role="status"><p>这餐刚有更新：{portionText(meal.portionFraction)}{meal.note ? `，${meal.note}` : ''}</p><button onClick={() => update({ ...draft, expectedVersion: meal.version || 1 })}>按我的补充确认</button></div>}
    <div className="tray-foot">
      <span className="tray-preview">{preview ? <>约 <b>{preview}</b></> : draft.portion === null ? '也可以直接说：“一半，汤没喝”' : '确认后收进记录'}</span>
      <button className="btn-primary" disabled={draft.portion === null || busy || !canSave || stale} onClick={() => void onConfirm(draft)}>{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}确认</button>
    </div>
    {others > 0 && <button className="tray-next" onClick={onNext}>还有 {others} 餐等你补充<ChevronRight size={14}/></button>}
  </section>
}
