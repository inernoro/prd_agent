// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostedPdfDownload, HostedPdfDownloadStatus } from './useHostedPdfDownload';

const { download, save } = vi.hoisted(() => ({ download: vi.fn(), save: vi.fn() }));
vi.mock('@/services/real/webPages', () => ({ downloadHostedPdf: download }));
vi.mock('./sourceDownload', () => ({ saveBlobAsFile: save }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>正在准备</span> }));

let root: Root;
let container: HTMLDivElement;
let bridge: ReturnType<typeof useHostedPdfDownload>;
const site = { id: 'site-a', siteUrl: 'https://assets.example/site/index.html', entryFile: 'index.html', pdfFilePaths: ['guide.pdf'] };
function Harness({ activeSite = site }: { activeSite?: typeof site }) {
  bridge = useHostedPdfDownload(activeSite, { token: 'share' });
  return <><iframe ref={bridge.iframeRef} /><HostedPdfDownloadStatus status={bridge.status} /></>;
}
function request(filePath = 'guide.pdf', source?: MessageEventSource | null) {
  const frame = bridge.iframeRef.current!.contentWindow!;
  const config = JSON.parse(bridge.decorateHtml('<main/>').match(/var context=(.*);/)![1]);
  window.dispatchEvent(new MessageEvent('message', { source: source === undefined ? frame : source,
    data: { type: 'map-hosted-pdf-download', siteId: site.id, nonce: config.nonce, filePath, requestId: 'click-1' } }));
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(navigator, 'userActivation', { value: { isActive: true }, configurable: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  download.mockReset(); save.mockReset(); vi.unstubAllGlobals();
});
describe('PDF下载的父页处理', () => {
  it('伪造frame与未登记PDF都不发起下载', async () => {
    await act(async () => { request('guide.pdf', window); request('other.pdf'); });
    expect(download).not.toHaveBeenCalled();
  });
  it('pending只允许一个请求，实际交给浏览器后才显示交接结论', async () => {
    let finish!: (value: unknown) => void;
    download.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await act(async () => { request(); request(); });
    expect(download).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('正在准备 PDF');
    expect(save).not.toHaveBeenCalled();
    const blob = new Blob(['%PDF-1.7'], { type: 'application/pdf' });
    await act(async () => { finish({ blob, fileName: 'guide.pdf', contentType: 'application/pdf' }); });
    expect(save).toHaveBeenCalledWith(blob, 'guide.pdf');
    expect(container.textContent).toContain('已交给浏览器');
    expect(container.textContent).not.toContain('已保存');
  });
  it('接口失败显示恢复动作，不能声称已交给浏览器', async () => {
    download.mockRejectedValue(new Error('请检查分享密码后重试。'));
    await act(async () => { request(); });
    expect(container.textContent).toContain('请检查分享密码后重试');
    expect(container.textContent).not.toContain('已交给浏览器');
    expect(save).not.toHaveBeenCalled();
  });
  it('没有真实用户激活时拒绝自动消息触发下载', async () => {
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: false }, configurable: true });
    await act(async () => { request(); });
    expect(download).not.toHaveBeenCalled();
    expect(container.textContent).toContain('请亲自点击');
  });
  it('切换站点后迟到的下载不能保存旧文件或覆盖新状态', async () => {
    let finish!: (value: unknown) => void;
    download.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await act(async () => { request(); });
    await act(async () => { root.render(<Harness activeSite={{ ...site, id: 'other-site' }} />); });
    await act(async () => { finish({ blob: new Blob(['%PDF-']), fileName: 'old.pdf', contentType: 'application/pdf' }); });
    expect(save).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('已交给浏览器');
  });
  it('当前frame ready可重新取得上下文，其他frame不能取得', async () => {
    const post = vi.spyOn(bridge.iframeRef.current!.contentWindow!, 'postMessage');
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: window, data: { type: 'map-hosted-pdf-ready' } }));
    });
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: bridge.iframeRef.current!.contentWindow!, data: { type: 'map-hosted-pdf-ready' } }));
    });
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'map-hosted-pdf-init', siteId: 'site-a', pdfFilePaths: ['guide.pdf'] }), '*');
  });
});
