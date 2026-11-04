// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostedReview, type HostedReview } from './useHostedReview';

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
async function mount() {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<Harness />));
}
beforeEach(() => { vi.clearAllMocks(); list.mockResolvedValue({ success: true, data: [current, previous] }); });
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('versioned webpage review', () => {
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
    const inline = { ...previous, siteUrl: null };
    list.mockResolvedValue({ success: true, data: [current, inline] });
    preview.mockResolvedValue({ success: true, data: { revision: inline, html: '<h1>只有旧版正文</h1>', siteUrl: null } });
    await mount();
    await act(async () => review.selectVersion('v1'));
    expect(review.historical).toBe(true);
    expect(review.site?.siteUrl).toBe('');
    expect(review.preview?.html).toContain('只有旧版正文');
  });
  it('reports an unavailable module snapshot instead of presenting the live page as history', async () => {
    const inline = { ...previous, siteUrl: null };
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
