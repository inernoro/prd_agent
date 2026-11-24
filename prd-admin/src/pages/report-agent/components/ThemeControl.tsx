import { useCallback, type MouseEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { transitionThemeMode } from '@/lib/themeTransition';
import { THEME_MODE_OPTIONS } from '@/lib/themeModeRegistry';
import { useMobileThemeStore, type MobileThemeMode } from '@/stores/mobileThemeStore';

// 选项来自唯一注册表：漏掉「随系统」会让用户在别处选了它之后，这里三个都不高亮。
const OPTIONS = THEME_MODE_OPTIONS;

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
              color: selected ? 'var(--report-accent-text)' : 'var(--text-secondary)',
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
