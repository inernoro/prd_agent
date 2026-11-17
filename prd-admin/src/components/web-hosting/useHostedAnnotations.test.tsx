// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHostedAnnotations, type HostedAnnotations } from './useHostedAnnotations';
import type { HostedSiteCommentDto } from '@/services/real/webPages';

vi.mock('@/services/real/webPages', () => ({ buildApiUrl: (path: string) => path }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let annotations: HostedAnnotations;
const initial = { id: 'site-a', siteUrl: 'https://assets.example/a/index.html?v=1' };
function Harness({ site = initial }: { site?: typeof initial }) {
  const frame = useRef<HTMLIFrameElement>(null);
  annotations = useHostedAnnotations(frame, site, vi.fn());
  return <iframe ref={frame} />;
}
async function mount() {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
}
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('hosted annotation bridge', () => {
  it('keeps comment text in the host and accepts only finite preview geometry from its frame', async () => {
    await mount();
    const frame = container.querySelector('iframe')!.contentWindow!;
    const send = vi.spyOn(frame, 'postMessage');
    await act(async () => annotations.setThreads([{ id: 'private', content: '仅宿主显示的正文', authorName: '评审者', anchor: { kind: 'element' } } as HostedSiteCommentDto]));
    const config = send.mock.calls.at(-1)![0];
    expect(JSON.stringify(config)).not.toContain('仅宿主显示的正文');
    expect(JSON.stringify(config)).not.toContain('评审者');
    const post = (rect: unknown) => window.dispatchEvent(new MessageEvent('message', { source: frame, data: { ...config, type: 'map-annotation-preview', id: 'private', rect } }));
    await act(async () => post({ left: 1, top: 2, width: Infinity, height: 20 }));
    expect(annotations.preview).toBeNull();
    await act(async () => post({ left: 1, top: 2, width: 40, height: 20 }));
    expect(annotations.preview?.id).toBe('private');
    await act(async () => annotations.dismissPreview());
    expect(annotations.preview).toBeNull();
    expect(send.mock.calls.at(-1)![0]).toMatchObject({ type: 'map-annotation-preview-dismiss' });
  });
  it('sends display preferences without replacing the page context and makes a new selection visible', async () => {
    await mount();
    expect(annotations.displayMode).toBe('bubble');
    const frame = container.querySelector('iframe')!.contentWindow!;
    const send = vi.spyOn(frame, 'postMessage');
    await act(async () => annotations.notifyFrame());
    const original = send.mock.calls.at(-1)![0] as { nonce: string };
    await act(async () => annotations.setDisplayMode('hidden'));
    expect(send.mock.calls.at(-1)![0]).toMatchObject({ nonce: original.nonce, displayMode: 'hidden' });
    await act(async () => annotations.select());
    expect(annotations.displayMode).toBe('standard');
    expect(send.mock.calls.at(-1)![0]).toMatchObject({ nonce: original.nonce, displayMode: 'standard', enabled: true });
  });
  it('rejects another window and a stale nonce, accepting only the active frame context', async () => {
    await mount();
    const frame = container.querySelector('iframe')!.contentWindow!;
    const send = vi.spyOn(frame, 'postMessage');
    await act(async () => annotations.notifyFrame());
    const config = send.mock.calls.at(-1)![0] as { nonce: string; siteId: string };
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: window,
      data: { ...config, type: 'map-annotation-ready' } })));
    expect(annotations.ready).toBe(false);
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame,
      data: { ...config, nonce: 'stale', type: 'map-annotation-ready' } })));
    expect(annotations.ready).toBe(false);
    await act(async () => window.dispatchEvent(new MessageEvent('message', { source: frame,
      data: { ...config, type: 'map-annotation-ready' } })));
    expect(annotations.ready).toBe(true);
  });
  it('retains discussions on a new content version, clearing them when switching sites', async () => {
    await mount();
    await act(async () => annotations.setThreads([{ id: 'discussion', content: '修改意见' } as HostedSiteCommentDto]));
    await act(async () => root.render(<Harness site={{ ...initial, siteUrl: 'https://assets.example/a/index.html?v=2' }} />));
    expect(annotations.threads.map(t => t.id)).toEqual(['discussion']);
    expect(annotations.ready).toBe(false);
    await act(async () => root.render(<Harness site={{ id: 'site-b', siteUrl: 'https://assets.example/b/index.html?v=1' }} />));
    expect(annotations.threads).toEqual([]);
  });
});

