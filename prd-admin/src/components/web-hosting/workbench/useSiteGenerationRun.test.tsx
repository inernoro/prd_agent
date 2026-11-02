// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSiteGenerationRun } from './useSiteGenerationRun';

const api = vi.hoisted(() => ({
  getDesignArtifactRun: vi.fn(),
  getActiveDesignArtifactRun: vi.fn(),
  getSite: vi.fn(),
  getSiteContent: vi.fn(),
  createDesignArtifactRun: vi.fn(),
  streamDesignArtifactRun: vi.fn(),
}));
vi.mock('@/services/real/webPages', () => api);
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

let root: Root;
let container: HTMLDivElement;
let current: ReturnType<typeof useSiteGenerationRun>;
const created = vi.fn();
function Harness() {
  current = useSiteGenerationRun({ destinationTeamId: null, hasInitialSource: false, onCreated: created });
  return null;
}
const savedRun = {
  runId: 'saved-generation', status: 'Done', runtime: 'open-design', progress: 100,
  phase: '设计产物已完成', artifactSiteId: 'saved-site', title: '会议纪要-1',
  createdAt: '2026-10-27T03:13:13.144Z', completedAt: '2026-10-27T03:17:18.946Z',
};

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  sessionStorage.setItem('web-hosting-design-active-run-v1', savedRun.runId);
  api.getDesignArtifactRun.mockResolvedValue({ success: true, data: savedRun });
  api.getSite.mockResolvedValue({ success: true, data: { siteUrl: 'https://assets.example/saved/index.html' } });
  api.getSiteContent.mockResolvedValue({ success: true, data: { html: '<html><body>已保存网页</body></html>' } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); sessionStorage.clear(); vi.clearAllMocks(); vi.unstubAllGlobals();
});

describe('恢复已完成生成的持久化耗时', () => {
  it('同一已保存任务恢复后保留实际起止耗时，不以重开窗口的零秒替代', async () => {
    await act(async () => { current.reset(); });
    expect(current.completedSite).toMatchObject({ id: 'saved-site', durationSeconds: 245.802 });
    expect(current.generating).toBe(false);
    expect(created).toHaveBeenCalledOnce();
    expect(api.getDesignArtifactRun).toHaveBeenCalledWith(savedRun.runId);
  });

  it('历史任务缺少完成时间时交付仍可打开，耗时保持未知', async () => {
    api.getDesignArtifactRun.mockResolvedValue({ success: true, data: { ...savedRun, completedAt: null } });
    await act(async () => { current.reset(); });
    expect(current.completedSite).toMatchObject({ id: 'saved-site', durationSeconds: null });
    expect(current.generating).toBe(false);
  });

  it('流完成事件也读取同一任务的持久化完成时间，不取本地计时器快照', async () => {
    sessionStorage.clear();
    api.createDesignArtifactRun.mockResolvedValue({ success: true, data: { ...savedRun, status: 'Queued', completedAt: null } });
    api.streamDesignArtifactRun.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'done', data: JSON.stringify({ siteId: 'saved-site' }) });
    });
    await act(async () => {
      await current.start({ instruction: '使用已有测试输入', sourceSurface: 'web-hosting', knowledge: [], styleId: null, attachmentIds: [] });
    });
    expect(api.getDesignArtifactRun).toHaveBeenCalledWith(savedRun.runId);
    expect(current.completedSite).toMatchObject({ id: 'saved-site', durationSeconds: 245.802 });
  });
});
