import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { crossesSelection, overlapsSelection, paintSelection, selectionBounds, type SelectionBounds, type SelectionPoint } from './siteSelectionGeometry';

type Operation = {
  kind: 'box' | 'paint'; pointerId: number; base: Set<string>; visited: Set<string>; select: boolean; additive: boolean;
  start: SelectionPoint; last: SelectionPoint; point: SelectionPoint; scrollTop: number; scrollLeft: number; moved: boolean;
};

export function useHostedSiteSelection({ container, enabled, mode, selected, onChange, visibleIds }: {
  container: RefObject<HTMLDivElement>; enabled: boolean; mode: boolean; selected: Set<string>;
  onChange: (next: Set<string>) => void; visibleIds: string[];
}) {
  const [rectangle, setRectangle] = useState<SelectionBounds | null>(null);
  const settings = useRef({ enabled, mode, selected, onChange });
  const operation = useRef<Operation | null>(null);
  const frame = useRef(0);
  const suppressClick = useRef(false);
  const originalSelect = useRef('');
  const idsKey = visibleIds.join(',');
  useLayoutEffect(() => { settings.current = { enabled, mode, selected, onChange }; });
  useEffect(() => {
    const valid = new Set(idsKey.split(','));
    const current = settings.current.selected;
    if ([...current].some(id => !valid.has(id))) settings.current.onChange(new Set([...current].filter(id => valid.has(id))));
  }, [idsKey]);
  const process = () => {
    frame.current = 0;
    const op = operation.current, root = container.current;
    if (!op || !root) return;
    const start = { x: op.start.x - (root.scrollLeft - op.scrollLeft), y: op.start.y - (root.scrollTop - op.scrollTop) };
    op.moved ||= Math.hypot(op.point.x - op.start.x, op.point.y - op.start.y) > 5;
    const bounds = selectionBounds(start, op.point);
    const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-hosted-site-id]'));
    const touched = cards.filter(card => {
      const rect = card.getBoundingClientRect();
      return op.kind === 'box' ? overlapsSelection(bounds, rect) : crossesSelection(op.last, op.point, rect);
    }).map(card => card.dataset.hostedSiteId!);
    const publish = (next: Set<string>) => {
      const current = settings.current.selected;
      if (current.size !== next.size || [...next].some(id => !current.has(id))) settings.current.onChange(next);
    };
    if (op.kind === 'paint') {
      for (const id of touched) op.visited.add(id);
      publish(paintSelection(op.base, op.visited, op.select));
    } else if (op.moved) {
      publish(paintSelection(op.additive ? op.base : new Set(), touched, true));
      const viewport = root.getBoundingClientRect();
      setRectangle({ left: Math.max(bounds.left, viewport.left), top: Math.max(bounds.top, viewport.top),
        right: Math.min(bounds.right, viewport.right), bottom: Math.min(bounds.bottom, viewport.bottom) });
    }
    op.last = { ...op.point };
    const viewport = root.getBoundingClientRect();
    const dy = op.point.y < viewport.top + 28 ? -14 : op.point.y > viewport.bottom - 28 ? 14 : 0;
    if (op.moved && dy) {
      const previous = root.scrollTop; root.scrollTop += dy;
      if (root.scrollTop !== previous) frame.current = requestAnimationFrame(() => tick.current());
    }
  };
  const tick = useRef(process);
  useLayoutEffect(() => { tick.current = process; });
  useEffect(() => {
    const root = container.current;
    const finish = (cancel: boolean) => {
      const op = operation.current;
      if (!op) return;
      if (!cancel) tick.current();
      operation.current = null;
      cancelAnimationFrame(frame.current); frame.current = 0;
      if (root) {
        root.style.userSelect = originalSelect.current;
        try { root.releasePointerCapture(op.pointerId); } catch { /* 指针已由浏览器释放。 */ }
      }
      if (cancel) settings.current.onChange(op.base);
      else if (op.kind === 'box' && !op.moved && !op.additive) settings.current.onChange(new Set());
      suppressClick.current = cancel || op.kind === 'paint' || op.moved;
      if (!cancel) window.setTimeout(() => { suppressClick.current = false; }, 0);
      setRectangle(null);
    };
    const move = (event: PointerEvent) => {
      const op = operation.current;
      if (!op || event.pointerId !== op.pointerId) return;
      op.point = { x: event.clientX, y: event.clientY };
      if (!frame.current) frame.current = requestAnimationFrame(() => tick.current());
      event.preventDefault();
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId === operation.current?.pointerId) finish(false);
      else if (suppressClick.current) window.setTimeout(() => { suppressClick.current = false; }, 0);
    };
    const cancel = () => finish(true);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && operation.current) { event.preventDefault(); event.stopPropagation(); finish(true); }
    };
    const click = (event: MouseEvent) => {
      if (suppressClick.current && root?.contains(event.target as Node)) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick.current = false; }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('click', click, true);
    return () => {
      cancelAnimationFrame(frame.current); operation.current = null;
      if (root) root.style.userSelect = originalSelect.current;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true); window.removeEventListener('click', click, true);
    };
  }, [container]);
  const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!operation.current) suppressClick.current = false;
    const config = settings.current, root = container.current;
    if (!config.enabled || event.pointerType !== 'mouse' || event.button !== 0 || !root) return;
    const target = event.target as HTMLElement;
    if (!root.contains(target)) return;
    const checkbox = target.closest('[data-site-select]');
    const card = target.closest<HTMLElement>('[data-hosted-site-id]');
    if (!checkbox && target.closest('button,a,input,textarea,select,[data-no-drag],[role="button"]')) return;
    if (card && !checkbox && !config.mode) return;
    const point = { x: event.clientX, y: event.clientY };
    const id = card?.dataset.hostedSiteId;
    operation.current = { kind: card ? 'paint' : 'box', pointerId: event.pointerId, base: new Set(config.selected),
      visited: new Set(id ? [id] : []), select: id ? !config.selected.has(id) : true, additive: event.ctrlKey || event.metaKey || event.shiftKey,
      start: point, last: point, point, scrollTop: root.scrollTop, scrollLeft: root.scrollLeft, moved: false };
    originalSelect.current = root.style.userSelect; root.style.userSelect = 'none';
    if (card) config.onChange(paintSelection(operation.current.base, operation.current.visited, operation.current.select));
    try { root.setPointerCapture(event.pointerId); } catch { /* 非捕获环境仍由 window 监听。 */ }
    event.preventDefault(); event.stopPropagation();
  };
  return { rectangle, onPointerDownCapture };
}
