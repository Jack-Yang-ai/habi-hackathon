import { useCallback, useState } from 'react'
import { BridgeError } from '@/shared/bridge'
import { useToast } from '@/shared/ui/Toast'

interface RunOptions {
  /** 成功不弹提示（例如结果已经在页面上展示） */
  silentSuccess?: boolean
}

function summarize(data: unknown): string | undefined {
  if (data === undefined || data === null) return undefined
  if (typeof data === 'string') return data.slice(0, 80)
  if (typeof data === 'number' || typeof data === 'boolean') return String(data)
  try {
    const text = JSON.stringify(data)
    return text.length > 80 ? `${text.slice(0, 80)}…` : text
  } catch {
    return undefined
  }
}

/**
 * 统一的「调一次原生能力」过程管理：pending 状态 + 成功 / 失败提示。
 *
 * 失败分支严格对齐 capsule-native-api 的 references/01-call-conventions.md 错误语义：
 *  cancelled 静默、denied 引导去设置、privacy 提示先同意隐私协议、unsupported 提示壳不支持、
 *  其余提示 errMsg。
 * 页面里不要自己写 try/catch + toast，用这个 hook 保证行为一致。
 */
export function useBridgeTask() {
  const { toast } = useToast()
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  const run = useCallback(
    async <T,>(key: string, label: string, fn: () => Promise<T>, options: RunOptions = {}): Promise<T | undefined> => {
      setPendingKey(key)
      try {
        const data = await fn()
        if (!options.silentSuccess) {
          toast({ title: `${label}成功`, description: summarize(data), tone: 'success' })
        }
        return data
      } catch (error) {
        const code = error instanceof BridgeError ? error.code : 'unknown'
        if (code === 'cancelled') return undefined

        if (code === 'denied') {
          toast({
            title: `${label}被拒绝`,
            description: '请到系统设置里允许本应用使用该权限后重试',
            tone: 'warning',
          })
          return undefined
        }

        if (code === 'unsupported') {
          toast({ title: `${label}在当前设备不可用`, tone: 'warning' })
          return undefined
        }

        if (code === 'privacy') {
          toast({
            title: `${label}失败`,
            description: '需要先在 App 内同意隐私协议后重试',
            tone: 'warning',
          })
          return undefined
        }

        toast({
          title: `${label}失败`,
          description: error instanceof Error ? error.message : String(error),
          tone: 'danger',
        })
        return undefined
      } finally {
        setPendingKey(null)
      }
    },
    [toast],
  )

  const isPending = useCallback((key: string) => pendingKey === key, [pendingKey])

  return { run, pendingKey, isPending }
}
