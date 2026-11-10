// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import MobileVisualAgentEditor from './MobileVisualAgentEditor';
import { cancelImageGenRun, createWorkspaceImageGenRun, getImageGenRun } from '@/services';
vi.mock('@/hooks/useSmartBack', () => ({ useSmartBack: () => vi.fn() }));
vi.mock('@/services', () => ({
  cancelImageGenRun: vi.fn(async () => ({ success: true, data: true })),
  createWorkspaceImageGenRun: vi.fn(), getImageGenRun: vi.fn(),
  getVisualAgentImageGenModels: vi.fn(async () => ({ success: true, data: [] })),
  getVisualAgentAdapterInfo: vi.fn(), getVisualAgentWorkspaceCanvas: vi.fn(),
  saveVisualAgentWorkspaceCanvas: vi.fn(), streamImageGenRunWithRetry: vi.fn(), uploadVisualAgentWorkspaceAsset: vi.fn(),
  getVisualAgentWorkspaceDetail: vi.fn(async () => ({ success: true, data: {
    workspace: { title: '已有项目' }, assets: [],
    canvas: { payloadJson: JSON.stringify({ elements: [{ id: 'card', runId: 'existing-run', status: 'running', name: '原任务' }] }) },
  } })),
}));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('手机重新打开后台任务可取消，服务端终态到达前保留进度且不会重新提交生成', async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let status = 'Running';
  vi.mocked(getImageGenRun).mockImplementation(async () => ({ success: true, data: { run: {
    id: 'existing-run', status, size: '1024x1024', responseFormat: 'url', maxConcurrency: 1,
    total: 1, done: 0, failed: 0, cancelRequested: status === 'Cancelled', lastSeq: 1, createdAt: '2026-11-10T00:00:00Z',
  }, items: [] }, error: null }));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<MobileVisualAgentEditor workspaceId="workspace" onOpenCanvas={() => {}} />));
    const cancel = () => host.querySelector<HTMLButtonElement>('button[aria-label="取消生成 1"]');
    expect(cancel()).not.toBeNull(); expect(host.textContent).toContain('正在生成');
    await act(async () => cancel()!.click());
    expect(cancelImageGenRun).toHaveBeenCalledWith({ runId: 'existing-run' });
    expect(host.textContent).not.toContain('已取消');
    status = 'Cancelled'; await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(cancel()).toBeNull(); expect(host.textContent).toContain('已取消');
    expect(createWorkspaceImageGenRun).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
