// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewToolbarControls } from './ReviewToolbarControls';
import type { HostedReview } from './useHostedReview';
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null }));
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
  const review = { versions, selected: versions[0], selectVersion, annotations: { displayMode: 'bubble', setDisplayMode } } as unknown as HostedReview;
  await act(async () => root.render(<ReviewToolbarControls review={review} canUpload={true} onOpen={onOpen} expanded={false} count={3} />));
  return { selectVersion, setDisplayMode, onOpen };
}
const find = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });

describe('hosted review toolbar', () => {
  it('keeps discussion and display controls first, and exposes all three display choices', async () => {
    const { onOpen, setDisplayMode } = await mount();
    expect([...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label')))
      .toEqual(['批注与讨论', '批注显示方式', '网页版本：V2']);
    await act(async () => find('批注与讨论').click());
    expect(onOpen).toHaveBeenCalledOnce();
    await act(async () => find('批注显示方式').click());
    const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(choices).toHaveLength(3);
    expect(choices[2].getAttribute('aria-checked')).toBe('true');
    await act(async () => choices[0].click());
    expect(setDisplayMode).toHaveBeenCalledWith('hidden');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(find('批注显示方式'));
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
    expect(selectVersion).toHaveBeenCalledWith('v1');
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
      await act(async () => find('批注显示方式').click());
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(parentEscape).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', parentEscape); }
  });
});
