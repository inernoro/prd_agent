export interface SegmentOption<T extends string = string> {
  value: T;
  label: string;
}

/** 列表工具条共用分段控件。 */
export function SegmentPills<T extends string>({ options, value, onChange, ariaLabel }: {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel}
      className="surface-choice-group no-scrollbar max-w-full shrink-0 overflow-x-auto">
      {options.map(opt => (
        <button key={opt.value} type="button" aria-pressed={opt.value === value} onClick={() => onChange(opt.value)}
          className="surface-choice h-7 min-w-10 shrink-0 rounded-md px-3 text-center text-[13px]">
          {opt.label}
        </button>
      ))}
    </div>
  );
}
