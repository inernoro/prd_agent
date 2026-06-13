import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export const ITEM_COMBOBOX_SELECTED_MAX_PX = 72;
export const ITEM_COMBOBOX_LABEL_MAX_LEN = 15;

/** combobox 内嵌 input：透明、无边框，禁止全局 focus-visible 内环（避免「框中框」） */
export const itemComboboxInputClass =
  'flex-1 min-w-0 bg-transparent outline-none border-none p-0 h-full shadow-none no-focus-ring';

export interface ItemSearchOption {
  id: string;
  label: string;
  subLabel?: string;
  /** 仅参与搜索匹配，不在下拉/触发器中展示 */
  searchExtra?: string;
}

export function formatItemSearchLabel(option: ItemSearchOption) {
  return option.subLabel ? `${option.subLabel} · ${option.label}` : option.label;
}

export function formatItemChipLabel(option: ItemSearchOption, maxLen = ITEM_COMBOBOX_LABEL_MAX_LEN) {
  return truncateItemLabel(option.label, maxLen);
}

export function truncateItemLabel(text: string, maxLen = ITEM_COMBOBOX_LABEL_MAX_LEN) {
  const chars = [...text];
  if (chars.length <= maxLen) return text;
  return `${chars.slice(0, maxLen).join('')}…`;
}

export function matchItemSearchOption(option: ItemSearchOption, q: string) {
  const hay = [option.label, option.subLabel, option.searchExtra].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(q);
}

export const itemComboboxPanelStyle: React.CSSProperties = {
  zIndex: 9999,
  background: 'var(--glass-bg-end, rgba(22, 22, 28, 0.98))',
  border: '1px solid var(--glass-border, rgba(255, 255, 255, 0.14))',
  boxShadow: '0 18px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255, 255, 255, 0.06) inset',
  backdropFilter: 'blur(40px) saturate(180%)',
  WebkitBackdropFilter: 'blur(40px) saturate(180%)',
};

export function itemComboboxTriggerStyle(open: boolean, extra?: React.CSSProperties): React.CSSProperties {
  return {
    background: 'var(--bg-input)',
    border: open ? '1px solid var(--accent-gold)' : '1px solid rgba(255,255,255,0.12)',
    color: 'var(--text-primary)',
    ...extra,
  };
}

export function comboboxRadius(uiSize: 'sm' | 'md') {
  return uiSize === 'sm' ? 'rounded-[8px]' : 'rounded-[8px]';
}

export type ComboboxPanelPos = { top?: number; bottom?: number; left: number; width: number; maxHeight: number };

export function useItemComboboxPanel(disabled = false) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<ComboboxPanelPos | null>(null);

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const margin = 8;
    const desired = 320;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openUp = spaceBelow < Math.min(desired, 200) && spaceAbove > spaceBelow;
    const width = Math.max(rect.width, 260);
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    if (openUp) {
      setPos({ bottom: window.innerHeight - rect.top + 4, left, width, maxHeight: Math.max(160, Math.min(desired, spaceAbove)) });
    } else {
      setPos({ top: rect.bottom + 4, left, width, maxHeight: Math.max(160, Math.min(desired, spaceBelow)) });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePos();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [open, updatePos]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setFilter('');
  }, []);

  useEffect(() => {
    if (!open || disabled) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current && !triggerRef.current.contains(target) &&
        panelRef.current && !panelRef.current.contains(target)
      ) {
        closePanel();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, closePanel, disabled]);

  return { open, setOpen, filter, setFilter, triggerRef, panelRef, inputRef, pos, closePanel };
}

export function ItemComboboxChevron({ open, disabled, onToggle }: { open: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="shrink-0 p-0 border-none bg-transparent cursor-pointer disabled:cursor-not-allowed"
      aria-label={open ? '收起列表' : '展开列表'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
    >
      <ChevronDown size={14} className="transition-transform duration-150" style={{ color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : undefined }} />
    </button>
  );
}

export function ItemComboboxChip({ label, title, locked, onRemove }: { label: string; title?: string; locked?: boolean; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium max-w-[160px]"
      style={{
        background: locked ? 'rgba(var(--accent-gold-rgb, 212,175,55), 0.12)' : 'rgba(255,255,255,0.08)',
        border: locked ? '1px solid rgba(var(--accent-gold-rgb, 212,175,55), 0.25)' : '1px solid rgba(255,255,255,0.12)',
        color: 'var(--text-primary)',
      }}
      title={title ?? label}
    >
      <span className="truncate">{label}</span>
      {!locked && onRemove && (
        <X size={10} className="shrink-0 cursor-pointer opacity-60 hover:opacity-100" onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); onRemove(); }} />
      )}
    </span>
  );
}

export function ItemComboboxSearchRow(props: {
  inputRef: React.Ref<HTMLInputElement>;
  value: string;
  onChange: (v: string) => void;
  onFocus: () => void;
  placeholder: string;
  open: boolean;
  disabled?: boolean;
  onChevronToggle: () => void;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 px-2.5 shrink-0 ${props.className ?? 'h-9'}`}>
      <Search size={14} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
      <input
        ref={props.inputRef}
        type="text"
        disabled={props.disabled}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onFocus={props.onFocus}
        placeholder={props.placeholder}
        className={`${itemComboboxInputClass} disabled:cursor-not-allowed`}
        style={{ color: 'var(--text-primary)', boxShadow: 'none' }}
      />
      <ItemComboboxChevron open={props.open} disabled={props.disabled} onToggle={props.onChevronToggle} />
    </div>
  );
}

export function ItemComboboxPanelFooter({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <div className="px-3 py-1.5 text-[10px] shrink-0 flex items-center justify-between" style={{ color: 'var(--text-muted)', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
      <span>{left}</span>
      {right}
    </div>
  );
}

export function ItemComboboxOptionRow({ selected, multiple, label, onSelect }: { selected: boolean; multiple?: boolean; label: string; onSelect: () => void }) {
  return (
    <div
      className="flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors hover:bg-white/8"
      style={selected ? { background: 'rgba(var(--accent-gold-rgb, 212,175,55), 0.08)' } : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onSelect}
    >
      {multiple ? (
        <div className="w-4 h-4 rounded shrink-0 flex items-center justify-center" style={{ border: selected ? '1.5px solid var(--accent-gold, #d4af37)' : '1.5px solid rgba(255,255,255,0.2)', background: selected ? 'rgba(var(--accent-gold-rgb, 212,175,55), 0.15)' : 'transparent' }}>
          {selected && <Check size={10} style={{ color: 'var(--accent-gold)' }} />}
        </div>
      ) : null}
      <div className="flex-1 min-w-0 text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }} title={label}>{label}</div>
      {!multiple && selected && <Check size={16} className="shrink-0" style={{ color: 'var(--accent-gold)' }} />}
    </div>
  );
}
