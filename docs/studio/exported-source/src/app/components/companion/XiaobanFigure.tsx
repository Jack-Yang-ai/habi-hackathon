/* =============================================================================
 * 小伴本体 —— 纯 SVG + CSS 动画绘制的柔软小生物，不依赖任何外部图片。
 *
 * 造型：一颗苔绿色的团子，头顶两片小叶子，圆眼睛、淡腮红，没有一条硬邦邦的直线。
 * 五种动作对应五种姿态 / 配件，伙伴页、背屏模拟器、动态卡片共用这一个组件，
 * 保证「背屏上的小伴」和「手机里的小伴」是同一只。
 *
 * 颜色：SVG 的 presentation attribute 不解析 CSS 变量（实测会整块变黑），
 * 所以这里一律用 xb-fill-* / xb-stroke-* 类上色（定义在 globals.css，取值来自 tokens.css）。
 * ========================================================================== */

import { useId } from 'react'

import type { CompanionAction } from '@/shared/api/companionApi'
import { cn } from '@/shared/lib/cn'

/** 小伴的动作 → 一句状态词。背屏与动态都用它，保证同一时刻说的是同一件事 */
export const ACTION_LABEL: Record<CompanionAction, string> = {
  resting: '在窗边歇着',
  watering: '在给薄荷浇水',
  collecting: '刚把照片收进木盒',
  thinking: '在慢慢想事情',
  sleeping: '睡着了',
}

/**
 * 小伴的头像：只保留轮廓里最有辨识度的三样——圆脸、两片小叶、两只眼睛。
 * 动态、对话气泡这些"小伴在说话"的地方用它；需要完整姿态时才用 XiaobanFigure。
 */
export function XiaobanAvatar({ action = 'resting', className }: { action?: CompanionAction; className?: string }) {
  const uid = useId().replace(/[:]/g, '')
  const gradient = `xiaoban-avatar-${uid}`
  const sleeping = action === 'sleeping'

  return (
    <svg viewBox="0 0 48 48" role="img" aria-label="小伴" className={cn('shrink-0', className)}>
      <defs>
        <linearGradient id={gradient} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop className="xb-stop-body-light" offset="0%" />
          <stop className="xb-stop-body" offset="100%" />
        </linearGradient>
      </defs>
      <path d="M25 20 Q27 11 39 7 Q36 18 25 20 Z" className="xb-fill-leaf" />
      <path d="M23 20 Q21 11 9 7 Q12 18 23 20 Z" className="xb-fill-leaf-light" />
      <circle cx="24" cy="29" r="15" fill={`url(#${gradient})`} />
      {sleeping ? (
        <>
          <path
            d="M17 28 Q20 25 23 28"
            fill="none"
            className="xb-stroke-face"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M26 28 Q29 25 32 28"
            fill="none"
            className="xb-stroke-face"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <circle cx="19" cy="28" r="2.3" className="xb-fill-face" />
          <circle cx="29" cy="28" r="2.3" className="xb-fill-face" />
        </>
      )}
      <ellipse cx="15" cy="33" rx="3.4" ry="2" className="xb-fill-blush" opacity="0.75" />
      <ellipse cx="33" cy="33" rx="3.4" ry="2" className="xb-fill-blush" opacity="0.75" />
    </svg>
  )
}

