import * as SelectPrimitive from '@radix-ui/react-select';
import { ChevronDown, Search, X } from 'lucide-react';
import * as React from 'react';
import {
  selectContentClass,
  selectContentStyle,
  selectItemClass,
  selectTriggerClass,
  selectTriggerStyle,
  selectViewportClass,
  selectViewportStyle,
} from './selectStyles';

export interface SearchableSelectOption {
  value: string;
  /** 用于搜索和下拉列表显示 */
  label: string;
  /** 可选，用于 Trigger 显示（不提供则使用 label） */
  displayLabel?: string;
}

export interface SearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  leftIcon?: React.ReactNode;
  uiSize?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = '请选择...',
  leftIcon,
  uiSize = 'sm',
  disabled,
  className,
  style,
}: SearchableSelectProps) {
  const [search, setSearch] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  // 将空值选项转换为特殊值以支持 Radix Select
  const ALL_VALUE = '__all__';
  const normalizedOptions = React.useMemo(() => {
    return options.map((opt) => ({
      ...opt,
      value: opt.value === '' ? ALL_VALUE : opt.value,
    }));
  }, [options]);

  const filteredOptions = React.useMemo(() => {
    if (!search.trim()) return normalizedOptions;
    const lowerSearch = search.toLowerCase();
    return normalizedOptions.filter(
      (opt) => opt.label.toLowerCase().includes(lowerSearch) || (opt.value !== ALL_VALUE && opt.value.toLowerCase().includes(lowerSearch))
    );
  }, [normalizedOptions, search, ALL_VALUE]);

  const currentValue = value || ALL_VALUE;
  const selectedOption = React.useMemo(() => normalizedOptions.find((opt) => opt.value === currentValue), [normalizedOptions, currentValue]);

  React.useEffect(() => {
    if (open && searchInputRef.current) {
      // 延迟聚焦，确保下拉框已打开
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    } else if (!open) {
      // 关闭时清空搜索
      setSearch('');
    }
  }, [open]);

  const handleValueChange = (newValue: string) => {
    onValueChange(newValue === ALL_VALUE ? '' : newValue);
  };

  return (
    <SelectPrimitive.Root value={currentValue} onValueChange={handleValueChange} open={open} onOpenChange={setOpen} disabled={disabled}>
      <SelectPrimitive.Trigger
        className={selectTriggerClass({ uiSize, hasLeftIcon: !!leftIcon, disabled, className })}
        style={{ ...selectTriggerStyle, ...style }}
      >
        {leftIcon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }}>
            {leftIcon}
          </div>
        )}
        <SelectPrimitive.Value placeholder={placeholder}>
          {selectedOption?.displayLabel || selectedOption?.label || placeholder}
        </SelectPrimitive.Value>
        <ChevronDown
          aria-hidden
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
          style={{ color: 'var(--text-muted)' }}
        />
      </SelectPrimitive.Trigger>

      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className={selectContentClass}
          style={selectContentStyle}
          position="popper"
          sideOffset={8}
        >
          {/* 搜索框 */}
          <div className="p-2 border-b" style={{ borderColor: 'rgba(255,255,255,0.12)' }}>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索..."
                className="w-full pl-8 pr-7 h-8 rounded-[8px] text-sm outline-none"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'var(--text-primary)',
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setOpen(false);
                  }
                  // 阻止事件冒泡，避免关闭下拉框
                  e.stopPropagation();
                }}
              />
              {search && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSearch('');
                    searchInputRef.current?.focus();
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>

          {/* 选项列表 */}
          <SelectPrimitive.Viewport className={selectViewportClass} style={selectViewportStyle}>
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                未找到匹配项
              </div>
            ) : (
              filteredOptions.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  className={selectItemClass}
                  style={{
                    color: 'var(--text-primary)',
                  }}
                >
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                </SelectPrimitive.Item>
              ))
            )}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

