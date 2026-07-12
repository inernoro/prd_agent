import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'llmgw.theme';
const CHANGE_EVENT = 'llmgw-theme-change';

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function readThemePreference(): ThemePreference {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

export function setThemePreference(preference: ThemePreference) {
  if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, preference);
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { preference, resolved } }));
}

export function initializeTheme() {
  setThemePreference(readThemePreference());
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (readThemePreference() === 'system') setThemePreference('system');
  });
}

export function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readThemePreference()));

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ preference: ThemePreference; resolved: ResolvedTheme }>).detail;
      setPreference(detail.preference);
      setResolved(detail.resolved);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  return { preference, resolved, setPreference: setThemePreference };
}
