export function SegmentedTabs<T extends string>(props: {
  items: Array<{ key: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { items, value, onChange, disabled, ariaLabel } = props;
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
        return (
          <button
            key={x.key}
            type="button"
            className="h-[32px] px-4 rounded-[11px] text-[13px] font-semibold transition-all duration-200 inline-flex items-center gap-2 shrink-0 whitespace-nowrap"
            style={{
              color: active ? '#ffffff' : 'var(--text-secondary)',
              background: active ? 'var(--gold-gradient)' : 'transparent',
              boxShadow: active ? '0 2px 8px -2px rgba(99, 102, 241, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.1) inset' : 'none',
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? 'not-allowed' : 'pointer',
              transform: active ? 'scale(1)' : 'scale(0.98)',
            }}
            disabled={!!disabled}
            aria-pressed={active}
            onClick={() => onChange(x.key)}
          >
            {x.label}
          </button>
        );
      })}
    </div>
  );
}
