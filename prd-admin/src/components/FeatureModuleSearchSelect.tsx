import { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import type { Feature } from '@/pages/product-agent/types';
import {
  ItemComboboxChevron,
  ItemComboboxOptionRow,
  ItemComboboxPanelFooter,
  itemComboboxInputClass,
  itemComboboxPanelStyle,
  itemComboboxTriggerStyle,
  matchItemSearchOption,
  truncateItemLabel,
  useItemComboboxPanel,
  type ItemSearchOption,
} from './itemSearchCombobox';

export function collectFeatureModuleOptions(features: Feature[], current?: string): ItemSearchOption[] {
  const names = new Set<string>();
  for (const f of features) {
    const n = f.moduleName?.trim();
    if (n) names.add(n);
  }
  if (current?.trim()) names.add(current.trim());
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN')).map((n) => ({ id: n, label: n }));
}

export function FeatureModuleSearchSelect({
  value,
  onChange,
  features,
  placeholder = '搜索功能模块，如：营销活动',
  disabled = false,
}: {
  value: string;
  onChange: (name: string) => void;
  features: Feature[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const options = useMemo(() => collectFeatureModuleOptions(features, value), [features, value]);
  const { open, setOpen, filter, setFilter, triggerRef, panelRef, inputRef, pos, closePanel } = useItemComboboxPanel(disabled);
  const q = filter.trim().toLowerCase();
  const filtered = useMemo(() => (q ? options.filter((o) => matchItemSearchOption(o, q)) : options), [options, q]);
  const canCreate = q.length > 0 && !options.some((o) => o.id.toLowerCase() === q);

  const closedLabel = value ? truncateItemLabel(value) : '';
  const inputDisplayValue = open ? filter : closedLabel;

  const apply = (name: string) => {
    onChange(name.trim());
    closePanel();
  };

  const dropdownPanel = open && pos && !disabled && createPortal(
    <div
      ref={panelRef}
      className="rounded-[8px] flex flex-col overflow-hidden"
      style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight, ...itemComboboxPanelStyle }}
    >
      <div className="overflow-auto flex-1 py-1" style={{ minHeight: 0 }}>
        {canCreate ? (
          <ItemComboboxOptionRow
            selected={false}
            label={`使用「${filter.trim()}」作为模块名`}
            onSelect={() => apply(filter.trim())}
          />
        ) : null}
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {q ? `未找到「${filter.trim()}」，可直接使用上方新建` : '输入关键字搜索已有模块'}
          </div>
        ) : filtered.map((o) => (
          <ItemComboboxOptionRow key={o.id} selected={o.id === value} label={o.label} onSelect={() => apply(o.id)} />
        ))}
      </div>
      <ItemComboboxPanelFooter left={q ? `${filtered.length} / ${options.length} 个模块匹配` : `共 ${options.length} 个模块`} />
    </div>,
    document.body,
  );

  return (
    <div className="relative">
      <div
        ref={triggerRef}
        className={`flex items-center gap-2 h-9 w-full rounded-[8px] px-2.5 text-[13px] ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
        style={itemComboboxTriggerStyle(open)}
      >
        <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          disabled={disabled}
          value={inputDisplayValue}
          title={!open && value ? value : undefined}
          onChange={(e) => { setFilter(e.target.value); setOpen(true); }}
          onFocus={() => { if (!disabled) { setOpen(true); setFilter(''); } }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && canCreate) {
              e.preventDefault();
              apply(filter.trim());
            }
          }}
          placeholder={placeholder}
          className={itemComboboxInputClass}
          style={{ color: 'var(--text-primary)', boxShadow: 'none' }}
        />
        <ItemComboboxChevron
          open={open}
          disabled={disabled}
          onToggle={() => {
            if (disabled) return;
            if (open) { closePanel(); inputRef.current?.blur(); } else { setOpen(true); setFilter(''); inputRef.current?.focus(); }
          }}
        />
      </div>
      {dropdownPanel}
    </div>
  );
}
