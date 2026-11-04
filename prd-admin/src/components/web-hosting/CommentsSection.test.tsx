// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CommentsSection from './CommentsSection';
import type { HostedAnnotations } from './useHostedAnnotations';
import type { HostedReview } from './useHostedReview';

const { auth, list, login, select } = vi.hoisted(() => ({
  auth: { isAuthenticated: false, token: '' }, list: vi.fn(), login: vi.fn(), select: vi.fn(),
}));
vi.mock('../../stores/authStore', () => ({ useAuthStore: (selector: (state: typeof auth) => unknown) => selector(auth) }));
vi.mock('../../services/real/webPages', () => ({ listShareComments: list, listSiteComments: list,
  addShareComment: vi.fn(), addSiteComment: vi.fn(), deleteSiteComment: vi.fn(), setSiteCommentResolved: vi.fn() }));
vi.mock('../ui/VideoLoader', () => ({ MapSpinner: () => null, MapSectionLoader: () => <p>正在加载讨论…</p> }));
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
  });
});
