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
  restartDesignArtifactRun: vi.fn(),
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

describe('生成失败后的恢复', () => {
  const failedRun = {
    runId: 'failed-generation', status: 'Error', runtime: 'open-design', progress: 90,
    phaseCode: 'collecting-artifact', runtimeFailure: { code: 'open_design_execution_failed', issueCodes: [] },
    retryInstruction: '面向工程团队',
    uploadedSources: [{ attachmentId: 'file-1', fileName: '架构记录.md' }],
    knowledgeReferences: [],
    previewHtml: '<!doctype html><html><body>上次生成的内容</body></html>', previewRevision: 2,
  };

  it('重开后找回失败资料和预览，用任务快照重试并打开已保存网页', async () => {
    sessionStorage.clear();
    api.getActiveDesignArtifactRun.mockResolvedValue({ success: true, data: failedRun });
    api.getDesignArtifactRun.mockResolvedValue({ success: true, data: failedRun });
    await act(async () => { current.reset(); });
    expect(current.notice?.text).toContain('整理页面产物时出错');
    expect(current.previewHtml).toContain('上次生成的内容');
    expect(current.failedRun?.uploadedSources?.[0]?.fileName).toBe('架构记录.md');

    api.restartDesignArtifactRun.mockResolvedValue({ success: true, data: { ...savedRun, status: 'Queued' } });
    api.getDesignArtifactRun.mockResolvedValue({ success: true, data: savedRun });
    api.streamDesignArtifactRun.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'done', data: JSON.stringify({ siteId: 'saved-site' }) });
    });
    await act(async () => { await Promise.all([current.restart(), current.restart()]); });
    expect(api.restartDesignArtifactRun).toHaveBeenCalledOnce();
    expect(api.restartDesignArtifactRun).toHaveBeenCalledWith(failedRun.runId, `web-generation-retry:${failedRun.runId}`);
    expect(api.createDesignArtifactRun).not.toHaveBeenCalled();
    expect(current.completedSite?.id).toBe('saved-site');
    expect(current.previewHtml).not.toContain('上次生成的内容');
  });

  it('流报错与重开恢复使用一样的持久化失败结果，缺预览时不补样张', async () => {
    sessionStorage.clear();
    api.createDesignArtifactRun.mockResolvedValue({ success: true, data: failedRun });
    api.getDesignArtifactRun.mockResolvedValue({ success: true, data: { ...failedRun, previewHtml: null } });
    api.streamDesignArtifactRun.mockImplementation(async ({ onEvent }) => {
      onEvent({ event: 'error', data: JSON.stringify({ message: 'raw service diagnostic' }) });
    });
    await act(async () => {
      await current.start({ instruction: '面向工程团队', sourceSurface: 'web-hosting', knowledge: [], styleId: null, attachmentIds: ['file-1'], modelOptionId: 'editor-model' });
    });
    expect(api.createDesignArtifactRun).toHaveBeenCalledWith(expect.objectContaining({ modelOptionId: 'editor-model' }));
    expect(current.notice?.text).toContain('整理页面产物时出错');
    expect(current.notice?.text).not.toContain('raw service diagnostic');
    expect(current.previewHtml).toBe('');
    expect(current.restartableRunId).toBe(failedRun.runId);
  });
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
