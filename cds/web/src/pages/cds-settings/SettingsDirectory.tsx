import './settings-directory.css';

type DirectoryGroup = { label: string; items: ReadonlyArray<{ value: string; label: string }> };
/** A page directory on small screens; desktop keeps the existing grouped sidebar. */
export function SettingsDirectory({ groups, value, label, onChange, minHeight = '3.25rem' }: {
  groups: ReadonlyArray<DirectoryGroup>;
  value: string;
  label: string;
  onChange: (value: string) => void;
  minHeight?: string | number;
}): JSX.Element {
  const items = groups.flatMap(group => group.items.map(item => ({ ...item, group: group.label })));
  const current = items.find(item => item.value === value);
  return <nav className="cds-settings-mobile-directory" aria-label={label}>
    {items.length === 1 ? <p className="text-sm text-muted-foreground">{current?.group} · {current?.label}</p> : <label className="block min-w-0 w-full"><span className="sr-only">{label}</span><select aria-label={label} value={value} onChange={event => onChange(event.target.value)} className="w-full min-w-0 rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{ minHeight }}>{groups.map(group => <optgroup key={group.label} label={group.label}>{group.items.map(item => <option key={item.value} value={item.value}>{group.label} · {item.label}</option>)}</optgroup>)}</select></label>}
  </nav>;
}
