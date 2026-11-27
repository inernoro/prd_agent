// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSiteContent, type HostedSite } from '@/services/real/webPages';
import { ok } from '@/types/api';
import { __resetSitePreviewHtmlCache, useSitePreviewHtml, type SitePreviewHtmlSite } from './useSitePreviewHtml';
import SitePreviewModal from './SitePreviewModal';

vi.mock('@/services/real/webPages', () => ({ buildApiUrl: (path: string) => path, getSiteContent: vi.fn(), getSiteAskConfig: vi.fn(), setSiteCommentsEnabled: vi.fn() }));
vi.mock('./useHostedPdfDownload', async () => {
  const { useRef } = await import('react');
  return { useHostedPdfDownload: () => ({ iframeRef: useRef(null), notifyFrame: vi.fn(), decorateHtml: (html: string) => html }), HostedPdfDownloadStatus: () => null };
});
vi.mock('./CommentsSection', () => ({ default: () => null }));
vi.mock('./ask/AskPanelInline', () => ({ default: () => null }));
vi.mock('./ask/AskConfigDrawer', () => ({ default: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null, MapSectionLoader: ({ text }: { text: string }) => <div data-testid="preview-loading">{text}</div> }));
const host = document.createElement('div');
let root: ReturnType<typeof createRoot>;
let observed: ReturnType<typeof useSitePreviewHtml>;
const site: SitePreviewHtmlSite = { id: 'test', siteUrl: 'https://storage.example/test/index.html', entryFile: 'index.html' };
const content = (html: string) => ({ siteId: site.id, title: '测试站点', contentType: 'text/html', html });

function Probe({ value, review = false }: { value: SitePreviewHtmlSite; review?: boolean }) {
  observed = useSitePreviewHtml(value, true, review);
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
  expect(observed).toMatchObject({ srcDoc: null, error: null, loading: false, settled: true });
});

it('仅阅读器请求生成网页的批注副本，服务端未生成时保留直链', async () => {
  const generated: SitePreviewHtmlSite = { ...site, contentShape: 'multi-file', canPrepareGeneratedReview: true };
  vi.mocked(getSiteContent)
    .mockResolvedValueOnce(ok({ ...content('<html><body>供审阅的原文</body></html>'), preparedGeneratedReview: true }))
    .mockResolvedValueOnce(ok(content('<html><body>仍需在独立域名运行</body></html>')));
  await act(async () => root.render(<Probe value={generated} />));
  expect(getSiteContent).not.toHaveBeenCalled();
  await act(async () => root.render(<Probe value={generated} review />));
  expect(getSiteContent).toHaveBeenCalledWith(site.id, true);
  expect(observed.srcDoc).toContain('供审阅的原文');
  await act(async () => root.render(<Probe value={{ ...generated, siteUrl: generated.siteUrl + '?v=2' }} review />));
  expect(observed).toMatchObject({ srcDoc: null, error: null, settled: true });
});

it('相同 URL 的站点类型变化不会复用旧正文，迟到响应不能覆盖当前策略', async () => {
  let finish!: (value: Awaited<ReturnType<typeof getSiteContent>>) => void;
  vi.mocked(getSiteContent).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<Probe value={{ ...site, contentShape: 'self-contained-html' }} />));
  expect(getSiteContent).toHaveBeenCalledOnce();
  await act(async () => root.render(<Probe value={{ ...site, contentShape: 'multi-file' }} />));
  await act(async () => finish(ok(content('<html><head></head><body>旧正文</body></html>'))));
  expect(observed).toMatchObject({ srcDoc: null, error: null, loading: false, settled: true });
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

it('相同地址元数据令内联失效时切换原地址并显示加载与慢提示', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  vi.mocked(getSiteContent).mockResolvedValue(ok(content('<html><head></head><body>恢复的正文</body></html>')));
  const hosted = { ...site, contentShape: 'self-contained-html', title: '恢复后预览', askEnabled: false } as HostedSite;
  try {
    await act(async () => root.render(<SitePreviewModal site={hosted} onClose={() => {}} />));
    const initial = document.querySelector('iframe')!;
    expect(initial.getAttribute('srcdoc')).toContain('恢复的正文');
    await act(async () => initial.dispatchEvent(new Event('load')));
    expect(document.querySelector('[data-testid="preview-loading"]')).toBeNull();
    await act(async () => root.render(<SitePreviewModal site={{ ...hosted, contentShape: 'multi-file' }} onClose={() => {}} />));
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('srcdoc')).toBeNull();
    expect(frame.getAttribute('src')).toBe(hosted.siteUrl);
    expect(document.querySelector('[data-testid="preview-loading"]')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(document.querySelector('[data-testid="preview-loading"]')).toBeNull();
    expect(document.body.textContent).toContain('加载较慢');
    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(document.body.textContent).not.toContain('加载较慢');
  } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it('直链已加载后迟到的多文件元数据不会重新盖住同一网页', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  vi.mocked(getSiteContent).mockResolvedValue(ok(content('<html><body><script type="module">console.log("module")</script></body></html>')));
  const hosted = { ...site, contentShape: 'self-contained-html', title: '直链预览', askEnabled: false } as HostedSite;
  try {
    await act(async () => root.render(<SitePreviewModal site={hosted} onClose={() => {}} />));
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('src')).toBe(hosted.siteUrl);
    await act(async () => frame.dispatchEvent(new Event('load')));
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(document.querySelector('[data-testid="preview-loading"]')).toBeNull();
    await act(async () => root.render(<SitePreviewModal site={{ ...hosted, contentShape: 'multi-file' }} onClose={() => {}} />));
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(document.querySelector('iframe')).toBe(frame);
    expect(frame.getAttribute('src')).toBe(hosted.siteUrl);
    expect(document.querySelector('[data-testid="preview-loading"]')).toBeNull();
  } finally { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
