// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommentsSection from './CommentsSection';
import type { HostedAnnotations } from './useHostedAnnotations';
import type { HostedReview } from './useHostedReview';

const { auth, list, login, select, add, resolveComment } = vi.hoisted(() => ({
  auth: { isAuthenticated: false, token: '' }, list: vi.fn(), login: vi.fn(), select: vi.fn(), add: vi.fn(), resolveComment: vi.fn(),
}));
vi.mock('../../stores/authStore', () => ({ useAuthStore: Object.assign((selector: (state: typeof auth) => unknown) => selector(auth), { getState: () => auth }) }));
vi.mock('../../services/real/webPages', () => ({ listShareComments: list, listSiteComments: list,
  addShareComment: add, addSiteComment: add, deleteSiteComment: vi.fn(), setSiteCommentResolved: resolveComment }));
vi.mock('../ui/VideoLoader', () => ({ MapSpinner: () => null, MapSectionLoader: ({ text }: { text?: string }) => <p>{text ?? '正在加载讨论…'}</p> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement;
const annotations = (): HostedAnnotations => ({ ready: true, enabled: false, connectionChecked: true, displayMode: 'bubble', setDisplayMode: vi.fn(),
  preview: null, dismissPreview: vi.fn(), openThread: vi.fn(),
  draftAnchor: null, activeId: null, missingIds: [], threads: [], select, clearDraft: vi.fn(), focus: vi.fn(),
  notifyFrame: vi.fn(), setThreads: vi.fn(), setEnabled: vi.fn(), setActiveId: vi.fn() });
async function mount(options: { ready?: boolean; review?: HostedReview } = {}) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<CommentsSection mode="share" token="share" onLogin={login}
    annotations={{ ...annotations(), ready: options.ready ?? true }} review={options.review} />));
}
function button(text: string) {
  const match = [...container.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') ?? element.textContent) === text);
  expect(match, `button ${text}`).toBeTruthy();
  return match!;
}
beforeEach(() => {
  vi.clearAllMocks(); auth.isAuthenticated = false; auth.token = '';
  list.mockResolvedValue({ success: true, data: { comments: [], commentsEnabled: true, canComment: false } });
});
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('annotation entry availability', () => {
  it('合集批注和讨论按真实锚点分开，计数排除回复和其他版本', async () => {
    auth.isAuthenticated = true; auth.token = 'session';
    const anchor = { kind: 'text' as const, pagePath: '/', selector: 'p', tagName: 'p', text: '原文', elementText: '原文', prefix: '', suffix: '', contentVersion: 'current' };
    const common = { siteId: 'member', authorName: '作者', createdAt: '2026-11-12T00:00:00Z', canDelete: false };
    list.mockResolvedValue({ success: true, data: { commentsEnabled: true, canComment: true, comments: [
      { ...common, id: 'note', content: '当前版批注', contentVersion: 'current', anchor },
      { ...common, id: 'talk', content: '当前版讨论', contentVersion: 'current' },
      { ...common, id: 'reply', content: '回复内容', contentVersion: 'current', parentId: 'note' },
      { ...common, id: 'old', content: '旧版批注', contentVersion: 'old', anchor },
    ] } });
    const counts = vi.fn();
    const review = { selected: { id: 'v1', versionLabel: 'V1', contentVersionKey: 'current' }, loading: false, versions: [] } as unknown as HostedReview;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    const render = (threadKind: 'annotation' | 'discussion') => root.render(<CommentsSection mode="share" token="collection" siteId="member" threadKind={threadKind} onThreadCountsChange={counts} review={review} annotations={annotations()} />);
    await act(async () => render('annotation'));
    expect(container.querySelectorAll('.review-thread')).toHaveLength(1);
    expect(container.querySelector('.review-thread')?.textContent).toContain('当前版批注');
    expect(counts).toHaveBeenLastCalledWith({ annotations: 1, discussions: 1 });
    await act(async () => button('回复 1').click());
    expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('回复内容');
    await act(async () => render('discussion'));
    expect(container.querySelectorAll('.review-thread')).toHaveLength(1);
    expect(container.querySelector('.review-thread')?.textContent).toContain('当前版讨论');
    expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('讨论内容');
    expect(container.querySelector('[aria-label="绑定页面元素 / 选中文字"]')).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });
  it('整页讨论不会带入其他批注尚未提交的位置', async () => {
    auth.isAuthenticated = true; auth.token = 'session';
    list.mockResolvedValue({ success: true, data: { comments: [], commentsEnabled: true, canComment: true } });
    const pending = { ...annotations(), draftAnchor: { kind: 'text' as const, pagePath: '/', selector: 'p', tagName: 'p', text: '位置', elementText: '位置', prefix: '', suffix: '', contentVersion: 'current' } };
    add.mockResolvedValue({ success: true, data: { id: 'talk', siteId: 'member', content: '整页看法', authorName: '作者', createdAt: '2026-11-12T00:00:00Z' } });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<CommentsSection mode="share" token="collection" password="original-password" siteId="member" threadKind="discussion" annotations={pending} />));
    await act(async () => { const field = container.querySelector('textarea')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '整页看法'); field.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('发送讨论').click());
    expect(add).toHaveBeenCalledWith('collection', '整页看法', 'original-password', expect.objectContaining({ siteId: 'member', anchor: undefined }));
    expect(pending.clearDraft).not.toHaveBeenCalled();
  });
  it('合集第二份文档解决和重新打开讨论都携带当前文档及密码', async () => {
    auth.isAuthenticated = true; auth.token = 'session';
    const comment = { id: 'thread-b', siteId: 'document-b', authorName: '作者', content: '第二份讨论',
      createdAt: new Date().toISOString(), canResolve: true, isResolved: false };
    list.mockResolvedValue({ success: true, data: { comments: [comment], commentsEnabled: true, canComment: true } });
    resolveComment.mockResolvedValueOnce({ success: true, data: { ...comment, isResolved: true } });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<CommentsSection mode="share" token="collection" password="pw" siteId="document-b" />));
    await act(async () => button('标记解决').click());
    expect(resolveComment).toHaveBeenNthCalledWith(1, { token: 'collection', password: 'pw', siteId: 'document-b' }, 'thread-b', true);
    await act(async () => button('已解决 1').click());
    resolveComment.mockResolvedValueOnce({ success: true, data: comment });
    await act(async () => button('重新打开').click());
    expect(resolveComment).toHaveBeenNthCalledWith(2, { token: 'collection', password: 'pw', siteId: 'document-b' }, 'thread-b', false);
  });
  it.each(['10000', '20000'])('waits for version metadata and preserves drafts only for the same publication, next=%s', async next => {
    auth.isAuthenticated = true; auth.token = 'session';
    list.mockResolvedValue({ success: true, data: { comments: [], commentsEnabled: true, canComment: true } });
    const known = { selected: { id: 'v1', versionLabel: 'V1', contentVersionKey: '10000' }, loading: false } as HostedReview;
    const pending = { selected: undefined, loading: true } as HostedReview;
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    const render = (review: HostedReview) => root.render(<CommentsSection mode="share" token="share" review={review} annotations={annotations()} />);
    await act(async () => render(known));
    await act(async () => {
      const input = container.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '不能丢失的草稿');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => render(pending));
    expect(container.querySelector('.review-thread-scroll')?.textContent).toContain('正在确认网页版本');
    expect(container.textContent).not.toContain('无法确认网页版本');
    expect(container.textContent).not.toContain('让意见留在对应的位置');
    expect(button('绑定页面元素 / 选中文字').disabled).toBe(true);
    expect(container.querySelector('[aria-label="批注版本范围"]')?.textContent).toContain('—');
    await act(async () => render({ ...known, selected: { ...known.selected!, contentVersionKey: next } }));
    expect(container.querySelector('textarea')?.value).toBe(next === '10000' ? '不能丢失的草稿' : '');
  });
  it('offers an actionable login entry to guests even before the annotation layer connects', async () => {
    await mount({ ready: false });
    const entry = button('登录后批注');
    expect(entry.disabled).toBe(false);
    expect(container.textContent).toContain('登录后可选择网页元素或文字留下批注');
    await act(async () => entry.click());
    expect(login).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')).toBeNull();
  });
  it('explains when the site has closed comments instead of asking the guest to log in', async () => {
    list.mockResolvedValue({ success: true, data: { comments: [], commentsEnabled: false, canComment: false } });
    await mount();
    const entry = button('绑定页面元素 / 选中文字');
    expect(entry.disabled).toBe(true);
    expect(entry.title).toBe('该站点已关闭评论与批注。');
    expect(container.textContent).not.toContain('先在网页上选择位置');
    await act(async () => entry.click());
    expect(login).not.toHaveBeenCalled();
  });
  it('starts element selection for an authenticated reviewer with a connected page', async () => {
    auth.isAuthenticated = true; auth.token = 'session';
    list.mockResolvedValue({ success: true, data: { comments: [], commentsEnabled: true, canComment: true } });
    await mount();
    const entry = button('绑定页面元素 / 选中文字');
    expect(entry.disabled).toBe(false);
    await act(async () => entry.click());
    expect(select).toHaveBeenCalledOnce();
    expect(login).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')).not.toBeNull();
  });
  it('provides a new login action when a persisted login is no longer accepted by the server', async () => {
    auth.isAuthenticated = true; auth.token = 'expired-session';
    await mount();
    const entry = button('重新登录后批注');
    expect(entry.disabled).toBe(false);
    expect(entry.title).toContain('当前登录状态无法批注');
    await act(async () => entry.click());
    expect(login).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
  });
  it('explains an unavailable annotation layer while keeping whole-page comments available', async () => {
    auth.isAuthenticated = true; auth.token = 'session';
    list.mockResolvedValue({ success: true, data: { comments: [], commentsEnabled: true, canComment: true } });
    await mount({ ready: false });
    const entry = button('绑定页面元素 / 选中文字');
    expect(entry.disabled).toBe(true);
    expect(entry.title).toContain('暂未连接批注层');
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.textContent).not.toContain('先在网页上选择位置');
  });
  it('distinguishes missing version metadata from a disconnected annotation layer', async () => {
    auth.isAuthenticated = true; auth.token = 'session';
    list.mockResolvedValue({ success: true, data: { comments: [], commentsEnabled: true, canComment: true } });
    await mount({ review: { selected: undefined, loading: false } as HostedReview });
    expect(button('绑定页面元素 / 选中文字').title).toContain('无法确认网页版本');
  });  it.each(['same', 'other', 'return'])('preserves a newer draft after an earlier submit completes, move=%s', async move => {
    auth.isAuthenticated = true; auth.token = 'session';
    list.mockResolvedValue({ success: true, data: { comments: [], commentsEnabled: true, canComment: true } });
    let finish!: (value: unknown) => void;
    add.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const firstReview = { selected: { id: 'v1', versionLabel: 'V1', contentVersionKey: '10000' }, loading: false } as HostedReview;
    const secondReview = { selected: { id: 'v2', versionLabel: 'V2', contentVersionKey: '20000' }, loading: false } as HostedReview;
    const firstAnnotations = annotations();
    const nextAnnotations = { ...annotations(), draftAnchor: { kind: 'element' as const, pagePath: '/', selector: '#new', tagName: 'P',
      text: '新版位置', elementText: '新版位置', prefix: '', suffix: '', contentVersion: move === 'other' ? '20000' : '10000' } };
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    const render = (review: HostedReview, anchor: HostedAnnotations) => root.render(<CommentsSection mode="share" token="share" review={review} annotations={anchor} />);
    await act(async () => render(firstReview, firstAnnotations));
    const write = async (text: string) => { await act(async () => {
      const input = container.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }); };
    await write('旧版提交');
    await act(async () => button('发送批注').click());
    expect(add).toHaveBeenCalledOnce();
    await act(async () => render(move === 'same' ? firstReview : secondReview, nextAnnotations));
    if (move === 'return') await act(async () => render(firstReview, nextAnnotations));
    await write('新的未发送草稿');
    await act(async () => finish({ success: true, data: { id: 'saved-old', content: '旧版提交', contentVersion: '10000', authorName: '作者' } }));
    expect(container.querySelector('textarea')?.value).toBe('新的未发送草稿');
    expect(nextAnnotations.clearDraft).not.toHaveBeenCalled();
    expect(container.textContent).toContain('新版位置');
    expect(button('发送批注').disabled).toBe(false);
  });
  it('submits an unrecorded current publication through its expected version rather than an empty revision ID', async () => {
    auth.isAuthenticated = true; auth.token = 'session';
    list.mockResolvedValue({ success: true, data: { comments: [], commentsEnabled: true, canComment: true } });
    add.mockResolvedValue({ success: true, data: { id: 'saved-current', contentVersion: '20000', content: 'current' } });
    await mount({ review: { selected: { id: '', contentVersionKey: '20000', versionLabel: 'V1' }, historical: false, loading: false } as HostedReview });
    await act(async () => {
      const input = container.querySelector('textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'current');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('发送批注').click());
    expect(add).toHaveBeenCalledWith('share', 'current', undefined, expect.objectContaining({ revisionId: undefined, expectedContentVersion: '20000' }));
  });

});
