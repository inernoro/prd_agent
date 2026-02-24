import { useSyncExternalStore } from 'react';

export type Breakpoint = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

export interface BreakpointState {
  breakpoint: Breakpoint;
  /** < 768px */
  isMobile: boolean;
  /** 768px – 1023px */
  isTablet: boolean;
  /** ≥ 1024px */
  isDesktop: boolean;
  width: number;
}

const BP_THRESHOLDS: [number, Breakpoint][] = [
  [1536, '2xl'],
  [1280, 'xl'],
  [1024, 'lg'],
  [768, 'md'],
  [480, 'sm'],
  [0, 'xs'],
];

function resolve(w: number): BreakpointState {
  const bp = BP_THRESHOLDS.find(([min]) => w >= min)![1];
  return {
    breakpoint: bp,
    isMobile: w < 768,
    isTablet: w >= 768 && w < 1024,
    isDesktop: w >= 1024,
    width: w,
  };
}

// --- external-store pattern (avoids tearing in concurrent mode) ---

let current = resolve(typeof window !== 'undefined' ? window.innerWidth : 1280);
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): BreakpointState {
  return current;
}

function getServerSnapshot(): BreakpointState {
  return resolve(1280);
}

if (typeof window !== 'undefined') {
  const update = () => {
    const next = resolve(window.innerWidth);
    if (next.breakpoint !== current.breakpoint || next.width !== current.width) {
      current = next;
      listeners.forEach((cb) => cb());
    }
  };
  window.addEventListener('resize', update, { passive: true });
}

/**
 * 响应式断点 Hook — 返回当前视口断点及便捷布尔值。
 *
 * ```ts
 * const { isMobile, isDesktop, breakpoint } = useBreakpoint();
 * ```
 */
export function useBreakpoint(): BreakpointState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
