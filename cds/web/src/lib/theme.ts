/*
 * Theme controller. Reads/writes localStorage and toggles `data-theme` on
 * <html>. Bootstrap script in index.html applies the stored value before paint
 * to avoid FOUC.
 */
import { useEffect, useState } from 'react';

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

export function useTheme(): {
  theme: Theme;
  mode: ThemeMode;
  setTheme: (t: ThemeMode) => void;
  toggle: () => void;
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

  return {
    theme,
    mode,
    setTheme: setMode,
    toggle: () => setMode((current) => (current === 'dark' ? 'light' : 'dark')),
  };
}
