// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ReviewVersionPreview } from './ReviewVersionPreview';
const { useReview } = vi.hoisted(() => ({ useReview: vi.fn() }));
vi.mock('./useHostedReview', () => ({ useHostedReview: useReview }));
vi.mock('./CommentsSection', () => ({ default: () => null }));
vi.mock('./AnnotationBubble', () => ({ AnnotationBubble: () => null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ title, content, actions }: { title: string; content: React.ReactNode; actions: React.ReactNode }) => <section aria-label={title}>{content}{actions}</section> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = async () => {};
afterEach(async () => { await cleanup(); vi.clearAllMocks(); });
async function setup(canRestore = true, failed = false) {
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  const version = { id: 'v1', versionLabel: 'V1', isCurrent: false };
  const selectVersion = vi.fn();
  useReview.mockReturnValue({ versions: [version], selected: version, selectVersion, loading: false,
    preview: failed ? null : { html: '<h1>这是旧版 V1</h1>' }, previewBaseUrl: 'https://storage.example/site/index.html',
    site: { contentShape: 'self-contained-html' }, error: failed ? '预览暂不可用，请重试' : null, annotations: {} });
  const onRestore = vi.fn().mockResolvedValue(false), onClose = vi.fn();
  await act(async () => root.render(<ReviewVersionPreview site={{ id: 'site', title: '当前 V2', siteUrl: 'https://storage.example/site/index.html?v=2', entryFile: 'index.html', contentShape: 'self-contained-html' }}
    source={{ mode: 'site', siteId: 'site' }} versionId="v1" canRestore={canRestore} restoring={false} restoreError={null} onRestore={onRestore} onClose={onClose} />));
  cleanup = async () => { await act(async () => root.unmount()); container.remove(); };
  const click = async (text: string) => act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!.click());
  return { container, click, onRestore, onClose, selectVersion };
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
  expect(container.textContent).not.toContain('恢复为当前版本');
  await click('重试预览'); expect(selectVersion).toHaveBeenLastCalledWith('v1');
  expect(onRestore).not.toHaveBeenCalled();
});
