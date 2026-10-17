import { useId } from 'react'

export function FoodIllustration({ small = false }: { small?: boolean }) {
  const id = useId().replace(/:/g, '')
  return <svg className={`food-illustration ${small ? 'food-small' : ''}`} viewBox="0 0 400 275" preserveAspectRatio="xMidYMid slice" role="img" aria-label="一餐食物的演示插画，不代表识别结果">
    <defs><linearGradient id={`${id}-meal-bg`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#f8e6d2"/><stop offset="1" stopColor="#efd2b5"/></linearGradient><filter id={`${id}-plate-shadow`}><feGaussianBlur stdDeviation="7"/></filter></defs>
    <rect width="400" height="275" fill={`url(#${id}-meal-bg)`}/>
    <path d="M0 190 400 90M0 260 400 160" stroke="#e0bda0" strokeWidth="1" opacity=".4"/>
    <ellipse cx="198" cy="158" rx="130" ry="89" fill="#8b9db0" opacity=".3" filter={`url(#${id}-plate-shadow)`}/>
    <ellipse cx="194" cy="140" rx="130" ry="93" fill="#fbfbf2"/>
    <ellipse cx="194" cy="140" rx="110" ry="76" fill="#edf0e3" stroke="#e0e4d4" strokeWidth="2"/>
    <path d="M106 132c-6-26 22-47 47-43 23-9 56 3 60 21 15 16 8 44-16 50-20 14-70 10-83-4-8-8-10-15-8-24" fill="#ece1bf"/>
    <path d="M124 119 132 113M147 106l6 3M172 118l9-4M133 140l8-3M165 147l7-5M189 135l7-3M156 126l5 2" stroke="#c7b68b" strokeWidth="3" strokeLinecap="round"/>
    <g fill="#70926b"><path d="m212 93 29-8 13 26-20 20-25-15Z"/><path d="m247 123 25-4 17 23-20 18-29-12Z"/><path d="m209 140 22-10 21 25-17 22-31-8Z"/></g>
    <g fill="#83a37d"><circle cx="221" cy="97" r="15"/><circle cx="241" cy="98" r="12"/><circle cx="257" cy="131" r="15"/><circle cx="278" cy="137" r="13"/><circle cx="219" cy="153" r="16"/><circle cx="239" cy="158" r="14"/></g>
    <g fill="#db9e69" stroke="#ce8d59" strokeWidth="2"><path d="m153 177 28-19 32 12-10 24-31 7Z"/><path d="m181 182 26-24 31 14-9 23-29 7Z"/></g>
    <g fill="#d18469"><ellipse cx="118" cy="171" rx="13" ry="10" transform="rotate(-25 118 171)"/><ellipse cx="131" cy="186" rx="13" ry="10" transform="rotate(15 131 186)"/></g>
    <path d="m331 79 13 144M345 76l12 144" stroke="#ad977a" strokeWidth="5" strokeLinecap="round"/>
    <rect x="36" y="32" width="70" height="3" rx="1.5" fill="#fff" opacity=".5"/>
  </svg>
}
