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
