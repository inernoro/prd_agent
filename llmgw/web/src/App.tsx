// 独立路由（自成体系，不依赖 prd-admin）：/login 登录 + /change-password 首登强制改密 + / 控制台首页（需鉴权）。
import { useEffect } from 'react';
import { BrowserRouter, Link, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { getHealth } from '@/lib/api';
import { ConsoleLayout } from '@/components/ConsoleLayout';
// 全局快捷提 bug（Ctrl+B / Command+B）+ 右下角常驻入口，跨路由常驻不卸载。
import { BugReportDialog } from '@/components/BugReportDialog';
import { LoginPage } from '@/pages/LoginPage';
import { MapSsoPage } from '@/pages/MapSsoPage';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { OverviewPage } from '@/pages/HomePage';
import { GovernancePage } from '@/pages/OverviewPage';
import { LogsPage } from '@/pages/LogsPage';
import { LogDetailPage } from '@/pages/LogDetailPage';
import { ModelPoolsPage } from '@/pages/ModelPoolsPage';
import { AppCallersPage } from '@/pages/AppCallersPage';
import { PlatformsPage } from '@/pages/PlatformsPage';
import { ModelsPage } from '@/pages/ModelsPage';
import { LogicalModelsPage } from '@/pages/LogicalModelsPage';
import { ExchangesPage } from '@/pages/ExchangesPage';
import { AuditsPage } from '@/pages/AuditsPage';
import { ShadowPage } from '@/pages/ShadowPage';
import { ServiceKeysPage } from '@/pages/ServiceKeysPage';
import { QuickstartPage } from '@/pages/QuickstartPage';
import { OrganizationPage } from '@/pages/OrganizationPage';
import { PromptPolicyPage } from '@/pages/PromptPolicyPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { AccountSecurityPage } from '@/pages/AccountSecurityPage';
import { UsagePage } from '@/pages/UsagePage';
import { LearningCenterPage } from '@/pages/LearningCenterPage';
import { AppCallerDetailsPage, ModelDetailsPage, ProviderDetailsPage } from '@/pages/EntityDetailsPages';
import { Card } from '@/components/ui';
import { canAccessPage, isTenantRole, roleLabel, type ConsolePage } from '@/lib/access';
import { getRouterBasename } from '@/lib/runtimeBase';

// 受保护路由守卫：未登录跳登录页；已登录但挂着「强制改密」标记则跳改密页（服务端策略门同样拦截，双保险）。
function RequireAuth({ children }: { children: ReactNode }) {
  const { authed, initializing, mustChangePassword, tenant, logout } = useAuth();
  const location = useLocation();
  if (initializing) return (
    <div role="status" aria-live="polite" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-canvas)', color: 'var(--text-secondary)' }}>
      正在恢复安全会话
    </div>
  );
  if (!authed) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  if (mustChangePassword) return <Navigate to="/change-password" replace />;
  if (!isTenantRole(tenant?.role)) return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20, background: 'var(--bg-canvas)' }}>
      <Card style={{ width: 'min(560px, 100%)' }}>
        <h1 className="lg-title">当前会话没有有效租户角色</h1>
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
        <h1 className="lg-title">当前角色不包含此页面</h1>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          你当前是 {roleLabel(tenant?.role)}。控制台已按服务端权限隐藏不可用入口；如果通过旧链接来到这里，不会再发起注定失败的请求。
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}><Link to="/">返回概览</Link><Link to="/learn">查看学习中心</Link></div>
      </Card>
    </div>
  );
}

export function App() {
  // 平台下发的 MAP 主入口（/gw/healthz 的 mapHomeUrl）在应用挂载时就取一次。
  // 此前只有 LoginPage / HomePage 会调 getHealth：SSO 直接落在某个页、或者用户
  // 从书签打开非首页时，权威值为空就会退回按 hostname 反推——而长分支的子域是
  // 截断+摘要过的，去掉 `-llmgw` 根本还原不出主入口，「返回 MAP」和教程深链会
  // 指向一个不存在的域名（Codex P2）。healthz 是匿名端点，未登录也能取。
  useEffect(() => { void getHealth(); }, []);
  return (
    <AuthProvider>
      <BrowserRouter basename={getRouterBasename()}>
        <BugReportDialog />
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
            <Route path="/logs/:id" element={<RequirePageAccess page="logs"><LogDetailPage /></RequirePageAccess>} />
            <Route path="/app-callers" element={<RequirePageAccess page="appCallers"><AppCallersPage /></RequirePageAccess>} />
            <Route path="/app-callers/view" element={<RequirePageAccess page="appCallers"><AppCallerDetailsPage /></RequirePageAccess>} />
            <Route path="/app-callers/:id/prompt-policy" element={<RequirePageAccess page="promptPolicy"><PromptPolicyPage /></RequirePageAccess>} />
            <Route path="/pools" element={<RequirePageAccess page="routeConfig"><ModelPoolsPage /></RequirePageAccess>} />
            <Route path="/platforms" element={<RequirePageAccess page="routeConfig"><PlatformsPage /></RequirePageAccess>} />
            <Route path="/platforms/view" element={<RequirePageAccess page="routeConfig"><ProviderDetailsPage /></RequirePageAccess>} />
            <Route path="/models" element={<RequirePageAccess page="routeConfig"><ModelsPage /></RequirePageAccess>} />
            <Route path="/models/view" element={<RequirePageAccess page="routeConfig"><ModelDetailsPage /></RequirePageAccess>} />
            <Route path="/logical-models" element={<RequirePageAccess page="routeConfig"><LogicalModelsPage /></RequirePageAccess>} />
            <Route path="/exchanges" element={<RequirePageAccess page="routeConfig"><ExchangesPage /></RequirePageAccess>} />
            <Route path="/audits" element={<RequirePageAccess page="audits"><AuditsPage /></RequirePageAccess>} />
            <Route path="/service-keys" element={<RequirePageAccess page="serviceKeys"><ServiceKeysPage /></RequirePageAccess>} />
            <Route path="/quickstart" element={<RequirePageAccess page="quickstart"><QuickstartPage /></RequirePageAccess>} />
            <Route path="/learn" element={<RequirePageAccess page="learn"><LearningCenterPage /></RequirePageAccess>} />
            <Route path="/organization" element={<RequirePageAccess page="organization"><OrganizationPage /></RequirePageAccess>} />
            <Route path="/shadow" element={<RequirePageAccess page="shadow"><ShadowPage /></RequirePageAccess>} />
            <Route path="/governance" element={<RequirePageAccess page="governance"><GovernancePage /></RequirePageAccess>} />
            <Route path="/settings" element={<RequirePageAccess page="settings"><SettingsPage /></RequirePageAccess>} />
            {/* 管自己的登录名与口令不是租户能力，任何角色都必须能进，故不套 RequirePageAccess。 */}
            <Route path="/account" element={<AccountSecurityPage />} />
            <Route path="/usage" element={<RequirePageAccess page="usage"><UsagePage /></RequirePageAccess>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
