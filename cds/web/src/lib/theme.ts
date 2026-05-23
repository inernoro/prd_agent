/*
 * Theme controller. Reads/writes sessionStorage and toggles `data-theme` on
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
    const v = sessionStorage.getItem(STORAGE_KEY);
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
    sessionStorage.setItem(STORAGE_KEY, mode);
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
    applyThemeMode(mode);
  }, [mode, theme]);

  return {
    theme,
    mode,
    setTheme: setMode,
    toggle: () => setMode((current) => (current === 'dark' ? 'light' : 'dark')),
  };
}
