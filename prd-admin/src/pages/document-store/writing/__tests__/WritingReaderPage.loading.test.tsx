// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WritingReaderPage } from '../WritingReaderPage';
import type { WritingReader } from '@/services/contracts/writing';
const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/services/real/writing', () => ({ readWriting: api.read }));
vi.mock('@/services/real/documentStore', () => ({ getDocumentContent: vi.fn() }));
vi.mock('../WritingThreads', () => ({ WritingThreads: () => null }));
vi.mock('../WritingWorkspacePage', () => ({ WritingThemeButton: () => <button>主题</button> }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('@/components/file-preview/MarkdownViewer', () => ({ MarkdownViewer: ({ content }: { content: string }) => <p>{content}</p> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function data(head = false, version = 1): WritingReader {
  return { entryId: 'entry', store: { id: 'store', name: '交接' } as WritingReader['store'], affectedSources: [], entries: [], canEdit: false, ...(head ? { bodyPending: true } : {}), publication: {
    version, title: '稳定交接说明', summary: '先核验再签收', templateId: 'prd', templateVersion: '1', authorName: '作者', reviewerName: '审核人', publishedAt: '2026-11-13T00:00:00Z', conclusions: ['缩短交接周期，保留责任边界'], scopeIn: '仅本部门', scopeOut: '跨部门暂不执行', roles: [{ label: '接手人', action: '核对负责人和资料', condition: '资料齐全才能签收', sectionId: 's1', orderedSectionIds: ['s1'] }], sources: [], openQuestions: [], chapters: [], captions: [], sections: [{ id: 's1', title: '执行交接', condition: head ? '' : '离岗前3个工作日', paragraphs: head ? [] : [{ id: 'p1', text: '已发布完整正文v' + version, status: 'auth', citations: [], confirmed: true }] }],
  } };
}
const ok = (d: WritingReader) => ({ success: true, data: d });
let root: Root, container: HTMLDivElement;
async function render(entry = 'entry', tutorial = false) { await act(async () => root.render(<MemoryRouter><WritingReaderPage storeId="store" entryId={entry} tutorial={tutorial} /></MemoryRouter>)); }
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
describe('真实发布概要先达与正文隔离', () => {
  it('正文尚未返回时结论、范围和下一步已可读，正文固定概要版本', async () => {
    let finish!: (r: unknown) => void;
    api.read.mockImplementation((_id, opts) => opts?.overview ? Promise.resolve(ok(data(true))) : new Promise(resolve => { finish = resolve; }));
    await render(); expect(container.textContent).toContain('缩短交接周期'); expect(container.textContent).toContain('仅本部门'); expect(container.textContent).toContain('核对负责人和资料');
    expect(container.textContent).toContain('正在加载正文与来源复核'); expect(container.querySelector('.writing-reader-body-state .sk')).toBeTruthy(); expect(container.querySelector<HTMLButtonElement>('.ord')?.disabled).toBe(true); expect(api.read).toHaveBeenLastCalledWith('entry', { version: 1 });
    await act(async () => finish(ok(data()))); expect(container.textContent).toContain('已发布完整正文v1'); expect(container.textContent).not.toContain('正在加载正文与来源复核');
  });
  it.each(['NETWORK_ERROR', 'DISCONNECTED'])('正文%s失败保留概要，重试只读同版正文并恢复', async code => {
    api.read.mockResolvedValueOnce(ok(data(true))).mockResolvedValueOnce({ success: false, error: { code, message: '网络中断' } }).mockResolvedValueOnce(ok(data()));
    await render(); expect(container.textContent).toContain('缩短交接周期'); expect(container.textContent).toContain('网络中断');
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent === '重试正文')!;
    expect(retry).toBeTruthy(); await act(async () => retry.click()); expect(api.read).toHaveBeenLastCalledWith('entry', { version: 1 }); expect(container.textContent).toContain('已发布完整正文v1');
  });
  it.each(['UNAUTHORIZED', 'PERMISSION_DENIED', 'NOT_FOUND', 'AUTH_SESSION_CHANGED'])('正文%s时立即清除概要', async code => {
    api.read.mockResolvedValueOnce(ok(data(true))).mockResolvedValueOnce({ success: false, error: { code, message: '已无权读取' } });
    await render(); expect(container.textContent).not.toContain('缩短交接周期'); expect(container.textContent).toContain('文档暂不可读');
  });
  it('返回另一版本不能将其正文与旧概要混合', async () => {
    api.read.mockResolvedValueOnce(ok(data(true))).mockResolvedValueOnce(ok(data(false, 2)));
    await render(); expect(container.textContent).toContain('正文版本与概要不一致'); expect(container.textContent).not.toContain('已发布完整正文v2'); expect(container.textContent).toContain('缩短交接周期');
  });
  it('换文档后旧正文迟到不会覆盖新文档', async () => {
    let finish!: (r: unknown) => void;
    api.read.mockImplementation((id, opts) => id === 'entry' ? opts?.overview ? Promise.resolve(ok(data(true))) : new Promise(resolve => { finish = resolve; }) : Promise.resolve(ok({ ...data(), publication: { ...data().publication, title: '新文档' } })));
    await render(); await render('next'); await act(async () => finish(ok(data()))); expect(container.querySelector('.writing-reader-title')?.textContent).toBe('新文档');
  });
  it('教学直接读取完整发布，不增加概要请求', async () => {
    api.read.mockResolvedValue(ok(data())); await render('entry', true); expect(api.read).toHaveBeenCalledTimes(1); expect(api.read).toHaveBeenCalledWith('entry');
  });
});
