const PREFIX = 'app.'

/**
 * 业务数据的轻量持久化：优先走原生 setStorage（真机沙箱 SharedPreferences，容量约 5MB），
 * 非原生环境回退 localStorage。两者都是同步 API 语义，避免业务层处理异步分支。
 *
 * 注意：这是「非敏感、可丢」的本地缓存。需要跨设备同步的数据必须走后端接口。
 */
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = window.localStorage.getItem(PREFIX + key)
      if (raw === null) return fallback
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  },

  set(key: string, value: unknown): void {
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value))
    } catch {
      // 隐私模式或配额超限：静默降级为不持久化，不影响主流程
    }
  },

  remove(key: string): void {
    try {
      window.localStorage.removeItem(PREFIX + key)
    } catch {
      // ignore
    }
  },
}
