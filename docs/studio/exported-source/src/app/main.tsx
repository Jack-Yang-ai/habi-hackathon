import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'

import '@/shared/styles/globals.css'

import { AuthProvider } from '@/shared/auth/AuthProvider'
import { NativeProvider } from '@/shared/native/NativeProvider'
import { initSafeArea } from '@/shared/native/safe-area'
import { initViewportUnitsPolyfill } from '@/shared/native/viewport-units'
import { ToastProvider } from '@/shared/ui/Toast'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('#root not found')

// 安全区先落地再渲染：真机（含真机预览）读壳的 getSafeArea，浏览器 / 平台预览用模拟值
// （见 shared/native/safe-area.ts）。不 await——拿不到值时由 tokens.css 的兜底链先顶着。
void initSafeArea()

// svh / lvh / dvh 兜底：老内核不认这些单位时，由它把实测值写进 --1svh / --1dvh / --1lvh；
// 原生支持的浏览器零副作用（见 shared/native/viewport-units.ts）。tailwind.config.js 的
// h-dvh / min-h-dvh / h-svh … 都消费这三个变量。
initViewportUnitsPolyfill()

createRoot(container).render(
  <StrictMode>
    <NativeProvider>
      <ToastProvider>
        <AuthProvider>
          {/* WebView 里加载本地资源时没有服务端路由，统一用 HashRouter */}
          <HashRouter>
            {/* 屏幕方向（capsule/manifest.json 的 orientation）由壳在原生层锁定、
                平台预览也按该字段限制横竖屏切换，H5 侧不做任何方向处理 */}
            <App />
          </HashRouter>
        </AuthProvider>
      </ToastProvider>
    </NativeProvider>
  </StrictMode>,
)
