import { useCallback, useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react';

/** Keep native details and its measured panel on opposite sides of the trigger. */
function positionPanel(details: HTMLDetailsElement) {
  if (!details.open || !details.isConnected) return;
  const summary = details.querySelector('summary');
  const panel = details.querySelector<HTMLElement>('[data-toolbar-panel]');
  if (!summary || !panel) return;
  const anchor = summary.getBoundingClientRect();
  if (anchor.bottom <= 0 || anchor.top >= window.innerHeight) {
    details.open = false;
    return;
  }
  const edge = 16, gap = 8;
  const header = document.querySelector('.lg-console-header')?.getBoundingClientRect();
  const topEdge = Math.max(edge, header && header.top <= edge ? header.bottom + gap : edge);
  const scrollTop = panel.scrollTop;
  // Clear previous constraints before measuring responsive width and full content height.
  panel.style.width = ''; panel.style.left = ''; panel.style.right = ''; panel.style.maxHeight = 'none';
  const width = Math.min(panel.getBoundingClientRect().width, Math.max(0, window.innerWidth - edge * 2));
  const left = Math.max(edge, Math.min(anchor.left, window.innerWidth - width - edge));
  panel.style.width = `${width}px`; panel.style.left = `${left}px`; panel.style.right = 'auto';
  const naturalHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
  const below = Math.max(0, window.innerHeight - edge - anchor.bottom - gap);
  const above = Math.max(0, anchor.top - gap - topEdge);
  const placeBelow = naturalHeight <= below || (naturalHeight > above && below >= above);
  const available = placeBelow ? below : above;
  const height = Math.min(naturalHeight, available);
  panel.style.maxHeight = `${available}px`;
  panel.style.top = `${placeBelow ? anchor.bottom + gap : anchor.top - gap - height}px`;
  panel.scrollTop = scrollTop;
}

export function useToolbarPopover() {
  const current = useRef<HTMLDetailsElement | null>(null);
  const [node, setNode] = useState<HTMLDetailsElement | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useCallback((element: HTMLDetailsElement | null) => {
    current.current = element; setNode(element); setOpen(Boolean(element?.open));
  }, []);
  const close = useCallback((returnFocus = true) => {
    const element = current.current;
    if (!element) return;
    element.open = false; setOpen(false);
    if (returnFocus) element.querySelector('summary')?.focus({ preventScroll: true });
  }, []);
  const onToggle = useCallback((event: SyntheticEvent<HTMLDetailsElement>) => {
    const element = event.currentTarget;
    if (element !== current.current) return;
    if (element.open) {
      document.querySelectorAll<HTMLDetailsElement>('details[data-toolbar-popover][open]').forEach(other => {
        if (other !== element) other.open = false;
      });
      positionPanel(element);
    }
    setOpen(element.open);
  }, []);
  useLayoutEffect(() => {
    if (!node || !open || !node.open) return;
    const position = () => positionPanel(node);
    const scroll = (event: Event) => {
      const panel = node.querySelector('[data-toolbar-panel]');
      if (panel?.contains(event.target as Node)) return;
      position();
    };
    const outside = (event: PointerEvent) => {
      if (!node.open || node.contains(event.target as Node)) return;
      // Existing confirmation dialogs own their pointer/focus lifecycle while displayed.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !node.open) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      event.preventDefault(); event.stopPropagation();
      close(node.contains(document.activeElement) || document.activeElement === document.body);
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', scroll, true);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    const panel = node.querySelector<HTMLElement>('[data-toolbar-panel]');
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(position) : null;
    if (panel) observer?.observe(panel);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', scroll, true);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
      observer?.disconnect();
    };
  }, [node, open, close]);
  return { ref, onToggle, close };
}
