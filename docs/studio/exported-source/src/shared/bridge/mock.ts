/* =============================================================================
 * 浏览器兜底 mock —— 仅在「没有 App 壳」时启用（本地 npm run dev / 平台预览）
 *
 * 作用：让业务代码在预览里也能跑通主流程，不用为 mock 写任何分支。
 * 约束：
 *  1. 只允许 bridge 层内部（index.ts / dev-report.ts）引用本文件，业务代码禁止 import。
 *  2. 出参字段必须与真机一致（多一个少一个都算 bug，会让业务在真机上才炸）。
 *  3. 无法真实模拟的交互（拍照、扫码、定位）返回固定样例值，并在真机上重新验收。
 * ========================================================================== */

import capsuleManifest from '../../../capsule/manifest.json'
import type {
  CapsuleSdk,
  NativeNetworkStatus,
  NativeSafeAreaInfo,
  NativeSystemInfo,
} from './types'

/**
 * 只能返回**写死数据**的能力（对照下面的 case 分支维护）。
 * 预览里对它们「跑通」没有任何证明力，必须真机验收 —— dev-report.ts 会据此提示开发者。
 * 在这里维护是为了和 mock 实现放在一起：改了 mock 就顺手改这里，不会两处漂移。
 */
export const SIMULATED_APIS: ReadonlySet<string> = new Set([
  'chooseImage', // 返回写死的文件路径 + 内置占位图
  'saveImageToPhotosAlbum', // 只弹一个 toast，并没有写入相册
  'scanCode', // 返回写死的二维码内容
  'getLocation', // 返回写死的经纬度
  'chooseContact', // 返回写死的联系人
  'previewImage', // 用 DOM 覆盖层模拟原生大图查看器（无缩放/手势）
])

/* ------------------------------- 安全区模拟 ------------------------------- */
/**
 * 假壳（浏览器 / 平台预览）的安全区模拟值（px）——口径与真机壳对齐，**按横竖屏取两套**：
 *  - 竖屏：top = 41（状态栏）/ bottom = 24（控制条）/ left = right = 0；
 *  - 横屏：状态栏仍贴顶 → top 同竖屏；控制条转到右侧 → right = 24、bottom = 0；侧边挖孔 → left = 41；
 *  - 全屏应用（`capsule/manifest.json` 的 `fullscreen`）：状态栏不可见 → top = 0。
 * 与真机一样随横竖屏切换：`safe-area.ts` 监听到视口变化后会重新取值。
 * 均为**占位值**（真机按机型返回，以壳为准）；改口径先改这里。
 */
function isLandscape(): boolean {
  // 按视口宽高比判断方向（等价于 CSS 的 orientation 媒体查询）：桌面浏览器里
  // screen.orientation 不随窗口 / 预览区变化（恒为 landscape），而宽高比在
  // 平台预览、本地调试、真机 WebView 三种环境下都正确 —— 旋转窗口即切换取值。
  return window.innerWidth > window.innerHeight
}

function mockSafeInsets(): { top: number; bottom: number; left: number; right: number } {
  const top = capsuleManifest.fullscreen ? 0 : 41
  return isLandscape()
    ? { top, bottom: 0, left: 41, right: 24 }
    : { top, bottom: 24, left: 0, right: 0 }
}

