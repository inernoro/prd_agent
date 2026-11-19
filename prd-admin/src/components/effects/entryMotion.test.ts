// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enterWorkspace } from './entryMotion';
vi.mock('@/lib/themeApplier', () => ({ prefersReducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches }));
afterEach(() => { vi.unstubAllGlobals(); document.documentElement.classList.remove('cinema-route-transition'); });
describe('登录跨页衔接', () => {
  it('浏览器不支持快照转场时仍导航一次', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    const commit = vi.fn();
    enterWorkspace(commit);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('cinema-route-transition')).toBe(false);
  });
  it('快照只包裹一次路由提交，结束后移除专属样式', async () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false });
    let finish!: () => void;
    const doc = document as Document & { startViewTransition?: unknown };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    Object.defineProperty(doc, 'startViewTransition', { configurable: true, value: vi.fn((update: () => void) => { update(); return { finished: new Promise<void>(resolve => { finish = resolve; }) }; }) });
    const commit = vi.fn();
    enterWorkspace(commit);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('cinema-route-transition')).toBe(true);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.documentElement.classList.contains('cinema-route-transition')).toBe(false);
    Reflect.deleteProperty(doc, 'startViewTransition');
  });
  it('减少动态效果时不启用页面快照', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    const snapshot = vi.fn();
    const doc = document as Document & { startViewTransition?: unknown };
    Object.defineProperty(doc, 'startViewTransition', { configurable: true, value: snapshot });
    const commit = vi.fn();
    enterWorkspace(commit);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(snapshot).not.toHaveBeenCalled();
    Reflect.deleteProperty(doc, 'startViewTransition');
  });
});
