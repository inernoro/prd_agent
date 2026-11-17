import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

type Anchor = { getBoundingClientRect(): Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>; contains?(node: Node): boolean };
export type PopoverAnchor = { readonly current: Anchor | null };
interface PositionOptions {
  open: boolean;
  anchorRef: PopoverAnchor;
  panelRef: RefObject<HTMLElement | null>;
  width?: number | 'anchor';
  widthRem?: number;
  minWidthRem?: number;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top' | 'right';
  gap?: number;
  maxHeightRem?: number;
}
const useLayout = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Shared geometry for menus, searchable suggestions and pointer-anchored actions.
 * Coordinates and viewport offsets use CSS pixels returned by browser geometry APIs. */
export function useAnchoredPosition({ open, anchorRef, panelRef, width, widthRem, minWidthRem, align = 'start', side = 'bottom', gap = 6, maxHeightRem }: PositionOptions): CSSProperties {
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  useLayout(() => {
    if (!open) {
      // A reopened panel must not become visible at its previous coordinates
      // before its new node, focus scope and geometry have been installed.
      setPosition(old => old.visibility === 'hidden' ? old : { position: 'fixed', visibility: 'hidden' });
      return;
    }
    let frame = 0;
    const update = (): void => {
      const anchor = anchorRef.current, panel = panelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect(), viewport = window.visualViewport;
      const margin = 8;
      const leftEdge = (viewport?.offsetLeft ?? 0) + margin;
      const topEdge = (viewport?.offsetTop ?? 0) + margin;
      const rightEdge = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? document.documentElement.clientWidth) - margin;
      const bottomEdge = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight) - margin;
      const availableWidth = Math.max(0, rightEdge - leftEdge);
      const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const requestedWidth = width === 'anchor' ? rect.width : width ?? (widthRem === undefined ? panel.getBoundingClientRect().width : widthRem * rootSize);
      const panelWidth = Math.min(Math.max(0, requestedWidth, (minWidthRem ?? 0) * rootSize), availableWidth);
      // Measure at the clamped width before reading scrollHeight, so wrapping is included.
      panel.style.minWidth = '0';
      panel.style.maxWidth = `${availableWidth}px`;
      panel.style.width = `${panelWidth}px`;
      const previousMaxHeight = panel.style.maxHeight;
      const previousScrollTop = panel.scrollTop;
      panel.style.maxHeight = 'none';
      const fullHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
      panel.style.maxHeight = previousMaxHeight;
      panel.scrollTop = previousScrollTop;
      const cap = maxHeightRem === undefined ? Infinity : maxHeightRem * rootSize;
      const below = Math.max(0, bottomEdge - Math.max(topEdge, rect.bottom + gap));
      const above = Math.max(0, Math.min(bottomEdge, rect.top - gap) - topEdge);
      const opensAbove = side === 'top' ? above >= Math.min(fullHeight, cap) || above > below : Math.min(fullHeight, cap) > below && above > below;
      let maxHeight = Math.min(cap, opensAbove ? above : below);
      let height = Math.min(fullHeight, maxHeight);
      let top = opensAbove ? rect.top - gap - height : rect.bottom + gap;
      let left = align === 'end' ? rect.right - panelWidth : rect.left;
      if (side === 'right' && rightEdge - rect.right - gap >= panelWidth) {
        maxHeight = Math.min(cap, Math.max(0, bottomEdge - topEdge));
        height = Math.min(fullHeight, maxHeight);
        left = rect.right + gap;
        top = rect.bottom - height;
      }
      left = Math.max(leftEdge, Math.min(left, rightEdge - panelWidth));
      top = Math.max(topEdge, Math.min(top, bottomEdge - height));
      const next: CSSProperties = { position: 'fixed', left, top, right: 'auto', bottom: 'auto', width: panelWidth,
        minWidth: 0, maxWidth: availableWidth, maxHeight, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        visibility: maxHeight > 0 && availableWidth > 0 ? 'visible' : 'hidden' };
      setPosition(old => Object.keys(next).every(key => old[key as keyof CSSProperties] === next[key as keyof CSSProperties]) ? old : next);
    };
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    // Ancestor resizing can move an anchor without changing the anchor's own size.
    let ancestor = anchorRef.current instanceof Element ? anchorRef.current : null;
    while (ancestor) { resize.observe(ancestor); ancestor = ancestor.parentElement; }
    if (panelRef.current) resize.observe(panelRef.current);
    let observedChildren = new Set<Element>();
    const observeContent = (): void => {
      const children = new Set<Element>(panelRef.current?.children ?? []);
      for (const child of observedChildren) if (!children.has(child)) resize.unobserve(child);
      for (const child of children) if (!observedChildren.has(child)) resize.observe(child);
      observedChildren = children;
    };
    observeContent();
    const mutations = new MutationObserver(() => { observeContent(); schedule(); });
    if (panelRef.current) mutations.observe(panelRef.current, { childList: true, characterData: true, subtree: true });
    update(); schedule();
    window.addEventListener('resize', schedule);
    const scroll = (event: Event): void => {
      // Scrolling the choices does not move their anchor. Re-measuring them here
      // would also perturb the list's own scroll position during measurement.
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      schedule();
    };
    document.addEventListener('scroll', scroll, true);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', schedule); document.removeEventListener('scroll', scroll, true);
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule);
    };
  }, [open, anchorRef, panelRef, width, widthRem, minWidthRem, align, side, gap, maxHeightRem]);
  return position;
}

