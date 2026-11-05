// @vitest-environment jsdom
import { act } from 'react';
import { useSiteEditSession } from './workbench/useSiteEditSession';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { HostedSite } from '@/services/real/webPages';
import SiteEditPanel from './SiteEditPanel';
const fixture = vi.hoisted(() => ({ restore: false, create: vi.fn(), stream: vi.fn(), read: vi.fn(), failRepeatedRead: false }));
vi.mock('@/services/real/documentStore', () => ({ listRecentDocumentEntries: async () => ({ success: true, data: { items: [] } }) }));
vi.mock('@/services/real/webPages', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/real/webPages')>(),
  listHostedSiteRevisions: async () => ({ success: true, data: [] }),
  getDesignRuntimeCapabilities: async () => ({ success: true, data: { runtimes: [{ id: 'open-design', enabled: true,
    label: 'OpenDesign', operations: ['edit'], isolationMode: 'service', artifactTypes: ['web-page'], sourceSurfaces: ['web-hosting'] }] } }),
  getActiveDesignArtifactRun: async () => ({ success: true, data: fixture.restore ? { runId: 'same-run', status: 'Running' } : null }),
  getHostedSiteEditRun: async () => {
    fixture.read();
    if (fixture.failRepeatedRead && fixture.read.mock.calls.length > 1) return { success: false, error: { code: 'NETWORK_ERROR', message: '本次恢复后的重复读取不可用' } };
    return { success: true, data: { runId: 'same-run', status: 'Done', runtime: 'open-design',
      createdAt: '2026-11-05T01:00:00Z', completedAt: '2026-11-05T01:02:22Z', artifactRevisionId: 'revision', progress: 100, phase: '已完成' } };
  },
  createHostedSiteEditRun: async () => { fixture.create(); return { success: true, data: { runId: 'same-run', runtime: 'open-design' } }; },
  streamHostedSiteEditRun: async ({ onEvent }: { onEvent: (event: { event: string; data: string }) => void }) => {
    fixture.stream(); onEvent({ event: 'done', data: JSON.stringify({ revisionId: 'revision' }) });
  },
  previewHostedSiteRevision: async () => ({ success: true, data: { revision: { id: 'revision', status: 'published',
    createdAt: '2026-11-05T03:00:00Z', runtime: 'open-design', isCurrent: true }, html: '<!doctype html><html><body>已有页面</body></html>', siteUrl: null } }),
  createHostedSiteRevisionPreviewAccess: async () => ({ success: true, data: { available: false } }),
}));
vi.mock('@/components/knowledge/KnowledgeEntryPicker', () => ({ default: () => null }));
vi.mock('./workbench/useSiteEditSession', async importOriginal => ({
  ...await importOriginal<typeof import('./workbench/useSiteEditSession')>(),
  useSiteEditSession: vi.fn(() => ({
    instruction: '', setInstruction: vi.fn(), phase: 'idle', progress: 0, elapsedSeconds: 0,
    revisions: [], recentKnowledge: [], selectedKnowledge: [], capabilities: [], screenshots: { items: [] }, unavailableRuntimes: [],
    generating: false, loadingHistory: false, loadingKnowledge: false, mutatingId: null, runtimeRecoveryGate: null,
    recoveryNotice: { title: '生成未完成', detail: '请查看版本', action: 'generate' },
  })),
}));
it('同一运行的142秒保留，重开纯历史未知，刷新恢复不重发模型', async () => {
  const actual = await vi.importActual<typeof import('./workbench/useSiteEditSession')>('./workbench/useSiteEditSession');
  let current: ReturnType<typeof actual.useSiteEditSession>;
  vi.mocked(useSiteEditSession).mockImplementation(function useCapturedSession(...args) {
    current = actual.useSiteEditSession(...args); return current;
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  fixture.restore = false; fixture.failRepeatedRead = false;
  fixture.create.mockClear(); fixture.stream.mockClear(); fixture.read.mockClear(); sessionStorage.clear();
  const container = document.createElement('div'); document.body.append(container);
  let root = createRoot(container);
  const mount = async () => { await act(async () => root.render(<SiteEditPanel site={{ id: 'site' } as HostedSite} onPublished={vi.fn()} />)); };
  try {
    await mount();
    await act(async () => current!.setInstruction('保留原文，只调整一个小标题'));
    await act(async () => current!.generate());
    expect(container.textContent).toContain('142 秒');
    await act(async () => root.unmount()); root = createRoot(container);
    await mount(); await act(async () => current!.openRevision('revision'));
    expect(container.textContent).toContain('用时未记录');
    expect(container.textContent).not.toMatch(/·\s*0 秒/);
    await act(async () => root.unmount()); root = createRoot(container); fixture.restore = true;
    fixture.read.mockClear(); fixture.failRepeatedRead = true;
    await mount();
    expect(container.textContent).toContain('142 秒');
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect(fixture.create).toHaveBeenCalledTimes(1); expect(fixture.stream).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
