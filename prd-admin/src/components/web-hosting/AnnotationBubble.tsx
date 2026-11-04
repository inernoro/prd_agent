import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowUpRight, MessageCircle, X } from 'lucide-react';
import type { HostedAnnotations } from './useHostedAnnotations';
import { placeAnnotationBubble } from './annotationBubblePlacement';

/** Comment text stays in the trusted host. The uploaded page supplies geometry only. */
export function AnnotationBubble({ annotations, hidden = false }: { annotations: HostedAnnotations; hidden?: boolean }) {
  const canvas = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0, canvasWidth: 0, canvasHeight: 0 });
  const preview = annotations.preview;
  const thread = preview && annotations.threads.find(item => item.id === preview.id);
  const visible = !hidden && !annotations.enabled && !annotations.draftAnchor && annotations.displayMode === 'bubble' && !!thread && !!preview;
  useLayoutEffect(() => {
    if (!visible || !canvas.current || !card.current) return;
    const measure = () => {
      if (!canvas.current || !card.current) return;
      const bounds = card.current.getBoundingClientRect();
      const next = { width: bounds.width, height: bounds.height, canvasWidth: canvas.current.clientWidth, canvasHeight: canvas.current.clientHeight };
      setSize(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(canvas.current); observer.observe(card.current);
    return () => observer.disconnect();
  }, [visible, thread?.id, thread?.content]);
  if (!visible || !thread || !preview) return null;
  const placement = size.width ? placeAnnotationBubble(preview.rect, size, { width: size.canvasWidth, height: size.canvasHeight }, preview.obstacles) : null;
  return <div ref={canvas} className="annotation-bubble-canvas">
    <div ref={card} className="annotation-chat-bubble" role="dialog" aria-label="批注气泡" data-placement={placement?.side}
      style={{ left: placement?.left ?? 10, top: placement?.top ?? 10, visibility: placement ? 'visible' : 'hidden',
        '--bubble-tail-x': `${placement?.tailX ?? 24}px`, '--bubble-tail-y': `${placement?.tailY ?? 24}px` } as CSSProperties}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); annotations.dismissPreview(); } }}>
      <div className="annotation-chat-author"><span className="annotation-chat-avatar">{Array.from(thread.authorName || '评').slice(0, 1).join('')}</span>
        <strong>{thread.authorName}</strong><span>留下批注</span><button type="button" onClick={annotations.dismissPreview} aria-label="收起批注气泡" title="收起气泡，保留页面标记"><X size={13} /></button></div>
      <p>{thread.content}</p>
      <button type="button" className="annotation-chat-open" onClick={() => annotations.openThread(thread.id)}><MessageCircle size={13} />查看讨论<ArrowUpRight size={13} /></button>
    </div>
  </div>;
}
