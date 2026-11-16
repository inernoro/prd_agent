import { useRef, useState } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';

const WIDTH_KEY = 'hosted-review-sidebar-width';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 320;

export function useReviewSidebarWidth() {
  const { width: viewportWidth } = useBreakpoint();
  const maxWidth = Math.min(720, Math.max(MIN_WIDTH, Math.floor(viewportWidth * .55)));
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = Number(sessionStorage.getItem(WIDTH_KEY));
      return Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= 720 ? saved : DEFAULT_WIDTH;
    } catch { return DEFAULT_WIDTH; }
  });
  const setWidth = (value: number) => {
    const next = Math.max(MIN_WIDTH, Math.min(maxWidth, value));
    setPreferredWidth(next);
    try { sessionStorage.setItem(WIDTH_KEY, String(next)); } catch { /* 存储受限仍允许调宽。 */ }
  };
  return { width: Math.min(preferredWidth, maxWidth), minWidth: MIN_WIDTH, maxWidth, setWidth };
}

export function ReviewSidebarResizeHandle({ width, minWidth, maxWidth, setWidth }: ReturnType<typeof useReviewSidebarWidth>) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  return <div role="separator" aria-orientation="vertical" aria-label="调整批注侧栏宽度" tabIndex={0}
    aria-valuemin={minWidth} aria-valuemax={maxWidth} aria-valuenow={Math.round(width)}
    title="拖动调整批注宽度，双击恢复默认；也可使用左右方向键"
    className={`review-resize-handle${dragging ? ' is-dragging' : ''}`}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { id: event.pointerId, x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (start?.id === event.pointerId) setWidth(start.width + start.x - event.clientX);
    }}
    onPointerUp={event => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; setDragging(false); }}
    onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
    onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      setWidth(event.key === 'Home' ? minWidth : event.key === 'End' ? maxWidth : width + (event.key === 'ArrowLeft' ? 32 : -32));
    }}><span aria-hidden="true" /></div>;
}
