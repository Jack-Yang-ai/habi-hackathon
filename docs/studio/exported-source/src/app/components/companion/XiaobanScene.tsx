/* =============================================================================
 * 小伴的小屋 —— 伙伴页主视觉。
 *
 * 一扇木框窗、窗外一点绿、窗台上两只小物件，小伴坐在窗台边做它自己的事。
 * 构图要点：小伴只占窗口下缘的一小块，窗外的天光与树影要留得住——
 * 它是"屋子里的伙伴"，不是贴满屏幕的角色立绘。
 *
 * 全部用 SVG 绘制（无外部图片）；颜色走 xb-fill-* / xb-stop-* 类
 * （SVG 的 presentation attribute 不解析 CSS 变量，口径见 globals.css 的说明）。
 * ========================================================================== */

import { useId } from 'react'

import type { CompanionAction } from '@/shared/api/companionApi'
import { cn } from '@/shared/lib/cn'
import { ACTION_LABEL, XiaobanFigure } from './XiaobanFigure'

export function XiaobanScene({
  action = 'resting',
  className,
}: {
  action?: CompanionAction
  className?: string
}) {
  const uid = useId().replace(/[:]/g, '')
  const skyGradient = `scene-sky-${uid}`
  const sunGlow = `scene-glow-${uid}`
  const windowClip = `scene-window-${uid}`

  return (
    <div className={cn('relative overflow-hidden rounded-lg bg-surface', className)}>
      <svg
        viewBox="0 0 360 250"
        role="img"
        aria-label={`小伴的小屋，小伴${ACTION_LABEL[action]}`}
        className="block w-full"
      >
        <defs>
          <linearGradient id={skyGradient} x1="0" y1="0" x2="0" y2="1">
            <stop className="xb-stop-sky" offset="0%" />
            <stop className="xb-stop-sky-fade" offset="100%" />
          </linearGradient>
          <radialGradient id={sunGlow} cx="0.5" cy="0.5" r="0.5">
            <stop className="xb-stop-light" offset="0%" stopOpacity="0.18" />
            <stop className="xb-stop-light" offset="100%" stopOpacity="0" />
          </radialGradient>
          <clipPath id={windowClip}>
            <rect x="78" y="24" width="204" height="140" rx="5" />
          </clipPath>
        </defs>

        {/* 墙面与墙脚 */}
        <rect width="360" height="250" className="xb-fill-wall" />
        <rect y="234" width="360" height="16" className="xb-fill-wall-shade" />

        {/* 窗框：外圈深木，内缘浅木。顺序要紧——内缘先整块铺满，
            随后的玻璃再盖住中间，只露出一圈 8px 的浅色倒角；
            反过来写的话，整片玻璃会被木色糊住，窗外就什么都看不见了。 */}
        <rect x="70" y="16" width="220" height="156" rx="10" className="xb-fill-wood" />
        <rect x="78" y="24" width="204" height="140" rx="5" className="xb-fill-wood-light" />

        {/* 窗外的风景（裁剪在玻璃内） */}
        <g clipPath={`url(#${windowClip})`}>
          <rect x="78" y="24" width="204" height="140" fill={`url(#${skyGradient})`} />
          <circle cx="118" cy="58" r="16" className="xb-fill-light" opacity="0.8" />
          <circle cx="134" cy="55" r="11" className="xb-fill-light" opacity="0.8" />
          <circle cx="232" cy="70" r="10" className="xb-fill-light" opacity="0.55" />
          <circle cx="245" cy="73" r="7" className="xb-fill-light" opacity="0.55" />
          {/* 远处的树冠：一层层压出层次 */}
          <ellipse cx="96" cy="152" rx="38" ry="36" className="xb-fill-foliage-far" />
          <ellipse cx="152" cy="142" rx="46" ry="40" className="xb-fill-foliage" />
          <ellipse cx="214" cy="154" rx="34" ry="30" className="xb-fill-foliage-far" />
          <ellipse cx="254" cy="144" rx="30" ry="28" className="xb-fill-foliage" />
        </g>

        {/* 只留一根竖棂：两扇窗比"田"字窗更开阔，小伴头顶也不会被横棂压住 */}
        <rect x="175" y="24" width="10" height="140" className="xb-fill-wood" />

        {/* 窗台 */}
        <rect x="54" y="172" width="252" height="13" rx="3" className="xb-fill-wood-light" />
        <rect x="54" y="182" width="252" height="10" rx="3" className="xb-fill-wood" />

        {/* 窗台上的薄荷盆栽 */}
        <g>
          <path d="M74 155 L92 155 L89 172 L77 172 Z" className="xb-fill-pot" />
          <path d="M74 155 L92 155 L91.5 159 L74.5 159 Z" className="xb-fill-pot-shade" />
          <ellipse cx="83" cy="145" rx="9" ry="12" className="xb-fill-plant" />
          <ellipse cx="73" cy="150" rx="7" ry="8" className="xb-fill-plant-deep" />
          <ellipse cx="93" cy="150" rx="7" ry="8" className="xb-fill-plant-deep" />
        </g>

        {/* 窗台上的陶杯 */}
        <g>
          <path d="M260 158 L278 158 L275 172 L263 172 Z" className="xb-fill-cup" />
          <ellipse cx="269" cy="158" rx="9" ry="3" className="xb-fill-cup-rim" />
          <path
            d="M266 149 Q263 144 266 139"
            fill="none"
            className="xb-stroke-cup"
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.55"
          />
          <path
            d="M273 149 Q270 143 273 137"
            fill="none"
            className="xb-stroke-cup"
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.35"
          />
        </g>

        {/* 小伴坐在窗台上：只占窗口下缘一小块，窗外要留得住 */}
        <g transform="translate(130, 84) scale(0.5)">
          <XiaobanFigure action={action} />
        </g>

        {/* 窗口透进来的一层暖光：只提亮窗内，不冲淡整幅画面 */}
        <ellipse cx="180" cy="106" rx="104" ry="76" fill={`url(#${sunGlow})`} />
      </svg>
    </div>
  )
}
