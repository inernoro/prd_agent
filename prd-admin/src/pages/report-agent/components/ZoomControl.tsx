import { useCallback } from 'react';

export type ZoomLevel = 'normal' | 'large' | 'extra';

export const ZOOM_SCALE: Record<ZoomLevel, number> = {
  normal: 1.0,
  large: 1.15,
  extra: 1.3,
};

const OPTIONS: { value: ZoomLevel; label: string }[] = [
  { value: 'normal', label: '标准' },
  { value: 'large', label: '大' },
  { value: 'extra', label: '特大' },
];

export interface ZoomControlProps {
  value: ZoomLevel;
  onChange: (value: ZoomLevel) => void;
}

export function ZoomControl({ value, onChange }: ZoomControlProps) {
  const handleClick = useCallback(
    (next: ZoomLevel) => {
      if (next !== value) onChange(next);
    },
    [value, onChange]
  );

  return (
    <div
      role="radiogroup"
      aria-label="字号"
      className="surface-inset rounded-xl p-1 flex items-center gap-0.5"
    >
      {OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => handleClick(opt.value)}
            className="px-2.5 py-1 rounded-lg text-[12px] font-medium transition-all duration-150 whitespace-nowrap"
            style={{
              background: selected ? 'rgba(59,130,246,.15)' : 'transparent',
              color: selected ? 'rgba(59,130,246,.95)' : 'var(--text-secondary)',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
