import { loadingSceneForPath } from '@/components/skeletons/loadingScenes';
import { createContext, forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { Link as RouterLink, useLocation, useNavigate, useNavigationType, useResolvedPath, type LinkProps, type NavigateFunction, type NavigateOptions, type To } from 'react-router-dom';
import { runSurfaceMotion, skipSurfaceMotion, reducedSurfaceMotion } from '@/lib/surfaceMotion';

export const SurfaceOriginContext = createContext<Element | null>(null);
export function isSameDocumentFragment(href: string, currentHref: string): boolean {
  const current = new URL(currentHref), target = new URL(href, current);
  return (target.hash !== '' || href.endsWith('#')) && target.origin === current.origin
    && target.pathname === current.pathname && target.search === current.search;
}
export function isConsoleHref(href: string): boolean {
  if (!href.startsWith('/') || href.startsWith('//')) return false;
  const scene = loadingSceneForPath(new URL(href, 'https://console.invalid').pathname);
  return !!scene && scene.scope !== 'standalone';
}
interface ViewPosition { scroll: Array<{ selector: string; top: number; left: number }>; focus?: string }
interface Origin { url: string; key: string; anchor?: string }
interface Waiter { destination: string; origin?: Origin; finish(): void }
const positions = new Map<string, ViewPosition>();
const origins = new Map<string, Origin>();
const restoring = new Set<string>();
let waiter: Waiter | undefined;
let lastSource: Element | null = null;
function selectorFor(element: HTMLElement): string {
  if (element.classList.contains('cds-main')) return '.cds-main';
  const parts: string[] = []; let node: HTMLElement | null = element;
  while (node && !node.classList.contains('cds-main')) {
    const parent: HTMLElement | null = node.parentElement; if (!parent) return '';
    parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(node) + 1})`); node = parent;
  }
  return node ? `.cds-main > ${parts.join(' > ')}` : '';
}
function anchorFor(source: Element | null): string | undefined {
  const card = source?.closest<HTMLElement>('[data-project-id],[data-branch-card-id]');
  if (card?.dataset.projectId) return `[data-project-id="${CSS.escape(card.dataset.projectId)}"] a[href]`;
  if (card?.dataset.branchCardId) return `[data-branch-card-id="${CSS.escape(card.dataset.branchCardId)}"]`;
  const link = source?.closest<HTMLAnchorElement>('a[href]');
  return link ? `a[href="${CSS.escape(link.getAttribute('href') || '')}"]` : undefined;
}
function restoreVisit(key: string): () => void {
  const saved = positions.get(key); if (!saved) return () => undefined;
  restoring.add(key); let frame = 0, done = false, stableFrames = 0, previousLayout = '';
  const stop = () => { if (done) return; done = true; restoring.delete(key); observer.disconnect(); clearTimeout(timer); cancelAnimationFrame(frame); window.removeEventListener('wheel', stop, true); window.removeEventListener('pointerdown', stop, true); window.removeEventListener('keydown', stop, true); };
  const restore = () => {
    if (done) return;
    // Wait for actual data instead of clamping a saved position against the skeleton.
    const ready = saved.scroll.every(entry => { const node = document.querySelector<HTMLElement>(entry.selector); return node && node.scrollHeight - node.clientHeight + 1 >= entry.top; });
    const focus = saved.focus ? document.querySelector<HTMLElement>(saved.focus) : null;
    if (!ready || saved.focus && !focus) { stableFrames = 0; return; }
    for (const entry of saved.scroll) { const node = document.querySelector<HTMLElement>(entry.selector)!; node.scrollTop = entry.top; node.scrollLeft = entry.left; }
    focus?.focus({ preventScroll: true });
    // content-visibility:auto first exposes intrinsic placeholders. Browser scroll
    // anchoring can move the viewport when the real cards paint on the next frame.
    const rect = focus?.getBoundingClientRect();
    const layout = saved.scroll.map(entry => {
      const node = document.querySelector<HTMLElement>(entry.selector)!;
      return [node.scrollHeight, node.clientHeight, node.scrollTop, node.scrollLeft];
    }).concat(rect ? [[rect.top, rect.height, rect.width, rect.left]] : []).flat().join(':');
    stableFrames = layout === previousLayout ? stableFrames + 1 : 0;
    previousLayout = layout;
    if (stableFrames >= 3) stop();
    else frame = requestAnimationFrame(restore);
  };
  const observer = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore); });
  observer.observe(document.body, { childList: true, subtree: true });
  const timer = window.setTimeout(stop, 15_000);
  window.addEventListener('wheel', stop, true); window.addEventListener('pointerdown', stop, true); window.addEventListener('keydown', stop, true);
  frame = requestAnimationFrame(restore); return stop;
}
/** Mounted by the actual page shell, inside any owner/lazy Suspense boundary. */
export function RouteMotionCommit(): null {
  const location = useLocation(), type = useNavigationType();
  const previous = useRef(location);
  useLayoutEffect(() => {
    const hashOnly = previous.current.pathname === location.pathname && previous.current.search === location.search && previous.current.hash !== location.hash;
    previous.current = location;
    const current = waiter;
    if (current?.destination === location.pathname + location.search + location.hash) {
      if (current.origin) origins.set(location.key, current.origin);
      current.finish();
    }
    return type === 'POP' && !hashOnly ? restoreVisit(location.key) : undefined;
  }, [location.key, location.pathname, location.search, location.hash, type]);
  return null;
}

export function useSurfaceNavigate(): NavigateFunction {
  const navigate = useNavigate(), location = useLocation();
  return useCallback(((to: To | number, options?: NavigateOptions) => {
    if (typeof to === 'number') { navigate(to); return; }
    // Resolve object and string destinations without dropping state, relative or replace semantics.
    const raw = typeof to === 'string' ? to : `${to.pathname ?? location.pathname}${to.search ?? ''}${to.hash ?? ''}`;
    const destination = new URL(raw, window.location.href);
    if (/^\.\.?($|\/)/.test(raw) || destination.origin !== window.location.origin || destination.pathname === location.pathname || !isConsoleHref(destination.pathname) || !document.querySelector('.cds-main')) { navigate(to, options); return; }
    const url = destination.pathname + destination.search + destination.hash;
    const origin = origins.get(location.key);
    const returning = !options?.replace && options?.state === undefined && origin?.url === url;
    const source = lastSource?.isConnected ? lastSource : document.activeElement;
    const anchor = anchorFor(source);
    const saved = positions.get(location.key) ?? { scroll: [] }; saved.focus = anchor; positions.set(location.key, saved);
    const enterSource = source?.closest('[data-project-id],[data-branch-card-id]') || source;
    runSurfaceMotion(() => new Promise<void>(resolve => {
      waiter?.finish();
      const own: Waiter = { destination: url, origin: returning ? undefined : { url: location.pathname + location.search + location.hash, key: location.key, anchor }, finish: () => { clearTimeout(timer); if (waiter === own) waiter = undefined; resolve(); } };
      const timer = window.setTimeout(() => { if (waiter === own) { skipSurfaceMotion(); own.finish(); } }, 1500);
      waiter = own;
      if (returning) navigate(-1); else navigate(to, options);
    }), returning && origin?.anchor ? () => document.querySelector(origin.anchor!) : enterSource, returning);
  }) as NavigateFunction, [navigate, location]);
}

/** Preserve React Router Link's real navigation options and caller handlers. */
export const MotionLink = forwardRef<HTMLAnchorElement, LinkProps>(function MotionLink({ onClick, to, replace, state, relative, preventScrollReset, reloadDocument, target, ...props }, ref) {
  const navigate = useSurfaceNavigate(), resolved = useResolvedPath(to, { relative }), origin = useContext(SurfaceOriginContext);
  const nativeFragment = typeof window !== 'undefined' && isSameDocumentFragment(resolved.pathname + resolved.search + resolved.hash, window.location.href);
  return <RouterLink {...props} ref={ref} to={to} replace={replace} state={state} relative={relative} preventScrollReset={preventScrollReset} reloadDocument={reloadDocument || nativeFragment} target={target} onClick={event => {
    onClick?.(event);
    const targetUrl = new URL(event.currentTarget.href, window.location.href);
    if (nativeFragment || targetUrl.origin !== window.location.origin || !['http:', 'https:'].includes(targetUrl.protocol) || event.defaultPrevented || reloadDocument || target && target !== '_self' || props.download || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); lastSource = origin || event.currentTarget;
    navigate(resolved, { replace, state, relative, preventScrollReset });
  }} />;
});

export function RouteMotion(): null {
  const location = useLocation(), navigate = useSurfaceNavigate();
  useEffect(() => {
    const preference = () => document.documentElement.classList.toggle('cds-reduced-motion', reducedSurfaceMotion());
    const media = window.matchMedia('(prefers-reduced-motion: reduce)'); preference();
    media.addEventListener('change', preference); window.addEventListener('storage', preference); window.addEventListener('cds-motion-preference', preference);
    return () => { media.removeEventListener('change', preference); window.removeEventListener('storage', preference); window.removeEventListener('cds-motion-preference', preference); };
  }, []);
  useEffect(() => {
    const pointer = (event: Event) => { lastSource = event.target instanceof Element ? event.target : null; };
    const save = (event: Event) => {
      if (restoring.has(location.key) || !(event.target instanceof HTMLElement)) return;
      const selector = selectorFor(event.target); if (!selector) return;
      const saved = positions.get(location.key) ?? { scroll: [] };
      saved.scroll = saved.scroll.filter(entry => entry.selector !== selector).concat({ selector, top: event.target.scrollTop, left: event.target.scrollLeft }); positions.set(location.key, saved);
      if (positions.size > 100) positions.delete(positions.keys().next().value!);
    };
    // Native links are adapted after caller handlers. Router Links already prevent default and preserve their own state.
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element)?.closest<HTMLAnchorElement>('a[href]');
      if (!link || link.target && link.target !== '_self' || link.hasAttribute('download')) return;
      const url = new URL(link.href); if (url.origin !== window.location.origin || isSameDocumentFragment(link.href, window.location.href) || !isConsoleHref(url.pathname)) return;
      event.preventDefault(); lastSource = link; navigate(url.pathname + url.search + url.hash);
    };
    document.addEventListener('pointerdown', pointer, true); document.addEventListener('scroll', save, true); document.addEventListener('click', click);
    return () => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('scroll', save, true); document.removeEventListener('click', click); };
  }, [location.key, navigate]);
  return null;
}
