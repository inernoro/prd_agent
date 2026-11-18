import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Eye, EyeOff, X } from 'lucide-react';
import type { HostedAnnotations, AnnotationRect } from './useHostedAnnotations';
import type { HostedSiteCommentDto } from '@/services/real/webPages';
import { getUserAvatarUrl } from '@/lib/avatar';
import { annotationPreviewText } from './annotationPreviewText';
import { placeAnnotationBubble, placeAnnotationRail } from './annotationBubblePlacement';

type Point = { left: number; top: number };
type Size = { width: number; height: number };
type Placement = Point & { side: string };
type CachedPlacement = { delta: Point; side: string; size: Size; viewport: Size };
const clamp = (n: number, max: number) => Math.max(8, Math.min(n, Math.max(8, max - 8)));
const marginWidth = 300;
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** Text stays in the host. The uploaded document provides only the anchor geometry. */
export function AnnotationBubble({ annotations, hidden = false }: { annotations: HostedAnnotations; hidden?: boolean }) {
  const summaryId = useId();
  const canvas = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLElement>(null);
  const autoPositions = useRef(new Map<string, CachedPlacement>());
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [geometry, setGeometry] = useState<Size & { dockHeight: number; cards: Record<string, Size> }>({ width: 0, height: 0, dockHeight: 0, cards: {} });
  const indexed = useMemo(() => {
    let number = 0;
    return new Map(annotations.threads.filter(thread => thread.anchor && !thread.parentId).map(thread => {
      const time = Date.parse(thread.createdAt);
      const hue = [...(thread.authorName || '')].reduce((hash, char) => (hash * 31 + char.codePointAt(0)!) % 360, 0);
      return [thread.id, { thread, number: ++number, excerpt: annotationPreviewText(thread.content), time: Number.isFinite(time) ? dateFormat.format(time) : '', hue }];
    }));
  }, [annotations.threads]);
  const visible = !hidden && !annotations.enabled && !annotations.draftAnchor && annotations.displayMode === 'bubble' && indexed.size > 0;
  const items = visible ? (annotations.previews ?? (annotations.preview ? [annotations.preview] : [])) : [];
  const entries = items.flatMap(item => {
    const itemData = indexed.get(item.id);
    return itemData ? [{ item, ...itemData }] : [];
  }).sort((a, b) => a.item.rect.top - b.item.rect.top || a.number - b.number);
  const wide = geometry.width >= 820;
  // Reserve space based on the version's annotation count, not the number seen on any one scroll frame.
  const docked = !wide && geometry.height >= 360 && indexed.size >= 4 && annotations.ready && !annotations.allPreviewsHidden;
  const cards = docked ? entries.filter(({ item }) => item.id === annotations.activeId) : entries;
  const activeInDock = docked && cards.length > 0 && !positions[cards[0].item.id];
  const key = JSON.stringify(cards.map(({ item }) => item.id).sort());
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const measure = () => {
      const cards: Record<string, Size> = {};
      element.querySelectorAll<HTMLElement>('[data-bubble-id]').forEach(card => {
        cards[card.dataset.bubbleId!] = { width: card.offsetWidth, height: card.offsetHeight };
      });
      const next = { width: element.clientWidth, height: element.clientHeight, dockHeight: dock.current?.offsetHeight ?? 0, cards };
      setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (dock.current) observer.observe(dock.current);
    element.querySelectorAll('[data-bubble-id]').forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [visible, key, annotations.activeId, docked]);

  const rail = placeAnnotationRail(wide ? entries.flatMap(({ item }) => {
    const size = geometry.cards[item.id];
    return size && !positions[item.id] ? [{ id: item.id, top: item.rect.top, height: size.height }] : [];
  }) : [], geometry.height, annotations.activeId);

  // Scrolling on the margin is only needed when this viewport's annotations do not fit.
  const maxScroll = rail.contentHeight - geometry.height;
  const offset = Math.min(scrollTop, maxScroll);
  useLayoutEffect(() => {
    const margin = scroller.current;
    const id = annotations.activeId;
    if (!id || !margin || !maxScroll) return;
    const card = Array.from(margin.querySelectorAll<HTMLElement>('[data-bubble-id]')).find(el => el.dataset.bubbleId === id);
    if (!card || card.dataset.placement !== 'right') return;
    if (card.offsetTop < margin.scrollTop) margin.scrollTop = card.offsetTop - 8;
    else if (card.offsetTop + card.offsetHeight > margin.scrollTop + margin.clientHeight) {
      margin.scrollTop = card.offsetTop + card.offsetHeight - margin.clientHeight + 8;
    }
  }, [annotations.activeId, geometry.cards, maxScroll]);

  // Keep the gutter even when every anchor has scrolled out of the iframe.
  if (!visible) return null;
  const occupied: AnnotationRect[] = [];
  // A resized card fits around the cards whose dimensions have not changed.
  const stable = new Map<string, Placement>();
  if (!wide && !docked) {
    for (const { item } of entries) {
      const size = geometry.cards[item.id];
      if (!size) continue;
      const saved = autoPositions.current.get(item.id);
      const cached = saved && saved.size.width === size.width && saved.size.height === size.height
        && saved.viewport.width === geometry.width && saved.viewport.height === geometry.height ? saved : null;
      const position = positions[item.id];
      const relative = position ? { ...position, side: 'moved' } : cached && { ...cached.delta, side: cached.side };
      if (!relative) continue;
      const placement = {
        left: clamp(item.rect.left + relative.left, geometry.width - size.width),
        top: clamp(item.rect.top + relative.top, geometry.height - size.height),
        side: relative.side,
      };
      stable.set(item.id, placement);
      occupied.push({ ...placement, ...size });
    }
  }
  const placed = cards.map(entry => {
    const { item } = entry;
    const size = geometry.cards[item.id];
    const position = positions[item.id];
    let placement: Placement | undefined;
    if (size && position) {
      placement = { side: 'moved', left: clamp(item.rect.left + position.left, geometry.width - size.width),
        top: offset + clamp(item.rect.top + position.top, geometry.height - size.height) };
    } else if (size && docked) {
      placement = { side: 'dock', left: Math.round((geometry.width - size.width) / 2),
        top: geometry.height - geometry.dockHeight + 6 };
    } else if (size && wide) {
      placement = { side: 'right', left: geometry.width - marginWidth + 21, top: rail.tops.get(item.id) ?? 10 };
    } else if (size) {
      placement = stable.get(item.id);
      if (!placement) {
        const fitted = placeAnnotationBubble(item.rect, size, geometry, item.obstacles, occupied.slice(-12), true, item.markers);
        if (fitted) {
          autoPositions.current.set(item.id, {
            delta: { left: fitted.left - item.rect.left, top: fitted.top - item.rect.top },
            side: fitted.side, size, viewport: { width: geometry.width, height: geometry.height },
          });
          placement = fitted;
          occupied.push({ ...fitted, ...size });
        }
      }
    }
    return { ...entry, size, placement };
  });
  const returnToDock = () => {
    const number = annotations.activeId && indexed.get(annotations.activeId)?.number;
    annotations.setActiveId(null);
    if (number) requestAnimationFrame(() => dock.current?.querySelector<HTMLButtonElement>(`[data-annotation-number="${number}"]`)?.focus());
  };
  return <>
    {docked && <section ref={dock} className="annotation-mobile-dock" aria-label="页边批注">
      <div className="annotation-dock-list" hidden={activeInDock}>
        {entries.map(({ item, thread, number, excerpt }) => <button type="button" key={item.id} data-annotation-number={number}
          className="annotation-dock-preview" aria-label={`展开批注气泡 ${number}`} aria-describedby={`${summaryId}-${number}`}
          onClick={event => {
            annotations.setActiveId(item.id);
            if (!event.detail) requestAnimationFrame(() => canvas.current?.querySelector<HTMLButtonElement>('[data-annotation-dock-back]')?.focus({ preventScroll: true }));
          }}>
          <span className="annotation-dock-author"><span className="annotation-chat-number">{number}</span><strong>{thread.authorName}</strong></span>
          <span id={`${summaryId}-${number}`} className="annotation-dock-excerpt">{excerpt}</span>
        </button>)}
        {!entries.length && <span className="annotation-dock-empty">滚动正文查看对应批注</span>}
      </div>
    </section>}
    <div ref={canvas} className="annotation-bubble-canvas" aria-label="页面批注气泡">
      <div className="annotation-bubble-scroll" ref={scroller} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        tabIndex={maxScroll > 0 ? 0 : undefined} aria-label={maxScroll > 0 ? '滚动查看更多页边批注' : undefined}>
        <div className="annotation-bubble-space" style={{ minHeight: rail.contentHeight }}>
          {maxScroll > 0 && <div className="annotation-bubble-scroll-area" />}
          {wide && <svg className="annotation-bubble-connectors" aria-hidden="true">
            {placed.map(({ item, placement, size }) => {
              if (!placement || !size || (placement.side !== 'moved' && annotations.activeId !== item.id)) return null;
              const { rect } = item;
              const x = Math.min(rect.left + rect.width + 8, geometry.width - marginWidth + 5);
              const start = Math.max(0, rect.top) + offset;
              const end = Math.min(geometry.height, rect.top + rect.height) + offset;
              const from = (start + end) / 2, to = placement.top + 27;
              const left = placement.left > x;
              const target = left ? placement.left - 1 : placement.left + size.width + 1;
              return <g key={item.id} className={placement.side === 'moved' ? 'is-moved' : undefined}>
                <path d={`M${x - 4},${start}h4V${end}h-4 M${x},${from} C${x + 16},${from} ${target + (left ? -16 : 16)},${to} ${target},${to}`} />
                <circle cx={target} cy={to} r={2} />
              </g>;
            })}
          </svg>}
          {placed.map(({ item, thread, excerpt, number, time, hue, placement, size }) => <BubbleCard key={item.id}
            thread={thread} excerpt={excerpt} number={number} time={time} hue={hue} annotations={annotations}
            placement={placement} mobileDock={docked} onBack={activeInDock ? returnToDock : undefined}
            onMove={point => setPositions(previous => {
              const next = { ...previous };
              if (point && size) next[item.id] = {
                left: clamp(point.left, geometry.width - size.width) - item.rect.left,
                top: clamp(point.top - offset, geometry.height - size.height) - item.rect.top,
              };
              else delete next[item.id];
              return next;
            })} />)}
        </div>
      </div>
    </div>
  </>;
}

