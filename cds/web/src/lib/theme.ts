/*
 * Theme controller. Reads/writes localStorage and toggles `data-theme` on
 * <html>. Bootstrap script in index.html applies the stored value before paint
 * to avoid FOUC.
 */
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';
export type ThemeMode = Theme | 'system';
const STORAGE_KEY = 'cds_theme';

function systemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function readStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* private mode */
  }
  return 'system';
}

function resolveTheme(mode: ThemeMode): Theme {
  return mode === 'system' ? systemTheme() : mode;
}

export function applyThemeMode(mode: ThemeMode): void {
  const theme = resolveTheme(mode);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = mode;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export type RippleOrigin = { x: number; y: number };

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => { ready: Promise<void> };
};

/**
 * 从 origin 点向外扩散的圆形主题切换（View Transition API），自动降级为瞬时切换。
 *
 * `apply` 必须**同步**改 DOM：startViewTransition 在回调返回后立刻捕「新」快照，
 * 异步改（比如只调 React setState）会让它捕到还没变的画面，波纹扫过去什么都没变。
 */
export function runThemeTransition(origin: RippleOrigin | null, apply: () => void): void {
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? 0;
  // 覆盖整屏所需半径 = 从 origin 到最远角的距离
  const maxRadius = Math.ceil(Math.sqrt(
    Math.max(x, window.innerWidth - x) ** 2
    + Math.max(y, window.innerHeight - y) ** 2,
  ));

  const root = document.documentElement;
  root.style.setProperty('--ripple-x', `${x}px`);
  root.style.setProperty('--ripple-y', `${y}px`);
  root.style.setProperty('--ripple-radius', `${maxRadius}px`);

  const start = (document as ViewTransitionDocument).startViewTransition;
  const reduced = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof start !== 'function') {
    apply();
    return;
  }

  const transition = start.call(document, () => {
    // 冻结全局 micro-motion，让「新」快照捕到的是最终配色而不是过渡中途色
    root.classList.add('vt-snapshotting');
    apply();
  });
  const unfreeze = (): void => root.classList.remove('vt-snapshotting');
  transition.ready.then(unfreeze, unfreeze);
}

export function useTheme(): {
  theme: Theme;
  mode: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  toggle: () => void;
  toggleWithRipple: (origin: RippleOrigin | null) => void;
} {
  const [mode, setMode] = useState<ThemeMode>(() => readStoredMode());
  const [system, setSystem] = useState<Theme>(() => systemTheme());
  const theme = mode === 'system' ? system : mode;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => setSystem(systemTheme());
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY) return;
      if (event.newValue === 'dark' || event.newValue === 'light' || event.newValue === 'system') {
        setMode(event.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    applyThemeMode(mode);
  }, [mode, theme]);

  const toggleWithRipple = useCallback((origin: RippleOrigin | null) => {
    const next: ThemeMode = theme === 'dark' ? 'light' : 'dark';
    runThemeTransition(origin, () => {
      // 先同步落 DOM（View Transition 要立刻捕到新配色），再同步 React 状态；
      // 下一轮 effect 里的 applyThemeMode 是幂等的，不会二次闪烁。
      applyThemeMode(next);
      setMode(next);
    });
  }, [theme]);

  return {
    theme,
    mode,
    setTheme: setMode,
    toggle: () => setMode((current) => (current === 'dark' ? 'light' : 'dark')),
    toggleWithRipple,
  };
}
