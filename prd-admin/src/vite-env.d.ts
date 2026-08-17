/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_CONTACT_EMAIL?: string;
  readonly VITE_PA_LEARN_MORE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
