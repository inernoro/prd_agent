// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionShell } from '../CollectionShell';
import { HostedCollectionDocument } from '../HostedCollectionDocument';

const calls = vi.hoisted(() => ({ review: vi.fn(), comments: vi.fn(), clearDraft: vi.fn(), setEnabled: vi.fn(), previewHtml: '<h1>真实文档</h1>' }));
vi.mock('../../document-store/writing/WritingThreads', () => ({ WritingThreads: () => null }));
vi.mock('@/components/web-hosting/useHostedReview', () => ({ useHostedReview: (...args: unknown[]) => {
  calls.review(...args); return { annotations: { clearDraft: calls.clearDraft, setEnabled: calls.setEnabled, notifyFrame: vi.fn(), select: vi.fn() } };
} }));
vi.mock('@/components/web-hosting/useSitePreviewHtml', () => ({ useSitePreviewHtml: () => ({ srcDoc: calls.previewHtml }) }));
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
  vi.clearAllMocks(); calls.previewHtml = '<h1>真实文档</h1>';
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
  it('手机阅读提供当前文档返回头与真实位置版本，不依赖h2摘要猜测正文标题', async () => {
    const back = vi.fn();
    await mount(<HostedCollectionDocument item={{ ...items[0], author: '作者甲', versionNumber: 7, annotationCount: 3, discussionCount: 2, headings: ['正文小节'] }} items={items} collection={collection} onBack={back} onNavigate={vi.fn()} />);
    expect(container.querySelector('.hc-mobile-doc-header')?.textContent).toContain('返回目录 · 主');
    expect(container.querySelector('.hc-doc-position')?.textContent).toContain('第 1 / 2 篇 · v7');
    expect(container.querySelector('.hc-doc-position')?.textContent).toContain('主文档');
    expect(container.querySelector('.hc-doc-mobile-meta')?.textContent).toContain('作者甲');
    expect(container.querySelector('.hc-doc-mobile-meta')?.textContent).toContain('批注 3 · 讨论 2');
    // h2摘要不代表正文没有h1；框架标题与原HTML均保留，不做误判删除。
    expect(container.querySelector('.hc-doc-paper > h1')?.textContent).toBe('主文档');
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('srcdoc')).toBe('<h1>真实文档</h1>');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    await click('.hc-mobile-doc-header [aria-label="返回目录"]'); expect(back).toHaveBeenCalledOnce();
  });
  it('组合副本仅去重与外层标题严格匹配的首h1，保留原输入及后续标题且不执行parent脚本', async () => {
    const original = '<!doctype html><html><head><script>window.__collectionScriptExecuted=true</script></head><body><h1 id="original-title" class="authored">  主文档  </h1><h1>后续标题</h1><h2>原小节</h2></body></html>';
    calls.previewHtml = original;
    await mount(<HostedCollectionDocument item={items[0]} items={items} collection={collection} onBack={vi.fn()} onNavigate={vi.fn()} />);
    const rendered = container.querySelector('iframe')!.getAttribute('srcdoc')!;
    const parsed = new DOMParser().parseFromString(rendered, 'text/html');
    expect(parsed.querySelector('#original-title')?.hasAttribute('hidden')).toBe(true);
    expect(parsed.querySelector('#original-title')?.getAttribute('aria-hidden')).toBe('true');
    expect(parsed.querySelector('#original-title')?.className).toBe('authored');
    expect(parsed.querySelectorAll('h1')[1].hasAttribute('hidden')).toBe(false);
    expect(parsed.querySelector('h2')?.textContent).toBe('原小节');
    expect(calls.previewHtml).toBe(original);
    expect((window as Window & { __collectionScriptExecuted?: boolean }).__collectionScriptExecuted).toBeUndefined();
    expect(container.querySelector('.hc-doc-paper > h1')?.textContent).toBe('主文档');
  });
  it('桌面阅读不应用手机标题去重', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    calls.previewHtml = '<h1>主文档</h1><p>原文</p>';
    await mount(<HostedCollectionDocument item={items[0]} items={items} collection={collection} onBack={vi.fn()} onNavigate={vi.fn()} />);
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toBe(calls.previewHtml);
  });
  it.each(['<h1>不同标题</h1><h1>主文档</h1>', '<h2>只有小节</h2>'])('非匹配首标题或无h1不改写正文：%s', async original => {
    calls.previewHtml = original;
    await mount(<HostedCollectionDocument item={items[0]} items={items} collection={collection} onBack={vi.fn()} onNavigate={vi.fn()} />);
    expect(container.querySelector('iframe')?.getAttribute('srcdoc')).toBe(original);
  });
  it('非主文档的紧凑header显示实际顺序，面板保留版本与独立打开入口', async () => {
    await mount(<HostedCollectionDocument item={{ ...items[1], siteUrl: '/b.html', versionNumber: 2 }} items={items} collection={collection} onBack={vi.fn()} onNavigate={vi.fn()} />);
    expect(container.querySelector('.hc-mobile-doc-header')?.textContent).toContain('返回目录 · 02');
    expect(container.querySelector('.hc-doc-position .t-m')).toBeNull();
    await click('.hc-mobile-read-tools [data-tool="notes"]');
    expect(container.querySelector('[role="dialog"] .hc-mobile-panel-controls [aria-label="批注与讨论"]')).toBeTruthy();
    expect(container.querySelector('[role="dialog"] .hc-mobile-panel-controls a')?.getAttribute('href')).toBe('/web-pages?openSite=b');
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
