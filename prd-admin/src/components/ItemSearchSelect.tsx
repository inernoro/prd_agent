import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import {
  comboboxRadius,
  formatItemSearchLabel,
  ItemComboboxChevron,
  ItemComboboxOptionRow,
  ItemComboboxPanelFooter,
  itemComboboxPanelStyle,
  itemComboboxInputClass,
  itemComboboxTriggerStyle,
  matchItemSearchOption,
  truncateItemLabel,
  useItemComboboxPanel,
  type ItemSearchOption,
} from './itemSearchCombobox';

export type { ItemSearchOption } from './itemSearchCombobox';
export { formatItemSearchLabel, matchItemSearchOption } from './itemSearchCombobox';

export interface ItemSearchSelectProps {
  value: string;
  onChange: (id: string) => void;
  options: ItemSearchOption[];
  placeholder?: string;
  clearOptionLabel?: string;
  uiSize?: 'sm' | 'md';
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  emptyText?: string;
  countUnit?: string;
}

export function ItemSearchSelect({
  value, onChange, options, placeholder = '搜索...', clearOptionLabel,
  uiSize = 'md', className, style, disabled = false, emptyText = '暂无可选项', countUnit = '项',
}: ItemSearchSelectProps) {
  const { open, setOpen, filter, setFilter, triggerRef, panelRef, inputRef, pos, closePanel } = useItemComboboxPanel(disabled);
  const selected = useMemo(() => options.find((o) => o.id === value), [options, value]);
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(() => (q ? options.filter((o) => matchItemSearchOption(o, q)) : options), [options, q]);
  const radius = comboboxRadius(uiSize);
  const rowHeight = uiSize === 'sm' ? 'h-8' : 'h-9';
  const inputPlaceholder = !value && clearOptionLabel ? clearOptionLabel : placeholder;
  const closedLabel = value && selected ? truncateItemLabel(formatItemSearchLabel(selected)) : '';
  const inputDisplayValue = open ? filter : closedLabel;

  const dropdownPanel = open && pos && !disabled && createPortal(
    <div ref={panelRef} className="rounded-[8px] flex flex-col overflow-hidden" style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight, ...itemComboboxPanelStyle }}>
      <div className="overflow-auto flex-1 py-1" style={{ minHeight: 0 }}>
        {clearOptionLabel && !q && (
          <>
            <ItemComboboxOptionRow selected={!value} label={clearOptionLabel} onSelect={() => { onChange(''); closePanel(); }} />
            {filtered.length > 0 && <div className="mx-3 my-0.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }} />}
          </>
        )}
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{q ? `未找到匹配「${filter}」的${countUnit}` : emptyText}</div>
        ) : filtered.map((o) => (
          <ItemComboboxOptionRow key={o.id} selected={o.id === value} label={formatItemSearchLabel(o)} onSelect={() => { onChange(o.id); closePanel(); }} />
        ))}
      </div>
      <ItemComboboxPanelFooter left={q ? `${filtered.length} / ${options.length} ${countUnit}匹配` : `共 ${options.length} ${countUnit}`} />
    </div>,
    document.body,
  );

  return (
    <div className={`relative ${className ?? ''}`}>
      <div ref={triggerRef} className={`flex items-center gap-2 ${rowHeight} w-full ${radius} px-2.5 text-[13px] ${disabled ? 'opacity-50 pointer-events-none' : ''}`} style={itemComboboxTriggerStyle(open, style)}>
        <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input ref={inputRef} type="text" disabled={disabled} value={inputDisplayValue} title={!open && selected ? formatItemSearchLabel(selected) : undefined}
          onChange={(e) => { setFilter(e.target.value); setOpen(true); }}
          onFocus={() => { if (!disabled) { setOpen(true); setFilter(''); } }}
          placeholder={inputPlaceholder}
          className={itemComboboxInputClass}
          style={{ color: 'var(--text-primary)', boxShadow: 'none' }}
        />
        {value && clearOptionLabel && !open && (
          <button type="button" className="shrink-0 p-0 border-none bg-transparent cursor-pointer" aria-label="清除" onMouseDown={(e) => e.preventDefault()} onClick={() => onChange('')}>
            <X size={11} style={{ color: 'var(--text-muted)' }} />
          </button>
        )}
        <ItemComboboxChevron open={open} disabled={disabled} onToggle={() => {
          if (disabled) return;
          if (open) { closePanel(); inputRef.current?.blur(); } else { setOpen(true); setFilter(''); inputRef.current?.focus(); }
        }} />
      </div>
      {dropdownPanel}
    </div>
  );
}
