export type NativeContextSignal = {
  action?: string
  reason?: string
  stage?: string
  classification?: { stage?: string; ingestionConfirmed?: boolean }
}

export type NativePipeline = {
  phase?: 'idle' | 'starting' | 'loading_models' | 'listening' | 'processing' | 'stopping' | 'stopped' | 'failed'
  models_ready?: boolean
  processed_chunks?: number
  submitted_signals?: number
  failed_chunks?: number
  dropped_chunks?: number
  queued_chunks?: number
  last_transcript?: string | null
  last_decision?: { stage?: string; probability?: number; wallMs?: number; model?: string; runtime?: string } | null
  last_signal?: NativeContextSignal | null
  last_meal_signal?: NativeContextSignal | null
  last_error?: string | null
  last_network_error?: string | null
}

export type NativeRecording = {
  recording?: boolean
  stopping?: boolean
  started_at?: string | null
  segments?: number
  uploaded?: boolean
  asr_connected?: boolean
  error?: string | null
  pipeline?: NativePipeline
  voice_trigger?: NativeVoiceTrigger
}

export type NativeVoiceTrigger = {
  phase?: string
  kws_ready?: boolean
  asr_ready?: boolean
  wake_word?: string
  command?: string
  command_count?: number
  error?: string
  last_error?: string
  last_command?: {
    text?: string
    asr_ms?: number
    command_verified?: boolean
    camera_request_accepted?: boolean
    /** Why the utterance was accepted or refused: exact_asr, the acoustic route, or rejected. */
    verification_route?: string
  }
}

/** What the phone made of the last spoken command.
 * A row that only exists after a command has been refused is invisible exactly when the user is
 * looking for it, so this always returns a line while the listener is on.
 */
export function nativeCommandLabel(last?: NativeVoiceTrigger['last_command']) {
  if (!last || (last.text === undefined && last.verification_route === undefined)) return '还没听到口令，对着手机说「哈比记录」'
  if (last.command_verified) return last.verification_route === 'exact_asr' ? '已听清口令，正在拍照' : '已按声学关键词确认口令，正在拍照'
  const heard = last.text?.trim()
  return heard ? `听到「${heard}」，不是「哈比记录」` : '这一句没有听清口令'
}

/** A committed preview is available: the on-demand route first, the older embedded field second. */
export function localPhotoReady(camera?: NativePhoneCamera): boolean {
  return camera?.local_photo_ready === true || typeof camera?.local_photo === 'string'
}

/** Reads the committed photo; on new builds the polled payload never carries image bytes. */
export function readLocalPhoto(embedded?: string | null): string | null {
  if (typeof embedded === 'string' && embedded.startsWith('data:image/')) return embedded
  try {
    const raw = window.EchoDevice?.getLocalPhoto?.()
    if (!raw) return null
    const parsed = JSON.parse(raw) as { photo?: string | null }
    return typeof parsed.photo === 'string' && parsed.photo.startsWith('data:image/') ? parsed.photo : null
  } catch { return null }
}

export type NativePhoneCamera = {
  phase?: string
  voice_armed?: boolean
  capture_id?: string
  saved_locally?: boolean
  uploaded?: boolean
  /** Data URL of the committed local JPEG, so the page can show it before the upload finishes. */
  /** True while a committed preview is available from the bridge; the bytes are read on demand. */
  local_photo_ready?: boolean
  /** Older builds embedded the whole preview here; still read so a page is never stuck between versions. */
  local_photo?: string | null
  detail?: string
  error?: string
  meal_title?: string | null
  review?: { status?: string; foodDetected?: boolean | null; reason?: string | null }
}

export type NativeCapabilities = {
  bridge_version?: number
  model?: string
  root?: string
  rootAvailable?: boolean
  standalone_vendor_rear_supported?: boolean
  rear_display?: { backend?: string; native_rendering?: boolean; vendor_permission_granted?: boolean; diagnostics_granted?: boolean; vendor_control_available?: boolean; enabled?: boolean; custom_frame_active?: boolean; phase?: string; error?: string | null; pattern?: string; note?: string }
  recording?: NativeRecording
  phone_camera?: NativePhoneCamera
  voice_trigger?: NativeVoiceTrigger
}

declare global {
  interface Window {
    EchoDevice?: {
      getCapabilities: () => string
      getStatus?: () => string
      startRecording?: () => string
      stopRecording?: () => string
      takePhoto?: () => string
      /** On-demand preview of the photo the phone just committed, as a data URL. */
      getLocalPhoto?: () => string
      /** Retries the latest saved photo with the same capture ID; never reshoots. */
      retryLocalPhoto?: () => string
      /** Drops the on-demand preview; the saved original stays on the phone. */
      dismissLocalPhoto?: () => string
      openDeviceSettings?: () => string
      setRearScene?: (json: string) => string
      setRearEnabled?: (enabled: boolean) => string
    }
  }
}

