/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 平台构建时注入的支付 API 基址；预览走同源代理 */
  readonly VITE_PAY_BASE?: string
  /** 后端接口基址；留空表示走平台 mock / 相对路径 */
  readonly VITE_API_BASE?: string
  /** 'true' 时使用本地 mock 数据（默认 true） */
  readonly VITE_USE_MOCK?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
