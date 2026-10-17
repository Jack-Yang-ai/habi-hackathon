/* =============================================================================
 * 演示用的餐食插画（SVG，不联网、不引用任何外部图片）。
 *
 * **只在演示模式里出现**：正常模式的照片一律来自设备（真实原图），
 * 绝不用这张插画充当用户自己的记录。每一处渲染它的地方都必须挂「演示」标记。
 *
 * 颜色走 xb-fill-* / xb-stroke-* / xb-stop-* 类（SVG 的 presentation attribute
 * 不解析 CSS 变量，口径见 globals.css 的说明），取值来自 tokens.css。
 * ========================================================================== */

import { useId } from 'react'

import { cn } from '@/shared/lib/cn'

export function DemoMealIllustration({ className }: { className?: string }) {
  const uid = useId().replace(/[:]/g, '')
  const plate = `demo-plate-${uid}`

  return (
    <svg
      viewBox="0 0 400 300"
      role="img"
      aria-label="演示插画：一份家常餐"
      className={cn('block size-full', className)}
    >
      <defs>
        <radialGradient id={plate} cx="0.4" cy="0.34" r="0.72">
          <stop className="xb-stop-plate-light" offset="0%" />
          <stop className="xb-stop-plate" offset="100%" />
        </radialGradient>
      </defs>

      {/* 木桌面 */}
      <rect width="400" height="300" className="xb-fill-table" />
      <rect y="0" width="400" height="6" className="xb-fill-table-grain" opacity="0.5" />
      <rect y="276" width="400" height="6" className="xb-fill-table-grain" opacity="0.5" />

      {/* 盘子 */}
      <ellipse cx="202" cy="160" rx="122" ry="116" className="xb-fill-plate-edge" opacity="0.45" />
      <circle cx="200" cy="150" r="120" fill={`url(#${plate})`} />
      <circle cx="200" cy="150" r="104" fill="none" className="xb-stroke-plate-edge" strokeWidth="1.5" />

      {/* 米饭：一堆压实的白饭——用密一点的米粒表现颗粒，而不是一整块白面 */}
      <ellipse cx="142" cy="134" rx="56" ry="50" className="xb-fill-rice-shade" />
      <ellipse cx="142" cy="126" rx="56" ry="47" className="xb-fill-rice" />
      <ellipse cx="114" cy="102" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(-28 114 102)" />
      <ellipse cx="138" cy="96" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(14 138 96)" />
      <ellipse cx="164" cy="104" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(-6 164 104)" />
      <ellipse cx="104" cy="118" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(22 104 118)" />
      <ellipse cx="126" cy="112" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(-18 126 112)" />
      <ellipse cx="152" cy="114" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(6 152 114)" />
      <ellipse cx="176" cy="126" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(26 176 126)" />
      <ellipse cx="142" cy="118" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(2 142 118)" />
      <ellipse cx="112" cy="134" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(-4 112 134)" />
      <ellipse cx="136" cy="130" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(16 136 130)" />
      <ellipse cx="158" cy="134" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(-22 158 134)" />
      <ellipse cx="124" cy="150" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(10 124 150)" />
      <ellipse cx="148" cy="152" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(-12 148 152)" />
      <ellipse cx="168" cy="150" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(18 168 150)" />
      <ellipse cx="136" cy="166" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(-8 136 166)" />
      <ellipse cx="154" cy="168" rx="5.5" ry="2.6" className="xb-fill-rice-grain" transform="rotate(24 154 168)" />

      {/* 清炒青菜 */}
      <g>
        <ellipse cx="256" cy="108" rx="36" ry="17" className="xb-fill-greens" transform="rotate(-28 256 108)" />
        <ellipse cx="278" cy="146" rx="34" ry="16" className="xb-fill-greens-deep" transform="rotate(24 278 146)" />
        <ellipse cx="240" cy="160" rx="32" ry="15" className="xb-fill-greens" transform="rotate(-12 240 160)" />
        <path
          d="M232 108 L282 96"
          fill="none"
          className="xb-stroke-greens-deep"
          strokeWidth="2.4"
          strokeLinecap="round"
          opacity="0.7"
        />
        <path
          d="M254 158 L300 142"
          fill="none"
          className="xb-stroke-greens-deep"
          strokeWidth="2.2"
          strokeLinecap="round"
          opacity="0.55"
        />
      </g>

      {/* 煎蛋 */}
      <g>
        <ellipse cx="246" cy="216" rx="46" ry="36" className="xb-fill-egg-white" />
        <ellipse cx="222" cy="206" rx="17" ry="13" className="xb-fill-egg-white" />
        <ellipse cx="272" cy="228" rx="15" ry="11" className="xb-fill-egg-white" />
        <circle cx="248" cy="212" r="17" className="xb-fill-yolk" />
        <ellipse cx="243" cy="206" rx="6" ry="4" className="xb-fill-yolk-light" />
      </g>

      {/* 盘边的一双筷子：家常感，不用来当装饰花纹 */}
      <g>
        <rect
          x="322"
          y="76"
          width="7"
          height="150"
          rx="3.5"
          className="xb-fill-chopstick"
          transform="rotate(9 325 151)"
        />
        <rect
          x="338"
          y="82"
          width="7"
          height="150"
          rx="3.5"
          className="xb-fill-chopstick-light"
          transform="rotate(9 341 157)"
        />
      </g>
    </svg>
  )
}
