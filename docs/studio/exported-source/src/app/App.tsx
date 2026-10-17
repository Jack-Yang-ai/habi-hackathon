import { Navigate, Route, Routes } from 'react-router-dom'

import { AppStateProvider } from './state/AppStateProvider'
import { AppShell } from './layout/AppShell'
import { CompanionPage } from './pages/CompanionPage'
import { MealsPage } from './pages/MealsPage'
import { ChangesPage } from './pages/ChangesPage'
import { ChatPage } from './pages/ChatPage'

/**
 * App UI 路由表。
 *
 * 三个 Tab（伙伴 / 饮食 / 变化）挂在 AppShell 里，共用顶栏与底部导航；
 * 对话页是沉浸式页——底部导航要给输入框让位，所以它挂在 AppShell 之外，自己处理安全区。
 */
export function App() {
  return (
    <AppStateProvider>
      <Routes>
        {/* 沉浸式页（不套 AppShell） */}
        <Route path="/chat" element={<ChatPage />} />

        <Route element={<AppShell />}>
          <Route index element={<CompanionPage />} />
          <Route path="meals" element={<MealsPage />} />
          <Route path="changes" element={<ChangesPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AppStateProvider>
  )
}
