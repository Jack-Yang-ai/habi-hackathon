/** 金额：分 → 「¥12.34」 */
export function formatCurrency(cents: number, currency = '¥'): string {
  return `${currency}${(cents / 100).toFixed(2)}`
}

/** 大数字：12345 → 「1.2万」 */
export function formatCompactNumber(value: number): string {
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return String(value)
}

/** 时间：ISO 字符串 → 「MM-DD HH:mm」；同年省略年份 */
export function formatDateTime(iso: string, withYear = false): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number) => String(n).padStart(2, '0')
  const datePart = withYear
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${datePart} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 相对时间：用于列表页「3 分钟前」这类展示 */
export function formatRelativeTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const diffSeconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (diffSeconds < 60) return '刚刚'
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} 分钟前`
  if (diffSeconds < 86_400) return `${Math.floor(diffSeconds / 3600)} 小时前`
  if (diffSeconds < 2_592_000) return `${Math.floor(diffSeconds / 86_400)} 天前`
  return formatDateTime(iso, true)
}

/** 手机号脱敏：13800000000 → 138****0000 */
export function maskPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone
}

/** 字节数 → 「1.2 MB」 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
