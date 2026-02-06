import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { initializeTheme } from '@/stores/themeStore';
import AppShell from '@/layouts/AppShell';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import UsersPage from '@/pages/UsersPage';
import { ModelManageTabsPage } from '@/pages/ModelManageTabsPage';
import GroupsPage from '@/pages/GroupsPage';
import LlmLogsPage from '@/pages/LlmLogsPage';
import LabPage from '@/pages/LabPage';
import AiChatPage from '@/pages/AiChatPage';
import DataManagePage from '@/pages/DataManagePage';
import PromptStagesPage from '@/pages/PromptStagesPage';
import VisualAgentFullscreenPage from '@/pages/visual-agent/VisualAgentFullscreenPage';
import { LiteraryAgentWorkspaceListPage, LiteraryAgentEditorPageWrapper } from '@/pages/literary-agent';
import { DefectAgentPage } from '@/pages/defect-agent';
import { AgentDashboardPage } from '@/pages/agent-dashboard';
import { MarketplacePage } from '@/pages/marketplace';
import { AiToolboxPage } from '@/pages/ai-toolbox';
import { LandingPage } from '@/pages/home';
import AssetsManagePage from '@/pages/AssetsManagePage';
import OpenPlatformTabsPage from '@/pages/OpenPlatformTabsPage';
import AutomationRulesPage from '@/pages/AutomationRulesPage';
import AuthzPage from '@/pages/AuthzPage';
import SettingsPage from '@/pages/SettingsPage';
import ExecutiveDashboardPage from '@/pages/ExecutiveDashboardPage';
import RichComposerLab from '@/pages/_dev/RichComposerLab';
import { getAdminAuthzMe, getAdminMenuCatalog } from '@/services';
import { ToastContainer } from '@/components/ui/Toast';
import { AgentSwitcherProvider } from '@/components/agent-switcher';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/home" replace />;
  return <>{children}</>;
}

