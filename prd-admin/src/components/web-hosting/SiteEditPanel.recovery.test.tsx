// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { HostedSite } from '@/services/real/webPages';
import SiteEditPanel from './SiteEditPanel';
vi.mock('./SiteEditComposer', () => ({ default: () => null }));
vi.mock('@/components/knowledge/KnowledgeEntryPicker', () => ({ default: () => null }));
vi.mock('./workbench/useSiteEditSession', async importOriginal => ({
  ...await importOriginal<typeof import('./workbench/useSiteEditSession')>(),
  useSiteEditSession: () => ({
    instruction: '', setInstruction: vi.fn(), phase: 'idle', progress: 0, elapsedSeconds: 0,
    revisions: [], recentKnowledge: [], selectedKnowledge: [], capabilities: [], screenshots: { items: [] }, unavailableRuntimes: [],
    generating: false, loadingHistory: false, loadingKnowledge: false, mutatingId: null, runtimeRecoveryGate: null,
    recoveryNotice: { title: '生成未完成', detail: '请查看版本', action: 'generate' },
  }),
}));
it('紧凑模式的恢复入口先显示版本页签，再滚动并聚焦可见版本区', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const scroll = vi.fn();
  const originalScroll = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(<SiteEditPanel site={{ id: 'site' } as HostedSite} onPublished={vi.fn()} compact />));
    act(() => frames.splice(0).forEach(frame => frame(0)));
    const history = Array.from(container.querySelectorAll('div[tabindex="-1"]')).find(element => element.textContent?.includes('尚无版本记录')) as HTMLElement;
    expect(history.hidden).toBe(true);
    const button = Array.from(container.querySelectorAll('button')).find(element => element.textContent === '查看版本记录')!;
    act(() => button.click());
    expect(history.hidden).toBe(false);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('版本');
    act(() => frames.splice(0).forEach(frame => frame(0)));
    expect(document.activeElement).toBe(history);
    expect(scroll).toHaveBeenLastCalledWith({ block: 'start', behavior: 'smooth' });
  } finally { act(() => root.unmount()); container.remove(); HTMLElement.prototype.scrollIntoView = originalScroll; vi.unstubAllGlobals(); }
});
