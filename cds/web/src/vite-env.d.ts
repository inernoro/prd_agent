/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CDS_PUBLIC_BASE_URL?: string;
  readonly VITE_PRD_AGENT_BASE_URL?: string;
  readonly VITE_SKILL_MARKETPLACE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
