import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * 合并 className：clsx 处理条件类，tailwind-merge 处理同类覆盖（后者生效）。
 *
 * ⚠️ 自定义字号必须在这里登记，否则会被当成**颜色**类合并掉：
 * tailwind-merge 内置只认识 `text-sm` / `text-2xl` 这类档位，认不出的 `text-caption` /
 * `text-body` / `text-title` / `text-display` 会落到"文字颜色"组里 —— 同一个类名串里
 * "字号 + 颜色"就必然互相顶掉一个：
 *   - 字号排在后面（Button 的 `px-4 text-body`）→ 丢掉 `text-primary-foreground`，
 *     彩色按钮上的字退回继承色，白底主题下对比度只剩 2.8:1，暗色主题 2.5:1；
 *   - 颜色排在后面（Badge 的 `bg-* text-primary`、Input 的 `text-danger`）→ 丢掉
 *     `text-caption`，徽标与提示文字被撑成 14px。
 * 这不是"配色调错了"，是类名合并规则漏了自定义档位——新增自定义字号时，这里要同步补。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['caption', 'body', 'title', 'display'] }],
      // 发丝线同理：`border-hairline` 认不出来时会掉进"描边颜色"组，
      // 与 `border-border` 互相顶掉 → 发丝线悄悄变成 1px（或直接没了）。
      'border-w': [{ border: ['hairline'] }],
      'border-w-x': [{ 'border-x': ['hairline'] }],
      'border-w-y': [{ 'border-y': ['hairline'] }],
      'border-w-t': [{ 'border-t': ['hairline'] }],
      'border-w-r': [{ 'border-r': ['hairline'] }],
      'border-w-b': [{ 'border-b': ['hairline'] }],
      'border-w-l': [{ 'border-l': ['hairline'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
