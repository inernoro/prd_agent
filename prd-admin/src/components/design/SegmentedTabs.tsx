import { useState, type ReactNode } from 'react';

export function SegmentedTabs<T extends string>(props: {
  items: Array<{ key: T; label: string; icon?: ReactNode }>;
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { items, value, onChange, disabled, ariaLabel } = props;
  // 鼠标悬浮态：内联样式优先级高于 Tailwind hover，故用 state 驱动非激活项的 hover 反馈
  const [hoverKey, setHoverKey] = useState<T | null>(null);
  return (
    <div
      className="inline-flex items-center max-w-full p-1 rounded-[14px] overflow-x-auto"
      style={{
        background: 'var(--nested-block-bg)',
        border: '1px solid var(--border-subtle)',
        boxShadow: '0 2px 8px -2px rgba(0, 0, 0, 0.3) inset',
      }}
      aria-label={ariaLabel}
    >
      {items.map((x) => {
        const active = x.key === value;
        const hovered = !active && !disabled && hoverKey === x.key;
        return (
          <button
            key={x.key}
            type="button"
            className="h-[32px] px-4 rounded-[11px] text-[13px] font-semibold transition-all duration-200 inline-flex items-center gap-2 shrink-0 whitespace-nowrap"
            style={{
              color: active ? '#ffffff' : hovered ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: active ? 'var(--gold-gradient)' : hovered ? 'rgba(255,255,255,0.06)' : 'transparent',
              boxShadow: active ? '0 2px 8px -2px rgba(99, 102, 241, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1) inset' : 'none',
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? 'not-allowed' : 'pointer',
              transform: active ? 'scale(1)' : 'scale(0.98)',
            }}
            disabled={!!disabled}
            aria-pressed={active}
            onMouseEnter={() => setHoverKey(x.key)}
            onMouseLeave={() => setHoverKey((k) => (k === x.key ? null : k))}
            onClick={() => onChange(x.key)}
          >
            {x.icon ? <span className="inline-flex items-center shrink-0">{x.icon}</span> : null}
            {x.label}
          </button>
        );
      })}
    </div>
  );
}
