import { Check, Flame, Heart, Leaf, LoaderCircle, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { PersonalProfile } from './model'
import { suggestedTarget } from './insights'

export const profileGoals: Array<{ value: NonNullable<PersonalProfile['goal']>; label: string; description: string }> = [
  { value: 'balanced', label: '吃得更均衡', description: '照顾好每一餐' },
  { value: 'weight-management', label: '管理体重', description: '找到适合自己的节奏' },
  { value: 'fitness', label: '支持运动', description: '为日常活动补充能量' },
  { value: 'understand', label: '了解饮食习惯', description: '先看看自己怎么吃' },
]

export function profileInitial(nickname: string) { return Array.from(nickname.trim())[0] || '' }

export function ProfileForm({ profile, initialDraft, onDraftChange, busy, demo, canSave, onSave }: {
  profile: PersonalProfile; initialDraft?: PersonalProfile | null; onDraftChange?: (draft: PersonalProfile) => void; busy: boolean; demo: boolean; canSave: boolean; onSave: (profile: PersonalProfile) => Promise<void>
}) {
  const [draft, setDraft] = useState<PersonalProfile>(() => ({ ...(initialDraft || profile) }))
  const suggestion = suggestedTarget(draft)
  const edited = useRef(!!initialDraft)
  useEffect(() => { if (!edited.current) setDraft({ ...profile }) }, [profile])
  function update<K extends keyof PersonalProfile>(key: K, value: PersonalProfile[K]) { edited.current = true; const next = { ...draft, [key]: value }; setDraft(next); onDraftChange?.(next) }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (canSave && !busy) void onSave(draft) }
  return <form aria-busy={busy} className="profile-form" onSubmit={submit}><div className="profile-scroll">
    <div className="profile-intro"><div className="profile-portrait">{profileInitial(draft.nickname) || <UserRound size={27}/>}</div><div className="profile-intro-copy"><h2>让 Habi 更了解你</h2><p>全部选填，随时可以修改。</p></div></div>
    <section className="profile-section" aria-labelledby="profile-basic-title"><h3 id="profile-basic-title"><UserRound size={16}/> 关于你</h3>
      <label className="profile-field" htmlFor="profile-nickname"><span>昵称</span><input id="profile-nickname" value={draft.nickname} onChange={event => update('nickname', event.target.value)} maxLength={30} autoComplete="nickname" placeholder="希望 Habi 怎么称呼你？"/></label>
      <div className="profile-field-row"><label className="profile-field" htmlFor="profile-gender"><span>性别</span><select id="profile-gender" value={draft.gender} onChange={event => update('gender', event.target.value as PersonalProfile['gender'])}><option value="undisclosed">暂不填写</option><option value="female">女</option><option value="male">男</option></select></label><label className="profile-field" htmlFor="profile-age"><span>年龄</span><div className="profile-unit-input"><input id="profile-age" type="number" inputMode="numeric" min="1" max="120" step="1" value={draft.age ?? ''} onChange={event => update('age', event.target.value === '' ? null : event.target.valueAsNumber)} placeholder="选填"/><span>岁</span></div></label></div>
      <div className="profile-field-row"><label className="profile-field" htmlFor="profile-height"><span>身高</span><div className="profile-unit-input"><input id="profile-height" type="number" inputMode="decimal" min="50" max="250" step="0.1" value={draft.heightCm ?? ''} onChange={event => update('heightCm', event.target.value === '' ? null : event.target.valueAsNumber)} placeholder="选填"/><span>cm</span></div></label><label className="profile-field" htmlFor="profile-weight"><span>体重</span><div className="profile-unit-input"><input id="profile-weight" type="number" inputMode="decimal" min="10" max="500" step="0.1" value={draft.weightKg ?? ''} onChange={event => update('weightKg', event.target.value === '' ? null : event.target.valueAsNumber)} placeholder="选填"/><span>kg</span></div></label></div>
    </section>
    <section className="profile-section" aria-labelledby="profile-goal-title"><div className="profile-section-heading"><h3 id="profile-goal-title"><Heart size={16}/> 想一起做的事</h3>{draft.goal && <button type="button" onClick={() => update('goal', null)}>清除</button>}</div><p>选一个现在最在意的，之后也能改。</p><div className="profile-goals" role="group" aria-label="饮食目标">{profileGoals.map(goal => <button type="button" key={goal.value} aria-pressed={draft.goal === goal.value} className={draft.goal === goal.value ? 'selected' : ''} onClick={() => update('goal', draft.goal === goal.value ? null : goal.value)}><span className="goal-check">{draft.goal === goal.value && <Check size={12}/>}</span><strong>{goal.label}</strong><small>{goal.description}</small></button>)}</div></section>
    <section className="profile-section" aria-labelledby="profile-energy-title"><div className="profile-section-heading"><h3 id="profile-energy-title"><Flame size={16}/> 每日热量参考</h3>{draft.calorieTarget !== null && <button type="button" onClick={() => update('calorieTarget', null)}>清除</button>}</div><p>选填。分析页会用它做对比，不用它来打分或下结论。</p><label className="profile-field target-field" htmlFor="profile-calorie-target"><span>每天参考</span><div className="profile-unit-input"><input id="profile-calorie-target" type="number" inputMode="numeric" min="800" max="6000" step="50" value={draft.calorieTarget ?? ''} onChange={event => update('calorieTarget', event.target.value === '' ? null : Math.round(event.target.valueAsNumber))} placeholder={suggestion ? String(suggestion) : '选填'}/><span>kcal</span></div></label>{draft.calorieTarget === null && suggestion && <div className="target-actions"><button type="button" onClick={() => update('calorieTarget', suggestion)}>用推算的 {suggestion} kcal</button></div>}<p className="target-hint">{[draft.age, draft.heightCm, draft.weightKg].filter(value => value !== null).length < 3 ? '填好年龄、身高、体重后，Habi 可以推算一个起点。' : suggestion ? `按你的资料和“吃得更均衡/管理体重”的目标推算约 ${suggestion} kcal（静息 × 1.35${draft.goal === 'weight-management' ? '，管理体重时留 400 kcal 余量' : ''}）。你自己的数字优先。` : ''}这只是参考，不是医嘱，也不代表必须吃到。</p></section>
    <section className="profile-section" aria-labelledby="profile-food-title"><h3 id="profile-food-title"><Leaf size={16}/> 饮食偏好与忌口</h3><label className="profile-field" htmlFor="profile-dietary"><span>有想让 Habi 记住的吗？</span><textarea id="profile-dietary" value={draft.dietaryNotes} onChange={event => update('dietaryNotes', event.target.value)} maxLength={500} rows={3} placeholder="比如：不吃香菜、偏好清淡，或有需要记录的过敏信息"/></label><p className="profile-dietary-note">作为个人备注保存，暂不用于自动排除食物。</p></section>
    <div className="profile-storage-note"><ShieldCheck size={17}/><p>{demo ? '演示资料只在本次体验中保留，退出后不会写入真实档案。' : '资料保存在你的本地服务中；不随餐食照片发送给模型。你可以随时修改或清空字段。'}</p></div>
    {!canSave && <p className="profile-offline-note">连接本地服务后即可保存，已填写的内容会保留在当前页面。</p>}
    </div><div className="profile-footer"><button className="primary-button profile-save" type="submit" disabled={busy || !canSave}>{busy ? <LoaderCircle size={17} className="spin"/> : <Check size={17}/>}保存个人资料</button>
    {profile.updatedAt && <p className="profile-saved-at">上次保存 {new Date(profile.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</p>}
    </div>
  </form>
}
