import { useEffect, type ReactNode } from 'react';
import { Moon, Sun } from 'lucide-react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { Button } from '@/components/design/Button';
import { useApplyDocumentTheme } from '@/hooks/useApplyDocumentTheme';
import type { ResolvedThemeMode } from '@/stores/mobileThemeStore';
import './product-appearance.css';

type VersionAppearanceState = {
  mode: ResolvedThemeMode;
  setMode: (mode: ResolvedThemeMode) => void;
};

const useVersionAppearance = create<VersionAppearanceState>()(
  persist(
    (set) => ({ mode: 'light', setMode: (mode) => set({ mode }) }),
    {
      name: 'map-product-version-appearance',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

export function ProductAgentAppearance({ children }: { children: ReactNode }) {
  const mode = useVersionAppearance((state) => state.mode);
  useApplyDocumentTheme(window.location.pathname, mode);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-product-agent-appearance', '');
    return () => root.removeAttribute('data-product-agent-appearance');
  }, []);

  return children;
}

export function VersionAppearance() {
  const mode = useVersionAppearance((state) => state.mode);
  const setMode = useVersionAppearance((state) => state.setMode);

  const isLight = mode === 'light';
  const Icon = isLight ? Sun : Moon;

  return (
    <Button
      size="sm"
      role="switch"
      aria-label="浅色模式"
      aria-checked={isLight}
      title={isLight ? '切换为深色模式' : '切换为浅色模式'}
      onClick={() => setMode(isLight ? 'dark' : 'light')}
      className="shrink-0"
    >
      <Icon size={14} aria-hidden="true" />
      {isLight ? '浅色' : '深色'}
    </Button>
  );
}
