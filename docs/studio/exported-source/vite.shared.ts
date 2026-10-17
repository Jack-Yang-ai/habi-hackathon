/* =============================================================================
 * 两个构建配置（App UI / Admin UI）共用的基础
 *
 * 本工程一次 `npm run build` 产出**两个互不依赖**的目录：
 *   dist/client/  ← App UI 的壳侧交付目录（= <applicationId>/ 的内容，见 capsule/）
 *   dist/admin/   ← Admin UI 的静态站点目录
 *
 * 所以构建拆成两次独立的 Vite 构建，各自单入口：
 * 单入口 = 不会产出跨入口的共享 chunk = 两个目录之间没有任何相对引用，
 * 可以各自单独部署（App UI 打进 APK、Admin UI 拷到线上）。
 *
 * 本文件只放"两边必须一致"的配置；任何一侧特有的配置写在各自的 config 里。
 * ========================================================================== */

import { existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import type { Plugin, UserConfig } from 'vite'

/** 相对工程根解析路径，避免两个 config 各写一份 `new URL(..., import.meta.url)` */
export const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/* -----------------------------------------------------------------------------
 * 图标按需引用（只作用于构建）
 *
 * 图标库 `lucide-react` 没有 `exports` 字段，入口 `dist/esm/lucide-react.js` 是一个
 * 把全部图标逐个再导出的「大桶」。打包器必须把桶里每一个图标都读出来、解析、判定副作用，
 * 之后才能摇掉不用的——**摇树能删掉产物里的代码，删不掉读取和解析的成本**。
 *
 * 实测（本模板）：一次 App 构建共转换 1816 个模块，其中 1713 个来自图标库，而模板
 * 实际只用到 9 个图标；改写为按需引用后模块数降到 122（图标 19），产物字节数几乎不变
 * （差 0.02 kB，仅 hash 变化），整次构建的 CPU 时间少约 0.8–1.0s。
 * 代价主要在**冷启动**：一次构建要读取的文件数从约 3600 个降到约 250 个。
 *
 * 这里在构建期把「从大桶整体导入」改写成「只引用用到的那几个图标文件」，业务代码零改动。
 * 只作用于 build：dev 侧由 Vite 预打包一次大桶（与改写前行为一致），不改动预览链路的解析方式。
 *
 * 边界：`import * as Icons from 'lucide-react'` 这类整体命名空间导入无法改写（会退回大桶），
 * 命中时会打一条构建告警，避免"悄悄变慢"。认不出的导出名同样留在原语句里，绝不猜。
 * 交付门禁 G54 会拦下命名空间导入 / 整桶再导出 / 动态整桶导入三种写法
 * （口径见 references/01-tech-stack.md §2 与 references/09-deployment.md §1.1）。
 * -------------------------------------------------------------------------- */

const LUCIDE = 'lucide-react'
const ICONS_DIR = fromRoot('./node_modules/lucide-react/dist/esm/icons/')
const ICON_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*(['"])lucide-react\2/g
const NAMESPACE_IMPORT_RE = /import\s*\*\s*as\s+\w+\s*from\s*['"]lucide-react['"]/

/** `ChevronLeft` → `chevron-left`、`Loader2` → `loader-2`、`AArrowDown` → `a-arrow-down` */
const toKebab = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-zA-Z])(\d)/g, '$1-$2')
    .toLowerCase()

function lucideDeepImports(): Plugin {
  return {
    name: 'ai-builder:lucide-deep-imports',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      if (id.includes('node_modules') || !code.includes(LUCIDE)) return null
      if (NAMESPACE_IMPORT_RE.test(code)) {
        this.warn(
          `整体导入 ${LUCIDE} 会让构建读进全部图标（约 1700 个模块）。` +
            `改成具名导入（import { X } from '${LUCIDE}'）即可按需只读用到的图标。`,
        )
      }
      ICON_IMPORT_RE.lastIndex = 0
      if (!ICON_IMPORT_RE.test(code)) return null
      ICON_IMPORT_RE.lastIndex = 0
      return code.replace(ICON_IMPORT_RE, (_statement, specifiers: string, quote: string) => {
        const deep: string[] = []
        const keep: string[] = []
        for (const raw of specifiers.split(',')) {
          const spec = raw.trim()
          if (!spec) continue
          // `type X` / `X as type` 是类型说明符：esbuild 本来就会抹掉，留着会把整条语句拖回大桶
          if (/^type\s/.test(spec) || /\sas\s+type$/.test(spec)) continue
          const [exported, local = exported] = spec.split(/\s+as\s+/).map((part) => part.trim())
          const icon = toKebab(exported)
          if (!existsSync(`${ICONS_DIR}${icon}.js`)) {
            keep.push(spec)
            continue
          }
          deep.push(`import ${local} from '${LUCIDE}/dist/esm/icons/${icon}.js';`)
        }
        const barrel = keep.length ? `import { ${keep.join(', ')} } from ${quote}${LUCIDE}${quote};` : ''
        return [...deep, barrel].filter(Boolean).join('\n')
      })
    },
  }
}

export const sharedViteConfig: UserConfig = {
  // 壳从包内本地资源加载页面，绝对路径会 404；Admin UI 也因此能挂在任意子路径下
  base: './',
  plugins: [react(), lucideDeepImports()],
  resolve: {
    alias: { '@': fromRoot('./src') },
  },
  build: {
    target: 'es2020',
    sourcemap: false,
  },
}
