/* =============================================================================
 * 原生能力类型定义（capsule SDK）
 *
 * 只声明工程实际会用到的接口；新增调用前先在 capsule-native-api 的
 * references/02-api-reference.md 跳到 references/api/ 下对应分册，查到准确的入参 / 出参，再来这里补类型。
 * 这里没有的类型 = 还没确认过，不要凭记忆写。
 * ========================================================================== */

/** 安全区矩形（`getSystemInfo.safeArea`），单位 dp */
export interface NativeSafeAreaRect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

/** `getSafeArea` 出参 / `appShow` 事件里的 safeArea：除 density 外均为 dp */
export interface NativeSafeAreaInfo extends NativeSafeAreaRect {
  density: number
}

export interface NativeSystemInfo {
  pixelRatio: number
  screenWidth: number
  screenHeight: number
  windowWidth: number
  windowHeight: number
  statusBarHeight: number
  screenTop: number
  safeArea: NativeSafeAreaRect
  brand: string
  model: string
  manufacturer: string
  device: string
  abi: string
  benchmarkLevel: number
  platform: string
  system: string
  release: string
  sdkInt: number
  deviceOrientation: 'portrait' | 'landscape' | 'undefined'
  language: string
  version: string
  SDKVersion: string
  /** 当前应用 ID（manifest.applicationId），不是 appId */
  applicationId: string
  enableDebug: boolean
}

/** `getAppBaseInfo` 出参：壳体基础信息与当前应用的 `host.applicationId` */
export interface NativeAppBaseInfo {
  SDKVersion: string
  enableDebug: boolean
  /** 当前应用 ID 在 host.applicationId 下（manifest.applicationId），不是 appId */
  host: { applicationId: string }
  language: string
  version: string
  theme: 'light' | 'dark'
  fontSizeScaleFactor: number
  fontSizeSetting: number
}

export type NativeNetworkType = 'wifi' | '2g' | '3g' | '4g' | '5g' | 'none' | 'unknown'

export interface NativeNetworkStatus {
  networkType: NativeNetworkType
  isConnected: boolean
  type: NativeNetworkType
  connected: boolean
  metered: boolean
}

export interface NativePermissionStatus {
  scope: string
  protection: 'none' | 'normal' | 'dangerous'
  state: 'granted' | 'denied' | 'permanentlyDenied' | 'notRequired' | 'unknown'
  granted: boolean
  permanent: boolean
  canAskAgain: boolean
}

export interface NativeImageFile {
  path: string
  size: number
}

/** 每个接口的「入参 → 出参」映射；出参不含 ok / errMsg（封装层已剥掉） */
export interface NativeCapabilityMap {
  // ---- 系统信息 ----
  getSystemInfo: { params: undefined; result: NativeSystemInfo }
  getAppBaseInfo: { params: undefined; result: NativeAppBaseInfo }
  getSafeArea: { params: undefined; result: NativeSafeAreaInfo }
  /** 临时覆盖当前 Activity 的方向；离开时调用方必须恢复 manifest 基准值 */
  setScreenOrientation: {
    params: { orientation: 'portrait' | 'landscape' | 'auto' }
    result: { orientation: 'portrait' | 'landscape' | 'auto' }
  }
  canIUse: { params: { args?: string; schema?: string; api?: string }; result: { data: boolean } }
  getNetworkType: { params: undefined; result: NativeNetworkStatus }

  // ---- 界面 ----
  showToast: {
    params: { title: string; message?: string; icon?: string; duration?: number }
    result: Record<string, never>
  }
  hideToast: { params: undefined; result: Record<string, never> }
  showLoading: { params: { title?: string; mask?: boolean }; result: Record<string, never> }
  hideLoading: { params: undefined; result: Record<string, never> }
  showModal: {
    params: {
      title?: string
      content?: string
      confirmText?: string
      cancelText?: string
      showCancel?: boolean
    }
    result: { confirm: boolean; cancel: boolean }
  }
  showActionSheet: {
    params: { itemList: string[]; title?: string }
    result: { tapIndex: number }
  }
  /** 状态栏下方内容底色偏深时传 true（浅色前景），偏浅时传 false（深色前景）。背景保持透明 */
  setStatusBarStyle: { params: { light: boolean }; result: Record<string, never> }
  setStatusBarVisible: { params: { visible?: boolean }; result: Record<string, never> }
  hideKeyboard: { params: undefined; result: Record<string, never> }
  exitApp: { params: undefined; result: Record<string, never> }

  // ---- 设备与传感器 ----
  vibrateShort: { params: { type?: 'light' | 'medium' | 'heavy' }; result: Record<string, never> }
  vibrateLong: { params: undefined; result: Record<string, never> }
  haptic: {
    params: { type?: 'light' | 'medium' | 'heavy' }
    result: Record<string, never>
  }
  setKeepScreenOn: {
    params: { keepScreenOn: boolean }
    result: Record<string, never>
  }
  /** bottom 单位是 dp，不是 px */
  adjustPosition: { params: { bottom: number }; result: Record<string, never> }
  scanCode: {
    params: undefined
    result: {
      result: string
      scanType: string
      charSet: string
      rawData: string
      path: string
    }
  }
  getLocation: {
    params: { type?: 'wgs84' | 'gcj02'; isHighAccuracy?: boolean }
    result: {
      latitude: number
      longitude: number
      speed: number
      accuracy: number
      altitude: number
      verticalAccuracy: number
      horizontalAccuracy: number
    }
  }

