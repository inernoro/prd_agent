import { useEffect, useRef } from 'react';

const MENU = 'details.lg-user-menu, details.lg-tenant-switcher, details.gateway-account-organizations, details.gateway-entry-help';

/** Dismiss transient disclosures without collapsing business forms or nested ancestors. */
export function useDismissableMenus(route: string) {
  const root = useRef<HTMLDivElement>(null);
  const routeFocus = useRef(false);
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const menus = () => Array.from(host.querySelectorAll<HTMLDetailsElement>(MENU)).filter(menu => menu.open);
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      for (const menu of menus()) if (!menu.contains(event.target)) menu.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const opened = menus();
      const menu = opened[opened.length - 1];
      if (!menu) return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true });
    };
    const rememberNavigation = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.target === '_blank' || !menus().some(menu => menu.contains(link))) return;
      const next = new URL(link.href, window.location.href);
      if (next.origin === window.location.origin && (next.pathname !== window.location.pathname || next.search !== window.location.search)) routeFocus.current = true;
    };
    const select = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const action = event.target.closest('a[href], button:not(:disabled)');
      if (!action || !host.contains(action)) return;
      for (const menu of menus()) if (menu.contains(action)) menu.open = false;
    };
    const exclusive = (event: Event) => {
      const opened = event.target;
      if (!(opened instanceof HTMLDetailsElement) || !opened.open || !opened.matches(MENU)) return;
      for (const menu of menus()) {
        if (menu !== opened && !menu.contains(opened) && !opened.contains(menu)) menu.open = false;
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape);
    document.addEventListener('click', rememberNavigation, true);
    document.addEventListener('click', select);
    host.addEventListener('toggle', exclusive, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape);
      document.removeEventListener('click', rememberNavigation, true);
      document.removeEventListener('click', select);
      host.removeEventListener('toggle', exclusive, true);
    };
  }, []);
  useEffect(() => {
    const host = root.current;
    const opened = Array.from(host?.querySelectorAll<HTMLDetailsElement>(MENU) ?? []).filter(menu => menu.open);
    const ownedFocus = opened.some(menu => menu.contains(document.activeElement));
    opened.forEach(menu => { menu.open = false; });
    const restore = ownedFocus || routeFocus.current;
    routeFocus.current = false;
    if (restore) {
      const target = host?.querySelector<HTMLElement>('main h1') ?? host?.querySelector<HTMLElement>('main');
      if (target) { if (!target.hasAttribute('tabindex')) target.tabIndex = -1; target.focus({ preventScroll: true }); }
    }
  }, [route]);
  return root;
}
