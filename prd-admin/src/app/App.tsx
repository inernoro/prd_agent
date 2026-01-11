import { useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
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
import VisualAgentWorkspaceListPage from '@/pages/visual-agent/VisualAgentWorkspaceListPage';
import VisualAgentWorkspaceEditorPage from '@/pages/visual-agent/VisualAgentWorkspaceEditorPage';
import { LiteraryAgentWorkspaceListPage, LiteraryAgentEditorPageWrapper } from '@/pages/literary-agent';
import AssetsManagePage from '@/pages/AssetsManagePage';
import OpenPlatformPage from '@/pages/OpenPlatformPage';
import AuthzPage from '@/pages/AuthzPage';
import { getAdminAuthzMe } from '@/services';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequirePermission({ perm, children }: { perm: string; children: React.ReactNode }) {
  const perms = useAuthStore((s) => s.permissions);
  const loaded = useAuthStore((s) => s.permissionsLoaded);
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
  const logout = useAuthStore((s) => s.logout);

  // 刷新/回到主页时补齐权限（避免“持久化 token 但 permissions 为空”导致误判）
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
      setPermissionsLoaded(true);
    })();
  }, [isAuthenticated, permissionsLoaded, setPermissions, setPermissionsLoaded, logout]);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/"
        element={
          <RequireAuth>
            <RequirePermission perm="admin.access">
              <AppShell />
            </RequirePermission>
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="users" element={<RequirePermission perm="admin.users.read"><UsersPage /></RequirePermission>} />
        <Route path="groups" element={<RequirePermission perm="admin.groups.read"><GroupsPage /></RequirePermission>} />
        <Route path="model-manage" element={<RequirePermission perm="admin.models.read"><ModelManageTabsPage /></RequirePermission>} />
        <Route path="ai-chat" element={<AiChatPage />} />
        <Route path="visual-agent" element={<VisualAgentWorkspaceListPage />} />
        <Route path="visual-agent/:workspaceId" element={<VisualAgentWorkspaceEditorPage />} />
        <Route path="literary-agent" element={<LiteraryAgentWorkspaceListPage />} />
        <Route path="literary-agent/:workspaceId" element={<LiteraryAgentEditorPageWrapper />} />
        <Route path="llm-logs" element={<RequirePermission perm="admin.logs.read"><LlmLogsPage /></RequirePermission>} />
        <Route path="data" element={<RequirePermission perm="admin.data.read"><DataManagePage /></RequirePermission>} />
        <Route path="open-platform" element={<RequirePermission perm="admin.openPlatform.manage"><OpenPlatformPage /></RequirePermission>} />
        <Route path="prompts" element={<PromptStagesPage />} />
        <Route path="assets" element={<RequirePermission perm="admin.assets.read"><AssetsManagePage /></RequirePermission>} />
        <Route path="lab" element={<RequirePermission perm="admin.models.read"><LabPage /></RequirePermission>} />
        <Route path="authz" element={<RequirePermission perm="admin.authz.manage"><AuthzPage /></RequirePermission>} />
        <Route path="stats" element={<Navigate to="/" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
