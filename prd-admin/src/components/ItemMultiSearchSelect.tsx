import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  comboboxRadius,
  formatItemChipLabel,
  formatItemSearchLabel,
  ITEM_COMBOBOX_SELECTED_MAX_PX,
  ItemComboboxChip,
  ItemComboboxOptionRow,
  ItemComboboxPanelFooter,
  ItemComboboxSearchRow,
  itemComboboxPanelStyle,
  itemComboboxTriggerStyle,
  matchItemSearchOption,
  useItemComboboxPanel,
  type ItemSearchOption,
} from './itemSearchCombobox';

export interface ItemMultiSearchSelectProps {
  value: string[];
  onChange: (ids: string[]) => void;
  options: ItemSearchOption[];
  placeholder?: string;
  uiSize?: 'sm' | 'md';
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  emptyText?: string;
  countUnit?: string;
  lockedIds?: string[];
}

export function ItemMultiSearchSelect({
  value, onChange, options, placeholder = '搜索并选择...', uiSize = 'md', className, style,
  disabled = false, emptyText = '暂无可选项', countUnit = '项', lockedIds = [],
}: ItemMultiSearchSelectProps) {
  const { open, setOpen, filter, setFilter, triggerRef, panelRef, inputRef, pos, closePanel } = useItemComboboxPanel(disabled);
  const lockedSet = useMemo(() => new Set(lockedIds), [lockedIds]);
  const optionMap = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  const selectedOptions = useMemo(() => value.map((id) => optionMap.get(id)).filter(Boolean) as ItemSearchOption[], [value, optionMap]);
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(() => (q ? options.filter((o) => matchItemSearchOption(o, q)) : options), [options, q]);
  const radius = comboboxRadius(uiSize);

  const toggleOption = (id: string) => {
    if (lockedSet.has(id)) return;
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };

  const dropdownPanel = open && pos && !disabled && createPortal(
    <div ref={panelRef} className="rounded-[8px] flex flex-col overflow-hidden" style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight, ...itemComboboxPanelStyle }}>
      <div className="overflow-auto flex-1 py-1" style={{ minHeight: 0 }}>
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{q ? `未找到匹配「${filter}」的${countUnit}` : emptyText}</div>
        ) : filtered.map((o) => (
          <ItemComboboxOptionRow key={o.id} multiple selected={value.includes(o.id)} label={formatItemSearchLabel(o)} onSelect={() => toggleOption(o.id)} />
        ))}
      </div>
      <ItemComboboxPanelFooter left={q ? `${filtered.length} / ${options.length} ${countUnit}匹配` : `共 ${options.length} ${countUnit}`} right={value.length > 0 ? <span style={{ color: 'var(--accent-gold)' }}>已选 {value.length}</span> : undefined} />
    </div>,
    document.body,
  );

  return (
    <div className={`relative ${className ?? ''}`}>
      <div ref={triggerRef} className={`flex flex-col w-full ${radius} overflow-hidden text-[13px] ${disabled ? 'opacity-50 pointer-events-none' : ''}`} style={itemComboboxTriggerStyle(open, style)}>
        {selectedOptions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 px-2 pt-2 pb-1 overflow-y-auto shrink-0" style={{ maxHeight: ITEM_COMBOBOX_SELECTED_MAX_PX, overscrollBehavior: 'contain' }}>
            {selectedOptions.map((o) => (
              <ItemComboboxChip key={o.id} label={formatItemChipLabel(o)} title={formatItemSearchLabel(o)} locked={lockedSet.has(o.id)} onRemove={lockedSet.has(o.id) ? undefined : () => onChange(value.filter((x) => x !== o.id))} />
            ))}
          </div>
        )}
        <ItemComboboxSearchRow
          inputRef={inputRef}
          value={filter}
          onChange={(v) => { setFilter(v); setOpen(true); }}
          onFocus={() => { if (!disabled) setOpen(true); }}
          placeholder={selectedOptions.length === 0 ? placeholder : '继续搜索...'}
          open={open}
          disabled={disabled}
          className={uiSize === 'sm' ? 'h-8' : 'h-9'}
          onChevronToggle={() => {
            if (disabled) return;
            if (open) { closePanel(); inputRef.current?.blur(); } else { setOpen(true); inputRef.current?.focus(); }
          }}
        />
      </div>
      {dropdownPanel}
    </div>
  );
}