  // ---- 存储与剪贴板（存储类需已同意隐私协议）----
  setStorage: { params: { key: string; data: unknown }; result: Record<string, never> }
  /** key 不存在时成功返回 data: null */
  getStorage: { params: { key: string }; result: { data: unknown } }
  removeStorage: { params: { key: string }; result: Record<string, never> }
  getStorageInfo: {
    params: undefined
    result: { keys: string[]; currentSize: number; limitSize: number }
  }
  setClipboardData: { params: { data: string }; result: Record<string, never> }
  getClipboardData: { params: undefined; result: { data: string } }

  // ---- 媒体与文件 ----
  chooseImage: {
    params: { count?: number; sourceType?: Array<'album' | 'camera'>; sizeType?: string[] }
    /** tempFilePaths 是虚拟 URL（https://<页面主机>/media/…，测试包 appassets.t-stepos.com，线上包 appassets.stepaos.com），可直接给 <img> */
    result: { tempFilePaths: string[]; tempFiles: NativeImageFile[] }
  }
  previewImage: { params: { urls?: string[]; current?: string }; result: Record<string, never> }
  saveImageToPhotosAlbum: {
    params: { filePath?: string; dataUrl?: string }
    result: Record<string, never>
  }

  // ---- 网络（仅 https，不限制域名；第三方业务请求走这里）----
  request: {
    params: {
      url: string
      method?: string
      header?: Record<string, string>
      data?: unknown
      timeout?: number
      dataType?: 'json' | 'text'
      responseType?: 'text' | 'json' | 'arraybuffer'
    }
    result: { statusCode: number; data: unknown; header: Record<string, string> }
  }

  // ---- 通讯录 / 分享 / 系统应用 ----
  chooseContact: {
    params: undefined
    result: { displayName: string; phoneNumber: string; phoneNumberList: string }
  }
  makePhoneCall: { params: { phoneNumber: string }; result: Record<string, never> }
  openLocation: {
    params: { latitude?: number; longitude?: number; name?: string; address?: string }
    result: Record<string, never>
  }
  shareText: { params: { text: string; title?: string }; result: Record<string, never> }
  openUrl: { params: { url: string }; result: Record<string, never> }

  // ---- 权限与隐私 ----
  getSetting: { params: undefined; result: { authSetting: Record<string, boolean> } }
  authorize: { params: { scope: string; scene?: string }; result: Record<string, never> }
  openSetting: { params: undefined; result: { authSetting: Record<string, boolean> } }
  requestPermission: {
    params: { scope: string; scene?: string }
    result: NativePermissionStatus
  }
  getPermissionStatus: {
    params: { scope: string; scene?: string }
    result: NativePermissionStatus
  }
  'privacy.getStatus': {
    params: undefined
    result: {
      agreed: boolean
      protocolVersion: number
      agreedVersion: number
      agreedAt: number
      shellVersion: string
      applicationId: string
    }
  }
}

export type NativeApiName = keyof NativeCapabilityMap
export type NativeParams<K extends NativeApiName> = NativeCapabilityMap[K]['params']
export type NativeResult<K extends NativeApiName> = NativeCapabilityMap[K]['result']

/** 事件 channel → payload。事件 payload 不含 ok / errMsg */
export interface NativeEventMap {
  appShow: { safeArea?: NativeSafeAreaInfo }
  appHide: Record<string, never>
  networkStatusChange: NativeNetworkStatus
  memoryWarning: { level: number }
}

export type NativeEventName = keyof NativeEventMap

/** 归一化后的错误码：业务按这个分支，不要匹配 errMsg 字符串 */
export type BridgeErrorCode =
  | 'cancelled'
  | 'unsupported'
  | 'denied'
  | 'privacy'
  | 'not-found'
  | 'timeout'
  | 'unknown'

export class BridgeError extends Error {
  readonly code: BridgeErrorCode
  readonly apiName: string
  readonly raw?: unknown

  constructor(code: BridgeErrorCode, apiName: string, message: string, raw?: unknown) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.apiName = apiName
    this.raw = raw
  }
}

/** 当前宿主：native = 真机 App 壳；mock = 平台预览 / 浏览器 */
export type BridgeMode = 'native' | 'mock'

/** 日志等级，对应 capsule.log 的 v / d / i / w / e */
export type NativeLogLevel = 'v' | 'd' | 'i' | 'w' | 'e'

/** 壳注入的原始 SDK 形状。业务代码不要直接用，走 src/shared/bridge/index.ts */
export interface CapsuleSdk {
  invoke(apiName: string, params?: unknown): Promise<Record<string, unknown>>
  on(channel: string, handler: (payload: unknown) => void): void
  off?(channel: string, handler: (payload: unknown) => void): void
  /** fire-and-forget，不是 invoke；浏览器预览里没有，会回落到 console */
  log?(level: NativeLogLevel, tag: string, message: string, extra?: unknown): void
}
