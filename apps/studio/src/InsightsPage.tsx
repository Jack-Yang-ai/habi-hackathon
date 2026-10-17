import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Info, LoaderCircle, Trash2 } from 'lucide-react'
import type { Meal, PersonalProfile } from './model'
import { dayKey, dayLabel, dayStat, energyTarget, formatKcal, hourOf, macroShares, mealSlot, mid, observations, shiftDay, weekdayShort, type DayStat } from './insights'
import { MealThumbnail, portionText } from './Timeline'
import { timeLabel } from './model'

const macroMeta = [
  { key: 'carbsG', share: 'carbs', label: '碳水', className: 'm-carbs' },
  { key: 'proteinG', share: 'protein', label: '蛋白质', className: 'm-protein' },
  { key: 'fatG', share: 'fat', label: '脂肪', className: 'm-fat' },
] as const

export function TodayStrip({ meals, profile, onOpen }: { meals: Meal[]; profile: PersonalProfile; onOpen: () => void }) {
  const today = dayStat(meals, dayKey(new Date()))
  const target = energyTarget(profile)
  const progress = today.kcal && target ? Math.min(1, today.kcal.mid / target.value) : 0
  return <button className="today-strip" onClick={onOpen} aria-label="今天的饮食，查看分析">
    <span className="today-main">
      <span className="today-label">今天</span>
      {today.kcal ? <span className="today-kcal"><b>{formatKcal(today.kcal.mid)}</b>{target && <small> / {formatKcal(target.value)}</small>}<small> kcal</small></span>
        : <span className="today-empty">{today.meals.length ? `${today.meals.length} 餐 · 还没有估算` : '还没有记录'}</span>}
    </span>
    {target && <span className="today-bar" aria-hidden="true"><i style={{ width: `${progress * 100}%` }}/></span>}
    {today.macros && <span className="today-macros">{macroMeta.map(item => <span key={item.key} className={item.className}><i/>{item.label} {Math.round(today.macros![item.key])}g</span>)}</span>}
    <ChevronRight className="today-chevron" size={16}/>
  </button>
}

