/* 原型入口（只用于原型，不进源码差异）：在正式的 AppShell 里挂载学习中心、课程页与练习页，数据走 src/env.ts 的模拟服务端。
 * 画面由地址 hash 决定起始路由，例如 #/learning-center/courses/automation-testing?lesson=l1&media=pdf。
 * 构建：node <技能根>/cds/scripts/design/prototype-build.mjs --dir design/map-test-course --checkout <仓库根> */
import './env';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import '@/styles/tailwind.css';
import '@/styles/tokens.css';
import '@/styles/globals.css';
import AppShell from '@/layouts/AppShell';
import { useAuthStore } from '@/stores/authStore';
import LearningCenterPage from '@/pages/learning-center/LearningCenterPage';
import LearningCoursePage from '@/pages/learning-course/LearningCoursePage';
import LearningPracticePage from '@/pages/learning-course/LearningPracticePage';

/* 菜单目录与服务端 AdminMenuCatalog 的侧栏分组一致（prd-api/src/PrdAgent.Core/Security/AdminMenuCatalog.cs） */
const menu = [
  ['home', '/', '首页', 'Home', 1, 'home'], ['ai-toolbox', '/ai-toolbox', 'AI 百宝箱', 'Sparkles', 10, 'tools'],
  ['workflow-agent', '/workflow-agent', '工作流', 'Workflow', 20, 'tools'], ['learning-center', '/learning-center', '学习中心', 'GraduationCap', 28, 'tools'],
  ['marketplace', '/marketplace', '探索市场', 'Store', 30, 'personal'], ['my-assets', '/my-assets', '我的资源', 'FolderHeart', 40, 'personal'],
  ['document-store', '/document-store', '知识库', 'Library', 46, 'personal'], ['settings', '/settings', '设置', 'Settings', 70, 'admin'],
].map(([appKey, path, label, icon, sortOrder, group]) => ({ appKey, path, label, icon, sortOrder, group, description: null }));

useAuthStore.setState({
  isAuthenticated: true, token: 'prototype', permissions: ['access'], permissionsLoaded: true, isRoot: false,
  menuCatalog: menu as never, menuCatalogLoaded: true,
  user: { userId: 'u-demo', username: 'zhouyan', displayName: '周妍', role: 'QA' } as never,
} as never);

const initialPath = () => (location.hash.replace(/^#/, '') || '/learning-center/courses/automation-testing');

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
          <Route path="/learning-center" element={<LearningCenterPage />} />
          <Route path="/learning-center/courses/:courseId" element={<LearningCoursePage />} />
          <Route path="/learning-center/courses/:courseId/practice/:practiceId" element={<LearningPracticePage />} />
          <Route path="*" element={<Navigate to="/learning-center/courses/automation-testing" replace />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Prototype /></React.StrictMode>);