it('全隐过滤旧帧迟到几何，点编号可单独恢复，再全显恢复所有', async () => {
  await mount(); const frame = container.querySelector('iframe')!.contentWindow!, send = vi.spyOn(frame, 'postMessage');
  await act(async () => annotations.notifyFrame()); const config = send.mock.calls.filter(call => call[0].type === 'map-annotation-init').at(-1)![0];
  const items = ['one', 'two'].map(id => ({ id, rect: { left: 10, top: 20, width: 100, height: 40 } }));
  const post = (extra: object) => window.dispatchEvent(new MessageEvent('message', { source: frame, data: { ...config, ...extra } }));
  await act(async () => post({ type: 'map-annotation-previews', items })); expect(annotations.previews).toHaveLength(2);
  await act(async () => annotations.hideAllPreviews()); await act(async () => post({ type: 'map-annotation-previews', items })); expect(annotations.previews).toHaveLength(0);
  await act(async () => post({ type: 'map-annotation-preview-select', id: 'two' })); await act(async () => post({ type: 'map-annotation-previews', items }));
  expect(annotations.previews?.map(item => item.id)).toEqual(['two']); expect(annotations.allPreviewsHidden).toBe(true);
  await act(async () => annotations.showAllPreviews()); await act(async () => post({ type: 'map-annotation-previews', items })); expect(annotations.previews).toHaveLength(2);
});
it('仅有旧单气泡协议时全隐后仍可点击编号重新显示', async () => {
  await mount(); const frame = container.querySelector('iframe')!.contentWindow!, send = vi.spyOn(frame, 'postMessage');
  await act(async () => annotations.notifyFrame()); const config = send.mock.calls.filter(call => call[0].type === 'map-annotation-init').at(-1)![0];
  const post = (extra: object) => window.dispatchEvent(new MessageEvent('message', { source: frame, data: { ...config, ...extra } }));
  await act(async () => post({ type: 'map-annotation-preview', id: 'one', rect: { left: 10, top: 20, width: 100, height: 40 } }));
  await act(async () => annotations.hideAllPreviews()); expect(annotations.preview).toBeNull(); expect(annotations.previews).toBeNull();
  await act(async () => post({ type: 'map-annotation-activate', id: 'one' })); expect(annotations.preview?.id).toBe('one');
});

it('单条收起即时过滤迟到几何，重载重放收起集合，编号与全显能显式恢复', async () => {
  await mount(); const frame = container.querySelector('iframe')!.contentWindow!, send = vi.spyOn(frame, 'postMessage');
  await act(async () => annotations.notifyFrame()); const config = send.mock.calls.filter(call => call[0].type === 'map-annotation-init').at(-1)![0];
  const items = ['one', 'two'].map(id => ({ id, rect: { left: 10, top: 20, width: 100, height: 40 } }));
  const post = (extra: object) => window.dispatchEvent(new MessageEvent('message', { source: frame, data: { ...config, ...extra } }));
  await act(async () => post({ type: 'map-annotation-previews', items }));
  await act(async () => { annotations.dismissPreview('one'); post({ type: 'map-annotation-previews', items }); });
  expect(annotations.previews?.map(item => item.id)).toEqual(['two']);
  await act(async () => annotations.notifyFrame());
  expect(send.mock.calls.at(-1)![0]).toMatchObject({ dismissedPreviewIds: ['one'], revealedPreviewIds: [] });
  await act(async () => post({ type: 'map-annotation-preview-select', id: 'one' }));
  await act(async () => post({ type: 'map-annotation-previews', items })); expect(annotations.previews).toHaveLength(2);
  await act(async () => annotations.dismissPreview('one')); await act(async () => annotations.notifyFrame());
  expect(send.mock.calls.at(-1)![0]).toMatchObject({ dismissedPreviewIds: ['one'], revealedPreviewIds: [] });
  await act(async () => annotations.focus('one')); await act(async () => post({ type: 'map-annotation-previews', items })); expect(annotations.previews).toHaveLength(2);
  await act(async () => annotations.dismissPreview('one'));
  await act(async () => annotations.showAllPreviews()); await act(async () => annotations.notifyFrame());
  expect(send.mock.calls.at(-1)![0]).toMatchObject({ dismissedPreviewIds: [] });
  await act(async () => post({ type: 'map-annotation-previews', items })); expect(annotations.previews).toHaveLength(2);
});
it('旧单气泡几何迟到也不能重开单独收起的气泡', async () => {
  await mount(); const frame = container.querySelector('iframe')!.contentWindow!, send = vi.spyOn(frame, 'postMessage');
  await act(async () => annotations.notifyFrame()); const config = send.mock.calls.at(-1)![0];
  const data = { ...config, type: 'map-annotation-preview', id: 'one', rect: { left: 10, top: 20, width: 100, height: 40 } };
  const post = () => window.dispatchEvent(new MessageEvent('message', { source: frame, data }));
  await act(async () => post()); await act(async () => { annotations.dismissPreview(); post(); }); expect(annotations.preview).toBeNull();
  await act(async () => annotations.showAllPreviews()); expect(annotations.preview?.id).toBe('one');
});
