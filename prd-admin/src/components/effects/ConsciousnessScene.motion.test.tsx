// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { IdentityScanner } from './ConsciousnessScene';

it('扫描状态改变只调整现有时钟速度，并在卸载时释放动画', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  const animations = Array.from({ length: 3 }, () => ({ playbackRate: 1, updatePlaybackRate: vi.fn(), cancel: vi.fn() }));
  let index = 0;
  const animate = vi.fn(() => animations[index++]);
  Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, value: animate });
  let nextFrame: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { nextFrame = callback; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<IdentityScanner phase="idle" />));
    expect(animate).toHaveBeenCalledTimes(3);
    await act(async () => root.render(<IdentityScanner phase="verifying" />));
    nextFrame?.(performance.now() + 1000);
    expect(animate).toHaveBeenCalledTimes(3);
    animations.forEach(animation => { expect(animation.updatePlaybackRate).toHaveBeenLastCalledWith(10); expect(animation.cancel).not.toHaveBeenCalled(); });
    await act(async () => root.unmount());
    animations.forEach(animation => expect(animation.cancel).toHaveBeenCalledTimes(1));
  } finally {
    Reflect.deleteProperty(SVGElement.prototype, 'animate');
    vi.unstubAllGlobals();
  }
});
