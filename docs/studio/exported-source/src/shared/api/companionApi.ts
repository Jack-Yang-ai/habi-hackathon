/* =============================================================================
 * 小伴 · 后端适配层（本工程唯一一处接口定义）
 *
 * 页面与状态层**只**通过这里读写数据，不直接 fetch、不内联 mock。
 * 端点全部预留给自建服务；服务不存在时这里会抛 OfflineError，由 UI 展示明确的离线状态。
 *
 * 端点契约：
 *   GET  /api/state                          整体状态（设备 + 餐食 + 动态 + 对话）
 *   POST /api/capture                        multipart：image + metadata（ESP32 相机上传一餐照片）
 *   POST /api/meals/:id/correction           { portionFraction }（用户对份量的确认 / 修正）
 *   POST /api/chat                           { message }（和小伴说话）
 *   POST /api/device/pause                   { paused }（暂停 / 恢复随身相机记录）
 *   POST /api/posts/:id/reply                { message }（回应小伴的动态，同时进入对话）
 *
 * 三条不可混淆的数据来源（界面上必须分别标注，见 types 下的注释）：
 *   1. capture   —— 相机拍下的原始记录：时间、原图、设备。**不含任何推断**。
 *   2. estimate  —— 模型对照片的估算。模型没跑 / 没接入时为 null，界面显示「尚未估算」。
 *   3. confirmation —— 用户自己确认的份量。**只有用户点了才算数**，模型不能代填。
 *
 * 安全：本文件不存放任何密钥。基地址来自构建期注入的 VITE_API_BASE（缺省为同源相对路径）。
 * ========================================================================== */

import { getBridgeMode, invokeNative } from '@/shared/bridge'

/** 未配置 / 未启动后端服务时的统一错误：UI 据此展示"离线"而不是"出错了" */
export class OfflineError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'OfflineError'
    this.reason = reason
  }
}

/* ------------------------------------------------------------------ *
 * 一、数据类型
 * ------------------------------------------------------------------ */

/**
 * 小伴当前的动作。背屏与伙伴页主视觉都只消费这一个枚举——
 * **背屏只显示"小伴在做什么"，不显示文章摘要或记录数字**。
 */
export type CompanionAction = 'resting' | 'watering' | 'collecting' | 'thinking' | 'sleeping'

/** 份量：全部 / 吃了一半 / 少量 → 折算成比例交给后端 */
export type PortionFraction = 1 | 0.5 | 0.25

export const PORTION_OPTIONS: Array<{ value: PortionFraction; label: string; hint: string }> = [
  { value: 1, label: '全部', hint: '这一份都吃完了' },
  { value: 0.5, label: '吃了一半', hint: '大约剩一半' },
  { value: 0.25, label: '少量', hint: '只吃了几口' },
]

/** 第 1 类：相机原始记录。字段全部来自设备，不含推断 */
export interface MealCapture {
  capturedAt: string
  /** 原图地址：真机上通常是壳返回的 /media/ 虚拟地址 */
  imageUrl: string
  /** 拍摄设备标识（随身相机） */
  deviceId?: string
  /** 原图尺寸，设备上报 */
  width?: number
  height?: number
}

/** 第 2 类：模型估算的状态。没接入模型时整段为 null，界面显示「尚未估算」 */
export interface MealEstimate {
  /** 生成估算的模型标识，界面上必须向用户标出 */
  model: string
  /** 一句话概述 */
  summary: string
  /** 千卡。模型没给出时为 null——界面显示"未提供"，不补零 */
  kcal: number | null
  /** 识别到的食物条目 */
  items: string[]
  createdAt: string
}

/** 第 3 类：用户确认。只有用户自己点了才有值 */
export interface MealConfirmation {
  portionFraction: PortionFraction
  confirmedAt: string
}

export interface Meal {
  id: string
  capture: MealCapture
  /** null = 尚未估算（模型未接入 / 还没跑完） */
  estimate: MealEstimate | null
  /** null = 用户还没确认 */
  confirmation: MealConfirmation | null
}

export interface PostReply {
  id: string
  text: string
  createdAt: string
  /** 谁回应的：伴 = 小伴，你 = 用户 */
  author: 'companion' | 'user'
}

/** 小伴主动发布的动态。`basis` 是这条动态的事实依据，界面上要显示出来 */
export interface Post {
  id: string
  createdAt: string
  action: CompanionAction
  text: string
  /** 事实依据：来自哪一餐 / 哪一次记录。没有依据的动态不生成 */
  basis: string
  replies: PostReply[]
}

export interface ChatMessage {
  id: string
  role: 'companion' | 'user'
  text: string
  createdAt: string
  /** 这条消息是从哪条动态的回应来的（用于在对话里标出来源） */
  fromPostId?: string
}

export interface DeviceState {
  /** 随身相机是否已连接 */
  connected: boolean
  /** 记录是否已暂停 */
  paused: boolean
  /** 设备名（未连接时为 null） */
  name: string | null
  /** 语音记录能力是否已接入。没有接入 = 未启用，界面如实显示 */
  voiceEnabled: boolean
  /** 最近一次上报时间 */
  lastSeenAt: string | null
}

