// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useReviewAutoOpen } from './useReviewAutoOpen';

it('有批注自动展开，每份文档只展开一次，刷新计数不抢回手动收起的面板', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div'), root = createRoot(element), open = vi.fn();
  let loaded!: (count: number) => void;
  function App({ id }: { id: string }) { loaded = useReviewAutoOpen(id, open); return null; }
  try {
    act(() => root.render(<App id="a" />));
    act(() => loaded(0)); expect(open).not.toHaveBeenCalled();
    act(() => loaded(1)); expect(open).toHaveBeenCalledTimes(1);
    act(() => loaded(2)); expect(open).toHaveBeenCalledTimes(1);
    act(() => root.render(<App id="b" />));
    act(() => loaded(1)); expect(open).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});


it('首次计数迟到时不重新展开用户已经打开并收起的面板，新文档仍自动展开', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const element = document.createElement('div'), root = createRoot(element), open = vi.fn();
  let loaded!: (count: number) => void;
  function App({ id, expanded }: { id: string; expanded: boolean }) {
    loaded = useReviewAutoOpen(id, open, expanded);
    return null;
  }
  try {
    act(() => root.render(<App id="a" expanded={false} />));
    act(() => root.render(<App id="a" expanded />));
    act(() => root.render(<App id="a" expanded={false} />));
    act(() => loaded(1)); expect(open).not.toHaveBeenCalled();
    act(() => root.render(<App id="b" expanded={false} />));
    act(() => loaded(1)); expect(open).toHaveBeenCalledTimes(1);
  } finally { act(() => root.unmount()); vi.unstubAllGlobals(); }
});
