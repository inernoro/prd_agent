// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SharePageActions, SharePageTitle } from './SharePageControls';
import { updateSite, type SharedSiteInfo } from '@/services/real/webPages';

vi.mock('@/services/real/webPages', () => ({ updateSite: vi.fn() }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ open, content, actions }: { open: boolean; content: React.ReactNode; actions: React.ReactNode }) => open ? <div role="dialog">{content}{actions}</div> : null }));
const site = { id: 'site-a', title: '原标题', viewerIsOwner: true, viewerCanEdit: true } as SharedSiteInfo;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('阅读页作者操作', () => {
  it('作者才能看见改名和设置；协作者可以返回定位', () => {
    act(() => root.render(<MemoryRouter><SharePageTitle site={{ ...site, viewerIsOwner: false }} onRenamed={vi.fn()} /><SharePageActions site={{ ...site, viewerIsOwner: false }} compact={false} onSettingsSaved={vi.fn()} /></MemoryRouter>));
    expect(container.querySelector('[aria-label="修改标题"]')).toBeNull();
    expect(container.querySelector('[aria-label="设置"]')).toBeNull();
    expect(container.querySelector('[aria-label="返回网页托管"]')).not.toBeNull();
  });
  it('保存标题只发送元信息更新，不创建新分享', async () => {
    const renamed = vi.fn();
    vi.mocked(updateSite).mockResolvedValue({ success: true, error: null, data: { ...site, title: '新标题' } } as unknown as Awaited<ReturnType<typeof updateSite>>);
    act(() => root.render(<SharePageTitle site={site} onRenamed={renamed} />));
    act(() => (container.querySelector('[aria-label="修改标题"]') as HTMLButtonElement).click());
    act(() => {
      const input = container.querySelector('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '新标题');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(updateSite).toHaveBeenCalledWith('site-a', { title: '新标题' });
    expect(renamed).toHaveBeenCalledWith('新标题');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('返回使用明确列表地址并携带网页定位参数', () => {
    function Location() { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; }
    act(() => root.render(<MemoryRouter initialEntries={['/s/wp/token']}><SharePageActions site={site} compact onSettingsSaved={vi.fn()} /><Location /></MemoryRouter>));
    act(() => (container.querySelector('[aria-label="返回网页托管"]') as HTMLButtonElement).click());
    expect(container.querySelector('output')?.textContent).toBe('/web-pages?focusSite=site-a');
  });
});
