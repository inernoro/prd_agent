import { useEffect, useRef, type RefObject } from 'react';

/** Native dialogs in this console use portals; keep keyboard work inside the active surface. */
export function useDialogFocus(ref: RefObject<HTMLElement>, onClose: () => void, busy = false, fallbackSelector?: string, enabled = true) {
  const close = useRef(onClose); close.current = onClose;
  const blocked = useRef(busy); blocked.current = busy;
  useEffect(() => {
    if (!enabled) return;
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('input,select,textarea,button,a[href],summary,[tabindex]')).filter(node => !node.matches(':disabled,[tabindex="-1"]') && node.getClientRects().length > 0);
    const options = controls();
    (options.find(node => /^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) || options[0] || dialog).focus({ preventScroll: true });
    const handle = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault(); event.stopPropagation();
        const disclosure = document.activeElement?.closest('details[open]');
        if (disclosure && dialog.contains(disclosure)) { disclosure.removeAttribute('open'); disclosure.querySelector('summary')?.focus(); return; }
        if (!blocked.current) close.current();
      }
      if (event.key !== 'Tab') return;
      const items = controls(), first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', handle);
    return () => {
      dialog.removeEventListener('keydown', handle);
      const target = opener?.isConnected && opener.getClientRects().length ? opener : fallbackSelector ? document.querySelector<HTMLElement>(fallbackSelector) : null;
      target?.focus({ preventScroll: true });
    };
  }, [ref, fallbackSelector, enabled]);
}