export function Insights({ meals, profile, demo, onMeal, onRecall, recalling, onProfile }: { meals: Meal[]; profile: PersonalProfile; demo: boolean; onMeal: (meal: Meal) => void; onRecall: (meal: Meal) => Promise<void> | void; recalling: string; onProfile: () => void }) {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const todayKey = dayKey(new Date())
  const [range, setRange] = useState<'day' | 'week'>('day')
  const [selected, setSelected] = useState(todayKey)
  const target = energyTarget(profile)
  const week = useMemo(() => Array.from({ length: 7 }, (_, index) => dayStat(meals, shiftDay(todayKey, index - 6))), [meals, todayKey])
  const day = useMemo(() => dayStat(meals, selected), [meals, selected])
  const weekMeals = week.flatMap(item => item.meals)
  const weekMacros = useMemo(() => ({
    macros: week.reduce<DayStat['macros']>((acc, item) => item.macros ? { proteinG: (acc?.proteinG || 0) + item.macros.proteinG, carbsG: (acc?.carbsG || 0) + item.macros.carbsG, fatG: (acc?.fatG || 0) + item.macros.fatG } : acc, null),
    macroMeals: week.reduce((sum, item) => sum + item.macroMeals, 0),
  }), [week])
  const notes = useMemo(() => observations(weekMeals), [week])
  const earliest = meals.reduce((min, meal) => { const key = dayKey(meal.capturedAt); return key && key < min ? key : min }, todayKey)

  return <div className="insights">
    <div className="seg" role="tablist" aria-label="分析范围">
      <button role="tab" aria-selected={range === 'day'} onClick={() => setRange('day')}>日</button>
      <button role="tab" aria-selected={range === 'week'} onClick={() => setRange('week')}>近 7 天</button>
    </div>
    {demo && <p className="demo-note">演示数据，不代表真实记录</p>}

    {range === 'day' ? <>
      <div className="day-nav">
        <button className="icon-btn" onClick={() => setSelected(shiftDay(selected, -1))} disabled={selected <= earliest} aria-label="前一天"><ChevronLeft size={18}/></button>
        <strong>{dayLabel(selected, todayKey)}</strong>
        <button className="icon-btn" onClick={() => setSelected(shiftDay(selected, 1))} disabled={selected >= todayKey} aria-label="后一天"><ChevronRight size={18}/></button>
      </div>
      <EnergyCard stat={day} target={target} onProfile={onProfile}/>
      <MacroCard stat={day}/>
      <section className="card">
        <header className="card-head"><h3>这一天的餐食</h3><span>{day.meals.length} 餐</span></header>
        {day.meals.length ? <ul className="meal-rows">{day.meals.map(meal => <li key={meal.id}>
          {confirmId === meal.id
            ? <div className="meal-row-confirm" role="alertdialog" aria-label="确认撤回这一餐">
              <p>撤回「{meal.foods?.length ? meal.foods.slice(0, 3).join('、') : meal.title}」？记录和它的照片会一起消失，恢复不了。</p>
              <div><button className="btn-secondary" onClick={() => setConfirmId(null)} disabled={recalling === meal.id}>保留</button><button className="btn-danger" onClick={() => { setConfirmId(null); void onRecall(meal) }} disabled={recalling === meal.id}>{recalling === meal.id ? <LoaderCircle size={16} className="spin"/> : <Trash2 size={16}/>}撤回</button></div>
            </div>
            : <>
              <button className="meal-row-open" onClick={() => onMeal(meal)}>
                <MealThumbnail meal={meal} size="sm"/>
                <span className="meal-row-text"><strong>{meal.foods?.length ? meal.foods.slice(0, 3).join('、') : meal.title}</strong><small>{mealSlot(meal.capturedAt)} {timeLabel(meal.capturedAt)} · {meal.confirmed ? portionText(meal.portionFraction) : '待确认'}</small></span>
                <span className="meal-row-kcal">{meal.consumedCalorieRange ? <><b>{mid(meal.consumedCalorieRange)}</b><small>kcal</small></> : <small>{meal.plateCalorieRange ? '待补充食量' : '未估算'}</small>}</span>
              </button>
              <button className="meal-row-recall" onClick={() => setConfirmId(meal.id)} aria-label={`撤回${meal.foods?.length ? meal.foods.slice(0, 2).join('、') : meal.title}`}><Trash2 size={16}/></button>
            </>}
        </li>)}</ul> : <p className="card-empty">这天没有记录。</p>}
      </section>
    </> : <>
      <WeekCard week={week} target={target} onDay={key => { setSelected(key); setRange('day') }}/>
      <TimingCard meals={weekMeals}/>
      <MacroCard stat={weekMacros} title="近 7 天的营养结构"/>
    </>}

    <section className="card observe">
      <header className="card-head"><h3>Habi 注意到</h3><span>近 7 天</span></header>
      {notes.length ? <ul>{notes.map(note => <li key={note.id}><p>{note.text}</p><small>依据：{note.evidence}</small></li>)}</ul>
        : <p className="card-empty">记录再多几餐，Habi 才能说出有依据的发现。</p>}
    </section>
    <p className="fine-print"><Info size={13}/>热量和营养来自照片估算，会有误差；按你确认的食量换算。不作为医疗建议。</p>
  </div>
}

function EnergyCard({ stat, target, onProfile }: { stat: DayStat; target: ReturnType<typeof energyTarget>; onProfile: () => void }) {
  const progress = stat.kcal && target ? stat.kcal.mid / target.value : 0
  const r = 52, c = 2 * Math.PI * r
  return <section className="card energy">
    <div className="ring" aria-hidden="true">
      <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r={r} className="ring-track"/>{progress > 0.005 && <circle cx="60" cy="60" r={r} className="ring-fill" strokeDasharray={`${Math.min(progress, 1) * c} ${c}`}/>}</svg>
      <span className="ring-center">{stat.kcal ? <><b>{formatKcal(stat.kcal.mid)}</b><small>kcal</small></> : <small>未估算</small>}</span>
    </div>
    <div className="energy-text">
      {stat.kcal ? <><p className="energy-range">约 {formatKcal(stat.kcal.min)}–{formatKcal(stat.kcal.max)} kcal</p>
        {target ? <p>{progress <= 1 ? `参考 ${formatKcal(target.value)}，还有约 ${formatKcal(Math.max(0, target.value - stat.kcal.mid))}` : `比参考 ${formatKcal(target.value)} 多约 ${formatKcal(stat.kcal.mid - target.value)}`}</p> : <p>还没有参考值</p>}
      </> : <p>{stat.meals.length ? '这天的餐食还没有热量估算，或还没补充食量。' : '这天还没有记录。'}</p>}
      <p className="energy-source">{stat.meals.length ? `${stat.estimated}/${stat.meals.length} 餐有估算` : ''}{target?.source === 'suggested' ? ' · 参考值按资料推算' : ''}</p>
      {!target && <button className="link" onClick={onProfile}>在资料里设一个参考值<ChevronRight size={13}/></button>}
    </div>
  </section>
}

