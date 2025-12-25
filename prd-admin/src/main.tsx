import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from '@/app/App';
import '@/styles/tailwind.css';
import '@/styles/tokens.css';
import '@/styles/globals.css';

function shouldAutoPlayBackdropOnLoad(): boolean {
  // Dev HMR 会反复执行入口模块；避免热更新时误触发“自动播放”
  // 但“浏览器刷新/新开页”仍应触发（HMR data 会在刷新后被清空）
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hot = typeof import.meta !== 'undefined' ? (import.meta as any).hot : undefined;
    if (hot) {
      const key = '__prd_backdrop_autoplay_inited__';
      if (hot.data?.[key]) return false;
      if (!hot.data) hot.data = {};
      hot.data[key] = true;
    }
  } catch {
    // ignore
  }

  try {
    const raw = localStorage.getItem('prd-admin-auth');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    // zustand persist 默认结构：{ state: {...}, version: n }
    const state = parsed?.state ?? parsed;
    return Boolean(state?.isAuthenticated);
  } catch {
    return false;
  }
}

try {
  // 只在“真实页面加载/刷新”时触发一次（不会被 React 重渲染触发）
  if (shouldAutoPlayBackdropOnLoad()) {
    sessionStorage.setItem('prd-postlogin-fx', '1');
  }
} catch {
  // ignore
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
