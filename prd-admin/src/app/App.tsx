import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import AppShell from '@/layouts/AppShell';
import LoginPage from '@/pages/LoginPage';
import DashboardPage from '@/pages/DashboardPage';
import UsersPage from '@/pages/UsersPage';
import ModelManagePage from '@/pages/ModelManagePage';
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

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (!user || user.role !== 'ADMIN') {
    return (
      <div className="h-full w-full flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="text-center">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            无权限访问
          </div>
          <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            只有管理员可以访问此系统
          </div>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/"
        element={
          <RequireAuth>
            <RequireAdmin>
              <AppShell />
            </RequireAdmin>
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="groups" element={<GroupsPage />} />
        <Route path="model-manage" element={<ModelManagePage />} />
        <Route path="ai-chat" element={<AiChatPage />} />
        <Route path="visual-agent" element={<VisualAgentWorkspaceListPage />} />
        <Route path="visual-agent/:workspaceId" element={<VisualAgentWorkspaceEditorPage />} />
        <Route path="literary-agent" element={<LiteraryAgentWorkspaceListPage />} />
        <Route path="literary-agent/:workspaceId" element={<LiteraryAgentEditorPageWrapper />} />
        <Route path="llm-logs" element={<LlmLogsPage />} />
        <Route path="data" element={<DataManagePage />} />
        <Route path="open-platform" element={<OpenPlatformPage />} />
        <Route path="prompts" element={<PromptStagesPage />} />
        <Route path="assets" element={<AssetsManagePage />} />
        <Route path="lab" element={<LabPage />} />
        <Route path="stats" element={<Navigate to="/" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
