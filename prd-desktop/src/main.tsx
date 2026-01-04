import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { useRemoteAssetsStore } from './stores/remoteAssetsStore';

// 冷启动时根据系统主题设置默认皮肤（仅覆盖 dark/white/空值；若用户未来选择自定义皮肤，则不强行覆盖）
try {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const desired = prefersDark ? 'dark' : 'white';
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
