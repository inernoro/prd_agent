import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  project: { id: 'project', name: 'Real project', source_type: 'repository', repository_type: 'github', repository_url: 'https://github.com/example/repo', default_branch: 'main', programming_languages: "[]", is_active: true, created_at: '2026-01-01T00:00:00Z', owner: { full_name: 'Administrator' } },
  getAgentTasks: vi.fn(async () => []), getSSHKey: vi.fn(async () => ({ has_key: false })),
  createAgentTask: vi.fn(async () => ({ id: 'agent-task' })),
  runRepositoryAudit: vi.fn(async () => 'regular-task'),
  getUserConfig: vi.fn(async () => ({ llmConfig: { llmApiKey: 'unit-test-secret' }, otherConfig: {} })),
  loadProjects: vi.fn(), reset: vi.fn(),
}));
vi.mock('@/shared/config/database', () => ({ api: {
  getProjectById: async () => mocks.project, getAuditTasks: async () => [],
  getProjectBranches: async () => ({ branches: ['main'], default_branch: 'main' }),
}, dbMode: 'api', isDemoMode: false }));
vi.mock('@/shared/api/database', () => ({ api: { getUserConfig: mocks.getUserConfig } }));
vi.mock('@/shared/api/agentTasks', () => ({ getAgentTasks: mocks.getAgentTasks, createAgentTask: mocks.createAgentTask }));
vi.mock('@/shared/api/sshKeys', () => ({ getSSHKey: mocks.getSSHKey }));
vi.mock('@/shared/api/rules', () => ({ getRuleSets: async () => ({ items: [] }) }));
vi.mock('@/shared/api/prompts', () => ({ getPromptTemplates: async () => ({ items: [] }) }));
vi.mock('@/features/projects/services/repoScan', () => ({ runRepositoryAudit: mocks.runRepositoryAudit }));
vi.mock('@/components/audit/hooks/useTaskForm', () => {
  const projects = [mocks.project];
  return { useProjects: () => ({ projects, loading: false, loadProjects: mocks.loadProjects }) };
});
vi.mock('@/components/audit/hooks/useZipFile', () => ({ useZipFile: () => ({ reset: mocks.reset }), formatFileSize: () => '' }));
vi.mock('@/components/audit/FileSelectionDialog', () => ({ default: () => null }));
vi.mock('@/components/audit/TerminalProgressDialog', () => ({ default: () => null }));
vi.mock('@/components/database/DatabaseManager', () => ({ DatabaseManager: () => <p>Database component</p> }));
vi.mock('@/components/agent/EmbeddingConfig', () => ({ default: () => <p>Embedding component</p> }));
vi.mock('@/shared/context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: false }) }));

async function configure(flag: boolean) {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv('VITE_CDS_STATIC_REVIEW', String(flag));
}
const Router = ({ children }: { children: React.ReactNode }) => <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{children}</MemoryRouter>;
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

for (const isStatic of [true, false]) describe(isStatic ? 'CDS static flow' : 'ordinary upstream flow', () => {
  it('loads project details using only supported task APIs', async () => {
    await configure(isStatic);
    const ProjectDetail = (await import('@/pages/ProjectDetail')).default;
    render(<MemoryRouter initialEntries={['/projects/project']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Routes><Route path='/projects/:id' element={<ProjectDetail />} /></Routes></MemoryRouter>);
    await screen.findByText('项目信息');
    expect(mocks.getAgentTasks).toHaveBeenCalledTimes(isStatic ? 0 : 1);
  });

  it('starts only the supported review mode from a selected project', async () => {
    await configure(isStatic);
    const CreateTaskDialog = (await import('@/components/audit/CreateTaskDialog')).default;
    render(<Router><CreateTaskDialog open preselectedProjectId='project' onOpenChange={() => {}} onTaskCreated={() => {}} /></Router>);
    const start = await screen.findByRole('button', { name: isStatic ? '开始静态审查' : '启动 Agent 审计' });
    if (isStatic) expect(screen.queryByRole('radio', { name: /AGENT/ })).toBeNull();
    else expect(document.querySelector('input[value="agent"]')).toBeChecked();
    fireEvent.click(start);
    await waitFor(() => expect(isStatic ? mocks.runRepositoryAudit : mocks.createAgentTask).toHaveBeenCalledTimes(1));
    expect(isStatic ? mocks.createAgentTask : mocks.runRepositoryAudit).not.toHaveBeenCalled();
  });

  it('hides unavailable admin tabs and avoids eager SSH calls', async () => {
    await configure(isStatic);
    const AdminDashboard = (await import('@/pages/AdminDashboard')).default;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<Router><AdminDashboard /></Router>);
    await screen.findByText('高级参数');
    expect(mocks.getSSHKey).toHaveBeenCalledTimes(isStatic ? 0 : 1);
    const database = screen.queryByRole('tab', { name: '数据管理' });
    const embedding = screen.queryByRole('tab', { name: '嵌入模型' });
    if (isStatic) { expect(database).toBeNull(); expect(embedding).toBeNull(); expect(screen.queryByText('Agent 超时配置')).toBeNull(); }
    else { expect(database).not.toBeNull(); expect(embedding).not.toBeNull(); }
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Git 集成' }), { button: 0 });
    fireEvent.click(screen.getByRole('tab', { name: 'Git 集成' }));
    if (isStatic) expect(screen.queryByText('SSH 密钥管理')).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain('unit-test-secret');
  });

  it('explains the protected CDS login without fake security decorations', async () => {
    await configure(isStatic);
    const Login = (await import('@/pages/Login')).default;
    render(<Router><Login /></Router>);
    if (isStatic) {
      expect(screen.getByText(/管理员账号用于浏览器身份验证及本页登录/)).toBeTruthy();
      expect(screen.queryByText('SYS_ID: 0x84F2')).toBeNull();
      expect(screen.queryByText('ENCRYPT: AES-256')).toBeNull();
      expect(screen.queryByText('TLS: 1.3')).toBeNull();
      expect(screen.queryByText(/Secure Connection/)).toBeNull();
    } else expect(screen.getByText('SYS_ID: 0x84F2')).toBeTruthy();
  });
});
