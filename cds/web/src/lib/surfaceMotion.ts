/** Same camera language as the approved monitor workspace; no spring or vertical drift. */
export const SURFACE_MOTION = { enter: 520, exit: 460, fade: 160, ease: 'cubic-bezier(.22,.8,.24,1)', maxScale: 2.2 } as const;
export interface SurfaceRect { x: number; y: number; w: number; h: number }
export function surfaceCamera(rect: SurfaceRect, width: number, height: number) {
  const scale = Math.max(1, Math.min(width / Math.max(1, rect.w), height / Math.max(1, rect.h)));
  const x = width / 2 - scale * (rect.x + rect.w / 2), y = height / 2 - scale * (rect.y + rect.h / 2);
  const zoom = Math.min(scale, SURFACE_MOTION.maxScale), cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  return {
    zoom: `translate(${cx - zoom * cx}px,${cy - zoom * cy}px) scale(${zoom})`,
    collapsed: `translate(${-x / scale}px,${-y / scale}px) scale(${1 / scale})`,
    clip: `inset(${Math.max(0, scale * rect.y + y)}px ${Math.max(0, width - (scale * rect.x + x + scale * rect.w))}px ${Math.max(0, height - (scale * rect.y + y + scale * rect.h))}px ${Math.max(0, scale * rect.x + x)}px round ${10 * scale}px)`,
  };
}
interface Transition { ready: Promise<void>; finished: Promise<void>; skipTransition(): void }
type MotionDocument = Document & { startViewTransition?: (change: () => void | Promise<void>) => Transition };
let active: Transition | undefined;
let generation = 0;
export function skipSurfaceMotion(): void { active?.skipTransition(); }
export function reducedSurfaceMotion(): boolean {
  let stored = false; try { stored = localStorage.getItem('cds.reduce-motion') === 'true'; } catch { /* storage is optional */ }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches || stored;
}
export function runSurfaceMotion(change: () => void | Promise<void>, source?: Element | null | (() => Element | null), reverse = false, detail = false): void {
  const ownGeneration = ++generation;
  const doc = document as MotionDocument, root = document.documentElement;
  if (!doc.startViewTransition || root.classList.contains('cds-theme-motion') || reducedSurfaceMotion()) { void change(); return; }
  active?.skipTransition();
  const sourceNode = typeof source === 'function' ? source() : source;
  const bounds = sourceNode?.getBoundingClientRect();
  const oldDrawer = document.querySelector('.cds-branch-detail-drawer')?.getBoundingClientRect();
  const content = document.querySelector('.cds-main')?.getBoundingClientRect();
  const rect = bounds && content ? { x: bounds.left - content.left, y: bounds.top - content.top, w: bounds.width, h: bounds.height } : undefined;
  let camera = rect && content ? surfaceCamera(rect, content.width, content.height) : undefined;
  root.classList.add('cds-surface-motion');
  let transition: Transition;
  try { transition = doc.startViewTransition(() => ownGeneration === generation ? change() : undefined); active = transition; }
  catch { root.classList.remove('cds-surface-motion'); void change(); return; }
  void transition.ready.then(() => {
    if (active !== transition) return;
    if (reverse && typeof source === 'function') {
      const current = source()?.getBoundingClientRect(), area = document.querySelector('.cds-main')?.getBoundingClientRect();
      if (current && area) camera = surfaceCamera({ x: current.left - area.left, y: current.top - area.top, w: current.width, h: current.height }, area.width, area.height);
    }
    const duration = reverse ? SURFACE_MOTION.exit : SURFACE_MOTION.enter;
    const animate = (name: string, frames: Keyframe[], time: number = duration) => root.animate(frames, { duration: time, easing: SURFACE_MOTION.ease, fill: 'both', pseudoElement: name });
    if (detail) {
      const drawer = (reverse ? oldDrawer : document.querySelector('.cds-branch-detail-drawer')?.getBoundingClientRect());
      const target = reverse ? sourceNode?.getBoundingClientRect() : bounds;
      // Snapshot the fixed drawer, never transform its live DOM or containing block.
      if (drawer && target) {
        const transform = `translate(${target.left - drawer.left}px,${target.top - drawer.top}px) scale(${target.width / drawer.width},${target.height / drawer.height})`;
        animate(reverse ? '::view-transition-old(cds-detail)' : '::view-transition-new(cds-detail)', reverse ? [{ transform: 'none', opacity: 1 }, { transform, opacity: 0 }] : [{ transform, opacity: 0 }, { transform: 'none', opacity: 1 }]);
      }
    } else if (camera) {
      const old = [{ transform: 'none', opacity: 1 }, { transform: camera.zoom, opacity: 0 }];
      const next = [{ transform: camera.collapsed, clipPath: camera.clip, opacity: 0 }, { transform: 'none', clipPath: 'inset(0)', opacity: 1 }];
      animate('::view-transition-old(cds-content)', reverse ? [...next].reverse() : old);
      animate('::view-transition-new(cds-content)', reverse ? [...old].reverse() : next);
    } else {
      animate('::view-transition-old(cds-content)', [{ opacity: 1 }, { opacity: 0 }], SURFACE_MOTION.fade);
      animate('::view-transition-new(cds-content)', [{ opacity: 0 }, { opacity: 1 }], SURFACE_MOTION.fade);
    }
  }).catch(() => undefined);
  void transition.finished.catch(() => undefined).finally(() => { if (active === transition) { active = undefined; root.classList.remove('cds-surface-motion'); } });
}
