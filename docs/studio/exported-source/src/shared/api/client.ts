/* =============================================================================
 * HTTP 客户端（自建服务端 / 第三方 https 接口）
 *
 * 两条路，业务代码只调 `http()`，不关心走的是哪一条：
 *   1. 真机 → 原生 `request`（容器代发，绕过 WebView 同源限制）；
 *   2. 浏览器 / 在线预览 → `fetch`（受 CORS 限制，只用于本地调试）。
 *
 * 注意：
 *  - 原生 `request` 仅支持 https（http 会被拒），调用口径见 capsule-native-api 的
 *    references/01-call-conventions.md；
 *  - 平台内置后端（数据库 / 云函数 / 认证 / 存储）**不要**用这里，统一走 `@/shared/track`；
 *  - 需要"浏览器预览也能出数据"时，参考 Skill 里 assets/demo-pages 的 mock 示例，
 *    或在 .env 里配好可跨域的调试后端。
 * ========================================================================== */

import { getBridgeMode, invokeNative } from '@/shared/bridge'

/** 接口基地址：在 `.env` 里配 `VITE_API_BASE`（不配就是同源相对路径） */
const API_BASE = import.meta.env.VITE_API_BASE ?? ''

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | undefined>
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const search = new URLSearchParams()
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value !== undefined && value !== '') search.set(key, String(value))
  })
  const suffix = search.toString()
  return `${API_BASE}${path}${suffix ? `?${suffix}` : ''}`
}

export async function http<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query } = options
  const url = buildUrl(path, query)
  const payload = method === 'GET' ? undefined : (body ?? {})

  if (getBridgeMode() === 'native') {
    const res = await invokeNative('request', {
      url,
      method,
      data: payload,
      dataType: 'json',
      header: { 'Content-Type': 'application/json' },
    })
    // 4xx/5xx 走的是成功回调，必须自己判 statusCode
    if (res.statusCode >= 400) throw new ApiError(res.statusCode, `HTTP ${res.statusCode}`)
    return res.data as T
  }

  const response = await fetch(url, {
    method,
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  })
  if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`)
  return (await response.json()) as T
}
