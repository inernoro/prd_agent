import { useCallback, type MouseEvent } from 'react';
import { Moon, Sun, type LucideIcon } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { transitionThemeMode } from '@/lib/themeTransition';
import { useMobileThemeStore, type MobileThemeMode } from '@/stores/mobileThemeStore';

const OPTIONS: { value: MobileThemeMode; label: string; icon: LucideIcon }[] = [
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'light', label: '浅色', icon: Sun },
];

export function ThemeControl() {
  const location = useLocation();
  const value = useMobileThemeStore((state) => state.mode);
  const setMode = useMobileThemeStore((state) => state.setMode);
  const handleClick = useCallback(
    (next: MobileThemeMode, event: MouseEvent<HTMLButtonElement>) => {
      if (next === value) return;
      transitionThemeMode({
        mode: next,
        pathname: location.pathname,
        origin: event,
        commit: setMode,
      });
    },
    [location.pathname, setMode, value]
  );

  return (
    <div
      role="radiogroup"
      aria-label="主题"
      className="surface-inset rounded-xl p-1 flex items-center gap-0.5"
    >
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={(event) => handleClick(opt.value, event)}
            className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-all duration-150 whitespace-nowrap flex items-center gap-1"
            style={{
              background: selected ? 'var(--report-accent-soft)' : 'transparent',
              color: selected ? 'var(--report-accent)' : 'var(--text-secondary)',
            }}
          >
            <Icon size={12} />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
