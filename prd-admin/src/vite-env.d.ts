/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** 腾讯云 COS 公网基础 URL（用于前端拼接静态资源，如头像） */
  readonly TENCENT_COS_PUBLIC_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
