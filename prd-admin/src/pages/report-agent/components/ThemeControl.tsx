import { useCallback } from 'react';
import { Moon, Sun, type LucideIcon } from 'lucide-react';

export type ColorScheme = 'dark' | 'light';

const OPTIONS: { value: ColorScheme; label: string; icon: LucideIcon }[] = [
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'light', label: '浅色', icon: Sun },
];

export interface ThemeControlProps {
  value: ColorScheme;
  onChange: (value: ColorScheme) => void;
}

export function ThemeControl({ value, onChange }: ThemeControlProps) {
  const handleClick = useCallback(
    (next: ColorScheme) => {
      if (next !== value) onChange(next);
    },
    [value, onChange]
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
            onClick={() => handleClick(opt.value)}
            className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-all duration-150 whitespace-nowrap flex items-center gap-1"
            style={{
              background: selected ? 'rgba(59,130,246,.15)' : 'transparent',
              color: selected ? 'rgba(59,130,246,.95)' : 'var(--text-secondary)',
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
