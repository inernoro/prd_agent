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
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  Element.prototype.scrollIntoView = vi.fn();
  api.context.mockResolvedValue({ success: true, data: context }); api.get.mockResolvedValue({ success: true, data: documentFor(state()) });
  api.save.mockResolvedValue({ success: true, data: documentFor({ ...state(), revision: 7 }) });
});

describe('补充确认的真实上下文', () => {
  function pendingState(): WritingState {
    const value = state();
    value.summary = '先移交、后签收，回收条件必须确认。';
    value.sources = ['S1', 'S2'].map((id, i) => ({ ...source, id, entryId: id, status: 'read', title: id, content: i ? '离岗当天回收全部权限。' : '提前三天完成权限移交。', hash: id }));
    value.sections = [
      { id: 's1', title: '范围', paragraphs: [{ id: 'p1', text: '确认适用范围', status: 'ask', citations: ['S1'], quotes: { S1: '提前三天完成权限移交。' }, confirmed: false }] },
      { id: 's2', title: '权限', paragraphs: [{ id: 'p2', text: '确认冲突', status: 'conf', citations: ['S1', 'S2'], quotes: { S1: '提前三天完成权限移交。', S2: '离岗当天回收全部权限。' }, confirmed: false }] },
    ];
    value.questions = [
      { id: 'q1', kind: 'ask', paragraphId: 'p1', sectionTitle: '范围', title: '范围是什么？', why: '资料缺少范围', citations: ['S1'], options: ['只限内部'], status: 'pending', answer: '' },
      { id: 'q2', kind: 'conf', paragraphId: 'p2', sectionTitle: '权限', title: '采用哪份权限规则？', why: '两份规定不同', citations: ['S1', 'S2'], options: ['保留两项条件'], status: 'pending', answer: '' },
    ];
    return value;
  }
  it('缺省evidence时仍定位真实摘录，选项不连写两遍，上一项同步正文', async () => {
    api.get.mockResolvedValue({ success: true, data: documentFor(pendingState()) });
    await mount();
    expect(container.querySelectorAll('.writing-conflict-body .side')).toHaveLength(2);
    expect(container.querySelector('.writing-conflict-body')?.textContent).toContain('离岗当天回收全部权限。');
    await click(findButton('选择采用哪一条'));
    expect(container.querySelector('.writing-source-excerpts .ex.on')?.textContent).toBe('提前三天完成权限移交。');
    expect(container.querySelector('.pa.focus')?.getAttribute('data-paragraph-id')).toBe('p2');
    expect(container.querySelector('.writing-question-options .opt')?.textContent).toBe('保留两项条件');
    await click(findButton('上一项'));
    expect(container.querySelector('.pa.focus')?.getAttribute('data-paragraph-id')).toBe('p1');
    expect(container.querySelector('#writing-question-title')?.textContent).toBe('范围是什么？');
  });
  it('回答后切下一题；刷新恢复题目、来源及高亮引用', async () => {
    const value = pendingState();
    api.get.mockResolvedValue({ success: true, data: documentFor(value) });
    api.save.mockResolvedValue({ success: true, data: documentFor(value) });
    const next = structuredClone(value); next.questions[0].status = 'answered'; next.questions[0].answer = '只限内部'; next.revision++;
    api.command.mockResolvedValue({ success: true, data: documentFor(next) });
    await mount(); await click(findButton('补充'));
    await click(container.querySelector<HTMLButtonElement>('.writing-question-options .opt')!);
    await click(container.querySelector<HTMLButtonElement>('.writing-question-footer .pri')!);
    expect(container.querySelector('#writing-question-title')?.textContent).toBe('采用哪份权限规则？');
    expect(container.querySelector('.pa.focus')?.getAttribute('data-paragraph-id')).toBe('p2');
    expect(JSON.parse(localStorage.getItem('map-writing-ui:actor:draft')!)).toMatchObject({ questionId: 'q2', sourceId: 'S1', sourceQuote: '提前三天完成权限移交。' });
    await act(async () => root.unmount()); container.remove();
    api.get.mockResolvedValue({ success: true, data: documentFor(next) }); await mount();
    expect(container.querySelector('#writing-question-title')?.textContent).toBe('采用哪份权限规则？');
    expect(container.querySelector('.writing-source-excerpts .ex.on')?.textContent).toBe('提前三天完成权限移交。');
  });
  it('手机关闭问题面板后保留正文滚动位置和入口焦点', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    api.get.mockResolvedValue({ success: true, data: documentFor(pendingState()) }); await mount();
    const main = container.querySelector<HTMLElement>('.writing-author-main')!;
    main.scrollTop = 420;
    const trigger = findButton('选择采用哪一条');
    await click(trigger);
    main.scrollTop = 80;
    await click(container.querySelector<HTMLButtonElement>('[aria-label="关闭补充面板（Esc）"]')!);
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(main.scrollTop).toBe(420);
    expect(document.activeElement).toBe(trigger);
  });
  it('摘要不冒充已有引用，标记可独立开关多类', async () => {
    api.get.mockResolvedValue({ success: true, data: documentFor(pendingState()) }); await mount();
    expect(container.querySelector('.writing-draft-summary')?.textContent).toContain('先移交、后签收');
    expect(container.querySelector('.writing-draft-summary')?.textContent).not.toContain('来源已支持');
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('.writing-legend .lg')];
    await click(buttons[0]); await click(buttons[1]);
    expect(buttons.map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'true']);
    expect(container.querySelector('.pa.ask')?.classList.contains('dim')).toBe(false);
  });
});
describe('作者确认后的表达与补缺整理', () => {
  it('提交审核被未核对必达点阻止时，指出对应项与恢复步骤并保留草稿', async () => {
    const value = state(); value.stage = 'review';
    value.sections[0].paragraphs[0].confirmed = true;
    value.intentPoints = ['先保留原目录', '失败立即停止', '例外需要明确批准'];
    value.intentCoverage = [
      { intentIndex: 0, paragraphIds: ['paragraph'], confirmed: false },
      { intentIndex: 1, paragraphIds: ['paragraph'], confirmed: true },
      { intentIndex: 2, paragraphIds: ['paragraph'], confirmed: false },
    ];
    api.get.mockResolvedValue({ success: true, data: documentFor(value) });
    api.save.mockResolvedValue({ success: true, data: documentFor({ ...value, revision: 7 }) });
    api.command.mockResolvedValue({ success: false, error: { code: 'INVALID_FORMAT', message: '操作未完成，请检查输入后重试。' } });
    await mount(); await click(findButton('提交审核'));
    const message = container.querySelector('[role="alert"]')?.textContent;
    expect(message).toContain('第1、3项作者必达点尚未核对');
    expect(message).toContain('请在「作者必达点」逐项确认对应正文及条件、例外后重试');
    expect(api.command).toHaveBeenCalledWith('draft', 7, 'review', {});
    expect(container.querySelector('.stp [aria-current="step"]')?.textContent).toContain('审核发布');
    expect(findButton('提交审核').disabled).toBe(false);
    expect(value.intentCoverage.map(c => c.confirmed)).toEqual([false, true, false]);
    expect(api.command).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'confirm-intent', expect.anything());
  });
  it('上下文模版更新后仍使用文档冻结的章节与提示', async () => {
    const value = state(); value.stage = 'select'; value.templateSnapshot = { ...context.templates[0], name: '发布时交接模版', version: '0.8', headings: [{ title: '冻结的停止条件', hint: '禁止重复提交' }] };
    const changed = { ...context, templates: [{ ...context.templates[0], version: '2.0', headings: [{ title: '当前模版新章节', hint: '' }] }] };
    api.context.mockResolvedValue({ success: true, data: changed });
    api.get.mockResolvedValue({ success: true, data: documentFor(value) });
    await mount();
    expect(container.querySelector('.writing-headings')?.textContent).toContain('冻结的停止条件');
    expect(container.querySelector('.writing-headings')?.textContent).not.toContain('当前模版新章节');
  });
  it('补缺后的预览自动整理派生表达，不让作者手工重写摘要与角色', async () => {
    const value = state(); value.derivedContentStale = true; value.summary = '整理前摘要';
    api.get.mockResolvedValue({ success: true, data: documentFor(value) });
    api.save.mockResolvedValue({ success: true, data: documentFor({ ...value, revision: 7 }) });
    api.generate.mockResolvedValue({ success: true, data: { state: { ...value, stage: 'generating', revision: 8 }, runId: 'reconcile-run' } });
    await mount();
    await click(findButton('检查正文与发布预览'));
    expect(api.generate).toHaveBeenCalledWith('draft', 7, 'reconcile');
    expect(api.command).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'review', expect.anything());
  });
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
