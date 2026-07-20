import { prefersReducedMotion } from '@/lib/themeApplier';
import type { MobileThemeMode } from '@/stores/mobileThemeStore';

type ViewTransitionLike = {
  ready: Promise<void>;
  finished: Promise<void>;
  skipTransition?: () => void;
};

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => ViewTransitionLike;
};

export type ThemeTransitionOrigin = {
  clientX?: number;
  clientY?: number;
  currentTarget?: EventTarget | null;
};

type ThemeModeTransitionOptions = {
  mode: MobileThemeMode;
  pathname: string;
  origin?: ThemeTransitionOrigin;
  commit: (mode: MobileThemeMode) => void;
};

const SELF_MANAGED_THEME_PATHS = ['/daily-post', '/report-agent'];
let activeTransition: ViewTransitionLike | null = null;

export function isSelfManagedThemePath(pathname: string): boolean {
  return SELF_MANAGED_THEME_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * 把全局明暗偏好同步落到 DOM。返回 false 表示当前页面自己持有 data-theme，
 * 壳层和全局切换入口都不应越权覆盖。
 */
export function applyDocumentThemeMode(mode: MobileThemeMode, pathname: string): boolean {
  if (typeof document === 'undefined' || isSelfManagedThemePath(pathname)) return false;

  if (mode === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  return true;
}

export function getThemeTransitionRadius(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  const horizontal = Math.max(x, viewportWidth - x);
  const vertical = Math.max(y, viewportHeight - y);
  return Math.hypot(horizontal, vertical);
}

function resolveOrigin(origin?: ThemeTransitionOrigin): { x: number; y: number } {
  const target = origin?.currentTarget;
  if (target instanceof Element) {
    const rect = target.getBoundingClientRect();
    const isKeyboardActivation = origin?.clientX === 0 && origin?.clientY === 0;
    if (isKeyboardActivation || origin?.clientX == null || origin?.clientY == null) {
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
  }

  return {
    x: origin?.clientX ?? window.innerWidth / 2,
    y: origin?.clientY ?? window.innerHeight / 2,
  };
}

/**
 * CDS 同款圆形水波主题切换：新主题从触发点向最远角扩散。
 * 不支持 View Transition API 或开启“减少动态效果”时，立即切换且不改变功能语义。
 */
export function transitionThemeMode({ mode, pathname, origin, commit }: ThemeModeTransitionOptions): void {
  const apply = () => {
    // View Transition 的更新回调内必须同步改变 DOM，否则快照仍会捕获旧主题。
    applyDocumentThemeMode(mode, pathname);
    commit(mode);
  };

  if (typeof document === 'undefined' || typeof window === 'undefined') {
    commit(mode);
    return;
  }

  const transitionDocument = document as ViewTransitionDocument;
  if (!transitionDocument.startViewTransition || prefersReducedMotion()) {
    apply();
    return;
  }

  activeTransition?.skipTransition?.();
  const { x, y } = resolveOrigin(origin);
  const radius = getThemeTransitionRadius(x, y, window.innerWidth, window.innerHeight);
  const root = document.documentElement;
  root.classList.add('theme-transition-snapshotting');

  try {
    const transition = transitionDocument.startViewTransition(apply);
    activeTransition = transition;

    void transition.ready
      .then(() => {
        root.classList.remove('theme-transition-snapshotting');
        root.animate(
          {
            clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`],
          },
          {
            duration: 520,
            easing: 'cubic-bezier(.16, 1, .3, 1)',
            pseudoElement: '::view-transition-new(root)',
          },
        );
      })
      .catch(() => {
        root.classList.remove('theme-transition-snapshotting');
      });

    void transition.finished.finally(() => {
      root.classList.remove('theme-transition-snapshotting');
      if (activeTransition === transition) activeTransition = null;
    });
  } catch {
    root.classList.remove('theme-transition-snapshotting');
    apply();
  }
}
