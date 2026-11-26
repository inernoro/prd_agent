import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FLIGHT_DURATION = 1440;
const LANDING_DELAY = FLIGHT_DURATION - 120;

export interface GatherMotionGeometry {
  from: DOMRectReadOnly;
  to: DOMRectReadOnly;
  target: HTMLElement;
}

/** 在源内容关闭前，记录它和接收入口的位置。 */
export function captureGatherMotion(from: DOMRectReadOnly, target: HTMLElement | null): GatherMotionGeometry | null {
  if (!target?.isConnected || !from.width || !from.height || typeof target.animate !== 'function'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
  const to = target.getBoundingClientRect();
  return to.width && to.height ? { from, to, target } : null;
}

function landingSpring(): Keyframe[] {
  const angularFrequency = (2 * Math.PI) / 0.42;
  const damping = 0.55;
  const dampedFrequency = angularFrequency * Math.sqrt(1 - damping * damping);
  return Array.from({ length: 49 }, (_, index) => {
    const offset = index / 48;
    const time = 0.42 * 2.4 * offset;
    const displacement = Math.exp(-damping * angularFrequency * time) *
      (Math.cos(dampedFrequency * time) + ((damping * angularFrequency) / dampedFrequency) * Math.sin(dampedFrequency * time));
    return { transform: `scale(${(1 + 0.16 * displacement).toFixed(4)}, ${(1 - 0.14 * displacement).toFixed(4)})`, offset };
  });
}

/** 归纳动效。接收方的回弹、辉光与收拢轨迹在同一帧预约。 */
export function GatherMotion({ geometry, children, className, onDone }: {
  geometry: GatherMotionGeometry;
  children: ReactNode;
  className?: string;
  onDone: () => void;
}) {
  const token = useRef<HTMLDivElement>(null);
  const halo = useRef<HTMLDivElement>(null);
  const ripple = useRef<HTMLDivElement>(null);
  const finish = useRef(onDone);
  finish.current = onDone;
  const { from, to, target } = geometry;
  const fromX = from.left + from.width / 2;
  const fromY = from.top + from.height / 2;

  useLayoutEffect(() => {
    if (!token.current || !halo.current || !ripple.current || !target.isConnected) {
      finish.current();
      return;
    }
    const dx = to.left + to.width / 2 - fromX;
    const dy = to.top + to.height / 2 - fromY;
    const flight = token.current.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.95 },
      { transform: `translate(-50%,-50%) translate(${dx * 0.5}px, ${dy * 0.5 - 36}px) scale(0.85)`, opacity: 1, offset: 0.55 },
      { transform: `translate(-50%,-50%) translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 },
    ], { duration: FLIGHT_DURATION, easing: 'cubic-bezier(.4,0,.2,1)' });
    const impact = target.animate(landingSpring(), { duration: 560, delay: LANDING_DELAY, easing: 'linear' });
    const highlight = target.animate([
      { borderColor: 'var(--accent-primary)', color: 'var(--accent-fg-info)', offset: 0 }, { offset: 1 },
    ], { duration: 700, delay: LANDING_DELAY, easing: 'ease-out' });
    const glow = halo.current.animate([
      { opacity: 0, transform: 'scale(0.55)' },
      { opacity: 0.95, transform: 'scale(1.05)', offset: 0.12 },
      { opacity: 0.3, transform: 'scale(1.25)', offset: 0.4 },
      { opacity: 0, transform: 'scale(1.45)' },
    ], { duration: 620, delay: LANDING_DELAY, easing: 'cubic-bezier(.2,.7,.3,1)' });
    const ring = ripple.current.animate([
      { opacity: 0.9, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.9)' },
    ], { duration: 520, delay: LANDING_DELAY, easing: 'cubic-bezier(.1,.6,.3,1)' });
    glow.onfinish = () => finish.current();
    return () => {
      glow.onfinish = null;
      flight.cancel();
      glow.cancel();
      ring.cancel();
      // 取消尚未开始的接收反馈，已经接住后让原入口自然回弹。
      for (const animation of [impact, highlight]) {
        if (typeof animation.currentTime !== 'number' || animation.currentTime < LANDING_DELAY) animation.cancel();
      }
    };
  }, [fromX, fromY, to, target]);

  return createPortal(<>
    <div ref={token} className={className} data-gather-motion="flight" aria-hidden="true"
      style={{ position: 'fixed', left: fromX, top: fromY, zIndex: 10001, pointerEvents: 'none', opacity: 0 }}>
      {children}
    </div>
    <div ref={halo} data-gather-motion="halo" aria-hidden="true" style={{
      position: 'fixed', left: to.left - 16, top: to.top - 16, width: to.width + 32, height: to.height + 32,
      borderRadius: 18, zIndex: 10000, pointerEvents: 'none', opacity: 0, filter: 'blur(2px)',
      background: 'radial-gradient(closest-side, transparent 46%, rgba(167,139,250,0.55) 70%, transparent 100%)',
    }} />
    <div ref={ripple} data-gather-motion="ripple" aria-hidden="true" style={{
      position: 'fixed', left: to.left, top: to.top, width: to.width, height: to.height,
      borderRadius: 10, zIndex: 10000, pointerEvents: 'none', opacity: 0, border: '1.5px solid rgba(196,181,253,0.9)',
    }} />
  </>, document.body);
}
