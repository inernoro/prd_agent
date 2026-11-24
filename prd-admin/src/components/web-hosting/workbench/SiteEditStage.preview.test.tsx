// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedSite } from '@/services/real/webPages';
import SiteEditStage from './SiteEditStage';

const mock = vi.hoisted(() => ({ openRevision: vi.fn(), loadShares: vi.fn(), events: [] as string[] }));
vi.mock('@/services', () => ({ listSiteShares: mock.loadShares }));
vi.mock('@/services/real/webPages', () => ({ downloadSiteOfflineHtml: vi.fn(), getDesignArtifactRun: vi.fn() }));
vi.mock('../KnowledgeInlineBrowser', () => ({ default: () => null }));
vi.mock('../QuickSharePopover', () => ({ QuickSharePopover: () => null }));
vi.mock('../useOfflineExport', () => ({ useOfflineExport: () => ({ busy: false, label: '', run: vi.fn() }) }));
vi.mock('./useSiteEditSession', () => ({
  GENERATION_STAGES: [],
  createRevisionMutationIdempotencyKey: vi.fn(),
  formatRevisionTime: (value: string) => value,
  siteEditStageState: () => ({ complete: false, current: false }),
  useSiteEditSession: () => ({
    instruction: '', setInstruction: vi.fn(), phase: '', elapsedSeconds: 0,
    previewHtml: '', previewUrl: null, previewedRevision: null, previewFromEvent: false,
    revisions: [
      { id: 'first', createdAt: '2026-10-27T03:17:18Z', publishedAt: '2026-10-27T03:17:18Z', status: 'published', source: 'baseline', isCurrent: false, knowledgeEntryIds: [] },
      { id: 'current', createdAt: '2026-10-27T03:40:14Z', publishedAt: '2026-10-27T03:43:00Z', status: 'published', source: 'ai-edit', isCurrent: true, knowledgeEntryIds: [] },
    ],
    loadingHistory: false, generating: false, mutatingId: null, mutatingAction: null,
    recentKnowledge: [], selectedKnowledge: [], setSelectedKnowledge: vi.fn(), loadingKnowledge: false,
    screenshots: { items: [], busy: false, reset: vi.fn() }, runInfo: null, activeRunId: null,
    recoveryNotice: null, runtimeRecoveryGate: null, runtimesLoaded: true,
    activeRuntime: null, requestRuntime: null, screenshotsSupported: false,
    generationStageIndex: 0, openRevision: mock.openRevision, progress: 0,
  }),
}));
let root: Root;
let container: HTMLDivElement;
const onPaneChange = (pane: string) => { mock.events.push(`pane:${pane}`); };
const site = { id: 'saved-site', title: '会议纪要-1', siteUrl: 'https://assets.example/saved/index.html' } as HostedSite;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { value: vi.fn(), configurable: true });
  mock.loadShares.mockResolvedValue({ success: true, data: { items: [] } });
  mock.openRevision.mockImplementation((id: string) => { mock.events.push(`open:${id}`); });
  mock.events.length = 0;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('默认与主动看这版复用同一可见预览入口', () => {
  it('默认当前版本先进入预览pane，再发起同一版本的加载', async () => {
    await act(async () => { root.render(<SiteEditStage site={site} pane="chat" onPaneChange={onPaneChange} onSiteChanged={vi.fn()} />); });
    expect(mock.events).toEqual(['pane:preview', 'open:current']);
  });
  it('主动看历史版本也先进入同一预览pane，不改变线上版本', async () => {
    await act(async () => { root.render(<SiteEditStage site={site} pane="chat" onPaneChange={onPaneChange} onSiteChanged={vi.fn()} />); });
    mock.events.length = 0;
    const look = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '看这版')!;
    await act(async () => { look.click(); });
    expect(mock.events).toEqual(['pane:preview', 'open:first']);
  });
});