function MacroCard({ stat, title = '营养结构' }: { stat: Pick<DayStat, 'macros' | 'macroMeals'>; title?: string }) {
  const shares = stat.macros ? macroShares(stat.macros) : null
  return <section className="card">
    <header className="card-head"><h3>{title}</h3><span>{stat.macroMeals ? `基于 ${stat.macroMeals} 餐` : ''}</span></header>
    {stat.macros && shares ? <>
      <div className="macro-stack" aria-hidden="true">{macroMeta.map(item => <i key={item.key} className={item.className} style={{ flexGrow: shares[item.share] }}/>)}</div>
      <ul className="macro-list">{macroMeta.map(item => <li key={item.key} className={item.className}><i/><span>{item.label}</span><b>{Math.round(stat.macros![item.key])}<small>g</small></b><em>{Math.round(shares[item.share] * 100)}%</em></li>)}</ul>
    </> : <p className="card-empty">有了照片估算并补充食量后，这里会显示碳水、蛋白质和脂肪。</p>}
  </section>
}

function WeekCard({ week, target, onDay }: { week: DayStat[]; target: ReturnType<typeof energyTarget>; onDay: (key: string) => void }) {
  const values = week.map(item => item.kcal?.max || 0)
  const top = Math.max(target?.value || 0, ...values, 1) * 1.08
  const withData = week.filter(item => item.kcal)
  const average = withData.length ? Math.round(withData.reduce((sum, item) => sum + item.kcal!.mid, 0) / withData.length) : null
  const todayKey = dayKey(new Date())
  return <section className="card week">
    <header className="card-head"><h3>每日热量</h3><span>{average ? `有估算的 ${withData.length} 天，平均 ${formatKcal(average)} kcal` : '还没有估算'}</span></header>
    <div className="bars" role="list">
      {target && <i className="bars-target" style={{ bottom: `${target.value / top * 100}%` }}><span>{formatKcal(target.value)}</span></i>}
      {week.map(item => <button role="listitem" key={item.key} className={`bar ${item.key === todayKey ? 'is-today' : ''}`} onClick={() => onDay(item.key)} aria-label={`${dayLabel(item.key)}：${item.kcal ? `约 ${item.kcal.mid} kcal` : item.meals.length ? `${item.meals.length} 餐，未估算` : '没有记录'}`}>
        <span className="bar-col">{item.kcal ? <><i className="bar-range" style={{ bottom: `${item.kcal.min / top * 100}%`, height: `${(item.kcal.max - item.kcal.min) / top * 100}%` }}/><i className="bar-fill" style={{ height: `${item.kcal.mid / top * 100}%` }}/></> : item.meals.length ? <i className="bar-ghost"/> : <i className="bar-none"/>}</span>
        <small>{item.key === todayKey ? '今' : weekdayShort(item.key)}</small>
      </button>)}
    </div>
  </section>
}

function TimingCard({ meals }: { meals: Meal[] }) {
  const points = meals.map(meal => ({ meal, hour: hourOf(meal.capturedAt) })).filter((item): item is { meal: Meal; hour: number } => item.hour !== null)
  return <section className="card timing">
    <header className="card-head"><h3>吃饭的时间</h3><span>{points.length} 餐</span></header>
    {points.length ? <div className="timeline-axis">
      <div className="axis-track">{points.map(({ meal, hour }) => <i key={meal.id} className={hour >= 21 || hour < 4.5 ? 'late' : ''} style={{ left: `${hour / 24 * 100}%` }}/>)}</div>
      <div className="axis-labels"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
    </div> : <p className="card-empty">还没有记录。</p>}
  </section>
}
