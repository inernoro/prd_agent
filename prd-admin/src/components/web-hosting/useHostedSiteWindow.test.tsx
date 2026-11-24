// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createShareLink } from '@/services/real/webPages';
import { toast } from '@/lib/toast';
import { useHostedSiteWindow } from './useHostedSiteWindow';

vi.mock('@/services/real/webPages', () => ({ createShareLink: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

async function withOpener(run: (click: () => Promise<void>, tab: { opener: unknown; document: { title: string; body: { textContent: string } }; location: { replace: ReturnType<typeof vi.fn> }; close: ReturnType<typeof vi.fn> }) => Promise<void>, revisionId?: string) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div'); const root = createRoot(element);
  const tab = { opener: window as unknown, document: { title: '', body: { textContent: '' } }, location: { replace: vi.fn() }, close: vi.fn() };
  vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
  let open!: (id: string, revisionId?: string) => Promise<void>;
  function Probe() { open = useHostedSiteWindow().open; return null; }
  await act(async () => root.render(<Probe />));
  try { await run(() => act(async () => open('document-id', revisionId)), tab); }
  finally { await act(async () => root.unmount()); }
}

it('用户点击时先打开窗口，复用访问便捷链，只进入 /s/ 阅读页', async () => {
  vi.mocked(createShareLink).mockResolvedValue({ success: true, data: { shareUrl: '/s/wp/existing-visit' }, error: null } as never);
  await withOpener(async (click, tab) => {
    await click();
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(createShareLink).toHaveBeenCalledWith({ siteId: 'document-id', shareType: 'single', expiresInDays: 0, purpose: 'visit' });
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).toHaveBeenCalledOnce();
    expect(tab.location.replace).toHaveBeenCalledWith('/s/wp/existing-visit');
    expect(tab.close).not.toHaveBeenCalled();
  });
});

it('内联历史快照在新窗口继续查看所选版本，不退回最新版或裸文件', async () => {
  vi.mocked(createShareLink).mockResolvedValue({ success: true, data: { shareUrl: '/s/wp/existing-visit' }, error: null } as never);
  await withOpener(async (click, tab) => {
    await click();
    expect(tab.location.replace).toHaveBeenCalledWith('/s/wp/existing-visit?review=revision-7');
  }, 'revision-7');
});

it('历史版本无分享权限时保留当前小窗，明确失败而非悄悄打开最新版', async () => {
  vi.mocked(createShareLink).mockResolvedValue({ success: false, data: null, error: { code: 'PERMISSION_DENIED' } } as never);
  await withOpener(async (click, tab) => {
    await click(); expect(tab.close).toHaveBeenCalledOnce(); expect(tab.location.replace).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('未能打开历史版本', '请在当前预览窗口继续查看此版本。');
  }, 'revision-7');
});

it('获取失败时关闭等待窗口并提示，不退回资产列表或 COS', async () => {
  vi.mocked(createShareLink).mockResolvedValue({ success: false, data: null, error: { message: '没有访问权限' } } as never);
  await withOpener(async (click, tab) => {
    await click(); expect(tab.close).toHaveBeenCalledOnce(); expect(tab.location.replace).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('未能打开阅读页', '没有访问权限');
  });
});

it('无分享权限的团队只读成员继续使用鉴权阅读入口，不关闭窗口或放宽权限', async () => {
  vi.mocked(createShareLink).mockResolvedValue({ success: false, data: null, error: { code: 'PERMISSION_DENIED', message: '无分享权限' } } as never);
  await withOpener(async (click, tab) => {
    await click();
    expect(tab.location.replace).toHaveBeenCalledWith('/web-pages?openSite=document-id');
    expect(tab.close).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

it('弹窗被拦截时不创建访问链，网络错误不向用户泄露技术异常', async () => {
  await withOpener(async (click, tab) => {
    vi.mocked(window.open).mockReturnValueOnce(null);
    await click(); expect(createShareLink).not.toHaveBeenCalled();
    vi.mocked(createShareLink).mockRejectedValue(new Error('internal transport detail'));
    await click(); expect(tab.location.replace).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenLastCalledWith('未能打开阅读页', '请检查网络后重试。');
  });
});