export function XiaobanFigure({
  action = 'resting',
  className,
}: {
  action?: CompanionAction
  className?: string
}) {
  const uid = useId().replace(/[:]/g, '')
  const bodyGradient = `xiaoban-body-${uid}`

  const eyesClosed = action === 'resting' || action === 'sleeping'
  const happy = action === 'collecting'

  return (
    <svg
      viewBox="0 0 200 200"
      role="img"
      aria-label={`小伴${ACTION_LABEL[action]}`}
      className={cn('overflow-visible', className)}
    >
      <defs>
        <linearGradient id={bodyGradient} x1="0.25" y1="0" x2="0.8" y2="1">
          <stop className="xb-stop-body-light" offset="0%" />
          <stop className="xb-stop-body" offset="100%" />
        </linearGradient>
      </defs>

      {/* 脚下的柔和落影：让团子落在窗台上，而不是浮着 */}
      <ellipse cx="100" cy="176" rx="46" ry="7" className="xb-fill-shadow" opacity="0.24" />

      <g className={action === 'sleeping' ? 'xiaoban-breathe-slow' : 'xiaoban-breathe'}>
        {/* 头顶的小叶子（先画，压在身体下沿） */}
        <g className="xiaoban-sway">
          <path d="M102 72 Q109 42 140 38 Q132 70 102 72 Z" className="xb-fill-leaf" />
          <path d="M98 72 Q91 42 60 38 Q68 70 98 72 Z" className="xb-fill-leaf-light" />
        </g>

        {/* 手臂：抱东西时收到身前，其余时候垂在两侧 */}
        {action === 'collecting' ? (
          <>
            <ellipse cx="70" cy="140" rx="15" ry="11" className="xb-fill-body" />
            <ellipse cx="130" cy="140" rx="15" ry="11" className="xb-fill-body" />
          </>
        ) : (
          <>
            <ellipse cx="48" cy="132" rx="13" ry="16" className="xb-fill-body" />
            <ellipse cx="152" cy="132" rx="13" ry="16" className="xb-fill-body" />
          </>
        )}

        {/* 身体 */}
        <path
          d="M100 66 C128 66 152 90 155 122 C158 152 134 172 100 172 C66 172 42 152 45 122 C48 90 72 66 100 66 Z"
          fill={`url(#${bodyGradient})`}
        />
        {/* 腹部的浅浅高光：柔软感的来源 */}
        <ellipse cx="100" cy="134" rx="34" ry="26" className="xb-fill-belly" opacity="0.35" />

        {/* 腮红 */}
        <ellipse cx="70" cy="128" rx="10" ry="6" className="xb-fill-blush" opacity="0.75" />
        <ellipse cx="130" cy="128" rx="10" ry="6" className="xb-fill-blush" opacity="0.75" />

        {/* 眼睛 */}
        {eyesClosed ? (
          <>
            <path
              d="M72 112 Q80 105 88 112"
              fill="none"
              className="xb-stroke-face"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <path
              d="M112 112 Q120 105 128 112"
              fill="none"
              className="xb-stroke-face"
              strokeWidth="4"
              strokeLinecap="round"
            />
          </>
        ) : happy ? (
          <>
            <path
              d="M72 114 Q80 106 88 114"
              fill="none"
              className="xb-stroke-face"
              strokeWidth="4.5"
              strokeLinecap="round"
            />
            <path
              d="M112 114 Q120 106 128 114"
              fill="none"
              className="xb-stroke-face"
              strokeWidth="4.5"
              strokeLinecap="round"
            />
          </>
        ) : (
          <>
            <ellipse cx="80" cy="111" rx="5.4" ry="6" className="xb-fill-face" />
            <ellipse cx="120" cy="111" rx="5.4" ry="6" className="xb-fill-face" />
            {/* 眼里的高光：让眼神有神采，不是两个黑洞 */}
            <circle cx="81.8" cy="108.6" r="1.8" className="xb-fill-glint" />
            <circle cx="121.8" cy="108.6" r="1.8" className="xb-fill-glint" />
          </>
        )}

        {/* 嘴：只是很短的一条弧，不做表情包式的夸张 */}
        {action === 'sleeping' ? (
          <ellipse cx="100" cy="130" rx="4" ry="5" className="xb-fill-face" opacity="0.5" />
        ) : (
          <path
            d="M95 128 Q100 132 105 128"
            fill="none"
            className="xb-stroke-face"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.6"
          />
        )}

        {/* 脚 */}
        <ellipse cx="80" cy="168" rx="12" ry="7" className="xb-fill-body-deep" />
        <ellipse cx="120" cy="168" rx="12" ry="7" className="xb-fill-body-deep" />

        {/* 抱在怀里的照片（收照片动作） */}
        {action === 'collecting' && (
          <g>
            <rect
              x="76"
              y="122"
              width="48"
              height="40"
              rx="5"
              className="xb-fill-photo xb-stroke-photo-edge"
              strokeWidth="2"
            />
            <path d="M82 152 L94 138 L104 148 L112 140 L118 152 Z" className="xb-fill-photo-ink" opacity="0.5" />
            <circle cx="88" cy="132" r="3.4" className="xb-fill-photo-ink" opacity="0.45" />
          </g>
        )}
      </g>

      {/* 喷壶 + 水珠（浇花动作） */}
      {action === 'watering' && (
        <g className="xiaoban-sway">
          <path d="M148 96 L178 96 L172 122 L152 122 Z" className="xb-fill-can" />
          <path d="M150 98 L138 88 L142 82 L154 92 Z" className="xb-fill-can" />
          <path
            d="M156 100 C156 94 168 94 168 100 C168 107 156 107 156 100 Z"
            className="xb-fill-can-shade"
            opacity="0.5"
          />
          <circle cx="140" cy="94" r="3" className="xb-fill-sky-deep xiaoban-drip" />
          <circle
            cx="144"
            cy="102"
            r="2.4"
            className="xb-fill-sky-deep xiaoban-drip"
            style={{ animationDelay: '0.55s' }}
          />
          <circle
            cx="136"
            cy="106"
            r="2"
            className="xb-fill-sky-deep xiaoban-drip"
            style={{ animationDelay: '1.05s' }}
          />
        </g>
      )}

      {/* 正在想事情的三个小点 */}
      {action === 'thinking' && (
        <g className="xiaoban-float">
          <circle cx="150" cy="52" r="5" className="xb-fill-leaf" opacity="0.85" />
          <circle cx="164" cy="38" r="4" className="xb-fill-leaf" opacity="0.6" />
          <circle cx="176" cy="26" r="3" className="xb-fill-leaf" opacity="0.4" />
        </g>
      )}

      {/* 睡着时飘起来的 z */}
      {action === 'sleeping' && (
        <g className="xiaoban-float">
          <path
            d="M146 60 L162 60 L146 78 L162 78"
            fill="none"
            className="xb-stroke-leaf"
            strokeWidth="3.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M168 34 L180 34 L168 47 L180 47"
            fill="none"
            className="xb-stroke-leaf"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.6"
          />
        </g>
      )}
    </svg>
  )
}
