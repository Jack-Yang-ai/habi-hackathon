import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { getBridgeMode, initBridge, invokeNative, nativeLog, onNativeEvent } from '@/shared/bridge'
import type { BridgeMode, NativeNetworkStatus, NativeSystemInfo } from '@/shared/bridge/types'

interface NativeContextValue {
  /** 宿主模式；ready 为 false 时还是 undefined */
  mode: BridgeMode | undefined
  ready: boolean
  systemInfo: NativeSystemInfo | null
  network: NativeNetworkStatus | null
}

const NativeContext = createContext<NativeContextValue>({
  mode: undefined,
  ready: false,
  systemInfo: null,
  network: null,
})

/**
 * 原生运行态 Provider：探测宿主、读系统信息、订阅网络与内存事件。
 * App / Admin 两棵树各挂一次。
 *
 * 安全区不在这里处理：App 入口在渲染前调 `initSafeArea()`（src/shared/native/safe-area.ts），
 * 由它把 `--safe-*` 四个方向的值写进 <html>（真机读壳值、预览用模拟值）。
 */
export function NativeProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<BridgeMode | undefined>(undefined)
  const [systemInfo, setSystemInfo] = useState<NativeSystemInfo | null>(null)
  const [network, setNetwork] = useState<NativeNetworkStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const disposers: Array<() => void> = []

    void (async () => {
      setMode(await initBridge())
      if (cancelled) return

      try {
        const info = await invokeNative('getSystemInfo')
        if (cancelled) return
        setSystemInfo(info)
      } catch {
        // 拿不到系统信息不阻塞渲染
      }

      try {
        setNetwork(await invokeNative('getNetworkType'))
      } catch {
        // 忽略：离线不影响首屏
      }

      disposers.push(
        // 回到前台时补一次网络状态：后台期间的变化不一定会推事件
        await onNativeEvent('appShow', () => {
          void invokeNative('getNetworkType')
            .then(setNetwork)
            .catch(() => undefined)
        }),
      )
      disposers.push(await onNativeEvent('networkStatusChange', setNetwork))
      disposers.push(
        await onNativeEvent('memoryWarning', ({ level }) => {
          nativeLog.w('NativeProvider', `memoryWarning level=${level}`)
        }),
      )
      if (!cancelled) setReady(true)
    })()

    return () => {
      cancelled = true
      disposers.forEach((dispose) => dispose())
    }
  }, [])

  const value = useMemo<NativeContextValue>(
    () => ({ mode: mode ?? getBridgeMode(), ready, systemInfo, network }),
    [mode, ready, systemInfo, network],
  )

  return <NativeContext.Provider value={value}>{children}</NativeContext.Provider>
}

export function useNative(): NativeContextValue {
  return useContext(NativeContext)
}
