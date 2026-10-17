/**
 * 大陆手机号工具：登录 / 绑定相关页面统一用这里，不要各自再写正则。
 * 只支持 +86；产物后端（火山 Supabase）的 OTP 也只认 +86 E.164。
 */

/** 规整为 +86 E.164；不是 11 位、1 开头的大陆号返回 null（允许输入带 +86、空格、横线） */
export function normalizeCNPhone(input: string): string | null {
  const digits = (input || '').replace(/\D/g, '').replace(/^86(?=1\d{10}$)/, '')
  return /^1\d{10}$/.test(digits) ? `+86${digits}` : null
}

export function isValidCNPhone(input: string): boolean {
  return normalizeCNPhone(input) !== null
}
