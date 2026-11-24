export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
}

/** 列表工具条共用分段控件，视觉以网页创作现有实现为准。 */
export function SegmentPills<T extends string>({ options, value, onChange, ariaLabel }: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel}
      className="inline-flex max-w-full items-center gap-1 overflow-x-auto p-1 rounded-lg shrink-0"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', scrollbarWidth: 'none' }}>
      {options.map(opt => {
        const active = opt.value === value;
        return (
          <button key={opt.value} type="button" aria-pressed={active} onClick={() => onChange(opt.value)}
            className="h-7 min-w-10 shrink-0 whitespace-nowrap px-3 rounded-md text-center text-[13px] transition-colors"
            style={active ? {
              background: 'var(--selection-bg)', color: 'var(--selection-text)', fontWeight: 500,
              boxShadow: 'inset 0 0 0 1px var(--selection-border)',
            } : { background: 'transparent', color: 'var(--text-muted)' }}
            onMouseEnter={event => { if (!active) event.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={event => { if (!active) event.currentTarget.style.color = 'var(--text-muted)'; }}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
