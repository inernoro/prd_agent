/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_CONTACT_EMAIL?: string;
  readonly VITE_FRONT_END_PDA_LINKS_JSON?: string;
  readonly VITE_FRONT_END_PROJECT_REGISTRY_JSON?: string;
  readonly VITE_PA_LEARN_MORE_URL?: string;
  readonly VITE_PUBLIC_DOCS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  __MAP_RUNTIME_CONFIG__?: Partial<Record<keyof ImportMetaEnv, string>>;
}
