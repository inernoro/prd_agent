// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WritingReaderPage } from '../WritingReaderPage';
import type { WritingReader } from '@/services/contracts/writing';
const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/services/real/writing', () => ({ readWriting: api.read }));
vi.mock('@/services/real/documentStore', () => ({ getDocumentContent: vi.fn() }));
vi.mock('../WritingThreads', () => ({ WritingThreads: () => null }));
vi.mock('../WritingWorkspacePage', () => ({ WritingThemeButton: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('@/components/file-preview/MarkdownViewer', () => ({ MarkdownViewer: ({ content }: { content: string }) => <p>{content}</p> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement;
const scroll = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class { observe() {} disconnect() {} } });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  Object.defineProperty(globalThis, 'CSS', { configurable: true, value: { escape: (value: string) => value } });
  const data: WritingReader = { entryId: 'entry', store: { id: 'store', name: '独立库' } as WritingReader['store'], affectedSources: [], entries: [{ id: 'entry', title: '发布说明' }], canEdit: false, publication: { version: 2, title: '发布说明', summary: '', templateId: 'prd', templateVersion: '1', authorName: '作者', reviewerName: '审核', publishedAt: '2026-11-13', conclusions: [], scopeIn: '', scopeOut: '', sources: [], openQuestions: [], chapters: [], sections: [{ id: 's1', title: '功能说明', paragraphs: [] }, { id: 's2', title: '验收标准', paragraphs: [] }], roles: ['交接人', '接手人', '直属主管', '培训学员'].map((label, i) => ({ label, action: `行动${i}`, condition: `条件${i}`, sectionId: i % 2 ? 's2' : 's1', orderedSectionIds: ['s1', 's2'] })) } };
  api.read.mockResolvedValue({ success: true, data });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });
it('当前角色的阅读路径和折叠目录定位真实正文，并更新已读计数', async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><WritingReaderPage storeId="store" entryId="entry" tutorial={false} /></MemoryRouter>));
  const jump = container.querySelector<HTMLButtonElement>('.writing-focused-actions .ord'); expect(jump).toBeTruthy();
  await act(async () => jump!.click()); expect(scroll).toHaveBeenCalled();
  const menu = container.querySelector<HTMLButtonElement>('.writing-mobile-toc > button'); expect(menu).toBeTruthy();
  expect(menu!.textContent).toContain('已读 1 / 2 节');
  await act(async () => menu!.click()); const link = container.querySelector<HTMLButtonElement>('[data-section-link="s2"]')!;
  await act(async () => link.click()); expect(menu!.getAttribute('aria-expanded')).toBe('false');
  expect(menu!.textContent).toContain('已读 2 / 2 节'); expect(scroll).toHaveBeenCalledTimes(2);
  const radios = container.querySelectorAll<HTMLButtonElement>('[role=radio]'); await act(async () => radios[2].click());
  expect(container.querySelector('.writing-focused-actions>.act')?.textContent).toContain('行动2');
  expect(container.querySelector('.writing-focused-actions>.act')?.textContent).toContain('条件2');
  expect(container.querySelector('.writing-other-roles')?.hasAttribute('open')).toBe(false);
  expect(container.querySelectorAll('.act')).toHaveLength(4);
});

it('首要行动不混入其他角色，完整条件和所有角色仍可展开核对', async () => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><WritingReaderPage storeId="store" entryId="entry" tutorial={false} /></MemoryRouter>));
  const primary = container.querySelector('.writing-focused-actions>.act')!;
  expect(primary.textContent).toContain('行动0'); expect(primary.textContent).toContain('条件0');
  expect(primary.textContent).not.toContain('行动1');
  const scope = container.querySelector('.writing-focused-actions>.writing-scope-grid')!;
  const path = container.querySelector('.writing-focused-actions .ord')!;
  expect(scope.compareDocumentPosition(path) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(scope.textContent).toContain('适用'); expect(scope.textContent).toContain('不适用');
  const conclusions = container.querySelector('.writing-reader-takeaways')!;
  expect(primary.compareDocumentPosition(conclusions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const others = container.querySelector<HTMLDetailsElement>('.writing-other-roles')!;
  expect(others.open).toBe(false);
  await act(async () => others.querySelector('summary')!.click());
  expect(others.open).toBe(true);
  for (const i of [1, 2, 3]) { expect(others.textContent).toContain(`行动${i}`); expect(others.textContent).toContain(`条件${i}`); }
});
it('首部来源入口可直接到达来源记录，跳过状态保留且可返回阅读', async () => {
  const response = await api.read();
  response.data.publication.sources = [{ id: 'S1', entryId: 's', title: '制度原文', status: 'read', content: '执行前先审核', hash: 'hash', updatedAt: '2026-11-13' }, { id: 'S2', entryId: 'skip', title: '未采用资料', status: 'skipped', content: '', hash: '', updatedAt: '' }];
  api.read.mockResolvedValue(response);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><WritingReaderPage storeId="store" entryId="entry" tutorial={false} /></MemoryRouter>));
  const shortcut = container.querySelector<HTMLButtonElement>('.writing-source-shortcut')!;
  expect(shortcut.textContent).toContain('1 份');
  await act(async () => shortcut.click());
  expect(document.activeElement?.getAttribute('aria-label')).toBe('文档来源');
  expect(document.activeElement?.textContent).toContain('已跳过 · 未参与本次生成');
  await act(async () => container.querySelector<HTMLButtonElement>('.writing-return-reading')!.click());
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(shortcut);
});
