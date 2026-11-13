// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamWorkflowPanel } from './TeamWorkflowPanel';
import type { TeamWorkflowInfo } from '@/services/contracts/reportAgent';

const api = vi.hoisted(() => ({ getTeamWorkflow: vi.fn(), bindTeamWorkflow: vi.fn(), listWorkflows: vi.fn(), runTeamWorkflow: vi.fn() }));
vi.mock('@/services', () => api);
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>读取中</span> }));
let container: HTMLDivElement;
let root: Root;
const bound: TeamWorkflowInfo = {
  canManage: true,
  workflow: { id: 'workflow-a', name: '现有研发采集', nodeCount: 3, isEnabled: true },
  lastExecution: { id: 'execution-a', status: 'completed', createdAt: '2026-11-13T08:00:00Z', durationMs: 150, artifactCount: 1 },
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks();
  api.listWorkflows.mockResolvedValue({ success: true, data: { items: [{ id: 'workflow-a', name: '现有研发采集' }], total: 1 } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const clickText = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)!.click();

describe('现有团队入口的采集工作流接线', () => {
  it('管理者选择已有工作流绑定与解绑后都读取真实嵌套GET结果，不自动执行或创建流程', async () => {
    api.getTeamWorkflow.mockResolvedValueOnce({ success: true, data: { canManage: true, workflow: null } })
      .mockResolvedValueOnce({ success: true, data: bound })
      .mockResolvedValueOnce({ success: true, data: { canManage: true, workflow: null } });
    api.bindTeamWorkflow.mockResolvedValueOnce({ success: true, data: { workflowId: 'workflow-a' } })
      .mockResolvedValueOnce({ success: true, data: { workflowId: null } });
    await act(async () => root.render(<TeamWorkflowPanel teamId="team-a" />));
    expect(container.textContent).toContain('未绑定采集工作流');
    expect(api.listWorkflows).toHaveBeenCalledWith({ page: 1, pageSize: 100 });
    act(() => {
      const select = container.querySelector('select')!;
      select.value = 'workflow-a'; select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => clickText('保存绑定'));
    expect(api.bindTeamWorkflow).toHaveBeenCalledWith({ teamId: 'team-a', workflowId: 'workflow-a' });
    expect(container.textContent).toContain('当前工作流：现有研发采集');
    expect(container.textContent).toContain('成功');
    expect(container.textContent).not.toContain('Invalid Date');
    expect(api.runTeamWorkflow).not.toHaveBeenCalled();
    await act(async () => clickText('解绑'));
    expect(api.bindTeamWorkflow).toHaveBeenLastCalledWith({ teamId: 'team-a', workflowId: null });
    expect(container.textContent).toContain('未绑定采集工作流');
    expect(api.getTeamWorkflow).toHaveBeenCalledTimes(3);
  });
  it('后端明确无管理权限时仅展示已绑定信息，不请求选择列表或显示修改/执行按钮', async () => {
    api.getTeamWorkflow.mockResolvedValue({ success: true, data: { ...bound, canManage: false } });
    await act(async () => root.render(<TeamWorkflowPanel teamId="team-a" />));
    expect(container.textContent).toContain('当前工作流：现有研发采集');
    expect(container.querySelector('select')).toBeNull();
    expect(container.textContent).not.toContain('保存绑定');
    expect(container.textContent).not.toContain('立即执行');
    expect(api.listWorkflows).not.toHaveBeenCalled();
    expect(api.bindTeamWorkflow).not.toHaveBeenCalled();
  });
});
