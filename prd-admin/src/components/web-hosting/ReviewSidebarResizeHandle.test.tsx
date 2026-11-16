// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ReviewSidebarResizeHandle, useReviewSidebarWidth } from './ReviewSidebarResizeHandle';

it('拖动只响应捕获的指针，限制最窄/最宽，松手后不再改变', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear();
  const el = document.createElement('div'); const root = createRoot(el);
  function App() { const sidebar = useReviewSidebarWidth(); return <ReviewSidebarResizeHandle {...sidebar} />; }
  act(() => root.render(<App />));
  const handle = el.firstElementChild as HTMLElement;
  handle.setPointerCapture = vi.fn(); handle.releasePointerCapture = vi.fn();
  function pointer(type: string, x: number, pointerId = 1) {
    const event = new MouseEvent(type, { clientX: x, button: 0, bubbles: true });
    Object.defineProperty(event, 'pointerId', { value: pointerId }); act(() => handle.dispatchEvent(event));
  }
  try {
    pointer('pointerdown', 600); pointer('pointermove', 500, 2);
    expect(handle.getAttribute('aria-valuenow')).toBe('400');
    pointer('pointermove', 400); expect(handle.getAttribute('aria-valuenow')).toBe('563');
    pointer('pointermove', -500); expect(handle.getAttribute('aria-valuenow')).toBe('563');
    pointer('pointermove', 1500); expect(handle.getAttribute('aria-valuenow')).toBe('320');
    pointer('pointerup', 1500); pointer('pointermove', 400);
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(1);
    act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(handle.getAttribute('aria-valuenow')).toBe('352');
    act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(handle.getAttribute('aria-valuenow')).toBe('400');
    expect(sessionStorage.getItem('hosted-review-sidebar-width')).toBe('400');
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
