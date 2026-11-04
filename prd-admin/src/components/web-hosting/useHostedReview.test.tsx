// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostedReview, type HostedReview } from './useHostedReview';
import { shouldFetchPreviewHtml } from './previewHtml';
import { resolveSitePreviewSource } from './sitePreviewSource';

const { list, preview, upload } = vi.hoisted(() => ({ list: vi.fn(), preview: vi.fn(), upload: vi.fn() }));
vi.mock('@/services/real/webPages', () => ({ listHostedReviewVersions: list, previewHostedReviewVersion: preview,
  reuploadSite: upload, buildApiUrl: (path: string) => path }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: (selector: (state: { token: string }) => unknown) => selector({ token: 'session' }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement, review: HostedReview;
const site = { id: 'site', title: '网页', siteUrl: 'https://assets.example/index.html?v=20000', entryFile: 'index.html' };
const current = { id: 'v2', siteId: 'site', versionLabel: 'V2', contentVersionKey: '20000', isCurrent: true, canPreview: true,
  entryFile: 'index.html', siteUrl: site.siteUrl };
const previous = { ...current, id: 'v1', versionLabel: 'V1', contentVersionKey: '10000', isCurrent: false, siteUrl: 'https://assets.example/v1/index.html?v=10000' };
function Harness({ live = site }: { live?: typeof site }) {
  const frame = useRef<HTMLIFrameElement>(null);
  review = useHostedReview(frame, live, { mode: 'site', siteId: site.id }, () => {});
  return <iframe ref={frame} />;
}
async function mount(live = site) {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<Harness live={live} />));
}
beforeEach(() => { vi.clearAllMocks(); list.mockResolvedValue({ success: true, data: [current, previous] }); });
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('versioned webpage review', () => {
  it.each([true, false])('reports the initial metadata wait until its request settles, success=%s', async success => {
    let finish!: (value: unknown) => void;
    list.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await mount();
    expect(review.loading).toBe(true);
    expect(review.selected).toBeUndefined();
    await act(async () => finish(success ? { success: true, data: [current, previous] }
      : { success: false, error: { message: '版本请求失败' } }));
    expect(review.loading).toBe(false);
    expect(review.selected?.id).toBe(success ? 'v2' : undefined);
    expect(review.error).toBe(success ? null : '版本请求失败');
  });
  it('keeps the live preview available when the version response has an invalid shape', async () => {
    list.mockResolvedValue({ success: true, data: { items: [] } });
    await mount();
    expect(review.versions).toEqual([]);
    expect(review.error).toBe('无法加载版本');
    expect(review.site?.siteUrl).toBe(site.siteUrl);
  });
  it('switches the viewed HTML and version scope without publishing or replacing the live site', async () => {
    preview.mockResolvedValue({ success: true, data: { revision: previous, html: '<h1>旧版</h1>', siteUrl: previous.siteUrl } });
    await mount();
    expect(review.selected?.id).toBe('v2');
    await act(async () => review.selectVersion('v1'));
    expect(review.selected?.contentVersionKey).toBe('10000');
    expect(review.preview?.html).toBe('<h1>旧版</h1>');
    expect(review.site?.siteUrl).toBe(previous.siteUrl);
    await act(async () => review.selectVersion('v2'));
    expect(review.site?.siteUrl).toBe(site.siteUrl);
    expect(review.preview).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });
  it('never substitutes the live URL when a historical snapshot has no direct URL', async () => {
    const inline = { ...previous, siteUrl: null, contentShape: 'self-contained-html' };
    list.mockResolvedValue({ success: true, data: [current, inline] });
    preview.mockResolvedValue({ success: true, data: { revision: inline, html: '<h1>只有旧版正文</h1>', siteUrl: null } });
    await mount();
    await act(async () => review.selectVersion('v1'));
    expect(review.historical).toBe(true);
    expect(review.site?.siteUrl).toBe('');
    expect(review.previewBaseUrl).toBe('https://assets.example/index.html');
    expect(review.preview?.html).toContain('只有旧版正文');
  });
  it('uses the historical entry name when the current AI publication has a generated filename', async () => {
    const inline = { ...previous, siteUrl: null, contentShape: 'self-contained-html' };
    const generated = { ...current, siteUrl: 'https://assets.example/pack/index.vnew.html?v=20000', entryFile: 'pack/index.html' };
    list.mockResolvedValue({ success: true, data: [generated, inline] });
    preview.mockResolvedValue({ success: true, data: { revision: inline, html: '<h1>旧版</h1>', siteUrl: null } });
    await mount();
    await act(async () => root.render(<Harness live={{ ...site, siteUrl: generated.siteUrl, entryFile: generated.entryFile }} />));
    await act(async () => review.selectVersion('v1'));
    expect(review.previewBaseUrl).toBe('https://assets.example/index.html');
    expect(review.site?.siteUrl).toBe('');
  });
  it.each(['中文目录/内层', '中文 空格/分%组'])('keeps the site root for inline history with a non-ASCII live entry: %s', async directory => {
    const inline = { ...previous, entryFile: '旧稿/首页.html', siteUrl: null, contentShape: 'self-contained-html' };
    const generated = { ...current, siteUrl: new URL(`${directory.split('/').map(encodeURIComponent).join('/')}/首页.vnew.html?v=20000`, 'https://assets.example/.versions/live/').href,
      entryFile: `${directory}/首页.html` };
    list.mockResolvedValue({ success: true, data: [generated, inline] });
    preview.mockResolvedValue({ success: true, data: { revision: inline, html: '<h1>旧版</h1>', siteUrl: null } });
    await mount({ ...site, siteUrl: generated.siteUrl, entryFile: generated.entryFile });
    await act(async () => review.selectVersion('v1'));
    expect(review.previewBaseUrl).toBe(new URL('旧稿/首页.html', 'https://assets.example/.versions/live/').href);
    expect(review.site?.siteUrl).toBe('');
  });
  it('rejects an HTML-only multi-file snapshot whose old resources cannot be recovered', async () => {
    const incomplete = { ...previous, siteUrl: null, contentShape: 'multi-file' };
    list.mockResolvedValue({ success: true, data: [current, incomplete] });
    preview.mockResolvedValue({ success: true, data: { revision: incomplete, html: '<img src="./changed.svg">', siteUrl: null } });
    await mount();
    await act(async () => review.selectVersion('v1'));
    expect(review.historical).toBe(false);
    expect(review.error).toContain('历史版本未保留可用的预览');
    expect(review.preview).toBeNull();
  });
  it('reports an unavailable module snapshot instead of presenting the live page as history', async () => {
    const inline = { ...previous, siteUrl: null, contentShape: 'self-contained-html' };
    list.mockResolvedValue({ success: true, data: [current, inline] });
    preview.mockResolvedValue({ success: true, data: { revision: inline, html: '<script type="module" src="./app.js"></script>', siteUrl: null } });
    await mount();
    await act(async () => review.selectVersion('v1'));
    expect(review.historical).toBe(false);
    expect(review.error).toContain('历史版本未保留可用的预览');
    expect(review.site?.siteUrl).toBe(site.siteUrl);
    expect(review.preview).toBeNull();
  });
  it('uses the recorded current version when the library still holds an older site URL', async () => {
    await mount();
    await act(async () => root.render(<Harness live={{ ...site, siteUrl: 'https://assets.example/v1/index.html?v=10000' }} />));
    expect(review.selected?.id).toBe('v2');
    expect(review.site?.siteUrl).toBe(current.siteUrl);
    expect(upload).not.toHaveBeenCalled();
  });
  it.each(['pdf', 'video'])('does not apply live %s wrapper policy to an HTML-only historical snapshot', async wrappedAssetType => {
    const inline = { ...previous, siteUrl: null, contentShape: 'self-contained-html' };
    list.mockResolvedValue({ success: true, data: [current, inline] });
    preview.mockResolvedValue({ success: true, data: { revision: inline, siteUrl: null, html: '<h1>旧 HTML</h1>' } });
    const live = { ...site, wrappedAssetType, pdfAssetUrl: 'https://assets.example/current.pdf',
      pdfFilePaths: ['current.pdf'], requiresPreviewBridge: true };
    await mount(live);
    await act(async () => review.selectVersion('v1'));
    expect(review.historical).toBe(true);
    expect(review.site?.wrappedAssetType).toBeUndefined();
    expect(review.site?.pdfAssetUrl).toBeUndefined();
    expect(review.site?.pdfFilePaths).toBeUndefined();
    expect(review.site?.requiresPreviewBridge).toBeUndefined();
    const selectedSite = { ...live, ...review.site };
    expect(shouldFetchPreviewHtml(selectedSite)).toBe(true);
    expect(resolveSitePreviewSource(selectedSite, { nativePdfViewer: true })).toEqual({ src: '', usingNativePdfViewer: false });
    await act(async () => review.selectVersion('v2'));
    expect(review.site?.pdfAssetUrl).toBe(live.pdfAssetUrl);
  });
  it('uses the recorded migrated URL even when its business version is unchanged', async () => {
    const moved = { ...current, siteUrl: 'https://assets.example/.versions/random/index.html?v=20000' };
    list.mockResolvedValue({ success: true, data: [moved, previous] });
    await mount();
    expect(review.selected?.contentVersionKey).toBe('20000');
    expect(review.liveSite?.siteUrl).toBe(moved.siteUrl);
    expect(review.site?.siteUrl).toBe(moved.siteUrl);
  });
  it('does not replace a newer live publication with an older version-list response', async () => {
    await mount();
    const newer = { ...site, siteUrl: 'https://assets.example/.versions/new/nested/page.html?v=30000', entryFile: 'nested/page.html' };
    await act(async () => root.render(<Harness live={newer} />));
    expect(review.liveSite?.siteUrl).toBe(newer.siteUrl);
    expect(review.liveSite?.entryFile).toBe(newer.entryFile);
    expect(review.site?.siteUrl).toBe(newer.siteUrl);
    expect(review.selected).toBeUndefined();
    expect(review.loading).toBe(true);
  });
  it('discards a late historical response after the reviewer has switched back to current', async () => {
    let finish!: (value: unknown) => void;
    preview.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await mount();
    let request!: Promise<void>;
    await act(async () => { request = review.selectVersion('v1'); });
    expect(review.loading).toBe(true);
    await act(async () => review.selectVersion('v2'));
    await act(async () => { finish({ success: true, data: { revision: previous, html: '<h1>迟到的旧版</h1>', siteUrl: previous.siteUrl } }); await request; });
    expect(review.selected?.id).toBe('v2');
    expect(review.historical).toBe(false);
    expect(review.preview).toBeNull();
    expect(review.site?.siteUrl).toBe(site.siteUrl);
  });
});
