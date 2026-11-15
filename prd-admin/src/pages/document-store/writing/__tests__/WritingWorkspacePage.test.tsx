// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WritingWorkspacePage from '../WritingWorkspacePage';
import type { WritingContext, WritingDocument, WritingSource, WritingState } from '@/services/contracts/writing';

const api = vi.hoisted(() => ({ context: vi.fn(), get: vi.fn(), save: vi.fn(), command: vi.fn(), generate: vi.fn(), create: vi.fn() }));
vi.mock('@/services/real/writing', () => ({ writingContext: api.context, getWriting: api.get, saveWriting: api.save, commandWriting: api.command, generateWriting: api.generate, createWriting: api.create }));
vi.mock('../WritingThreads', () => ({ WritingThreads: () => null }));
vi.mock('../WritingReaderPage', () => ({ WritingReaderPage: () => null }));
vi.mock('../WritingReviewPage', () => ({ WritingReviewPage: () => null }));
vi.mock('../WritingQuestionPanel', () => ({ WritingQuestionPanel: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: ({ text }: { text: string }) => <p>{text}</p>, MapSpinner: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const source: WritingSource = { id: 'S2', entryId: 'source-entry', title: '待读取的交接资料', status: 'pending', content: '', hash: '', updatedAt: '0001-01-01T00:00:00Z' };
const context: WritingContext = {
  store: { id: 'store', name: '交接知识库' } as WritingContext['store'], actorId: 'actor', actorName: '作者', reviewerId: 'reviewer', reviewerName: '审核人',
  templates: [{ id: 'prd', name: '需求说明', type: '需求说明', role: '', useWhen: '', version: '1.0', headings: [] }],
  sources: [{ id: source.entryId, title: source.title, contentType: 'text/markdown', createdBy: 'actor', authorName: '资料作者', updatedAt: '2026-11-13T08:47:47.816Z', fileSize: 34, metadata: {}, published: true }],
};
function state(): WritingState {
  return { revision: 6, stage: 'confirm', templateId: 'prd', templateVersion: '1.0', title: '独立手写草稿', summary: '', manualInput: '', authorId: 'actor', authorName: '作者', reviewerId: 'reviewer', reviewerName: '审核人', scopeIn: '', scopeOut: '', conclusions: [], intentPoints: [], sources: [{ ...source }], sections: [{ id: 'section', title: '交接', paragraphs: [{ id: 'paragraph', text: '手写正文', status: 'auth', citations: [], confirmed: false }] }], questions: [], roles: [], chapters: [], updatedAt: '2026-11-13T08:50:00Z' };
}
const documentFor = (state: WritingState): WritingDocument => ({ entryId: 'draft', store: context.store, state, canApprove: false });
let root: Root, container: HTMLDivElement;
async function mount() {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={['/document-store/store/write/draft']}><Routes><Route path="/document-store/:storeId/write/:entryId" element={<WritingWorkspacePage />} /></Routes></MemoryRouter>));
}
async function click(button: HTMLButtonElement) { await act(async () => button.click()); }
const findButton = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!;

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  api.context.mockResolvedValue({ success: true, data: context }); api.get.mockResolvedValue({ success: true, data: documentFor(state()) });
  api.save.mockResolvedValue({ success: true, data: documentFor({ ...state(), revision: 7 }) });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('手写草稿来源的读取状态必须真实', () => {
  it('跳过的待读资料明确未参与生成，不把默认日期或空白当原文证据', async () => {
    api.get.mockResolvedValue({ success: true, data: documentFor({ ...state(), sources: [{ ...source, status: 'skipped' }] }) });
    await mount();
    const row = container.querySelector<HTMLButtonElement>('.src-h')!;
    expect(row.textContent).toContain('已跳过');
    expect(row.textContent).not.toContain('01-01');
    await click(row);
    const excerpts = container.querySelector('.writing-source-excerpts')!;
    expect(excerpts.textContent).toContain('未参与本次生成');
    expect(excerpts.textContent).toContain('更新并复核');
    expect(excerpts.querySelector('.ex')).toBeNull();
  });
  it('跳过资料带有历史内容时，展开及预览均不把旧内容冒充本次来源', async () => {
    const oldContent = '历史内容：所有租户均可执行。';
    api.get.mockResolvedValue({ success: true, data: documentFor({ ...state(), sources: [{ ...source, status: 'skipped', content: oldContent, updatedAt: '2026-11-12T00:00:00Z' }] }) });
    await mount(); await click(container.querySelector<HTMLButtonElement>('.src-h')!);
    const excerpts = container.querySelector('.writing-source-excerpts')!;
    expect(excerpts.textContent).toContain('未参与本次生成');
    expect(excerpts.textContent).not.toContain(oldContent);
    await click(findButton('检查正文与发布预览'));
    const dialog = container.querySelector('[aria-label="来源原文"]')!;
    expect(dialog.textContent).toContain('已跳过');
    expect(dialog.textContent).toContain('未参与本次生成');
    expect(dialog.textContent).not.toContain(oldContent);
    expect(api.generate).not.toHaveBeenCalled();
  });
  it('pending来源不把默认日期当更新时间，展开明确沿现有更新按钮读取', async () => {
    await mount();
    const row = container.querySelector<HTMLButtonElement>('.src-h')!;
    expect(row.textContent).toContain('尚未读取');
    expect(row.textContent).not.toContain('01-01');
    expect(row.textContent).toContain('资料作者');
    await click(row);
    const content = container.querySelector('.writing-source-excerpts')!;
    expect(content.textContent).toContain('更新并复核');
    expect(content.textContent).toContain('无需生成正文');
    expect(content.textContent).not.toContain('生成后');
    expect(content.querySelector('.ex')).toBeNull();
    expect(content.querySelector('a')?.getAttribute('href')).toContain('source-entry');
  });
  it('现有更新并复核成功后显示读回日期及正文，保持手写路径不触发生成', async () => {
    const content = '仅限部门内部交接。\n\n离岗前3个工作日提交。';
    api.command.mockResolvedValue({ success: true, data: documentFor({ ...state(), revision: 8, sources: [{ ...source, status: 'read', updatedAt: '2026-11-13T08:47:47.816Z', content, hash: 'read-hash' }] }) });
    await mount(); await click(container.querySelector<HTMLButtonElement>('.src-h')!); await click(findButton('更新并复核'));
    expect(api.command).toHaveBeenCalledWith('draft', 7, 'update-source', { sourceId: 'S2' });
    const row = container.querySelector('.src-h')!;
    expect(row.textContent).toContain('2026-11-13'); expect(row.textContent).not.toContain('尚未读取');
    const excerpts = container.querySelector('.writing-source-excerpts')!;
    expect(excerpts.textContent).toContain('仅限部门内部交接。'); expect(excerpts.textContent).toContain('离岗前3个工作日提交。');
    expect(excerpts.textContent).not.toContain('尚未读取'); expect(excerpts.querySelectorAll('.ex')).toHaveLength(2);
    expect(api.generate).not.toHaveBeenCalled();
  });
  it('保留来源选择切至预览时不把pending弹层显示成空白原文', async () => {
    await mount(); await click(container.querySelector<HTMLButtonElement>('.src-h')!); await click(findButton('检查正文与发布预览'));
    const dialog = container.querySelector('[aria-label="来源原文"]')!;
    expect(dialog.textContent).toContain('尚未读取'); expect(dialog.textContent).toContain('更新并复核');
    expect(dialog.textContent).not.toContain('生成后');
  });
});
