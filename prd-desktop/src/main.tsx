import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

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
} catch {
  // ignore
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