export interface CompanionState {
  device: DeviceState | null
  meals: Meal[]
  posts: Post[]
  messages: ChatMessage[]
  companionAction: CompanionAction
}

/* ------------------------------------------------------------------ *
 * 二、HTTP 传输（JSON 走骨架的 http；multipart 单独处理）
 * ------------------------------------------------------------------ */

/** 基地址：构建期注入；缺省为同源相对路径（本地开发用 Vite 代理） */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')

/** 服务端确实在、但返回了错误 */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function offlineReason(error: unknown): string {
  if (error instanceof ApiError) {
    return error.status === 404
      ? '记录服务尚未接入（接口返回 404）'
      : `记录服务返回 ${error.status}`
  }
  return '连不上记录服务'
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(response.status, '响应不是合法的 JSON')
  }
}

async function request<T>(
  path: string,
  init: { method: 'GET' | 'POST'; json?: unknown; form?: FormData },
): Promise<T> {
  const url = `${API_BASE}${path}`
  const method = init.method

  // 真机：容器代发（无 CORS 限制，仅支持 https）。仅适用于 JSON 请求体。
  if (getBridgeMode() === 'native' && !init.form) {
    if (method === 'GET' && !init.json) {
      const res = await invokeNative('request', { url, method, dataType: 'json' })
      if (res.statusCode >= 400) throw new ApiError(res.statusCode, `HTTP ${res.statusCode}`)
      return res.data as T
    }
    const res = await invokeNative('request', {
      url,
      method,
      data: init.json ?? {},
      dataType: 'json',
      header: { 'Content-Type': 'application/json' },
    })
    if (res.statusCode >= 400) throw new ApiError(res.statusCode, `HTTP ${res.statusCode}`)
    return res.data as T
  }

  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: init.json ? { 'Content-Type': 'application/json' } : undefined,
      body: init.form ?? (init.json ? JSON.stringify(init.json) : undefined),
    })
  } catch {
    // 网络层直接失败：服务没起 / 域名不通 —— 这属于"离线"，不是"接口报错"
    throw new OfflineError('连不上记录服务')
  }

  if (!response.ok) {
    const error = new ApiError(response.status, `HTTP ${response.status}`)
    if (response.status === 404 || response.status >= 500) throw new OfflineError(offlineReason(error))
    throw error
  }
  return readJson<T>(response)
}

/**
 * multipart 上传（照片到达）。
 *
 * ESP32 相机的照片体积不大，这里按标准 multipart 发送：浏览器与真机 WebView 都走 fetch。
 * 若后续换成大图 / 断点续传，改走壳的文件上传接口（口径见 capsule-native-api），
 * 但**端点契约（image + metadata 两个字段）保持不变**。
 */
async function postMultipart<T>(path: string, form: FormData): Promise<T> {
  return request<T>(path, { method: 'POST', form })
}

/* ------------------------------------------------------------------ *
 * 三、端点（页面 / 状态层唯一入口）
 * ------------------------------------------------------------------ */

/** 拍照上传时一并提交的设备侧元数据 */
export interface CaptureMetadata {
  capturedAt: string
  deviceId?: string
  width?: number
  height?: number
  /** 设备侧上报的原始文件名 / 序号，便于对账 */
  source?: string
}

export const companionApi = {
  /** 拉取整体状态。失败一律抛 OfflineError，调用方据此进入离线态 */
  async getState(): Promise<CompanionState> {
    return request<CompanionState>('/api/state', { method: 'GET' })
  },

  /** 照片到达：上传原图 + 元数据，返回刚落库的那一餐（此时 estimate 通常为 null） */
  async capture(image: Blob, metadata: CaptureMetadata): Promise<Meal> {
    const form = new FormData()
    form.append('image', image, metadata.source ?? 'capture.jpg')
    form.append('metadata', JSON.stringify(metadata))
    return postMultipart<Meal>('/api/capture', form)
  },

  /** 用户确认份量 */
  async correctPortion(mealId: string, portionFraction: PortionFraction): Promise<Meal> {
    return request<Meal>(`/api/meals/${encodeURIComponent(mealId)}/correction`, {
      method: 'POST',
      json: { portionFraction },
    })
  },

  /** 和小伴说话 */
  async sendChat(message: string): Promise<ChatMessage> {
    return request<ChatMessage>('/api/chat', { method: 'POST', json: { message } })
  },

  /** 暂停 / 恢复随身相机记录 */
  async setDevicePaused(paused: boolean): Promise<DeviceState> {
    return request<DeviceState>('/api/device/pause', { method: 'POST', json: { paused } })
  },

  /** 回应小伴的动态，同时进入对话 */
  async replyToPost(postId: string, message: string): Promise<PostReply> {
    return request<PostReply>(`/api/posts/${encodeURIComponent(postId)}/reply`, {
      method: 'POST',
      json: { message },
    })
  },
}

/** 把任意异常归一化成"离线原因"文案；返回 null 表示不是离线问题 */
export function offlineReasonOf(error: unknown): string | null {
  if (error instanceof OfflineError) return error.reason
  return null
}
