/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** LLM 网关 API base，默认 /gw（dev 时由 vite proxy 反代）。 */
  readonly VITE_LLMGW_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
