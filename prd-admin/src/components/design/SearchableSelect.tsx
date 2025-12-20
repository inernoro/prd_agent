import { cn } from '@/lib/cn';
import * as SelectPrimitive from '@radix-ui/react-select';
import { ChevronDown, Search, X } from 'lucide-react';
import * as React from 'react';

export interface SearchableSelectOption {
  value: string;
  label: string;
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

  const sizeCls = uiSize === 'sm' ? 'h-9 rounded-[12px] text-sm' : 'h-10 rounded-[14px] text-[13px]';
  const paddingLeft = leftIcon ? 'pl-9' : 'px-3';

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
        className={cn(
          'w-full pr-9 outline-none transition-colors flex items-center',
          paddingLeft,
          'hover:border-white/20',
          'focus-visible:ring-2 focus-visible:ring-white/20',
          sizeCls,
          disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
          className
        )}
        style={{
          background: 'var(--bg-input)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'var(--text-primary)',
          ...style,
        }}
      >
        {leftIcon && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }}>
            {leftIcon}
          </div>
        )}
        <SelectPrimitive.Value placeholder={placeholder}>
          {selectedOption?.label || placeholder}
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
          className="z-50 rounded-[14px] overflow-hidden"
          style={{
            background: 'color-mix(in srgb, var(--bg-elevated) 92%, black)',
            border: '1px solid var(--border-default)',
            boxShadow: '0 18px 60px rgba(0,0,0,0.55)',
            minWidth: 'var(--radix-select-trigger-width)',
            maxHeight: 'var(--radix-select-content-available-height)',
          }}
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
          <SelectPrimitive.Viewport
            className="p-1"
            style={{
              maxHeight: 240,
              overflow: 'auto',
            }}
          >
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                未找到匹配项
              </div>
            ) : (
              filteredOptions.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  className={cn(
                    'px-3 py-2 rounded-[8px] text-sm cursor-pointer outline-none',
                    'hover:bg-white/8',
                    'focus:bg-white/8',
                    'data-[highlighted]:bg-white/8'
                  )}
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