function RequirePermission({ perm, children }: { perm: string; children: React.ReactNode }) {
  const perms = useAuthStore((s) => s.permissions);
  const loaded = useAuthStore((s) => s.permissionsLoaded);
  const logout = useAuthStore((s) => s.logout);

  if (!loaded) {
    return (
      <div className="h-full w-full flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="text-center">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            加载权限中...
          </div>
          <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            正在获取后台权限，请稍候
          </div>
        </div>
      </div>
    );
  }

  const has = Array.isArray(perms) && perms.includes(perm);
  if (!has) {
    return (
      <div className="h-full w-full flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="text-center">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            无权限访问
          </div>
          <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            缺少权限：{perm}
          </div>
          <button
            onClick={() => logout()}
            className="mt-4 px-4 py-2 text-sm rounded-md transition-colors"
            style={{
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-default)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--bg-elevated)';
            }}
          >
            退出登录
          </button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export default function App() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setPermissions = useAuthStore((s) => s.setPermissions);
  const permissionsLoaded = useAuthStore((s) => s.permissionsLoaded);
  const setPermissionsLoaded = useAuthStore((s) => s.setPermissionsLoaded);
  const setIsRoot = useAuthStore((s) => s.setIsRoot);
  const setMenuCatalog = useAuthStore((s) => s.setMenuCatalog);
  const menuCatalogLoaded = useAuthStore((s) => s.menuCatalogLoaded);
  const logout = useAuthStore((s) => s.logout);

  // 初始化主题（应用启动时立即执行）
  useEffect(() => {
    initializeTheme();
  }, []);

  // 刷新/回到主页时补齐权限（避免"持久化 token 但 permissions 为空"导致误判）
  useEffect(() => {
    if (!isAuthenticated) return;
    if (permissionsLoaded) return;
    (async () => {
      const res = await getAdminAuthzMe();
      if (!res.success) {
        logout();
        return;
      }
      setPermissions(res.data.effectivePermissions || []);
      setIsRoot(res.data.isRoot ?? false);
      setPermissionsLoaded(true);
    })();
  }, [isAuthenticated, permissionsLoaded, setPermissions, setPermissionsLoaded, setIsRoot, logout]);

  // 加载菜单目录
  useEffect(() => {
    if (!isAuthenticated) return;
    if (menuCatalogLoaded) return;
    (async () => {
      const res = await getAdminMenuCatalog();
      if (res.success && res.data?.items) {
        setMenuCatalog(res.data.items);
      }
    })();
  }, [isAuthenticated, menuCatalogLoaded, setMenuCatalog]);

  return (
    <AgentSwitcherProvider>
      <ToastContainer />
      <Routes>
        {/* Landing page - public */}
        <Route path="/home" element={<LandingPage />} />

        <Route path="/login" element={<LoginPage />} />

        {/* 开发试验场 - 无需权限 */}
        <Route path="/_dev/rich-composer-lab" element={<RichComposerLab />} />

        {/* 视觉创作 Agent - 独立全屏页面，不使用 AppShell 布局 */}
        <Route
          path="/visual-agent"
          element={
            <RequireAuth>
              <RequirePermission perm="visual-agent.use">
                <VisualAgentFullscreenPage />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/visual-agent/:workspaceId"
          element={
            <RequireAuth>
              <RequirePermission perm="visual-agent.use">
                <VisualAgentFullscreenPage />
              </RequirePermission>
            </RequireAuth>
          }
        />
        {/* 兼容旧路由 */}
        <Route
          path="/visual-agent-fullscreen"
          element={
            <RequireAuth>
              <RequirePermission perm="visual-agent.use">
                <VisualAgentFullscreenPage />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/visual-agent-fullscreen/:workspaceId"
          element={
            <RequireAuth>
              <RequirePermission perm="visual-agent.use">
                <VisualAgentFullscreenPage />
              </RequirePermission>
            </RequireAuth>
          }
        />

        {/* 海鲜市场 - 独立全屏页面 */}
        <Route
          path="/marketplace"
          element={
            <RequireAuth>
              <RequirePermission perm="access">
                <MarketplacePage />
              </RequirePermission>
            </RequireAuth>
          }
        />

      <Route
        path="/"
        element={
          <RequireAuth>
            <RequirePermission perm="access">
              <AppShell />
            </RequirePermission>
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="agent-dashboard" element={<AgentDashboardPage />} />
        <Route path="users" element={<RequirePermission perm="users.read"><UsersPage /></RequirePermission>} />
        <Route path="groups" element={<RequirePermission perm="groups.read"><GroupsPage /></RequirePermission>} />
        <Route path="mds" element={<RequirePermission perm="mds.read"><ModelManageTabsPage /></RequirePermission>} />
        <Route path="prd-agent" element={<RequirePermission perm="prd-agent.use"><AiChatPage /></RequirePermission>} />
        <Route path="literary-agent" element={<RequirePermission perm="literary-agent.use"><LiteraryAgentWorkspaceListPage /></RequirePermission>} />
        <Route path="literary-agent/:workspaceId" element={<RequirePermission perm="literary-agent.use"><LiteraryAgentEditorPageWrapper /></RequirePermission>} />
        <Route path="defect-agent" element={<RequirePermission perm="defect-agent.use"><DefectAgentPage /></RequirePermission>} />
        <Route path="ai-toolbox" element={<RequirePermission perm="ai-toolbox.use"><AiToolboxPage /></RequirePermission>} />
        <Route path="logs" element={<RequirePermission perm="logs.read"><LlmLogsPage /></RequirePermission>} />
        <Route path="data" element={<RequirePermission perm="data.read"><DataManagePage /></RequirePermission>} />
        <Route path="open-platform" element={<RequirePermission perm="open-platform.manage"><OpenPlatformTabsPage /></RequirePermission>} />
        <Route path="automations" element={<RequirePermission perm="automations.manage"><AutomationRulesPage /></RequirePermission>} />
        <Route path="prompts" element={<RequirePermission perm="prompts.read"><PromptStagesPage /></RequirePermission>} />

        <Route path="assets" element={<RequirePermission perm="assets.read"><AssetsManagePage /></RequirePermission>} />
        <Route path="lab" element={<RequirePermission perm="lab.read"><LabPage /></RequirePermission>} />
        <Route path="authz" element={<RequirePermission perm="authz.manage"><AuthzPage /></RequirePermission>} />
        <Route path="settings" element={<RequirePermission perm="settings.read"><SettingsPage /></RequirePermission>} />
        <Route path="executive" element={<RequirePermission perm="executive.read"><ExecutiveDashboardPage /></RequirePermission>} />
        <Route path="stats" element={<Navigate to="/" replace />} />
      </Route>

        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </AgentSwitcherProvider>
  );
}
