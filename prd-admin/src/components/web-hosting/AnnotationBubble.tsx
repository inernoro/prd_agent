import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { ArrowUpRight, Eye, EyeOff, GripHorizontal, MessageCircle, X } from 'lucide-react';
import type { HostedAnnotations, AnnotationRect } from './useHostedAnnotations';
import type { HostedSiteCommentDto } from '@/services/real/webPages';
import { annotationPreviewText } from './annotationPreviewText';
import { placeAnnotationBubble } from './annotationBubblePlacement';

const clamp = (n: number, max: number) => Math.max(8, Math.min(n, Math.max(8, max - 8)));
type Placement = NonNullable<ReturnType<typeof placeAnnotationBubble>>;

/** Text remains in the trusted host; the uploaded page sends only anchor geometry. */
export function AnnotationBubble({ annotations, hidden = false }: { annotations: HostedAnnotations; hidden?: boolean }) {
  const canvas = useRef<HTMLDivElement>(null);
  const autoPositions = useRef(new Map<string, { placement: Placement; dx: number; dy: number; width: number; height: number; vw: number; vh: number }>());
  const indexed = useMemo(() => {
    let number = 0;
    return new Map(annotations.threads.map(thread => [thread.id, { thread, number: thread.anchor && !thread.parentId ? ++number : 0, excerpt: annotationPreviewText(thread.content) }]));
  }, [annotations.threads]);
  const [positions, setPositions] = useState<Record<string, { left: number; top: number }>>({});
  const [geometry, setGeometry] = useState<{ width: number; height: number; cards: Record<string, { width: number; height: number }> }>({ width: 0, height: 0, cards: {} });
  const visible = !hidden && !annotations.enabled && !annotations.draftAnchor && annotations.displayMode === 'bubble';
  const items = visible ? (annotations.previews ?? (annotations.preview ? [annotations.preview] : [])).filter(item => indexed.has(item.id)) : [];
  const key = items.map(item => item.id).join(':');
  useLayoutEffect(() => {
    if (!canvas.current || !visible || !key) return;
    const measure = () => {
      if (!canvas.current) return;
      const cards: Record<string, { width: number; height: number }> = {};
      canvas.current.querySelectorAll<HTMLElement>('[data-bubble-id]').forEach(card => {
        cards[card.dataset.bubbleId!] = { width: card.offsetWidth, height: card.offsetHeight };
      });
      const next = { width: canvas.current.clientWidth, height: canvas.current.clientHeight, cards };
      setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas.current);
    canvas.current.querySelectorAll('[data-bubble-id]').forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [visible, key]);
  if (!visible || !key) return null;
  const occupied: AnnotationRect[] = [];
  return <div ref={canvas} className="annotation-bubble-canvas" aria-label="页面批注气泡">
    {items.map(item => {
      const { thread, number, excerpt } = indexed.get(item.id)!;
      const size = geometry.cards[item.id];
      let cached = autoPositions.current.get(item.id);
      if (size && (!cached || cached.width !== size.width || cached.height !== size.height || cached.vw !== geometry.width || cached.vh !== geometry.height)) {
        const placed = placeAnnotationBubble(item.rect, size, geometry, item.obstacles, occupied.slice(-12), true, item.markers);
        if (placed) { cached = { placement: placed, dx: placed.left - item.rect.left, dy: placed.top - item.rect.top, ...size, vw: geometry.width, vh: geometry.height }; autoPositions.current.set(item.id, cached); }
      }
      const placement = cached ? { ...cached.placement, left: item.rect.left + cached.dx, top: item.rect.top + cached.dy } : null;
      if (placement && size) occupied.push({ ...placement, ...size });
      return <BubbleCard key={item.id} thread={thread} excerpt={excerpt} anchor={item.rect} number={number} annotations={annotations} placement={placement} canvas={geometry} size={size}
        position={positions[item.id]} onMove={position => setPositions(previous => {
          const next = { ...previous }; if (position) next[item.id] = position; else delete next[item.id]; return next;
        })} />;
    })}
  </div>;
}

function BubbleCard({ thread, excerpt, anchor, number, annotations, placement, canvas, size, position, onMove }: {
  thread: HostedSiteCommentDto; excerpt: string; anchor: AnnotationRect; number: number; annotations: HostedAnnotations; placement: Placement | null;
  canvas: { width: number; height: number }; size?: { width: number; height: number };
  position?: { left: number; top: number }; onMove: (position: { left: number; top: number } | null) => void;
}) {
  const hasHidden = annotations.hasHiddenPreviews || annotations.allPreviewsHidden;
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  // Follow the anchor continuously, while keeping controls reachable at viewport edges.
  const left = clamp(position ? anchor.left + position.left : placement?.left ?? 8, canvas.width - (size?.width ?? 0));
  const top = clamp(position ? anchor.top + position.top : placement?.top ?? 8, canvas.height - (size?.height ?? 0));
  const move = (x: number, y: number) => onMove({ left: clamp(x, canvas.width - (size?.width ?? 0)) - anchor.left, top: clamp(y, canvas.height - (size?.height ?? 0)) - anchor.top });
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button:not(.annotation-chat-grip)')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = event.clientX - rect.left < 9 || rect.right - event.clientX < 9 || event.clientY - rect.top < 9 || rect.bottom - event.clientY < 9;
    if (!edge && !(event.target as Element).closest('.annotation-chat-author')) return;
    event.preventDefault(); event.stopPropagation();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left, top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return <div className={`annotation-chat-bubble${annotations.activeId === thread.id ? ' is-active' : ''}`} role="dialog" aria-label={`批注气泡 ${number}`}
    data-bubble-id={thread.id} data-placement={position ? 'moved' : placement?.side}
    style={{ left, top, visibility: placement || position ? 'visible' : 'hidden', '--bubble-tail-x': `${placement?.tailX ?? 24}px`, '--bubble-tail-y': `${placement?.tailY ?? 24}px` } as CSSProperties}
    onPointerDown={start} onPointerMove={event => { const d = drag.current; if (d?.id === event.pointerId) move(d.left + event.clientX - d.x, d.top + event.clientY - d.y); }}
    onPointerUp={event => { if (drag.current?.id === event.pointerId) { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); annotations.dismissPreview(thread.id); } }}>
    <div className="annotation-chat-author">
      <span className="annotation-chat-number">{number}</span><strong>{thread.authorName}</strong>{thread.isResolved && <span>已解决</span>}
      <button type="button" className="annotation-chat-grip" aria-label={`移动批注气泡 ${number}`} title="拖动顶部或边缘；方向键移动，双击复位"
        onDoubleClick={() => onMove(null)} onKeyDown={event => {
          const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
          if (delta) { event.preventDefault(); event.stopPropagation(); move(left + delta[0], top + delta[1]); }
          if (event.key === 'Home') { event.preventDefault(); onMove(null); }
        }}><GripHorizontal size={14} /></button>
      <button type="button" aria-label={hasHidden ? '显示全部气泡' : '隐藏全部气泡'} title={hasHidden ? '显示全部气泡' : '隐藏全部气泡'}
        onClick={() => hasHidden ? annotations.showAllPreviews() : annotations.hideAllPreviews()}>{hasHidden ? <Eye size={14} /> : <EyeOff size={14} />}</button>
      <button type="button" onClick={() => annotations.dismissPreview(thread.id)} aria-label={`收起批注气泡 ${number}`} title="收起此气泡，保留页面标记"><X size={13} /></button>
    </div>
    <p style={{ overflowWrap: 'anywhere' }}>{excerpt}</p>
    <button type="button" className="annotation-chat-open" onClick={() => annotations.openThread(thread.id)}><MessageCircle size={13} />查看讨论<ArrowUpRight size={13} /></button>
  </div>;
}