const MOCK_PREFIX = 'capsule.mock.'
const MOCK_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">
      <rect width="320" height="320" fill="#6366f1"/>
      <text x="160" y="172" font-size="28" fill="#fff" text-anchor="middle" font-family="sans-serif">MOCK IMAGE</text>
    </svg>`,
  )

function systemInfo(): NativeSystemInfo {
  const dpr = window.devicePixelRatio || 1
  // 真机的尺寸字段单位是 dp（CSS px 量级），不是物理像素
  const width = window.innerWidth
  const height = window.innerHeight
  const insets = mockSafeInsets()
  // 安全区矩形口径与真机一致：top / bottom 是矩形边界（距屏幕底 = 底部 inset），left / right 固定为 0 / 宽度
  const safeBottom = Math.max(height - insets.bottom, insets.top)
  return {
    pixelRatio: dpr,
    screenWidth: width,
    screenHeight: height,
    windowWidth: width,
    windowHeight: height,
    statusBarHeight: insets.top,
    screenTop: insets.top,
    safeArea: {
      left: 0,
      right: width,
      top: insets.top,
      bottom: safeBottom,
      width,
      height: Math.max(safeBottom - insets.top, 0),
    },
    brand: 'Mock',
    model: 'Browser',
    manufacturer: 'Mock',
    device: 'browser',
    abi: 'arm64-v8a',
    benchmarkLevel: -1,
    platform: 'android',
    system: 'Android 14',
    release: '14',
    sdkInt: 34,
    deviceOrientation: isLandscape() ? 'landscape' : 'portrait',
    language: (navigator.language || 'zh').split('-')[0],
    version: '14',
    SDKVersion: '1.1.0',
    applicationId: 'mock_app',
    enableDebug: true,
  }
}

function safeArea(): NativeSafeAreaInfo {
  const insets = mockSafeInsets()
  return {
    top: insets.top,
    bottom: insets.bottom,
    left: insets.left,
    right: insets.right,
    width: window.innerWidth,
    height: window.innerHeight,
    density: window.devicePixelRatio || 1,
  }
}

function networkStatus(): NativeNetworkStatus {
  const online = navigator.onLine
  const type = online ? 'wifi' : 'none'
  return {
    networkType: type,
    isConnected: online,
    type,
    connected: online,
    metered: false,
  }
}

function permissionStatus(scope: string) {
  // canAskAgain 只在 state 为 denied 时才可能为 true（真机口径）
  return {
    scope,
    protection: 'dangerous' as const,
    state: 'granted' as const,
    granted: true,
    permanent: false,
    canAskAgain: false,
  }
}

/* ------------------------------- 最小可视 UI ------------------------------- */
/* 目的只是让预览里「点得动、看得见」，样式一律用设计 token，不引入组件依赖 */

function toast(title: string, duration = 2000) {
  const el = document.createElement('div')
  el.textContent = title
  el.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:96px',
    'transform:translateX(-50%)',
    'max-width:80vw',
    'padding:10px 16px',
    'border-radius:10px',
    'font-size:14px',
    'z-index:2147483647',
    'background:rgb(var(--foreground) / 0.88)',
    'color:rgb(var(--background))',
    'pointer-events:none',
  ].join(';')
  document.body.appendChild(el)
  window.setTimeout(() => el.remove(), duration)
}

let loadingEl: HTMLDivElement | null = null

function showLoading(title: string) {
  if (loadingEl) return
  loadingEl = document.createElement('div')
  loadingEl.textContent = title
  loadingEl.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-size:14px',
    'z-index:2147483647',
    'background:rgb(var(--overlay) / 0.28)',
    'color:rgb(var(--background))',
  ].join(';')
  document.body.appendChild(loadingEl)
}

function hideLoading() {
  loadingEl?.remove()
  loadingEl = null
}

function overlay(content: HTMLElement) {
  const back = document.createElement('div')
  back.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'background:rgb(var(--overlay) / 0.45)',
  ].join(';')
  const close = () => back.remove()
  back.addEventListener('click', (e) => {
    if (e.target === back) close()
  })
  back.appendChild(content)
  document.body.appendChild(back)
  return close
}

function modal(params: { title?: string; content?: string; confirmText?: string; cancelText?: string; showCancel?: boolean }) {
  return new Promise<Record<string, unknown>>((resolve) => {
    const box = document.createElement('div')
    box.style.cssText = [
      'width:min(78vw,320px)',
      'border-radius:14px',
      'padding:20px',
      'background:rgb(var(--surface))',
      'color:rgb(var(--surface-foreground))',
      'box-shadow:var(--shadow-lg)',
      'font-size:14px',
    ].join(';')
    const title = document.createElement('div')
    title.textContent = params.title ?? ''
    title.style.cssText = 'font-size:17px;font-weight:600;text-align:center'
    const body = document.createElement('div')
    body.textContent = params.content ?? ''
    body.style.cssText = 'margin-top:8px;text-align:center;color:rgb(var(--muted-foreground))'
    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;gap:8px;margin-top:20px'
    const close = overlay(box)
    const done = (confirm: boolean) => {
      close()
      resolve({ confirm, cancel: !confirm })
    }
    const mk = (label: string, primary: boolean, confirm: boolean) => {
      const b = document.createElement('button')
      b.textContent = label
      b.style.cssText = [
        'flex:1',
        'min-height:44px',
        'border:none',
        'border-radius:10px',
        'font-size:14px',
        'cursor:pointer',
        primary
          ? 'background:rgb(var(--primary));color:rgb(var(--primary-foreground))'
          : 'background:rgb(var(--secondary));color:rgb(var(--secondary-foreground))',
      ].join(';')
      b.addEventListener('click', () => done(confirm))
      return b
    }
    if (params.showCancel !== false) actions.appendChild(mk(params.cancelText ?? '取消', false, false))
    actions.appendChild(mk(params.confirmText ?? '确定', true, true))
    box.append(title, body, actions)
  })
}

function actionSheet(params: { itemList: string[]; title?: string }) {
  return new Promise<Record<string, unknown> | never>((resolve, reject) => {
    const box = document.createElement('div')
    box.style.cssText = [
      'width:min(86vw,360px)',
      'border-radius:14px',
      'overflow:hidden',
      'background:rgb(var(--surface))',
      'color:rgb(var(--surface-foreground))',
      'font-size:14px',
    ].join(';')
    const close = overlay(box)
    const fail = () => {
      close()
      const error = new Error('showActionSheet:fail cancel')
      ;(error as Error & { errMsg?: string }).errMsg = 'showActionSheet:fail cancel'
      reject(error)
    }
    if (params.title) {
      const h = document.createElement('div')
      h.textContent = params.title
      h.style.cssText = 'padding:14px;text-align:center;color:rgb(var(--muted-foreground))'
      box.appendChild(h)
    }
    params.itemList.forEach((item, index) => {
      const b = document.createElement('button')
      b.textContent = item
      b.style.cssText = [
        'display:block',
        'width:100%',
        'min-height:48px',
        'border:none',
        'border-top:1px solid rgb(var(--border))',
        'background:transparent',
        'color:inherit',
        'font-size:14px',
        'cursor:pointer',
      ].join(';')
      b.addEventListener('click', () => {
        close()
        resolve({ tapIndex: index })
      })
      box.appendChild(b)
    })
    const cancel = document.createElement('button')
    cancel.textContent = '取消'
    cancel.style.cssText =
      'display:block;width:100%;min-height:48px;border:none;border-top:1px solid rgb(var(--border));background:transparent;color:rgb(var(--muted-foreground));font-size:14px;cursor:pointer'
    cancel.addEventListener('click', fail)
    box.appendChild(cancel)
  })
}

function previewImage(params: { urls?: string[]; current?: string }) {
  const src = params.current || params.urls?.[0]
  if (!src) throw new Error('previewImage:fail invalid url')
  const img = document.createElement('img')
  img.src = src
  img.alt = ''
  img.style.cssText = 'max-width:86vw;max-height:70vh;border-radius:14px'
  const close = overlay(img)
  img.addEventListener('click', close)
  return {}
}

/* --------------------------------- SDK 实现 -------------------------------- */

const KNOWN_APIS = new Set([
  'getSystemInfo',
  'getAppBaseInfo',
  'getSafeArea',
  'canIUse',
  'getNetworkType',
  'showToast',
  'hideToast',
  'showLoading',
  'hideLoading',
  'showModal',
  'showActionSheet',
  'setStatusBarStyle',
  'setStatusBarVisible',
  // setScreenOrientation / getVideoList 只在真机可用；预览 canIUse 不应声称已模拟。
  'hideKeyboard',
  'exitApp',
  'vibrateShort',
  'vibrateLong',
  'haptic',
  'setKeepScreenOn',
  'adjustPosition',
  'scanCode',
  'getLocation',
  'setStorage',
  'getStorage',
  'removeStorage',
  'getStorageInfo',
  'setClipboardData',
  'getClipboardData',
  'chooseImage',
  'previewImage',
  'saveImageToPhotosAlbum',
  'request',
  'chooseContact',
  'makePhoneCall',
  'openLocation',
  'shareText',
  'openUrl',
  'getSetting',
  'authorize',
  'openSetting',
  'requestPermission',
  'getPermissionStatus',
  'privacy.getStatus',
])

export function createMockSdk(): CapsuleSdk {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const emit = (channel: string, payload: unknown) => {
    handlers.get(channel)?.forEach((fn) => fn(payload))
  }

  const invoke = async (apiName: string, raw?: unknown): Promise<Record<string, unknown>> => {
    const params = (raw ?? {}) as Record<string, never> & {
      [key: string]: unknown
    }
    const ok = (extra: Record<string, unknown> = {}) => ({
      ok: true,
      errMsg: `${apiName}:ok`,
      ...extra,
    })

    switch (apiName) {
      case 'getSystemInfo':
        return ok({ ...systemInfo() })
      case 'getAppBaseInfo':
        // 真机里 host.applicationId 是当前应用的 manifest.applicationId；
        // 预览里给固定占位值，保证用到它的流程（如支付回跳深链）不崩、可继续调试。
        return ok({
          SDKVersion: '1.1.0',
          enableDebug: true,
          host: { applicationId: 'mock_app' },
          language: (navigator.language || 'zh').split('-')[0],
          version: '1.0.0',
          theme: 'light',
          fontSizeScaleFactor: 1,
          fontSizeSetting: 16,
        })
      case 'getSafeArea':
        return ok({ ...safeArea() })
      case 'canIUse': {
        const name = (params.args || params.schema || params.api || '') as string
        return ok({ data: name ? KNOWN_APIS.has(name) || KNOWN_APIS.has(name.split('.')[0]) : false })
      }
      case 'getNetworkType':
        return ok({ ...networkStatus() })
      case 'showToast':
        toast(String(params.title || params.message || ''), Number(params.duration) || 2000)
        return ok()
      case 'hideToast':
        return ok()
      case 'showLoading':
        showLoading(String(params.title || '加载中…'))
        return ok()
      case 'hideLoading':
        hideLoading()
        return ok()
      case 'showModal':
        return ok(await modal(params))
      case 'showActionSheet':
        return ok(await actionSheet({ itemList: (params.itemList as string[]) ?? [], title: params.title as string }))
      case 'setStatusBarStyle':
        // light 是必填布尔（下方底色偏深传 true、偏浅传 false）；缺了 / 非布尔按真机契约失败
        if (typeof params.light !== 'boolean') {
          const error = new Error(`${apiName}:fail invalid param`)
          ;(error as Error & { errMsg?: string }).errMsg = `${apiName}:fail invalid param`
          throw error
        }
        return ok()
      case 'setStatusBarVisible':
        return ok()
      case 'hideKeyboard':
        ;(document.activeElement as HTMLElement | null)?.blur()
        return ok()
      case 'exitApp':
        toast('退出应用（mock）')
        return ok()
      case 'vibrateShort':
      case 'vibrateLong':
      case 'haptic':
        navigator.vibrate?.(apiName === 'vibrateLong' ? 400 : 20)
        return ok()
      case 'setKeepScreenOn':
      case 'adjustPosition':
        return ok()
      case 'scanCode':
        return ok({
          result: 'https://example.com/mock-scan',
          scanType: 'QR_CODE',
          charSet: 'UTF-8',
          rawData: '',
          path: '',
        })
      case 'getLocation':
        return ok({
          latitude: 39.908823,
          longitude: 116.39747,
          speed: 0,
          accuracy: 20.5,
          altitude: 44.2,
          verticalAccuracy: 20.5,
          horizontalAccuracy: 20.5,
        })
      case 'setStorage':
        window.localStorage.setItem(MOCK_PREFIX + String(params.key), JSON.stringify(params.data))
        return ok()
      case 'getStorage': {
        const raw2 = window.localStorage.getItem(MOCK_PREFIX + String(params.key))
        // key 不存在时成功返回 data: null（真机口径），不要给空字符串
        return ok({ data: raw2 === null ? null : JSON.parse(raw2) })
      }
      case 'removeStorage':
        window.localStorage.removeItem(MOCK_PREFIX + String(params.key))
        return ok()
      case 'getStorageInfo': {
        const keys = Object.keys(window.localStorage)
          .filter((k) => k.startsWith(MOCK_PREFIX))
          .map((k) => k.slice(MOCK_PREFIX.length))
        const currentSize = keys.reduce(
          (sum, k) => sum + (window.localStorage.getItem(MOCK_PREFIX + k)?.length ?? 0),
          0,
        )
        return ok({ keys, currentSize, limitSize: 5 * 1024 * 1024 })
      }
      case 'setClipboardData':
        await navigator.clipboard?.writeText(String(params.data)).catch(() => undefined)
        return ok()
      case 'getClipboardData':
        return ok({ data: (await navigator.clipboard?.readText().catch(() => '')) ?? '' })
      case 'chooseImage':
        // 真机返回的是虚拟 URL（https://<页面主机>/media/<文件名>，测试包 appassets.t-stepos.com，线上包 appassets.stepaos.com），
        // 这里用 data: URL 只是为了让预览里的 <img src> 能真的显示出来
        return ok({
          tempFilePaths: [MOCK_IMAGE],
          tempFiles: [{ path: MOCK_IMAGE, size: 184320 }],
        })
      case 'previewImage':
        return ok(previewImage(params))
      case 'saveImageToPhotosAlbum':
        toast('已保存到相册（mock）')
        return ok()
      case 'request': {
        const response = await fetch(String(params.url), {
          method: String(params.method || 'GET').toUpperCase(),
          headers: (params.header as Record<string, string>) ?? undefined,
          body: params.data ? JSON.stringify(params.data) : undefined,
        })
        const text = await response.text()
        let data: unknown = text
        try {
          data = JSON.parse(text)
        } catch {
          // 非 JSON 就按文本返回，与 dataType: 'text' 行为一致
        }
        return ok({ statusCode: response.status, data, header: {} })
      }
      case 'chooseContact':
        return ok({
          displayName: '张三',
          phoneNumber: '13800000000',
          phoneNumberList: '13800000000',
        })
      case 'makePhoneCall':
        window.open(`tel:${String(params.phoneNumber)}`)
        return ok()
      case 'openLocation':
        window.open(
          `https://uri.amap.com/marker?position=${String(params.longitude)},${String(params.latitude)}&name=${encodeURIComponent(String(params.name || ''))}`,
          '_blank',
        )
        return ok()
      case 'shareText': {
        const text = String(params.text || params.title || '')
        if (navigator.share) await navigator.share({ text }).catch(() => undefined)
        else {
          await navigator.clipboard?.writeText(text).catch(() => undefined)
          toast('已复制到剪贴板（mock）')
        }
        return ok()
      }
      case 'openUrl':
        window.open(String(params.url), '_blank')
        return ok()
      case 'getSetting':
      case 'openSetting':
        // 字段与真机 getSetting 一致（见 capsule-native-api api/08-permission-privacy.md）；
        // 预览里一律给 granted，让主流程跑得通，真机以实际授权状态为准
        return ok({
          authSetting: {
            'scope.camera': true,
            'scope.record': true,
            'scope.userLocation': true,
            'scope.addPhoneContact': true,
            'scope.bluetooth': true,
            'scope.writePhotosAlbum': true,
          },
        })
      case 'authorize':
        return ok()
      case 'requestPermission':
      case 'getPermissionStatus':
        return ok(permissionStatus(String(params.scope || '')))
      case 'privacy.getStatus':
        return ok({
          agreed: true,
          protocolVersion: 1,
          agreedVersion: 1,
          agreedAt: Date.now(),
          shellVersion: '1.1.0',
          applicationId: 'mock_app',
        })
      default:
        throw new Error(`${apiName}:fail mock not implemented`)
    }
  }

  const on = (channel: string, handler: (payload: unknown) => void) => {
    if (!handlers.has(channel)) handlers.set(channel, new Set())
    handlers.get(channel)?.add(handler)
  }

  const off = (channel: string, handler: (payload: unknown) => void) => {
    handlers.get(channel)?.delete(handler)
  }

  // 浏览器事件映射到原生事件，保证订阅方代码在预览里也有反应
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => emit('networkStatusChange', networkStatus()))
    window.addEventListener('offline', () => emit('networkStatusChange', networkStatus()))
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') emit('appShow', { safeArea: safeArea() })
      else emit('appHide', {})
    })
  }

  return { invoke, on, off }
}
