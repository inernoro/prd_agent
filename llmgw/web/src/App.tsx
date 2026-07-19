// 独立路由（自成体系，不依赖 prd-admin）：/login 登录 + /change-password 首登强制改密 + / 控制台首页（需鉴权）。
import { BrowserRouter, Link, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { ConsoleLayout } from '@/components/ConsoleLayout';
import { LoginPage } from '@/pages/LoginPage';
import { MapSsoPage } from '@/pages/MapSsoPage';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { OverviewPage } from '@/pages/HomePage';
import { GovernancePage } from '@/pages/OverviewPage';
import { LogsPage } from '@/pages/LogsPage';
import { ModelPoolsPage } from '@/pages/ModelPoolsPage';
import { AppCallersPage } from '@/pages/AppCallersPage';
import { PlatformsPage } from '@/pages/PlatformsPage';
import { ModelsPage } from '@/pages/ModelsPage';
import { ExchangesPage } from '@/pages/ExchangesPage';
import { AuditsPage } from '@/pages/AuditsPage';
import { ShadowPage } from '@/pages/ShadowPage';
import { ServiceKeysPage } from '@/pages/ServiceKeysPage';
import { QuickstartPage } from '@/pages/QuickstartPage';
import { OrganizationPage } from '@/pages/OrganizationPage';
import { PromptPolicyPage } from '@/pages/PromptPolicyPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { UsagePage } from '@/pages/UsagePage';
import { LearningCenterPage } from '@/pages/LearningCenterPage';
import { Card } from '@/components/ui';
import { canAccessPage, isTenantRole, roleLabel, type ConsolePage } from '@/lib/access';
import { getRouterBasename } from '@/lib/runtimeBase';

// 受保护路由守卫：未登录跳登录页；已登录但挂着「强制改密」标记则跳改密页（服务端策略门同样拦截，双保险）。
function RequireAuth({ children }: { children: ReactNode }) {
  const { authed, mustChangePassword, tenant, logout } = useAuth();
  const location = useLocation();
  if (!authed) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  if (!isTenantRole(tenant?.role)) return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20, background: 'var(--bg-canvas)' }}>
      <Card style={{ width: 'min(560px, 100%)' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>当前会话没有有效租户角色</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>控制台不会加载导航或业务接口。请退出后重新登录；若仍出现，请联系租户 Owner 检查成员关系。</p>
        <button type="button" onClick={logout}>退出登录</button>
      </Card>
    </div>
  );
  return <>{children}</>;
}

// 改密页守卫：未登录跳登录；已登录且无需改密则不应停留在此页，回主页。
function RequireChangePassword({ children }: { children: ReactNode }) {
  const { authed, mustChangePassword } = useAuth();
  if (!authed) return <Navigate to="/login" replace />;
  if (!mustChangePassword) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function RequirePageAccess({ page, children }: { page: ConsolePage; children: ReactNode }) {
  const { tenant } = useAuth();
  if (canAccessPage(tenant, page)) return <>{children}</>;
  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 20 }}>
      <Card style={{ width: 'min(560px, 100%)' }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>当前角色不包含此页面</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          你当前是 {roleLabel(tenant?.role)}。控制台已按服务端权限隐藏不可用入口；如果通过旧链接来到这里，不会再发起注定失败的请求。
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}><Link to="/">返回概览</Link><Link to="/learn">查看学习中心</Link></div>
      </Card>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename={getRouterBasename()}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth/map" element={<MapSsoPage />} />
          <Route
            path="/change-password"
            element={
              <RequireChangePassword>
                <ChangePasswordPage />
              </RequireChangePassword>
            }
          />
          <Route
            element={
              <RequireAuth>
                <ConsoleLayout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<RequirePageAccess page="home"><OverviewPage /></RequirePageAccess>} />
            <Route path="/logs" element={<RequirePageAccess page="logs"><LogsPage /></RequirePageAccess>} />
            <Route path="/app-callers" element={<RequirePageAccess page="appCallers"><AppCallersPage /></RequirePageAccess>} />
            <Route path="/app-callers/:id/prompt-policy" element={<RequirePageAccess page="promptPolicy"><PromptPolicyPage /></RequirePageAccess>} />
            <Route path="/pools" element={<RequirePageAccess page="routeConfig"><ModelPoolsPage /></RequirePageAccess>} />
            <Route path="/platforms" element={<RequirePageAccess page="routeConfig"><PlatformsPage /></RequirePageAccess>} />
            <Route path="/models" element={<RequirePageAccess page="routeConfig"><ModelsPage /></RequirePageAccess>} />
            <Route path="/exchanges" element={<RequirePageAccess page="routeConfig"><ExchangesPage /></RequirePageAccess>} />
            <Route path="/audits" element={<RequirePageAccess page="audits"><AuditsPage /></RequirePageAccess>} />
            <Route path="/service-keys" element={<RequirePageAccess page="serviceKeys"><ServiceKeysPage /></RequirePageAccess>} />
            <Route path="/quickstart" element={<RequirePageAccess page="quickstart"><QuickstartPage /></RequirePageAccess>} />
            <Route path="/learn" element={<RequirePageAccess page="learn"><LearningCenterPage /></RequirePageAccess>} />
            <Route path="/organization" element={<RequirePageAccess page="organization"><OrganizationPage /></RequirePageAccess>} />
            <Route path="/shadow" element={<RequirePageAccess page="shadow"><ShadowPage /></RequirePageAccess>} />
            <Route path="/governance" element={<RequirePageAccess page="governance"><GovernancePage /></RequirePageAccess>} />
            <Route path="/settings" element={<RequirePageAccess page="settings"><SettingsPage /></RequirePageAccess>} />
            <Route path="/usage" element={<RequirePageAccess page="usage"><UsagePage /></RequirePageAccess>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
