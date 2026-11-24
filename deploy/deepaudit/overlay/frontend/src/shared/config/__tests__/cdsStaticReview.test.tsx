import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getAgentTasks: vi.fn(async () => []),
  getAuditTasks: vi.fn(async () => []),
  getProjects: vi.fn(async () => []),
  getProjectStats: vi.fn(async () => ({ total_projects: 0, active_projects: 0, total_tasks: 0, completed_tasks: 0, total_issues: 0, resolved_issues: 0, avg_quality_score: 0 })),
}));
vi.mock('@/shared/config/database', () => ({ api: mocks, dbMode: 'api', isDemoMode: false }));
vi.mock('@/shared/api/agentTasks', () => ({ getAgentTasks: mocks.getAgentTasks }));
vi.mock('@/shared/api/rules', () => ({ getRuleSets: async () => ({ items: [] }) }));
vi.mock('@/shared/api/prompts', () => ({ getPromptTemplates: async () => ({ items: [] }) }));
vi.mock('@/components/audit/CreateTaskDialog', () => ({ default: () => null }));
vi.mock('@/components/audit/TerminalProgressDialog', () => ({ default: () => null }));
vi.mock('@/components/reports/ExportReportDialog', () => ({ default: () => null }));
vi.mock('@/pages/AgentAudit/components/ReportExportDialog', () => ({ default: () => null }));
vi.mock('@/pages/AgentAudit', () => ({ default: () => null }));
vi.mock('@/pages/Projects', () => ({ default: () => null }));
vi.mock('@/pages/ProjectDetail', () => ({ default: () => null }));
vi.mock('@/pages/RecycleBin', () => ({ default: () => null }));
vi.mock('@/pages/InstantAnalysis', () => ({ default: () => null }));
vi.mock('@/pages/TaskDetail', () => ({ default: () => null }));
vi.mock('@/pages/AdminDashboard', () => ({ default: () => null }));
vi.mock('@/pages/Account', () => ({ default: () => null }));
vi.mock('@/pages/AuditRules', () => ({ default: () => null }));
vi.mock('@/pages/PromptManager', () => ({ default: () => null }));

async function configure(value: string | undefined) {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('VITE_CDS_STATIC_REVIEW', value);
  return await import('@/shared/config/runtime');
}
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

for (const mode of [{ name: 'CDS static', flag: 'true', enabled: true },
                    { name: 'ordinary upstream', flag: 'false', enabled: false }]) {
  describe(mode.name, () => {
    it('keeps the intended home route and Agent navigation visibility', async () => {
      expect((await configure(mode.flag)).isCdsStaticReview).toBe(mode.enabled);
      const routes = (await import('@/app/routes')).default;
      const root = routes.find(route => route.path === '/')!;
      expect(root.visible).toBe(!mode.enabled);
      if (mode.enabled) {
        expect((root.element as any).type).toBe(Navigate);
        expect((root.element as any).props.to).toBe('/projects');
        expect((routes.find(route => route.path.startsWith('/agent-audit/'))!.element as any).type).toBe(Navigate);
      } else expect((root.element as any).type).not.toBe(Navigate);
    });
    it('loads Dashboard data with Agent requests only when enabled', async () => {
      await configure(mode.flag);
      const Dashboard = (await import('@/pages/Dashboard')).default;
      render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Dashboard /></MemoryRouter>);
      await screen.findByText('快速操作');
      expect(mocks.getAuditTasks).toHaveBeenCalledTimes(1);
      expect(mocks.getAgentTasks).toHaveBeenCalledTimes(mode.enabled ? 0 : 1);
      if (mode.enabled) expect(screen.queryByText('Agent 智能审计')).toBeNull();
      else expect(screen.getByText('Agent 智能审计')).toBeTruthy();
    });
    it('loads the matching task tab without disabled Agent traffic', async () => {
      await configure(mode.flag);
      const AuditTasks = (await import('@/pages/AuditTasks')).default;
      render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><AuditTasks /></MemoryRouter>);
      await waitFor(() => expect(mocks.getAuditTasks).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByText('加载任务数据...')).toBeNull());
      expect(mocks.getAgentTasks).toHaveBeenCalledTimes(mode.enabled ? 0 : 1);
      if (mode.enabled) expect(screen.queryByText('Agent 智能审计')).toBeNull();
      else expect(screen.getByText('Agent 智能审计')).toBeTruthy();
    });
  });
}

it('keeps ordinary upstream mode when the CDS flag is absent', async () => {
  expect((await configure(undefined)).isCdsStaticReview).toBe(false);
});
