import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'

/**
 * 路由守卫：需要登录的路由用它包住。
 * - 会话未就绪（!ready）：先不渲染也不跳转，避免已登录用户刷新时闪登录页；
 * - 未登录：重定向 /auth 并记来源（登录页成功后 navigate(from, { replace: true }) 跳回）。
 * 服务未开通（available=false）不在此放行——那种情况数据功能本就不可用，
 * 由登录页显示「服务开通中」的提示。
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth()
  const location = useLocation()

  if (!ready) return null
  if (!user) {
    const from = location.pathname + location.search
    return <Navigate to="/auth" replace state={{ from }} />
  }
  return children
}
