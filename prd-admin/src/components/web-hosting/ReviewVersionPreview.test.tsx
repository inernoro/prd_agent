// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewVersionPreview } from './ReviewVersionPreview';
import { ReviewVersionPreviewHost } from './ReviewVersionBar';
import type { HostedReview } from './useHostedReview';
import { __resetSitePreviewHtmlCache } from './useSitePreviewHtml';
import type { HostedReviewSource } from '@/services/real/webPages';
const { useReview, getSiteContent, getShareSiteContent, listShareComments, downloadCommentFile, saveBlobAsFile } = vi.hoisted(() => ({
  useReview: vi.fn(), getSiteContent: vi.fn(), getShareSiteContent: vi.fn(),
  listShareComments: vi.fn(), downloadCommentFile: vi.fn(), saveBlobAsFile: vi.fn(),
}));
vi.mock('./useHostedReview', () => ({ useHostedReview: useReview }));
vi.mock('./sourceDownload', () => ({ saveBlobAsFile }));
vi.mock('@/services/real/webPages', () => ({
  getSiteContent, getShareSiteContent, buildApiUrl: (path: string) => path,
  listSiteComments: async () => ({ success: true, data: { comments: [] } }),
  listShareComments, downloadCommentFile,
}));
vi.mock('./CommentsSection', () => ({ default: () => <p data-test-comments>当前绑定的批注</p> }));
vi.mock('./AnnotationBubble', () => ({ AnnotationBubble: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ title, titleAction, content, actions }: { title: string; titleAction: React.ReactNode; content: React.ReactNode; actions: React.ReactNode }) => <section aria-label={title}>{titleAction}{content}{actions}</section> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
listShareComments.mockResolvedValue({ success: true, data: { comments: [] } });
let cleanup = async () => {};
afterEach(async () => { await cleanup(); __resetSitePreviewHtmlCache(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
async function setup(canRestore = true, failed = false, missingMetadata = false, commentId?: string, parentErrors?: { error: string; restoreError: string | null }) {
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  const version = { id: 'v1', versionLabel: 'V1', isCurrent: false };
  const selectVersion = vi.fn();
  const refresh = vi.fn();
  useReview.mockReturnValue({ versions: missingMetadata ? [] : [version], selected: missingMetadata ? undefined : version, selectVersion, refresh, loading: false,
    preview: failed ? null : { html: '<h1>这是旧版 V1</h1>' }, previewBaseUrl: 'https://storage.example/site/index.html',
    site: { contentShape: 'self-contained-html' }, error: failed ? '预览暂不可用，请重试' : null, annotations: {} });
  const onRestore = vi.fn().mockResolvedValue(false), onClose = vi.fn();
  const site = { id: 'site', title: '当前 V2', siteUrl: 'https://storage.example/site/index.html?v=2', entryFile: 'index.html', contentShape: 'self-contained-html' as const };
  const parent = { ...parentErrors, liveSite: site, source: { mode: 'site', siteId: 'site' }, versionPreview: { id: 'v1' }, uploading: false, restoreVersion: onRestore, setVersionPreview: onClose } as unknown as HostedReview;
  await act(async () => root.render(parentErrors ? <ReviewVersionPreviewHost review={parent} canRestore={canRestore} /> : <ReviewVersionPreview site={site}
    source={{ mode: 'site', siteId: 'site' }} versionId="v1" commentId={commentId} canRestore={canRestore} restoring={false} restoreError={null} onRestore={onRestore} onClose={onClose} />));
  cleanup = async () => { await act(async () => root.unmount()); container.remove(); };
  const click = async (text: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click());
  return { container, click, onRestore, onClose, selectVersion, refresh };
}
it('小窗显示旧版快照；预览与取消不发布，明确确认后才恢复且重试复用标识', async () => {
  const { container, click, onRestore, onClose } = await setup();
  expect(container.querySelector('iframe')?.srcdoc).toContain('这是旧版 V1');
  expect(onRestore).not.toHaveBeenCalled();
  await click('恢复为当前版本'); await click('取消'); expect(onRestore).not.toHaveBeenCalled();
  await click('恢复为当前版本'); await click('确认恢复并发布');
  expect(onClose).not.toHaveBeenCalled();
  onRestore.mockResolvedValueOnce(true); await click('确认恢复并发布');
  expect(onRestore.mock.calls[0][0]).toBe(onRestore.mock.calls[1][0]);
  expect(onClose).toHaveBeenCalledOnce();
});
it('只读预览不提供恢复入口，快照失败时不展示当前内容并允许重试', async () => {
  const { container, click, selectVersion, onRestore } = await setup(false, true);
  expect(container.querySelector('iframe')).toBeNull();
  expect(container.querySelector('[data-test-comments]')).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('[aria-label="查看此版本批注"]')?.disabled).toBe(true);
  expect(container.textContent).not.toContain('恢复为当前版本');
  await click('重试预览'); expect(selectVersion).toHaveBeenLastCalledWith('v1', undefined);
  expect(onRestore).not.toHaveBeenCalled();
});
it('初次版本元数据失败时重试真正重载列表，不调用会直接返回的版本选择', async () => {
  const { click, selectVersion, refresh } = await setup(false, true, true);
  await click('重试预览');
  expect(refresh).toHaveBeenCalledOnce(); expect(selectVersion).not.toHaveBeenCalled();
});
it('从批注打开历史小窗后失败重试仍携带原定位目标', async () => {
  const { click, selectVersion } = await setup(false, true, false, 'target-comment');
  expect(selectVersion).toHaveBeenLastCalledWith('v1', 'target-comment');
  await click('重试预览');
  expect(selectVersion).toHaveBeenLastCalledWith('v1', 'target-comment');
});

it('成功历史快照不显示父页面上传错误，恢复失败仍在小窗提示', async () => {
  const { container } = await setup(true, false, false, undefined, { error: '上传失败，请重新上传', restoreError: null });
  expect(container.querySelector('iframe')?.srcdoc).toContain('这是旧版 V1');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it('恢复操作自己的错误仍可见，不被父页面其他错误替换', async () => {
  const { container } = await setup(true, false, false, undefined, { error: '上传失败，请重新上传', restoreError: '版本已更新，请核对后重试恢复' });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('版本已更新，请核对后重试恢复');
});

async function setupReaderVersion(contentShape: 'self-contained-html' | 'multi-file', source: HostedReviewSource, historical = false) {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  const container = document.createElement('div');
  const main = document.createElement('iframe');
  main.srcdoc = '<input value="当前阅读现场">';
  document.body.append(container, main);
  const root = createRoot(container);
  cleanup = async () => { await act(async () => root.unmount()); container.remove(); main.remove(); };
  const version = historical
    ? { id: 'v2', versionLabel: 'V2', isCurrent: false, contentVersionKey: '2', canPreview: true }
    : { id: 'v3', versionLabel: 'V3', isCurrent: true, contentVersionKey: '3', canPreview: true };
  const site = { id: 'site', title: '当前 V3', siteUrl: 'https://storage.example/site/index.html?v=3', entryFile: 'index.html', contentShape };
  useReview.mockReturnValue({
    versions: [version], selected: version, selectVersion: vi.fn(), loading: false,
    preview: historical ? { html: '<h1>旧版正文</h1>' } : null, previewBaseUrl: site.siteUrl,
    site, liveSite: site, error: null, annotations: { setThreads: vi.fn(), setDisplayMode: vi.fn(), notifyFrame: vi.fn() },
  });
  await act(async () => root.render(<ReviewVersionPreview site={site} source={source} versionId={version.id} canRestore
    restoring={false} restoreError={null} onRestore={vi.fn()} onClose={vi.fn()}
    placement={{ trigger: { current: null }, stage: { current: main }, lastPosition: { current: null } }} />));
  const preview = () => document.querySelector<HTMLIFrameElement>('.review-history-window iframe');
  return { site, main, preview };
}

it.each(['site', 'share'] as const)('当前行复用 %s 正文加载策略，等待期间不请求直链', async mode => {
  let complete!: (value: unknown) => void;
  const content = new Promise(resolve => { complete = resolve; });
  const request = mode === 'site' ? getSiteContent : getShareSiteContent;
  request.mockReturnValue(content);
  const source: HostedReviewSource = mode === 'site' ? { mode, siteId: 'site' } : { mode, siteId: 'site', token: 'share', password: 'secret' };
  const { main, preview } = await setupReaderVersion('self-contained-html', source);
  expect(preview()).toBeNull();
  expect(request).toHaveBeenCalledWith(...(mode === 'site' ? ['site'] : ['share', 'site', 'secret']));
  await act(async () => { complete({ success: true, data: { html: '<h1>当前 V3 的正文</h1>' } }); });
  expect(preview()?.srcdoc).toContain('当前 V3 的正文');
  expect(preview()?.hasAttribute('src')).toBe(false);
  expect(preview()?.getAttribute('sandbox')).not.toContain('allow-same-origin');
  expect(main.srcdoc).toContain('当前阅读现场');
  expect(document.querySelector('.review-history-window')?.textContent).not.toContain('恢复此版本');
});

it('当前多文件页面沿用真实地址与资源同源，不加载独立的入口 HTML', async () => {
  const { site, preview } = await setupReaderVersion('multi-file', { mode: 'site', siteId: 'site' });
  expect(preview()?.src).toBe(site.siteUrl);
  expect(preview()?.hasAttribute('srcdoc')).toBe(false);
  expect(preview()?.getAttribute('sandbox')).toContain('allow-same-origin');
  expect(getSiteContent).not.toHaveBeenCalled();
});

it('当前独立正文取回失败时保持窗口、允许原地重试', async () => {
  getSiteContent.mockResolvedValueOnce({ success: false, error: { message: '源暂不可读' } })
    .mockResolvedValueOnce({ success: true, data: { html: '<h1>重新取得的正文</h1>' } });
  const { preview } = await setupReaderVersion('self-contained-html', { mode: 'site', siteId: 'site' });
  expect(preview()).toBeNull();
  expect(document.querySelector('.review-history-window [role="alert"]')?.textContent).toContain('V3 载入失败');
  const retry = [...document.querySelectorAll<HTMLButtonElement>('.review-history-window button')].find(button => button.textContent === '重试');
  await act(async () => retry?.click());
  expect(getSiteContent).toHaveBeenCalledTimes(2);
  expect(preview()?.srcdoc).toContain('重新取得的正文');
});

it('历史小窗显示附件评论和回复，并按分享凭据下载对应文件', async () => {
  const source = { mode: 'share', token: 'share', password: 'secret', siteId: 'site' } as const;
  const attachment = { index: 0, name: '旧版附件.txt', length: 4 };
  const replyFile = { ...attachment, name: '旧版回复.txt' };
  const original = { id: 'note', authorName: '旧版作者', content: '', contentVersion: '2', attachments: [attachment] };
  listShareComments.mockResolvedValueOnce({ success: true, data: { comments: [
    original, { ...original, id: 'reply', parentId: 'note', attachments: [replyFile] },
  ] } });
  const blob = new Blob(['test']);
  downloadCommentFile.mockResolvedValueOnce({ blob, fileName: attachment.name }).mockRejectedValueOnce(new Error('暂时不可用'));
  await setupReaderVersion('self-contained-html', source, true);
  const click = async (text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.review-history-window button')].find(entry => entry.textContent === text);
    expect(button).toBeDefined();
    await act(async () => button?.click());
  };
  await click(attachment.name);
  expect(downloadCommentFile).toHaveBeenCalledWith(source, 'note', attachment);
  expect(saveBlobAsFile).toHaveBeenCalledWith(blob, attachment.name);
  await click('1 条回复');
  await click(replyFile.name);
  expect(downloadCommentFile).toHaveBeenLastCalledWith(source, 'reply', replyFile);
  expect(document.querySelector('.review-history-window [role="alert"]')?.textContent).toContain('附件下载失败');
});

it('评论变动后历史小窗更新回复和附件，较早的响应不能恢复已删除的附件', async () => {
  const source = { mode: 'share', token: 'share', siteId: 'site' } as const;
  const note = { id: 'note', authorName: '旧版作者', content: '原意见', contentVersion: '2' };
  const before = { success: true, data: { comments: [
    { ...note, attachments: [{ index: 0, name: '旧附件.txt', length: 4 }] },
  ] } };
  let completeOldRequest!: (response: typeof before) => void;
  const oldRequest = new Promise<typeof before>(resolve => { completeOldRequest = resolve; });
  listShareComments.mockResolvedValueOnce(before).mockReturnValueOnce(oldRequest).mockResolvedValueOnce({
    success: true, data: { comments: [note, { ...note, id: 'reply', parentId: note.id, content: '新回复' }] },
  });
  const { preview } = await setupReaderVersion('self-contained-html', source, true);
  const originalFrame = preview();
  const windowText = () => document.querySelector('.review-history-window')?.textContent;
  const changed = () => window.dispatchEvent(new CustomEvent('hosted-comments-changed'));
  expect(windowText()).toContain('旧附件.txt');
  await act(async () => { changed(); });
  expect(windowText()).toContain('原意见');
  await act(async () => { changed(); });
  expect(windowText()).toContain('1 条回复');
  expect(windowText()).not.toContain('旧附件.txt');
  await act(async () => { completeOldRequest(before); });
  expect(windowText()).toContain('1 条回复');
  expect(windowText()).not.toContain('旧附件.txt');
  expect(preview()).toBe(originalFrame);
});
