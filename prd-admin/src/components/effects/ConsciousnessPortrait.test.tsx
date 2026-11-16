// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConsciousnessPortrait } from './ConsciousnessPortrait';
import { beginEntryArrival, finishEntryArrival } from './entryArrival';
const renderers = vi.hoisted(() => ({ load: vi.fn(), create: vi.fn() }));
vi.mock('./portraitRenderer', () => ({ loadPortraitImages: renderers.load, createPortraitRenderer: renderers.create }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  host = document.createElement('div'); host.className = 'consciousness-home'; document.body.appendChild(host);
  root = createRoot(host); renderers.load.mockReset(); renderers.create.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); finishEntryArrival(); vi.useRealTimers(); });
it('WebGL 不可用时恢复静态场景、搜索和导航，不留黑场或无限等待', async () => {
  renderers.load.mockResolvedValue([]); renderers.create.mockReturnValue(null); beginEntryArrival();
  await act(async () => root.render(<ConsciousnessPortrait fog={false} arriving />));
  expect(host.querySelector('canvas')).toBeNull();
  expect(host.querySelector('[data-renderer="static-fallback"]')).not.toBeNull();
  expect(host.style.getPropertyValue('--portrait-controls')).toBe('1');
  expect(host.style.getPropertyValue('--portrait-controls-visibility')).toBe('visible');
  expect(document.documentElement.hasAttribute('data-entry-arriving')).toBe(false);
});
it('图片准备挂起时有独立超时，仍恢复可操作首页', async () => {
  vi.useFakeTimers(); renderers.load.mockReturnValue(new Promise(() => {})); beginEntryArrival();
  await act(async () => root.render(<ConsciousnessPortrait fog={false} arriving />));
  await act(async () => vi.advanceTimersByTime(1800));
  expect(host.querySelector('canvas')).toBeNull();
  expect(host.style.getPropertyValue('--portrait-controls')).toBe('1');
  expect(document.documentElement.hasAttribute('data-entry-arriving')).toBe(false);
});
