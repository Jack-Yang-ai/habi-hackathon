/* =============================================================================
 * 和小伴说话 —— 从伙伴页进入的对话页。
 *
 * 这是一页沉浸式对话：不套 AppShell（底部导航会让位给输入框），自己处理安全区。
 * 从动态里回应过来的那句会带一个来源标注，方便对上"当时是在回哪一条"。
 * 离线时不假装能说话：输入区直接禁用，并写清原因。
 * ========================================================================== */

import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Send } from 'lucide-react'

import { Button } from '@/shared/ui/Button'
import { EmptyState } from '@/shared/ui/Feedback'
import { cn } from '@/shared/lib/cn'
import { useAppState } from '../state/AppStateProvider'
import { XiaobanAvatar } from '../components/companion/XiaobanFigure'

function clockOf(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function ChatPage() {
  const { messages, sendMessage, pending, connection, offlineReason } = useAppState()
  const navigate = useNavigate()
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  const offline = connection === 'offline'

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, pending])

  const submit = async () => {
    const text = draft.trim()
    if (!text || offline) return
    setDraft('')
    await sendMessage(text)
  }

  return (
    // 沉浸式页不套 AppShell，所以自己限宽：桌面上聊天是一列，不是横跨整屏的一条
    <div className="mx-auto flex h-screen-dvh w-full max-w-[640px] flex-col bg-background text-foreground">
      <header className="z-20 shrink-0 border-b border-border bg-surface/95 backdrop-blur pt-safe-top">
        <div className="flex min-h-12 items-center gap-2 px-4">
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="返回"
            className="-ml-2 flex size-11 items-center justify-center rounded-md text-foreground active:bg-accent"
          >
            <ChevronLeft className="size-6" />
          </button>
          <XiaobanAvatar className="size-7" />
          <h1 className="flex-1 truncate text-title font-semibold">和小伴说话</h1>
        </div>
      </header>

      <main className="min-h-0 flex-1 scroll-y px-4 py-3">
        {messages.length === 0 ? (
          <EmptyState
            title="这里还没有话"
            description="想说什么都可以，说一半也没关系。小伴不会催你。"
          />
        ) : (
          <ul className="space-y-3">
            {messages.map((message) => {
              const mine = message.role === 'user'
              return (
                <li key={message.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
                  {mine && message.fromPostId && (
                    <span className="mb-1 text-caption text-muted-foreground">回应小伴的动态</span>
                  )}
                  <div className={cn('flex max-w-[85%] items-end gap-2', mine && 'flex-row-reverse')}>
                    {!mine && <XiaobanAvatar className="size-8" />}
                    <div
                      className={cn(
                        'rounded-lg px-3 py-2 text-body',
                        mine
                          ? 'bg-primary text-primary-foreground'
                          : 'border border-border bg-surface text-surface-foreground',
                      )}
                    >
                      {message.text}
                    </div>
                  </div>
                  <span className="mt-1 text-caption text-muted-foreground">{clockOf(message.createdAt)}</span>
                </li>
              )
            })}
            {pending && (
              <li className="flex items-center gap-2">
                <XiaobanAvatar className="size-8" />
                <span className="text-caption text-muted-foreground">小伴正在想…</span>
              </li>
            )}
          </ul>
        )}
        <div ref={endRef} />
      </main>

      <footer className="shrink-0 border-t border-border bg-surface pb-safe-bottom">
        {offline ? (
          <p className="px-4 py-3 text-caption text-muted-foreground">
            {offlineReason ?? '还没连上记录服务'}，现在说不了话。小伴就在那儿，等你接上再讲。
          </p>
        ) : (
          <div className="flex items-end gap-2 px-3 py-2">
            <textarea
              value={draft}
              rows={1}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder="说点什么…"
              aria-label="要说的话"
              className="max-h-32 min-h-tap flex-1 resize-none rounded-md border border-input bg-surface px-3 py-2 text-body placeholder:text-muted-foreground focus:border-primary focus-visible:outline-none"
            />
            <Button size="icon" aria-label="发送" disabled={!draft.trim()} onClick={submit}>
              <Send className="size-4" aria-hidden />
            </Button>
          </div>
        )}
      </footer>
    </div>
  )
}