/** Read-only bridge observation. An accepted command is never treated as proof. */
export function readNativeCapabilities(): NativeCapabilities | null {
  try {
    if (!window.EchoDevice?.getCapabilities) return null
    const value = JSON.parse(window.EchoDevice.getCapabilities()) as unknown
    if (!value || typeof value !== 'object') return null
    // getStatus contains the latest recorder/pipeline observation; capabilities
    // still provides model/root details for older bridge versions.
    if (window.EchoDevice.getStatus) {
      const status = JSON.parse(window.EchoDevice.getStatus()) as unknown
      if (status && typeof status === 'object') return { ...value, ...status } as NativeCapabilities
    }
    return value as NativeCapabilities
  } catch { return null }
}

export function nativeRecordingControlsAvailable() {
  return typeof window.EchoDevice?.startRecording === 'function' && typeof window.EchoDevice?.stopRecording === 'function'
}

/** Accepted is a queued request; rendering state must still be read from the native service. */
export function requestNativeRearScene(scene: string) {
  const mapped: Record<string, string> = { idle: 'idle', received: 'received', watering: 'watering', resting: 'resting', chatting: 'listening', watching: 'collecting' }
  if (!mapped[scene] || !window.EchoDevice?.setRearScene) return
  const receipt = JSON.parse(window.EchoDevice.setRearScene(JSON.stringify({ scene: mapped[scene], ttl_ms: 8000 })))
  if (!receipt.accepted) throw new Error('背屏未接受这次状态请求。')
}

/** A request receipt is not a recording-state observation. The native UI owns consent. */
export function requestNativeRecording(start: boolean) {
  const bridge = window.EchoDevice
  if (!bridge || (start ? !bridge.startRecording : !bridge.stopRecording)) throw new Error('请在支持录音控制的手机设备版中操作。')
  let receipt: { accepted?: boolean; error?: string }
  try { receipt = JSON.parse(start ? bridge.startRecording!() : bridge.stopRecording!()) }
  catch { throw new Error('手机暂未返回录音请求回执，请查看设备状态。') }
  if (receipt?.accepted !== true) throw new Error('手机没有接受这次请求，请稍后重试。')
}

export function nativePipelineLabel(pipeline?: NativePipeline) {
  const labels = {
    idle: '尚未启动', starting: '准备中', loading_models: '模型加载中', listening: '本地聆听中',
    processing: '本地处理中', stopping: '停止中', stopped: '已停止', failed: '处理异常',
  }
  return pipeline?.phase ? labels[pipeline.phase] || '状态待确认' : '状态待确认'
}

export function nativeDecisionLabel(stage?: string) {
  const labels: Record<string, string> = { start_soon: '近期用餐线索', invited: '用餐邀请线索', eating_now: '当前用餐线索',
    finished: '用餐结束线索', declined: '暂不吃的线索', unrelated: '非用餐线索', uncertain: '尚不确定' }
  return stage ? labels[stage] || '阶段待确认' : null
}

export function nativeSignalLabel(action?: string) {
  const labels: Record<string, string> = { capture_window: '请求首图窗口', soft_reminder: '留一句轻提醒',
    phone_capture: '手机拍一张并识别', cancel: '取消本次取景', defer: '暂缓触发', ignore: '无须动作' }
  return action ? labels[action] || '收到线索回执' : '尚无已提交线索'
}

export function nativeCameraLabel(phase?: string) {
  const labels: Record<string, string> = { idle: '等待口令', capturing: '正在拍照', uploading: '照片上传中',
    checking: 'Step 正在检查', no_food: '这张没有看到食物', complete: '识别完成，食量待确认',
    uncertain: '画面不清楚，本次已结束', failed: '本次未完成', stopped: '已停止', review_pending: '照片已上传，结果待查询' }
  return phase ? labels[phase] || phase : '尚未开启'
}

export function nativeWakeLabel(phase?: string) {
  const labels: Record<string, string> = { idle: '尚未开启', loading_models: '唤醒模型加载中', listening: '等待“哈比”',
    awaiting_command: '已听到哈比，等待“记录”', confirming_command: '正在确认口令', capture_requested: '拍照请求已提交',
    waiting_asr: '短句识别准备中', stopping: '停止中', stopped: '已停止', failed: '唤醒检测异常' }
  return phase ? labels[phase] || '状态待确认' : '状态待确认'
}

/** Final context classification takes precedence over the raw model candidate. */
export function nativeMealSignal(pipeline?: NativePipeline) {
  return pipeline?.last_meal_signal ?? pipeline?.last_signal ?? null
}

export function nativeMealSignalLabel(signal: NativeContextSignal | null) {
  const stage = signal?.stage || signal?.classification?.stage
  const labels: Record<string, string> = {
    start_soon: '准备去吃饭，尚未确认进食',
    invited: '收到用餐邀请，尚未确认进食',
    eating_now: '出现用餐线索，仍需照片核对',
  }
  return stage && labels[stage] ? labels[stage] : signal?.action === 'capture_window' ? '收到用餐相关线索，尚未确认进食' : null
}
