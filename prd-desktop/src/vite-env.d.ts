/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DESKTOP_API_BASE_URL?: string;
  readonly VITE_DESKTOP_PRESET_SERVERS_JSON?: string;
}

// View Transition API (Chrome 111+, Tauri WebView supported)
interface ViewTransition {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
}

interface Document {
  startViewTransition?(callback: () => void | Promise<void>): ViewTransition;
}
