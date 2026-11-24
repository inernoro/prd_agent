import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptPackageDownloadRequest, downloadHostedPackage, parsePackageManifest, withPackageDownloadBridge } from './packageDownloadBridge';

const context = { siteId: 'site', siteUrl: 'https://assets.example/site/.versions/v1/index.html?v=1',
  entryFile: 'index.html', nonce: 'nonce', pdfFilePaths: [] };
const bytes = new TextEncoder().encode('ZIP-test');
async function fixture() {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  return { fileName: '教程.zip', bytes: bytes.length, sha256: hash,
    parts: [{ path: 'downloads/tutorial-complete.part-001.bin', bytes: bytes.length, sha256: hash }] };
}
afterEach(() => vi.unstubAllGlobals());
describe('完整包有限下载协议', () => {
  it('拒绝其他frame、过期上下文和非协议请求', () => {
    const frame = {} as Window;
    const request = { type: 'map-hosted-package-download', siteId: 'site', nonce: 'nonce', requestId: 'click' };
    expect(acceptPackageDownloadRequest(request, frame, frame, context)).toBe(true);
    for (const change of [{ nonce: 'old' }, { siteId: 'other' }, { requestId: '' }, { type: 'open-url' }])
      expect(acceptPackageDownloadRequest({ ...request, ...change }, frame, frame, context)).toBe(false);
    expect(acceptPackageDownloadRequest(request, {} as Window, frame, context)).toBe(false);
  });
  it('拒绝外部地址、路径穿越、重复分片、错误总量和超限文件', async () => {
    const manifest = await fixture();
    expect(parsePackageManifest(manifest)).toEqual(manifest);
    for (const path of ['https://evil.example/a.bin', '../a.bin', 'downloads/../a.bin', 'downloads/%2e%2e.bin'])
      expect(() => parsePackageManifest({ ...manifest, parts: [{ ...manifest.parts[0], path }] })).toThrow();
    expect(() => parsePackageManifest({ ...manifest, parts: [...manifest.parts, ...manifest.parts] })).toThrow();
    expect(() => parsePackageManifest({ ...manifest, bytes: 1 })).toThrow();
    expect(() => parsePackageManifest({ ...manifest, bytes: 6 * 1024 ** 3 })).toThrow();
    expect(() => parsePackageManifest({ ...manifest, fileName: '../bad.zip' })).toThrow();
  });
  it('从当前版本读取、核验分片并返回一个ZIP，内容损坏会拒绝', async () => {
    const manifest = await fixture();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetcher);
    const progress = vi.fn();
    const result = await downloadHostedPackage(context, new AbortController().signal, progress);
    expect(result.blob.type).toBe('application/zip');
    expect(await result.blob.text()).toBe('ZIP-test');
    expect(String(fetcher.mock.calls[0][0])).toBe('https://assets.example/site/.versions/v1/downloads/tutorial-package.json');
    expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: 'error', credentials: 'omit' });
    expect(progress).toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(manifest))).mockResolvedValueOnce(new Response('bad-data'));
    await expect(downloadHostedPackage(context, new AbortController().signal, progress)).rejects.toThrow('校验失败');
  });
  it('注入在window捕获真实点击，保持原按钮和沙箱，不导航新窗口', () => {
    const html = withPackageDownloadBridge('<main/>', context);
    const script = html.slice(html.indexOf('>(function(){') + 1, html.lastIndexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain("window.addEventListener('click'");
    expect(script).toContain('event.stopImmediatePropagation()');
    expect(script).toContain('[data-download-package]');
    expect(script).not.toMatch(/window.open|allow-downloads|allow-same-origin/);
  });
});