export function AnchoredPopover({ open, anchorRef, onDismiss, width, widthRem, minWidthRem, align, side, gap, maxHeightRem,
  children, style, autoFocus = false, tabIntoPanel = true, contentRef, ...props }: Omit<HTMLAttributes<HTMLDivElement>, 'autoFocus'> & {
  open: boolean; anchorRef: PopoverAnchor; onDismiss?: () => void; width?: number | 'anchor'; widthRem?: number; minWidthRem?: number;
  contentRef?: RefObject<HTMLDivElement>;
  align?: 'start' | 'end'; side?: 'bottom' | 'top' | 'right'; gap?: number; maxHeightRem?: number;
  autoFocus?: false | 'first' | 'last'; tabIntoPanel?: boolean; children: ReactNode;
}): JSX.Element | null {
  const localRef = useRef<HTMLDivElement>(null);
  const panelRef = contentRef ?? localRef;
  const focusedOnOpen = useRef(false);
  const dismissRef = useRef(onDismiss); dismissRef.current = onDismiss;
  const position = useAnchoredPosition({ open, anchorRef, panelRef, width, widthRem, minWidthRem, align, side, gap, maxHeightRem });
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event): void => {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !anchorRef.current?.contains?.(target)) dismissRef.current?.();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Tab' && !event.defaultPrevented) {
        if (!tabIntoPanel) return; // Comboboxes retain their native form Tab order.
        const panel = panelRef.current, anchor = anchorRef.current;
        const items = [...(panel?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled),button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]') ?? [])]
          .filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== 'hidden' && item.getAttribute('aria-disabled') !== 'true');
        const active = document.activeElement;
        const returnTarget = anchor instanceof HTMLElement
          ? anchor.matches('button,input,summary,[tabindex]') ? anchor : anchor.querySelector<HTMLElement>('input,button,summary,[tabindex]')
          : null;
        const target = !event.shiftKey && active && anchor?.contains?.(active) ? items[0]
          : event.shiftKey && active === items[0] ? returnTarget : null;
        if (target) { event.preventDefault(); target.focus({ preventScroll: true }); }
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      const anchor = anchorRef.current;
      if (anchor instanceof HTMLElement) {
        const focusable = anchor.matches('button,input,summary,[tabindex]') ? anchor : anchor.querySelector<HTMLElement>('input,button,summary,[tabindex]');
        focusable?.focus({ preventScroll: true });
      }
      dismissRef.current?.();
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', key); };
  }, [open, anchorRef, tabIntoPanel]);
  useEffect(() => {
    if (!open) { focusedOnOpen.current = false; return; }
    if (!autoFocus || focusedOnOpen.current || position.visibility !== 'visible') return;
    const items = panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled),button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]');
    const target = autoFocus === 'last' ? items?.[items.length - 1] : items?.[0];
    if (target) { focusedOnOpen.current = true; target.focus({ preventScroll: true }); }
  }, [open, autoFocus, position.visibility, children, panelRef]);
  if (!open) return null;
  // Preserve readable fallback markup for server-rendered consumers.
  if (typeof document === 'undefined') return <div {...props}>{children}</div>;
  return createPortal(<div {...props} ref={panelRef} data-cds-anchored-popover="" style={{ ...style, ...position }}
    onClick={event => { props.onClick?.(event); event.stopPropagation(); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && onDismiss) {
        event.preventDefault(); event.stopPropagation();
        const anchor = anchorRef.current;
        if (anchor instanceof HTMLElement) {
          (anchor.matches('button,input,summary,[tabindex]') ? anchor : anchor.querySelector<HTMLElement>('input,button,summary,[tabindex]'))?.focus({ preventScroll: true });
        }
        onDismiss(); return;
      }
      props.onKeyDown?.(event);
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
      if (event.defaultPrevented || props.role !== 'menu' || /^(INPUT|SELECT|TEXTAREA)$/.test((event.target as HTMLElement).tagName)) return;
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')].filter(item => item.getClientRects().length);
      if (!items.length) return;
      event.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[index].focus();
    }}>{children}</div>, document.body);
}
