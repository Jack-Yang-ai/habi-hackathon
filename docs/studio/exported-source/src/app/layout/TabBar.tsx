/* =============================================================================
 * 底部三个导航：伙伴 / 饮食 / 变化。
 *
 * 三个入口就是这一版产品的全部：回到小伴身边、处理到的照片、看长期的变化。
 * 不设第四个入口，也不放"我的 / 设置"——那里在变化页的设备区块里，够用。
 * ========================================================================== */

import { Home, Sprout, Utensils } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'

import { cn } from '@/shared/lib/cn'

const TABS = [
  { to: '/', label: '伙伴', icon: Home },
  { to: '/meals', label: '饮食', icon: Utensils },
  { to: '/changes', label: '变化', icon: Sprout },
] as const

export function TabBar() {
  const { pathname } = useLocation()

  return (
    <nav
      aria-label="主导航"
      className="z-20 shrink-0 border-t border-border bg-surface/95 backdrop-blur pb-safe-bottom"
    >
      <ul className="mx-auto flex max-w-[640px]">
        {TABS.map(({ to, label, icon: Icon }) => {
          const active = pathname === to
          return (
            <li key={to} className="flex-1">
              <Link
                to={to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-tabbar flex-col items-center justify-center gap-1 transition-colors duration-fast',
                  active ? 'text-primary' : 'text-muted-foreground',
                )}
              >
                <Icon className="size-5" aria-hidden />
                <span className="text-caption font-medium">{label}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
