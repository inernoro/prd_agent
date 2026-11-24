import { useRef, useState } from 'react';
import { clampAskWidth } from './askDockGeometry';
import './askDock.css';

const WIDTH_KEY = 'web-page-ask-width';
export function useAskWidth() {
  const [width, setWidth] = useState(() => {
    try { const saved = Number(sessionStorage.getItem(WIDTH_KEY)); return saved >= 320 && saved <= 960 ? saved : 480; }
    catch { return 480; }
  });
  return [width, (value: number) => {
    setWidth(value);
    try { sessionStorage.setItem(WIDTH_KEY, String(value)); } catch { /* 存储受限时仍可调整 */ }
  }] as const;
}

/** 左边缘拖动与键盘调宽共用同一几何边界，指针捕获防止越过 iframe 后失去拖动。 */
export function AskResizeHandle({ width, viewportWidth, onWidth }: {
  width: number; viewportWidth: number; onWidth: (width: number) => void;
}) {
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const resize = (value: number) => onWidth(clampAskWidth(value, viewportWidth));
  return <div role="separator" aria-orientation="vertical" aria-label="调整提问侧栏宽度"
    aria-valuemin={Math.min(320, viewportWidth - 40)} aria-valuemax={Math.min(960, viewportWidth - 40)}
    aria-valuenow={Math.round(width)} tabIndex={0} title="拖动调整宽度，双击恢复默认"
    className={`ask-resize-handle${dragging ? ' is-dragging' : ''}`}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag.current = { id: event.pointerId, x: event.clientX, width };
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(true);
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (start?.id === event.pointerId) resize(start.width + start.x - event.clientX);
    }}
    onPointerUp={(event) => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current = null; setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { drag.current = null; setDragging(false); }}
    onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
    onDoubleClick={() => resize(480)}
    onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      resize(event.key === 'Home' ? 320 : event.key === 'End' ? 960 : width + (event.key === 'ArrowLeft' ? 32 : -32));
    }}><span /></div>;
}
