import { useCallback, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { ArrowLeft, ArrowUpRight, Check, CornerDownLeft, Eye, EyeOff, RotateCcw, Send, X } from 'lucide-react';
import type { HostedAnnotations, AnnotationRect } from './useHostedAnnotations';
import type { HostedSiteCommentDto } from '@/services/real/webPages';
import { getUserAvatarUrl } from '@/lib/avatar';
import { annotationPreviewText } from './annotationPreviewText';
import { placeAnnotationBubble, placeAnnotationRail } from './annotationBubblePlacement';
import '@/styles/hosted-review-margin.css';

type Point = { left: number; top: number };
type Size = { width: number; height: number };
type Placement = Point & { side: string };
type CachedPlacement = { delta: Point; side: string; size: Size; viewport: Size };
type MarginReply = { text: string; clientId?: string; error?: string; sending?: boolean; editing?: boolean };
type RailSnapshot = { active: string | null; documentTop: number | null; offset: number; tops: Map<string, number> };
const emptyReply: MarginReply = { text: '' };
const clamp = (n: number, max: number) => Math.max(8, Math.min(n, Math.max(8, max - 8)));
const marginWidth = 300;
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const marginDateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function useRailSelectionMotion(layer: { current: HTMLElement | null }, snapshot: RailSnapshot | null) {
  const previous = useRef<RailSnapshot | null>(null);
  const motion = useRef<{ frame?: number; animations: Animation[] }>({ animations: [] });
  const cancel = useCallback(() => {
    if (motion.current.frame !== undefined) cancelAnimationFrame(motion.current.frame);
    motion.current.animations.forEach(animation => animation.cancel());
    motion.current = { animations: [] };
  }, []);
  useLayoutEffect(() => cancel, [cancel]);
  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = snapshot;
    if (!from || !snapshot || from.documentTop !== snapshot.documentTop || from.offset !== snapshot.offset) {
      cancel();
      return;
    }
    if (from.active === snapshot.active || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    cancel();
    motion.current.frame = requestAnimationFrame(() => {
      const margin = layer.current;
      if (!margin) return;
      const options = { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' };
      margin.querySelectorAll<HTMLElement>('[data-placement="right"]').forEach(card => {
        const before = from.tops.get(card.dataset.bubbleId!);
        const after = card.offsetTop;
        if (before === undefined || Math.abs(before - after) < 1 || !card.animate) return;
        const intersects = (top: number) => top + card.offsetHeight > snapshot.offset && top < snapshot.offset + margin.clientHeight;
        if (!intersects(before) || !intersects(after)) return;
        motion.current.animations.push(card.animate([{ transform: `translateY(${before - after}px)` }, { transform: 'none' }], options));
      });
      const connector = margin.querySelector<SVGElement>('[data-active-connector]');
      if (motion.current.animations.length && connector?.animate) {
        // The new line attaches to the settled card. Keep it out of the old position.
        motion.current.animations.push(connector.animate([{ opacity: 0 }, { opacity: 1 }], { delay: 200, duration: 100, fill: 'backwards' }));
      }
    });
  });
}

/** Text stays in the host. The uploaded document provides only the anchor geometry. */
export function AnnotationBubble({ annotations, hidden = false }: { annotations: HostedAnnotations; hidden?: boolean }) {
  const summaryId = useId();
  const canvas = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scrollDocument = annotations.scrollDocument;
  const dock = useRef<HTMLElement>(null);
  const autoPositions = useRef(new Map<string, CachedPlacement>());
  const replies = useRef(new Map<string, MarginReply>());
  const [, refreshReplies] = useReducer((revision: number) => revision + 1, 0);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [geometry, setGeometry] = useState<Size & { dockHeight: number; cards: Record<string, Size> }>({ width: 0, height: 0, dockHeight: 0, cards: {} });
  const indexed = useMemo(() => {
    let number = 0;
    const format = annotations.dualColumn ? marginDateFormat : dateFormat;
    return new Map(annotations.threads.filter(thread => thread.anchor && !thread.parentId).map(thread => {
      const time = Date.parse(thread.createdAt);
      const hue = [...(thread.authorName || '')].reduce((hash, char) => (hash * 31 + char.codePointAt(0)!) % 360, 0);
      return [thread.id, { thread, number: ++number, excerpt: annotationPreviewText(thread.content), time: Number.isFinite(time) ? format.format(time) : '', hue }];
    }));
  }, [annotations.threads, annotations.dualColumn]);
  const visible = !hidden && !annotations.enabled && !annotations.draftAnchor && annotations.displayMode === 'bubble' && indexed.size > 0;
  const items = visible ? (annotations.previews ?? (annotations.preview ? [annotations.preview] : [])) : [];
  const entries = items.flatMap(item => {
    const itemData = indexed.get(item.id);
    return itemData ? [{ item, ...itemData }] : [];
  }).sort((a, b) => a.item.rect.top - b.item.rect.top || a.number - b.number);
  const wide = geometry.width >= 820;
  const dualColumn = wide && annotations.dualColumn === true;
  const farRight = geometry.width - marginWidth + 21;
  const marginLeft = dualColumn && annotations.column ? Math.max(8, Math.min(farRight, annotations.column.right + 40)) : farRight;
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
  }) : [], geometry.height, annotations.activeId, dualColumn);

  // Scrolling on the margin is only needed when this viewport's annotations do not fit.
  const maxScroll = rail.contentHeight - geometry.height;
  const offset = Math.min(scrollTop, maxScroll);
  const selectedHeight = annotations.activeId ? geometry.cards[annotations.activeId]?.height : undefined;
  // Only a new selection, a card resizing, or a window resize can reveal a
  // card automatically. Anchor geometry arriving from a scroll frame cannot.
  useLayoutEffect(() => {
    const margin = scroller.current;
    const id = annotations.activeId;
    if (!id || !margin || !selectedHeight) return;
    const card = Array.from(margin.querySelectorAll<HTMLElement>('[data-bubble-id]')).find(el => el.dataset.bubbleId === id);
    if (!card || card.dataset.placement !== 'right') return;
    if (card.offsetTop >= margin.scrollTop && card.offsetTop + card.offsetHeight <= margin.scrollTop + margin.clientHeight) return;
    const first = Math.max(0, card.offsetTop - 10);
    const last = Math.max(first - Math.max(0, margin.clientHeight - 20 - card.offsetHeight), 0);
    const next = Math.max(last, Math.min(first, margin.scrollTop));
    if (Math.abs(next - margin.scrollTop) < 1) return;
    if (dualColumn && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches && margin.scrollTo) {
      margin.scrollTo({ top: next, behavior: 'smooth' });
    } else {
      margin.scrollTop = next;
      setScrollTop(margin.scrollTop);
    }
  }, [annotations.activeId, dualColumn, geometry.height, selectedHeight]);

  useLayoutEffect(() => {
    const margin = scroller.current;
    if (!visible || !dualColumn || !margin || !scrollDocument) return;
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      // Scroll an open replies list or textarea before scrolling the document.
      for (let node = event.target instanceof HTMLElement ? event.target : null; node && node !== margin; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)
          && (event.deltaY > 0 ? node.scrollTop < node.scrollHeight - node.clientHeight - 1 : node.scrollTop > 0)) return;
      }
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? margin.clientHeight : 1;
      if (event.cancelable && scrollDocument(event.deltaY * unit)) event.preventDefault();
    };
    margin.addEventListener('wheel', wheel, { passive: false });
    return () => margin.removeEventListener('wheel', wheel);
  }, [scrollDocument, dualColumn, visible]);

  const candidate = annotations.dualColumn && !annotations.enabled && !annotations.draftAnchor
    && annotations.discussionActions?.canReply ? annotations.selectionCandidate : null;
  const selectionAction = candidate ? <div className="annotation-selection-action" style={{
    '--annotation-selection-left': `${Math.max(8, candidate.rect.left + candidate.rect.width - 48)}px`,
    '--annotation-selection-top': `${Math.max(4, candidate.rect.top - 40)}px`,
  } as CSSProperties}>
    <span className="annotation-selection-quote">已选「{candidate.anchor.text}」</span>
    <button type="button" className="annotation-selection-cancel" onClick={annotations.dismissSelection}>取消</button>
    <button type="button" className="annotation-selection-confirm" aria-label="批注所选文字"
      onMouseDown={event => event.preventDefault()} onClick={annotations.acceptSelection}>批注</button>
  </div> : null;
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
      placement = { side: 'right', left: marginLeft, top: rail.tops.get(item.id) ?? 10 };
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
  useRailSelectionMotion(scroller, dualColumn && visible ? {
    active: annotations.activeId, documentTop: annotations.documentScrollTop ?? null, offset,
    tops: new Map(placed.flatMap(({ item, placement }) => placement?.side === 'right' ? [[item.id, placement.top]] : [])),
  } : null);
  // Keep the gutter even when every anchor has scrolled out of the iframe.
  if (!visible) return selectionAction;
  const returnToDock = () => {
    const number = annotations.activeId && indexed.get(annotations.activeId)?.number;
    annotations.setActiveId(null);
    if (number) requestAnimationFrame(() => dock.current?.querySelector<HTMLButtonElement>(`[data-annotation-number="${number}"]`)?.focus());
  };
  return <>
    {selectionAction}
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
    <div ref={canvas} className="annotation-bubble-canvas" aria-label="页面批注气泡" data-review-margin={dualColumn ? '' : undefined}
      style={dualColumn && annotations.column?.paper ? { '--review-margin-paper': annotations.column.paper } as CSSProperties : undefined}>
      <div className="annotation-bubble-scroll" ref={scroller} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
        tabIndex={maxScroll > 0 ? 0 : undefined} aria-label={maxScroll > 0 ? '滚动查看更多页边批注' : undefined}>
        <div className="annotation-bubble-space" style={{ minHeight: rail.contentHeight }}>
          {(maxScroll > 0 || (dualColumn && annotations.documentScrollTop != null)) && <div className="annotation-bubble-scroll-area" style={dualColumn ? { left: marginLeft, right: 'auto', width: 264 } : undefined} />}
          {wide && <svg className="annotation-bubble-connectors" aria-hidden="true">
            {placed.map(({ item, placement, size }) => {
              if (!placement || !size || (placement.side !== 'moved' && annotations.activeId !== item.id)) return null;
              const { rect } = item;
              const x = dualColumn && annotations.column ? Math.min(annotations.column.right + 10, marginLeft - 8)
                : Math.min(rect.left + rect.width + 8, geometry.width - marginWidth + 5);
              const start = Math.max(0, rect.top) + offset;
              const end = Math.min(geometry.height, rect.top + rect.height) + offset;
              const from = (start + end) / 2, to = placement.top + (dualColumn ? 20 : 27);
              if (dualColumn && (to < offset || to > offset + geometry.height)) return null;
              const left = placement.left > x;
              const target = left ? placement.left - 1 : placement.left + size.width + 1;
              return <g key={item.id} data-active-connector={annotations.activeId === item.id ? '' : undefined} className={placement.side === 'moved' ? 'is-moved' : undefined}>
                <path d={`M${x - 4},${start}h4V${end}h-4 M${x},${from} C${x + 16},${from} ${target + (left ? -16 : 16)},${to} ${target},${to}`} />
                <circle cx={target} cy={to} r={2} />
              </g>;
            })}
          </svg>}
          {placed.map(({ item, thread, excerpt, number, time, hue, placement, size }) => <BubbleCard key={item.id}
            thread={thread} excerpt={excerpt} number={number} time={time} hue={hue} annotations={annotations}
            placement={placement} mobileDock={docked} dualColumn={dualColumn} replyDrafts={replies.current} refreshReplies={refreshReplies}
            onBack={activeInDock ? returnToDock : undefined}
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

function BubbleCard({ thread, excerpt, number, time, hue, annotations, placement, mobileDock, dualColumn, replyDrafts, refreshReplies, onBack, onMove }: {
  thread: HostedSiteCommentDto; excerpt: string; number: number; time: string; hue: number; annotations: HostedAnnotations;
  placement?: Placement; mobileDock: boolean; dualColumn: boolean; replyDrafts: Map<string, MarginReply>;
  refreshReplies: () => void; onBack?: () => void; onMove: (point: Point | null) => void;
}) {
  const active = annotations.activeId === thread.id;
  const hasHidden = annotations.hasHiddenPreviews || annotations.allPreviewsHidden;
  const permissions = dualColumn ? annotations.discussionActions : null;
  const canResolve = permissions?.canResolve(thread.id);
  const [showOlder, setShowOlder] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const reply = replyDrafts.get(thread.id) ?? emptyReply;
  const replyBox = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const field = replyBox.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = Math.min(142, field.scrollHeight) + 'px';
  }, [reply.editing, reply.text]);
  const setReply = (next: MarginReply) => {
    // The card is removed while its anchor is off screen. Keep in-flight changes with the rail.
    if (next.editing || next.text) replyDrafts.set(thread.id, next);
    else replyDrafts.delete(thread.id);
    refreshReplies();
  };
  const visibleReplies = active && permissions ? permissions.getReplies(thread.id) : [];
  const beginReply = () => {
    setReply({ ...reply, editing: true });
    requestAnimationFrame(() => replyBox.current?.focus());
  };
  const sendReply = async () => {
    const current = replyDrafts.get(thread.id);
    if (!permissions?.canReply || !current?.text.trim() || current.sending) return;
    const submission = { ...current, clientId: current.clientId ?? crypto.randomUUID(), sending: true, error: undefined };
    setReply(submission);
    try {
      const error = await permissions.reply(thread.id, submission.text.trim(), submission.clientId);
      setReply(error ? { ...submission, sending: false, error } : emptyReply);
    } catch {
      setReply({ ...submission, sending: false, error: '发送失败，草稿已保留。' });
    }
  };
  const toggleResolved = async () => {
    if (!permissions || !canResolve || resolving) return;
    setResolving(true); setResolveError(null);
    try { setResolveError(await permissions.resolve(thread.id)); }
    catch { setResolveError('未能更新批注，请重试。'); }
    finally { setResolving(false); }
  };
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const resetTouch = useRef<{ id: number; x: number; y: number } | null>(null);
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
  return <div className={`annotation-chat-bubble${active ? ' is-active' : ''}`} role={dualColumn && !active ? 'group' : 'dialog'} aria-label={`批注气泡 ${number}`}
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
      if (reply.editing) {
        if (!reply.sending) setReply({ ...reply, editing: false });
        return;
      }
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
    <p className={active && expanded ? 'annotation-chat-full' : undefined}>{dualColumn && active && expanded ? thread.content : excerpt}</p>
    {active
      ? <>
        {dualColumn && thread.content.length > 110 && <button type="button" className="annotation-chat-more" onClick={() => setExpanded(value => !value)}>
          {expanded ? '收起全文' : `展开全文 · ${thread.content.length} 字`}
        </button>}
        {dualColumn && visibleReplies.length > 0 && <div className="annotation-chat-replies">
          {!showOlder && visibleReplies.length > 2 && <button type="button" onClick={() => setShowOlder(true)}>还有 {visibleReplies.length - 2} 条更早的回复</button>}
          {(showOlder ? visibleReplies : visibleReplies.slice(-2)).map(child => <div className="annotation-chat-reply" key={child.id}>
            <span className="annotation-chat-reply-author">{child.authorName}</span>
            <p>{annotationPreviewText(child.content)}</p>
          </div>)}
        </div>}
        <div className="annotation-chat-actions">
          {placement?.side === 'moved' && <button type="button" className={dualColumn ? 'annotation-chat-reset' : undefined}
            aria-label={dualColumn ? '放回原位' : undefined} title={dualColumn ? '放回原位' : undefined}
            onClick={() => onMove(null)} onPointerDown={event => {
            if (event.pointerType === 'touch') resetTouch.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          }} onPointerCancel={() => { resetTouch.current = null; }} onPointerUp={event => {
            const touch = resetTouch.current;
            resetTouch.current = null;
            if (!touch || touch.id !== event.pointerId || Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 10) return;
            const button = event.currentTarget;
            // Chromium can suppress the compatibility click immediately after a touch drag.
            if (button.contains(button.ownerDocument.elementFromPoint(event.clientX, event.clientY))) onMove(null);
          }}>{dualColumn ? <RotateCcw size={14} /> : '放回原位'}</button>}
          {permissions?.canReply && <button type="button" className="annotation-chat-reply-trigger" onClick={beginReply}><CornerDownLeft size={13} />回复</button>}
          {canResolve && <button type="button" onClick={() => void toggleResolved()} disabled={resolving}><Check size={13} />{thread.isResolved ? '重新打开' : '解决'}</button>}
          {!permissions?.canReply && !canResolve && <button type="button" className="annotation-chat-open" onClick={() => annotations.openThread(thread.id)}>查看讨论<ArrowUpRight size={13} /></button>}
        </div>
        {resolveError && <p role="alert" className="annotation-chat-error">{resolveError}</p>}
        {permissions?.canReply && reply.editing && <div className="annotation-chat-editor">
          {reply.error && <div className="annotation-chat-error" role="alert">{reply.error}<button type="button" onClick={() => void sendReply()}>重试</button></div>}
          <div className="annotation-chat-editor-target">回复 {thread.authorName}<button type="button" disabled={reply.sending}
            title="取消回复" aria-label="取消回复" onClick={() => setReply({ ...reply, editing: false })}><X size={13} /></button></div>
          <form onSubmit={event => { event.preventDefault(); void sendReply(); }}>
            <textarea ref={replyBox} rows={1} aria-label="写回复" placeholder="写回复…" value={reply.text} readOnly={reply.sending}
              onChange={event => setReply({ text: event.target.value, editing: true })}
              onKeyDown={event => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void sendReply(); }
              }} />
            <button type="submit" disabled={reply.sending || !reply.text.trim()} aria-label="发送回复"><Send size={14} /></button>
          </form>
        </div>}
        <div className="annotation-chat-controls">
          <button type="button" aria-label={hasHidden ? '显示全部气泡' : '隐藏全部气泡'} title={hasHidden ? '显示全部气泡' : '隐藏全部气泡'}
            onClick={() => hasHidden ? annotations.showAllPreviews() : annotations.hideAllPreviews()}>{hasHidden ? <Eye size={15} /> : <EyeOff size={15} />}</button>
          {onBack
            ? <button type="button" onClick={onBack} data-annotation-dock-back aria-label="返回批注摘要" title="返回批注摘要"><ArrowLeft size={15} /></button>
            : !dualColumn && <button type="button" onClick={() => annotations.dismissPreview(thread.id)} aria-label={`收起批注气泡 ${number}`} title="收起此气泡，保留页面标记"><X size={14} /></button>}
        </div>
      </>
      : <button type="button" className="annotation-chat-select" aria-label={`展开批注气泡 ${number}`} onClick={choose} />}
  </div>;
}
