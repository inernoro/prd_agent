// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionShell } from '../CollectionShell';
import { HostedCollectionDocument } from '../HostedCollectionDocument';

const calls = vi.hoisted(() => ({ review: vi.fn(), comments: vi.fn(), clearDraft: vi.fn(), setEnabled: vi.fn() }));
vi.mock('../../document-store/writing/WritingThreads', () => ({ WritingThreads: () => null }));
vi.mock('@/components/web-hosting/useHostedReview', () => ({ useHostedReview: (...args: unknown[]) => {
  calls.review(...args); return { annotations: { clearDraft: calls.clearDraft, setEnabled: calls.setEnabled, notifyFrame: vi.fn(), select: vi.fn() } };
} }));
vi.mock('@/components/web-hosting/useSitePreviewHtml', () => ({ useSitePreviewHtml: () => ({ srcDoc: '<h1>真实文档</h1>' }) }));
vi.mock('@/components/web-hosting/useHostedAnnotations', () => ({ withAnnotationRuntime: (html: string) => html }));
vi.mock('@/components/web-hosting/ReviewToolbarControls', () => ({ ReviewToolbarControls: ({ onOpen, expanded }: { onOpen: () => void; expanded: boolean }) => <button aria-label="批注与讨论" aria-expanded={expanded} onClick={onOpen}>批注</button> }));
vi.mock('@/components/web-hosting/CommentsSection', () => ({ default: (props: { threadKind: string; mode: string; token?: string; password?: string }) => {
  calls.comments(props); return <p data-thread-kind={props.threadKind}>{props.threadKind === 'annotation' ? '已有批注正文' : '已有讨论正文'}</p>;
} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const collection = { id: 'c', name: '评审合集', description: '', siteIds: ['a', 'b'], mainSiteId: 'a', sections: [], version: 1 };
const items = [{ id: 'a', title: '主文档', siteUrl: '/asset.html', canEdit: true, canShare: true, memberships: [{ id: 'other', name: '另一合集' }] }, { id: 'b', title: '下一份资料', canEdit: false, canShare: false }];
let root: Root, container: HTMLDivElement;
async function mount(children: ReactNode) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter>{children}</MemoryRouter>));
}
async function click(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector); expect(button, selector).toBeTruthy();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); vi.unstubAllGlobals(); });

describe('手机合集控件必须通向可用内容', () => {
  it('作者从移动操作菜单进入现有管理或分享，选择后菜单关闭', async () => {
    const manage = vi.fn(); await mount(<CollectionShell name="评审合集" shareHref="/web-pages/collections/c/share" onManage={manage}>目录</CollectionShell>);
    await click('.hc-mobile-top [aria-label="合集操作"]');
    expect(container.querySelector('.hc-mobile-action-list a')?.getAttribute('href')).toBe('/web-pages/collections/c/share');
    await click('.hc-mobile-action-list button'); expect(manage).toHaveBeenCalledOnce();
    expect(container.querySelector('.hc-mobile-action-list')).toBeNull();
  });
  it('没有管理能力的访客不渲染作者移动操作入口', async () => {
    await mount(<CollectionShell name="评审合集">目录</CollectionShell>);
    expect(container.querySelector('.hc-mobile-top [aria-label="合集操作"]')).toBeNull();
    expect(container.querySelector('.hc-mobile-action-list')).toBeNull();
  });
  it('分享页加载时返回阅读仍指向当前合集，不抢先返回合集列表', async () => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={['/web-pages/collections/c/share']}><Routes><Route path="/web-pages/collections/:collectionId/share" element={<CollectionShell mode="share" name="合集">正在核对分享权限</CollectionShell>} /></Routes></MemoryRouter>));
    expect(container.querySelector('.hc-mobile-top [aria-label="返回阅读页"]')?.getAttribute('href')).toBe('/web-pages/collections/c');
  });
  it('批注展开成可关闭的移动对话框，讨论和关联使用同一个真实内容区域', async () => {
    await mount(<HostedCollectionDocument item={items[0]} items={items} collection={collection} onBack={vi.fn()} onNavigate={vi.fn()} />);
    await click('[aria-label="批注与讨论"]');
    const panel = container.querySelector('[role="dialog"][aria-label="合集阅读面板"]');
    expect(panel).toBeTruthy(); expect(panel?.classList.contains('hc-mobile-panel-open')).toBe(true);
    expect(panel?.textContent).toContain('已有批注正文');
    await click('[role="tab"]:nth-child(2)'); expect(panel?.textContent).toContain('已有讨论正文');
    expect(calls.clearDraft).toHaveBeenCalled(); expect(calls.setEnabled).toHaveBeenCalledWith(false);
    await click('[role="tab"]:nth-child(3)'); expect(panel?.textContent).toContain('另一合集');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[aria-label="批注与讨论"]')?.getAttribute('aria-expanded')).toBe('false');
  });
  it('匿名分享阅读面板沿用token与密码，下一篇工具保持实际文档顺序', async () => {
    const navigate = vi.fn();
    await mount(<HostedCollectionDocument item={items[0]} items={items} collection={collection} token="share-token" password="share-password" onBack={vi.fn()} onNavigate={navigate} />);
    await click('.hc-mobile-read-tools [data-tool="notes"]');
    expect(container.querySelector('[role="dialog"] [data-thread-kind="annotation"]')).toBeTruthy();
    expect(calls.comments).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'share', token: 'share-token', password: 'share-password', siteId: 'a' }));
    await click('[aria-label="关闭阅读面板"]');
    await click('.hc-mobile-read-tools [data-tool="next"]'); expect(navigate).toHaveBeenCalledWith('b');
    expect(calls.review).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ mode: 'share', token: 'share-token', password: 'share-password', siteId: 'a' }), expect.any(Function));
  });
});