function BubbleCard({ thread, excerpt, number, time, hue, annotations, placement, mobileDock, onBack, onMove }: {
  thread: HostedSiteCommentDto; excerpt: string; number: number; time: string; hue: number; annotations: HostedAnnotations;
  placement?: Placement; mobileDock: boolean; onBack?: () => void; onMove: (point: Point | null) => void;
}) {
  const active = annotations.activeId === thread.id;
  const hasHidden = annotations.hasHiddenPreviews || annotations.allPreviewsHidden;
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (!placement || event.button !== 0 || target.closest('button:not(.annotation-chat-grip)')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const edge = event.clientX - rect.left < 9 || rect.right - event.clientX < 9 || event.clientY - rect.top < 9 || rect.bottom - event.clientY < 9;
    if (!edge && !target.closest('.annotation-chat-grip')) return;
    event.preventDefault();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: placement.left, top: placement.top, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const choose = () => annotations.setActiveId(thread.id);
  return <div className={`annotation-chat-bubble${active ? ' is-active' : ''}`} role="dialog" aria-label={`批注气泡 ${number}`}
    data-bubble-id={thread.id} data-placement={placement?.side} data-mobile-dock={mobileDock ? '' : undefined}
    style={{ left: placement?.left, top: placement?.top, visibility: placement ? undefined : 'hidden' }}
    onPointerDown={start}
    onPointerMove={event => {
      const d = drag.current;
      if (!d || d.id !== event.pointerId) return;
      const x = event.clientX - d.x, y = event.clientY - d.y;
      if (!d.moved && Math.hypot(x, y) < 4) return;
      d.moved = true;
      onMove({ left: d.left + x, top: d.top + y });
    }}
    onPointerUp={event => {
      const d = drag.current;
      if (d?.id !== event.pointerId) return;
      drag.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (!d.moved && !active) choose();
    }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || !active) return;
      event.preventDefault(); event.stopPropagation();
      if (onBack) onBack(); else annotations.setActiveId(null);
    }}>
    <button type="button" className="annotation-chat-grip" aria-label={`移动批注气泡 ${number}`} title="拖动顶部或边缘；方向键移动，双击复位"
      onDoubleClick={() => onMove(null)} onKeyDown={event => {
        if (!placement) return;
        const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
        if (delta) { event.preventDefault(); event.stopPropagation(); onMove({ left: placement.left + delta[0], top: placement.top + delta[1] }); }
        if (event.key === 'Home') { event.preventDefault(); onMove(null); }
      }}><span /></button>
    <div className="annotation-chat-author">
      <span className="annotation-chat-number">{number}</span>
      {thread.authorAvatarFileName
        ? <img className="annotation-chat-avatar" alt="" src={getUserAvatarUrl({ avatarFileName: thread.authorAvatarFileName, displayName: thread.authorName })} loading="lazy" />
        : <span className="annotation-chat-avatar" aria-hidden="true" style={{ '--annotation-avatar-hue': hue } as CSSProperties}>{Array.from(thread.authorName || '?')[0]}</span>}
      <strong>{thread.authorName}</strong>
      {time && <time dateTime={thread.createdAt}>{time}</time>}
      {thread.isResolved && <span className="annotation-chat-status">已解决</span>}
    </div>
    <p>{excerpt}</p>
    {active
      ? <>
        <div className="annotation-chat-actions">
          {placement?.side === 'moved' && <button type="button" onClick={() => onMove(null)}>放回原位</button>}
          <button type="button" className="annotation-chat-open" onClick={() => annotations.openThread(thread.id)}>查看讨论<ArrowUpRight size={13} /></button>
        </div>
        <div className="annotation-chat-controls">
          <button type="button" aria-label={hasHidden ? '显示全部气泡' : '隐藏全部气泡'} title={hasHidden ? '显示全部气泡' : '隐藏全部气泡'}
            onClick={() => hasHidden ? annotations.showAllPreviews() : annotations.hideAllPreviews()}>{hasHidden ? <Eye size={15} /> : <EyeOff size={15} />}</button>
          {onBack
            ? <button type="button" onClick={onBack} data-annotation-dock-back aria-label="返回批注摘要" title="返回批注摘要"><ArrowLeft size={15} /></button>
            : <button type="button" onClick={() => annotations.dismissPreview(thread.id)} aria-label={`收起批注气泡 ${number}`} title="收起此气泡，保留页面标记"><X size={14} /></button>}
        </div>
      </>
      : <button type="button" className="annotation-chat-select" aria-label={`展开批注气泡 ${number}`} onClick={choose} />}
  </div>;
}
