import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { useRemoteAssetsStore } from './stores/remoteAssetsStore';

const THEME_STORAGE_KEY = 'prd-desktop-theme';

function readStoredTheme(): 'dark' | 'light' | null {
  try {
    const v = (localStorage.getItem(THEME_STORAGE_KEY) || '').trim().toLowerCase();
    if (v === 'dark' || v === 'light') return v;
    return null;
  } catch {
    return null;
  }
}

// 冷启动：优先使用用户选择的主题（若无则跟随系统）
try {
  const stored = readStoredTheme();
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = stored ? stored === 'dark' : prefersDark;

  // 早于 React render 应用主题 class，避免闪烁
  document.documentElement.classList.toggle('dark', isDark);

  const desired = isDark ? 'dark' : 'white';
  const cur = useRemoteAssetsStore.getState().skin;
  if (!cur || cur === 'dark' || cur === 'white') {
    useRemoteAssetsStore.getState().setSkin(desired);
  }
} catch {
  // ignore
}

// 冷启动轻量检查远端资源（失败不影响启动；仅用于缓存更新/域名替换后的快速生效）
void useRemoteAssetsStore
  .getState()
  .refreshOnColdStart()
  .catch(() => {});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
