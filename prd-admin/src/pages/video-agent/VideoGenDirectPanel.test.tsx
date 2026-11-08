// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoGenRun } from '@/services/contracts/videoAgent';
import { VideoGenDirectPanel } from './VideoGenDirectPanel';

const api = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn(), download: vi.fn() }));
vi.mock('@/services/real/videoAgent', () => ({
  getVideoGenRunReal: api.get, createVideoGenRunReal: api.create, createVideoGenDownloadTicketReal: api.download,
}));
vi.mock('@/services/real/apiClient', () => ({ resolveApiUrl: (path: string) => path }));

const run = (overrides: Partial<VideoGenRun> = {}): VideoGenRun => ({
  id: 'existing-run', appKey: 'video-agent', ownerAdminId: 'synthetic-owner',
  directPrompt: 'existing', generateAudio: false, exportRequested: false,
  status: 'Cancelled', mode: 'direct', directVideoJobId: 'existing-job', cancelRequested: true,
  currentPhase: 'videogen-polling', phaseProgress: 20, scenes: [], totalDurationSeconds: 0,
  createdAt: '2026-11-08T00:00:00Z', ...overrides,
});
const ok = (data: VideoGenRun) => ({ success: true, data });

describe('取消后的原作业费用详情刷新', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers(); vi.resetAllMocks();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
    expect(api.create).not.toHaveBeenCalled(); expect(api.download).not.toHaveBeenCalled();
  });
  const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(3000); });

  it('打开已取消的作业仍刷新，核到账单后显示最终费用并停止刷新', async () => {
    api.get.mockResolvedValueOnce(ok(run())).mockResolvedValueOnce(ok(run({ directVideoCost: 0.01 })))
      .mockResolvedValue(ok(run({ directVideoCost: 0.43, directVideoReconciledAt: '2026-11-08T00:01:00Z' })));
    await act(async () => root.render(<VideoGenDirectPanel externalRunId="existing-run" />));
    expect(container.textContent).toContain('供应商状态与费用尚未核定');
    expect(container.textContent).not.toContain('历史任务');
    await tick(); expect(api.get).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('待核对费用 $0.010');
    await tick(); expect(api.get).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('供应商任务已结束');
    expect(container.textContent).toContain('费用 $0.430');
    expect(container.textContent).not.toContain('待核对费用');
    await tick(); expect(api.get).toHaveBeenCalledTimes(3);
  });

  it('生成中变为本地取消时不中断收据刷新，最终显式零费用保留', async () => {
    api.get.mockResolvedValueOnce(ok(run({ status: 'Rendering', cancelRequested: false })))
      .mockResolvedValueOnce(ok(run()))
      .mockResolvedValue(ok(run({ directVideoCost: 0, directVideoReconciledAt: '2026-11-08T00:01:00Z' })));
    await act(async () => root.render(<VideoGenDirectPanel externalRunId="existing-run" />));
    await tick(); expect(api.get).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('不代表免费');
    await tick(); expect(api.get).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('费用 $0.000');
    await tick(); expect(api.get).toHaveBeenCalledTimes(3);
  });

  it.each([
    run({ directVideoJobId: undefined }),
    run({ directVideoReconciledAt: '2026-11-08T00:01:00Z' }),
    run({ status: 'Failed' }),
    run({ status: 'Completed', videoAssetUrl: 'https://synthetic.invalid/existing.mp4' }),
  ])('既有终态或未提交作业不产生多余刷新（%j）', async (data) => {
    api.get.mockResolvedValue(ok(data));
    await act(async () => root.render(<VideoGenDirectPanel externalRunId="existing-run" />));
    await tick(); expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('详情接口暂时失败不会把未知费用改成零，下次成功仍能更新', async () => {
    api.get.mockResolvedValueOnce(ok(run())).mockResolvedValueOnce({ success: false, error: { message: 'fixture unavailable' } })
      .mockResolvedValue(ok(run({ directVideoCost: 0.43, directVideoReconciledAt: '2026-11-08T00:01:00Z' })));
    await act(async () => root.render(<VideoGenDirectPanel externalRunId="existing-run" />));
    await tick(); expect(container.textContent).toContain('不代表免费');
    expect(container.textContent).not.toContain('$0.000');
    await tick(); expect(container.textContent).toContain('费用 $0.430');
  });

  it('切回新任务清理只读轮询，不修改或重生成已有作业', async () => {
    api.get.mockResolvedValue(ok(run()));
    await act(async () => root.render(<VideoGenDirectPanel externalRunId="existing-run" />));
    await act(async () => root.render(<VideoGenDirectPanel />));
    await tick(); expect(api.get).toHaveBeenCalledTimes(1);
  });
});
