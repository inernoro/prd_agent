// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RevisionRunRecord } from './RevisionRunRecord';

const getRun = vi.hoisted(() => vi.fn());
vi.mock('@/services/real/webPages', () => ({ getDesignArtifactRun: getRun }));
vi.mock('./useSiteEditSession', () => ({ formatRevisionTime: (value: string) => value }));
let root: Root;
let container: HTMLDivElement;
const run = {
  runId: 'saved-generation', status: 'Done', artifactSiteId: 'saved-site',
  createdAt: '2026-10-27T03:13:13.144Z', completedAt: '2026-10-27T03:17:18.946Z',
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  getRun.mockResolvedValue({ success: true, data: run });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('已有网页版本的只读生成记录', () => {
  it('从同一版本的来源任务读取真实起止与用时，重开页面也可见', async () => {
    await act(async () => { root.render(<RevisionRunRecord siteId="saved-site" sourceRunId={run.runId} />); });
    expect(getRun).toHaveBeenCalledWith(run.runId);
    expect(container.querySelector('summary')?.textContent).toBe('生成记录 · 用时 4 分 06 秒');
    expect(container.textContent).toContain(run.createdAt);
    expect(container.textContent).toContain(run.completedAt);
  });
  it('完成时间缺失保持未知，不伪造零秒', async () => {
    getRun.mockResolvedValue({ success: true, data: { ...run, completedAt: null } });
    await act(async () => { root.render(<RevisionRunRecord siteId="saved-site" sourceRunId={run.runId} />); });
    expect(container.textContent).toContain('用时 未知');
    expect(container.textContent).not.toContain('用时 0 秒');
  });
  it('旧请求晚到不覆盖当前版本来源', async () => {
    let finish!: (value: unknown) => void;
    getRun.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await act(async () => { root.render(<RevisionRunRecord siteId="saved-site" sourceRunId="old-run" />); });
    await act(async () => { root.render(<RevisionRunRecord siteId="saved-site" sourceRunId={run.runId} />); });
    await act(async () => { finish({ success: true, data: { ...run, runId: 'old-run', completedAt: null } }); });
    expect(container.querySelector('summary')?.textContent).toBe('生成记录 · 用时 4 分 06 秒');
  });
});
