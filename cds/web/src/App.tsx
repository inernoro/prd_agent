import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { BranchDetailPage } from '@/pages/BranchDetailPage';
import { BranchListPage } from '@/pages/BranchListPage';
import { BranchTopologyPage } from '@/pages/BranchTopologyPage';
import { CdsSettingsPage } from '@/pages/CdsSettingsPage';
import { HelloPage } from '@/pages/HelloPage';
import { HomePage } from '@/pages/HomePage';
import { LoginPage } from '@/pages/LoginPage';
import { ProjectListPage } from '@/pages/ProjectListPage';
import { ProjectSettingsPage } from '@/pages/ProjectSettingsPage';

class DashboardErrorBoundary extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null };

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the dashboard debuggable without crashing the whole React tree.
    // eslint-disable-next-line no-console
    console.error('[cds-dashboard] render failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.message) return this.props.children;
    return (
      <div className="min-h-screen bg-background p-8 text-foreground">
        <div className="mx-auto max-w-3xl rounded-md border border-destructive/35 bg-destructive/10 p-5 text-sm text-destructive">
          <div className="mb-2 text-base font-semibold">页面局部渲染异常</div>
          <div className="text-destructive/85">
            CDS 控制台没有退出，当前页面渲染失败。请刷新页面；若反复出现，把下面错误发给开发者定位。
          </div>
          <pre className="mt-4 max-h-48 overflow-auto rounded-md bg-background/70 p-3 text-xs text-foreground">
            {this.state.message}
          </pre>
          <button
            type="button"
            className="mt-4 rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground"
            onClick={() => window.location.reload()}
          >
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}

/*
 * Router root for the React-based CDS Dashboard.
 *
 * The Express server (cds/src/server.ts) holds a list of migrated routes and
 * serves the built React index.html for them. Unmigrated paths still resolve
 * to legacy static pages under cds/web-legacy/, so each migration step is a
 * single addition to MIGRATED_REACT_ROUTES + a new <Route> here.
 *
 * Currently migrated:
 *   /                       CDS marketing/control-plane home
 *   /login                  React basic-auth login page
 *   /hello                  Foundation demo page (Tailwind / theme / API / Dialog)
 *   /cds-settings           CDS system settings
 *   /project-list           Project list
 *   /branches/:projectId    Branch list + one-click preview
 *   /branch-list?project=   Back-compat entry to the React branch list
 *   /branch-panel/:branchId Branch detail + logs + single-service actions
 *   /branch-topology        Project service topology
 *   /settings/:projectId    Project settings
 */
export function App(): JSX.Element {
  return (
    <DashboardErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/hello" element={<HelloPage />} />
          <Route path="/cds-settings" element={<CdsSettingsPage />} />
          <Route path="/project-list" element={<ProjectListPage />} />
          <Route path="/branches/:projectId" element={<BranchListPage />} />
          <Route path="/branch-list" element={<BranchListPage />} />
          <Route path="/branch-panel" element={<BranchDetailPage />} />
          <Route path="/branch-panel/:branchId" element={<BranchDetailPage />} />
          <Route path="/branch-topology" element={<BranchTopologyPage />} />
          <Route path="/settings/:projectId" element={<ProjectSettingsPage />} />
          <Route path="*" element={<Navigate to="/project-list" replace />} />
        </Routes>
      </BrowserRouter>
    </DashboardErrorBoundary>
  );
}
