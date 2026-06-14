import { useRequirementTypes } from './requirementTypes';

const selectCls =
  'w-full h-9 rounded-[8px] border border-white/12 bg-[var(--bg-input)] px-2.5 text-[13px] text-white outline-none focus:border-cyan-500/40 no-focus-ring';

export function RequirementTypeSelect({
  value,
  onChange,
  allowEmpty = true,
  emptyLabel = '请选择',
  uiSize = 'md',
}: {
  value: string;
  onChange: (v: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  uiSize?: 'sm' | 'md';
}) {
  const { types } = useRequirementTypes();
  const sizeCls = uiSize === 'sm' ? 'h-8 text-[12px]' : '';

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${selectCls} ${sizeCls}`}
    >
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {types.map((t) => (
        <option key={t.id} value={t.name}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
