// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DailyLogPanel } from './DailyLogPanel';

const api = vi.hoisted(() => ({
  getMyDailyDeliveryEvidence: vi.fn(), getDailyLog: vi.fn(), saveDailyLog: vi.fn(), deleteDailyLog: vi.fn(), listDailyLogs: vi.fn(),
  getMyDailyLogTags: vi.fn(), updateMyDailyLogTags: vi.fn(), listPersonalSources: vi.fn(), listDataSourceCommits: vi.fn(), uploadDailyLogImage: vi.fn(),
}));
vi.mock('@/services', () => api);
vi.mock('../hooks/useDataTheme', () => ({ useDataTheme: () => 'light' }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <div>正在加载</div>, MapSpinner: () => <span>核对中</span> }));
vi.mock('./RichTextMarkdownContent', () => ({ RichTextMarkdownContent: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('./DailyLogPolishPopover', () => ({ DailyLogPolishPopover: () => null }));

let container: HTMLDivElement;
let root: Root;
const item = { content: '导出功能继续联调', category: 'development', tags: ['development'], workItemId: 'github:example/repo#10', createdAt: '2026-11-12T10:00:00Z', durationMinutes: 30 };
const log = { id: 'log-a', userId: 'user-a', date: '2026-11-13', items: [item], createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  api.getMyDailyDeliveryEvidence.mockResolvedValue({ success: true, data: { schemaVersion: 1, periodStart: '2026-11-13', periodEnd: '2026-11-13', timeZone: 'Asia/Shanghai', headline: '有记录待核查', items: [], limitations: [], metrics: [] } });
  api.getDailyLog.mockResolvedValue({ success: true, data: log });
  api.listDailyLogs.mockResolvedValue({ success: true, data: { items: [] } });
  api.getMyDailyLogTags.mockResolvedValue({ success: true, data: { items: [], tagOrder: [], defaultTags: [] } });
  api.listPersonalSources.mockResolvedValue({ success: true, data: { items: [] } });
  api.saveDailyLog.mockResolvedValue({ success: true, data: log });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('日常记录的连续事项身份', () => {
  it('读取、编辑和保存记录时保留后端事项ID及原创建时间', async () => {
    await act(async () => { root.render(<DailyLogPanel />); });
    expect(container.textContent).toContain('导出功能继续联调');
    act(() => container.querySelector<HTMLButtonElement>('button[title="编辑"]')!.click());
    const editor = container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="编辑内容"]')!;
    expect(editor).not.toBeNull();
    await act(async () => { editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(api.saveDailyLog).toHaveBeenCalledOnce();
    const request = api.saveDailyLog.mock.calls[0][0];
    expect(request.items[0]).toMatchObject({ workItemId: item.workItemId, createdAt: item.createdAt, content: item.content, durationMinutes: 30 });
  });
});
