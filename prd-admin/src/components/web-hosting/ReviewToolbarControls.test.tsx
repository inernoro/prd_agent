// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewToolbarControls } from './ReviewToolbarControls';
import type { HostedReview } from './useHostedReview';
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null }));
vi.mock('./ReviewVersionPreview', () => ({ ReviewVersionPreview: ({ versionId }: { versionId: string }) => <section aria-label="历史版本预览小窗">{versionId}</section> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement;
const versions = [
  { id: 'v2', versionLabel: 'V2', isCurrent: true, canPreview: true },
  { id: 'v1', versionLabel: 'V1', isCurrent: false, canPreview: true },
  { id: 'old', versionLabel: 'V0', isCurrent: false, canPreview: false },
];
async function mount() {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  const selectVersion = vi.fn(), setDisplayMode = vi.fn(), onOpen = vi.fn();
  function Harness() {
    const [versionPreview, setVersionPreview] = useState<{ id: string } | null>(null);
    const review = { versions, selected: versions[0], selectVersion, versionPreview, setVersionPreview, source: { mode: 'site', siteId: 'site' }, liveSite: { id: 'site' }, annotations: { displayMode: 'bubble', setDisplayMode } } as unknown as HostedReview;
    return <ReviewToolbarControls review={review} canUpload={true} onOpen={onOpen} expanded={false} count={3} />;
  }
  await act(async () => root.render(<Harness />));
  return { selectVersion, setDisplayMode, onOpen };
}
const find = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('hosted review toolbar', () => {
  it('只保留批注与版本入口，不再提供显示方式菜单', async () => {
    const { onOpen } = await mount();
    expect([...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label')))
      .toEqual(['批注与讨论', '网页版本：V2']);
    expect(document.querySelector('[aria-label="批注显示方式"]')).toBeNull();
    await act(async () => find('批注与讨论').click()); expect(onOpen).toHaveBeenCalledOnce();
  });
  it('offers keyboard-selectable version history and rejects unavailable snapshots', async () => {
    const { selectVersion } = await mount();
    await act(async () => find('网页版本：V2').click());
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(document.activeElement).toBe(choices[0]);
    await act(async () => choices[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement).toBe(choices[1]);
    expect(choices[2].disabled).toBe(true);
    await act(async () => choices[1].click());
    expect(selectVersion).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="历史版本预览小窗"]')?.textContent).toBe('v1');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
  it('closes the active popover with Escape without closing the surrounding preview', async () => {
    await mount();
    const parentEscape = vi.fn();
    window.addEventListener('keydown', parentEscape);
    try {
      await act(async () => find('网页版本：V2').click());
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      expect(document.querySelector('[role="listbox"]')).toBeNull();
      expect(parentEscape).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', parentEscape); }
  });
});
