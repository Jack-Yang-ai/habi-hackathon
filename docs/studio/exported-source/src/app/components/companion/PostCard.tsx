/* =============================================================================
 * 小伴的动态卡片。
 *
 * 每条动态都必须带「依据」——它由某一次真实记录触发（哪一餐、谁确认的份量）。
 * 没有依据的话就不该产生这条动态，所以这里也把依据原样显示给用户看。
 * 回应动态 = 进入对话：回复会同时出现在对话里，之后可以接着聊。
 * ========================================================================== */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MessageCircle, Send } from 'lucide-react'

import type { Post } from '@/shared/api/companionApi'
import { Badge } from '@/shared/ui/Badge'
import { Button } from '@/shared/ui/Button'
import { cn } from '@/shared/lib/cn'
import { formatRelativeTime } from '@/shared/lib/format'
import { useAppState } from '../../state/AppStateProvider'
import { ACTION_LABEL, XiaobanAvatar } from './XiaobanFigure'

export function PostCard({ post, className }: { post: Post; className?: string }) {
  const { source, replyPost } = useAppState()
  const navigate = useNavigate()
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const isDemo = source === 'demo'
  const myReplies = post.replies.filter((reply) => reply.author === 'user').length

  const submit = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    await replyPost(post.id, text)
    setSending(false)
    setDraft('')
    setComposing(false)
  }

  return (
    <article className={cn('rounded-lg bg-surface p-3', className)}>
      <header className="flex items-start gap-3">
        <XiaobanAvatar action={post.action} className="size-10" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-body font-medium">小伴</p>
            {isDemo && <Badge tone="primary">演示</Badge>}
          </div>
          <p className="text-caption text-muted-foreground">
            {formatRelativeTime(post.createdAt)} · {ACTION_LABEL[post.action]}
          </p>
        </div>
      </header>

      <p className="mt-3 text-body leading-relaxed">{post.text}</p>

      <p className="mt-3 rounded-md bg-surface-muted px-3 py-2 text-caption text-muted-foreground">
        依据 · {post.basis}
      </p>

      {post.replies.length > 0 && (
        <ul className="mt-3 space-y-2">
          {post.replies.map((reply) => (
            <li key={reply.id} className="flex gap-2 text-caption">
              <span className="shrink-0 font-medium text-muted-foreground">
                {reply.author === 'user' ? '你' : '小伴'}
              </span>
              <span className="min-w-0 flex-1">{reply.text}</span>
            </li>
          ))}
        </ul>
      )}

      {composing ? (
        <div className="mt-3">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            autoFocus
            placeholder="说点什么给小伴…"
            className="w-full resize-none rounded-md border border-input bg-surface px-3 py-2 text-body placeholder:text-muted-foreground focus:border-primary focus-visible:outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button size="md" loading={sending} disabled={!draft.trim()} onClick={submit}>
              <Send className="size-4" aria-hidden />
              送出去
            </Button>
            <Button variant="ghost" size="md" onClick={() => setComposing(false)}>
              先不说
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="md" onClick={() => setComposing(true)}>
            <MessageCircle className="size-4" aria-hidden />
            回应小伴
          </Button>
          {myReplies > 0 && (
            <button
              type="button"
              onClick={() => navigate('/chat')}
              className="min-h-tap px-2 text-caption text-primary underline-offset-4 hover:underline"
            >
              去对话里接着聊
            </button>
          )}
        </div>
      )}
    </article>
  )
}
