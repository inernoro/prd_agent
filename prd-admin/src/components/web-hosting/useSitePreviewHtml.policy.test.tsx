// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSiteContent } from '@/services/real/webPages';
import { ok } from '@/types/api';
import { __resetSitePreviewHtmlCache, useSitePreviewHtml, type SitePreviewHtmlSite } from './useSitePreviewHtml';

vi.mock('@/services/real/webPages', () => ({ getSiteContent: vi.fn() }));
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
