// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureGatherMotion, GatherMotion } from './GatherMotion';

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
const play = vi.fn(function (this: HTMLElement, _frames: Keyframe[], options: KeyframeAnimationOptions) {
  return { target: this, options, currentTime: 0, cancel: vi.fn(), onfinish: null as (() => void) | null };
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: play });
  play.mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
  if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  vi.unstubAllGlobals();
});

describe('归纳动效', () => {
  it('飞行和落地反馈同帧预约，卸载时取消尚未开始的反馈', () => {
    const mount = document.createElement('div');
    const entry = document.createElement('button');
    document.body.append(mount, entry);
    vi.spyOn(entry, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 60, 30));
    const from = new DOMRect(200, 350, 120, 56);
    const geometry = captureGatherMotion(from, entry);
    expect(geometry).not.toBeNull();

    const root = createRoot(mount);
    try {
      act(() => root.render(<GatherMotion geometry={geometry!} onDone={vi.fn()}>资料合集</GatherMotion>));
      const [flight, impact, highlight, glow, ripple] = play.mock.results.map(result => result.value);
      expect(flight.target.dataset.gatherMotion).toBe('flight');
      expect(impact.target).toBe(entry);
      expect(glow.target.dataset.gatherMotion).toBe('halo');
      expect([impact, highlight, glow, ripple].map(animation => animation.options.delay)).toEqual([1320, 1320, 1320, 1320]);
      expect(flight.options.duration).toBe(1440);
      expect(play.mock.calls[0][0].at(-1)?.transform).toContain('translate(-220px, -343px)');
    } finally {
      act(() => root.unmount());
    }
    expect(play.mock.results.every(result => result.value.cancel.mock.calls.length === 1)).toBe(true);
    expect(document.querySelector('[data-gather-motion]')).toBeNull();
  });

  it('偏好减少动态效果时不创建动画', () => {
    const entry = document.createElement('button');
    document.body.append(entry);
    vi.spyOn(entry, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 50, 30));
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(captureGatherMotion(new DOMRect(100, 100, 50, 50), entry)).toBeNull();
    expect(play).not.toHaveBeenCalled();
  });
});
