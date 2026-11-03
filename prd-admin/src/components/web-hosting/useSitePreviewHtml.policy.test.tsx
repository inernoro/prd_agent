// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSiteContent, type HostedSite } from '@/services/real/webPages';
import { ok } from '@/types/api';
import { __resetSitePreviewHtmlCache, useSitePreviewHtml, type SitePreviewHtmlSite } from './useSitePreviewHtml';
import SitePreviewModal from './SitePreviewModal';

vi.mock('@/services/real/webPages', () => ({ getSiteContent: vi.fn(), getSiteAskConfig: vi.fn(), setSiteCommentsEnabled: vi.fn() }));
vi.mock('./useHostedPdfDownload', async () => {
  const { useRef } = await import('react');
  return { useHostedPdfDownload: () => ({ iframeRef: useRef(null), notifyFrame: vi.fn(), decorateHtml: (html: string) => html }), HostedPdfDownloadStatus: () => null };
});
vi.mock('./CommentsSection', () => ({ default: () => null }));
vi.mock('./ask/AskPanelInline', () => ({ default: () => null }));
vi.mock('./ask/AskConfigDrawer', () => ({ default: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null, MapSectionLoader: () => null }));
const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
let observed: ReturnType<typeof useSitePreviewHtml>;
const site: SitePreviewHtmlSite = { id: 'test', siteUrl: 'https://storage.example/test/index.html', entryFile: 'index.html' };
const content = (html: string) => ({ siteId: site.id, title: '测试站点', contentType: 'text/html', html });

function Probe({ value }: { value: SitePreviewHtmlSite }) {
  observed = useSitePreviewHtml(value, true);
  return null;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  __resetSitePreviewHtmlCache();
  vi.mocked(getSiteContent).mockReset();
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); });

it('多文件站不请求正文，也不产生正文错误或等待状态', async () => {
  await act(async () => root.render(<Probe value={{ ...site, contentShape: 'multi-file' }} />));
  expect(getSiteContent).not.toHaveBeenCalled();
  expect(observed).toEqual({ srcDoc: null, error: null, loading: false });
});

it('相同 URL 的站点类型变化不会复用旧正文，迟到响应不能覆盖当前策略', async () => {
  let finish!: (value: Awaited<ReturnType<typeof getSiteContent>>) => void;
  vi.mocked(getSiteContent).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<Probe value={{ ...site, contentShape: 'self-contained-html' }} />));
  expect(getSiteContent).toHaveBeenCalledOnce();
  await act(async () => root.render(<Probe value={{ ...site, contentShape: 'multi-file' }} />));
  await act(async () => finish(ok(content('<html><head></head><body>旧正文</body></html>'))));
  expect(observed).toEqual({ srcDoc: null, error: null, loading: false });
});

it('旧站点仍能取回正文并注入原资源基址', async () => {
  vi.mocked(getSiteContent).mockResolvedValue(ok(content('<html><head></head><body>旧站点</body></html>')));
  await act(async () => root.render(<Probe value={site} />));
  expect(observed.srcDoc).toContain('<base href="https://storage.example/test/">');
  expect(observed.srcDoc).toContain('旧站点');
});

it('原地址弹窗结束等待时保留同一个 iframe，发布新地址仍能更新文档', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  const hosted = { ...site, contentShape: 'multi-file', title: '原地址预览', askEnabled: false } as HostedSite;
  try {
    await act(async () => root.render(<SitePreviewModal site={hosted} onClose={() => {}} />));
    const frame = document.querySelector('iframe')!;
    expect(frame.src).toBe(hosted.siteUrl);
    expect(getSiteContent).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1499));
    expect(document.querySelector('iframe')).toBe(frame);
    await act(async () => vi.advanceTimersByTime(1));
    expect(document.querySelector('iframe')).toBe(frame);
    expect(frame.isConnected).toBe(true);

    const next = { ...hosted, siteUrl: `${hosted.siteUrl}?v=2` };
    await act(async () => root.render(<SitePreviewModal site={next} onClose={() => {}} />));
    expect(frame.src).toBe(next.siteUrl);
    await act(async () => vi.advanceTimersByTime(1600));
    expect(document.querySelector('iframe')).toBe(frame);
    expect(frame.src).toBe(next.siteUrl);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
