import { useMemo } from 'react';
import { Search, X } from 'lucide-react';
import { AnchoredMenu } from './ui/AnchoredMenu';
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
  truncateSelectedLabel?: boolean;
}

export function ItemSearchSelect({
  value, onChange, options, placeholder = '搜索...', clearOptionLabel,
  uiSize = 'md', className, style, disabled = false, emptyText = '暂无可选项', countUnit = '项', truncateSelectedLabel = true,
}: ItemSearchSelectProps) {
  const { open, setOpen, filter, setFilter, triggerRef, panelRef, inputRef, pos, closePanel } = useItemComboboxPanel(disabled);
  const selected = useMemo(() => options.find((o) => o.id === value), [options, value]);
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(() => (q ? options.filter((o) => matchItemSearchOption(o, q)) : options), [options, q]);
  const radius = comboboxRadius(uiSize);
  const rowHeight = uiSize === 'sm' ? 'h-8' : 'h-9';
  const inputPlaceholder = !value && clearOptionLabel ? clearOptionLabel : placeholder;
  const selectedLabel = selected ? formatItemSearchLabel(selected) : '';
  const closedLabel = value ? truncateSelectedLabel ? truncateItemLabel(selectedLabel) : selectedLabel : '';
  const inputDisplayValue = open ? filter : closedLabel;

  // 复用菜单的弹窗内 portal 与定位校正，避免 body 下的列表被模态滚动锁拦截。
  const dropdownPanel = open && pos && !disabled && (
    <AnchoredMenu open onClose={closePanel} anchorRef={triggerRef} align="left" gap={4} minWidth={pos.width}
      className="rounded-[8px]"
      style={{ width: pos.width, maxHeight: pos.maxHeight, padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', ...itemComboboxPanelStyle }}>
      <div ref={panelRef} className="flex flex-col" style={{ minHeight: 0 }}>
        <div className="flex-1 py-1" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {clearOptionLabel && !q && (
            <>
              <ItemComboboxOptionRow selected={!value} label={clearOptionLabel} onSelect={() => { onChange(''); closePanel(); }} />
              {filtered.length > 0 && <div className="mx-3 my-0.5 border-b border-token-subtle" />}
            </>
          )}
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>{q ? `未找到匹配「${filter}」的${countUnit}` : emptyText}</div>
          ) : filtered.map((o) => (
            <ItemComboboxOptionRow key={o.id} selected={o.id === value} label={formatItemSearchLabel(o)} onSelect={() => { onChange(o.id); closePanel(); }} />
          ))}
        </div>
        <ItemComboboxPanelFooter left={q ? `${filtered.length} / ${options.length} ${countUnit}匹配` : `共 ${options.length} ${countUnit}`} />
      </div>
    </AnchoredMenu>
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
