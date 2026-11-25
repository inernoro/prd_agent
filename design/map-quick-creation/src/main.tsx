/* 原型入口（只用于原型，不进源码差异）：在正式的 AppShell 里挂载快速创作页，数据走 src/fixtures.ts。
 * 画面由地址 hash 决定起始路由，例如 #/quick-creation-agent?run=run-failed；CDS 的画面清单用它定位到各状态。
 * 构建：node <技能根>/cds/scripts/design/prototype-build.mjs --dir design/map-quick-creation --checkout <仓库根> */
import './env';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import '@/styles/tailwind.css';
import '@/styles/tokens.css';
import '@/styles/globals.css';
import AppShell from '@/layouts/AppShell';
import { useAuthStore } from '@/stores/authStore';
import { QuickCreationAgentPage } from '@/pages/quick-creation-agent/QuickCreationAgentPage';
import { HostingLanding, ToolboxLanding } from './concept/Landings';
import { SettingsConcept } from './concept/SettingsConcept';
import { StudioConcept } from './concept/StudioConcept';

/* 菜单目录与服务端 AdminMenuCatalog 的侧栏分组一致（prd-api/src/PrdAgent.Core/Security/AdminMenuCatalog.cs） */
const menu = [
  ['home', '/', '首页', 'Home', 1, 'home'], ['ai-toolbox', '/ai-toolbox', 'AI 百宝箱', 'Sparkles', 10, 'tools'],
  ['workflow-agent', '/workflow-agent', '工作流', 'Workflow', 20, 'tools'], ['executive', '/executive', '团队洞察', 'BarChart3', 25, 'tools'],
  ['marketplace', '/marketplace', '探索市场', 'Store', 30, 'personal'], ['my-assets', '/my-assets', '我的资源', 'FolderHeart', 40, 'personal'],
  ['web-pages', '/web-pages', '网页托管', 'Globe', 45, 'personal'], ['document-store', '/document-store', '知识库', 'Library', 46, 'personal'],
  ['settings', '/settings', '设置', 'Settings', 70, 'admin'],
].map(([appKey, path, label, icon, sortOrder, group]) => ({ appKey, path, label, icon, sortOrder, group, description: null }));

useAuthStore.setState({
  isAuthenticated: true, token: 'prototype', permissions: ['access', 'admin'], permissionsLoaded: true, isRoot: false,
  menuCatalog: menu as never, menuCatalogLoaded: true,
  user: { userId: 'u-demo', username: 'linzhixia', displayName: '林知夏', role: 'PM' } as never,
} as never);

const initialPath = () => (location.hash.replace(/^#/, '') || '/quick-creation-agent');

function Prototype() {
  const [entry, setEntry] = useState(initialPath);
  useEffect(() => {
    const onHash = () => setEntry(initialPath());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  return (
    <MemoryRouter key={entry} initialEntries={[entry]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/quick-creation-agent" element={<QuickCreationAgentPage />} />
          <Route path="/web-pages" element={<HostingLanding />} />
          <Route path="/ai-toolbox" element={<ToolboxLanding />} />
          <Route path="/concept/settings" element={<SettingsConcept />} />
          <Route path="/concept/studio" element={<StudioConcept />} />
          <Route path="*" element={<Navigate to="/quick-creation-agent" replace />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Prototype /></React.StrictMode>);
