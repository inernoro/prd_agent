import { useEffect, useRef } from 'react';
import { ArrowDown, ArrowUp, Check, GripVertical, RotateCcw, Settings2 } from 'lucide-react';
import type { ColumnDef, LogTableDensity, LogTablePreferences } from '@/lib/logsHelpers';
import { LOG_TABLE_DENSITIES, defaultLogTablePreferences } from '@/lib/logsHelpers';

type Props = {
  columns: ColumnDef[];
  preferences: LogTablePreferences;
  onChange: (value: LogTablePreferences) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: 'columns' | 'density';
  onTabChange: (tab: 'columns' | 'density') => void;
};

export function LogTableSettings({ columns, preferences, onChange, open, onOpenChange, tab, onTabChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onOpenChange, open]);

  const byKey = new Map(columns.map((column) => [column.key, column]));
  const ordered = preferences.order.map((key) => byKey.get(key)).filter((column): column is ColumnDef => Boolean(column));
  const toggle = (column: ColumnDef) => {
    if (column.required) return;
    const visibleKeys = preferences.visibleKeys.includes(column.key)
      ? preferences.visibleKeys.filter((key) => key !== column.key)
      : [...preferences.visibleKeys, column.key];
    onChange({ ...preferences, visibleKeys });
  };
  const move = (key: string, offset: -1 | 1) => {
    const index = preferences.order.indexOf(key);
    const nextIndex = index + offset;
    if (index < 0 || nextIndex < 0 || nextIndex >= preferences.order.length) return;
    const order = [...preferences.order];
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    onChange({ ...preferences, order });
  };
  const setDensity = (density: LogTableDensity) => onChange({ ...preferences, density });

  return (
    <div className="lg-log-table-settings" ref={rootRef}>
      <button
        type="button"
        className="lg-log-table-settings-trigger"
        aria-label="表格设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="表格设置"
        onClick={() => onOpenChange(!open)}
      >
        <Settings2 size={15} />
      </button>
      {open ? (
        <div className="lg-log-table-settings-popover" role="dialog" aria-label="表格设置">
          <header>
            <strong>表格设置</strong>
            <button type="button" onClick={() => onChange(defaultLogTablePreferences(columns))}>
              <RotateCcw size={13} />重置
            </button>
          </header>
          <div className="lg-log-table-settings-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'columns'} onClick={() => onTabChange('columns')}>列</button>
            <button type="button" role="tab" aria-selected={tab === 'density'} onClick={() => onTabChange('density')}>密度</button>
          </div>
          {tab === 'columns' ? (
            <div className="lg-log-column-list">
              {ordered.map((column, index) => {
                const selected = preferences.visibleKeys.includes(column.key);
                return (
                  <div key={column.key} className="lg-log-column-item">
                    <GripVertical size={14} aria-hidden="true" />
                    <button
                      type="button"
                      className="lg-log-column-toggle"
                      aria-pressed={selected}
                      disabled={column.required}
                      onClick={() => toggle(column)}
                    >
                      <span className="lg-log-column-check">{selected ? <Check size={12} strokeWidth={3} /> : null}</span>
                      {column.label}
                    </button>
                    <span className="lg-log-column-order">
                      <button type="button" aria-label={`上移${column.label}`} disabled={index === 0} onClick={() => move(column.key, -1)}><ArrowUp size={12} /></button>
                      <button type="button" aria-label={`下移${column.label}`} disabled={index === ordered.length - 1} onClick={() => move(column.key, 1)}><ArrowDown size={12} /></button>
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="lg-log-density-list">
              {LOG_TABLE_DENSITIES.map((density) => (
                <button key={density.key} type="button" aria-pressed={preferences.density === density.key} onClick={() => setDensity(density.key)}>
                  <span className="lg-log-density-radio">{preferences.density === density.key ? <span /> : null}</span>
                  <span><strong>{density.label}</strong><small>{density.description}</small></span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
