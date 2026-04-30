import { useMemo, useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import {
  MODEL_TYPE_DEFINITIONS,
  MODEL_TYPE_CATEGORIES,
  type ModelTypeDefinition,
} from '@/lib/appCallerUtils';

interface ModelTypePickerProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 紧凑模式：直接展示网格，不可折叠 */
  compact?: boolean;
}

/**
 * 模型类型选择面板
 * 点击后弹出浮动面板（popover），不撑开页面布局。
 */
export function ModelTypePicker({ value, onChange, disabled, compact }: ModelTypePickerProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => MODEL_TYPE_DEFINITIONS.find((d) => d.value === value),
    [value],
  );

  const grouped = useMemo(() => {
    const groups: Record<string, ModelTypeDefinition[]> = {};
    for (const def of MODEL_TYPE_DEFINITIONS) {
      (groups[def.category] ??= []).push(def);
    }
    return groups;
  }, []);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        anchorRef.current?.contains(e.target as Node) ||
        popoverRef.current?.contains(e.target as Node)
      ) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // compact 模式保持内联展示
  if (compact) {
    return (
      <InlineGrid
        grouped={grouped}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }

  return (
    <div ref={anchorRef} className="relative">
      {/* 触发按钮 */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        className="model-type-trigger w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-left transition-all disabled:cursor-not-allowed disabled:opacity-60"
        data-open={open}
        data-active={!!selected}
      >
        {selected ? (
          <>
            <span
              className="model-type-icon shrink-0 w-8 h-8 rounded-[10px] flex items-center justify-center"
            >
              <selected.icon size={16} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="model-type-label text-[13px] font-medium">
                {selected.label}
              </div>
              <div className="text-[11px] truncate text-token-muted">
                {selected.description}
              </div>
            </div>
          </>
        ) : (
          <span className="text-[13px] text-token-muted">
            选择模型类型...
          </span>
        )}
        <ChevronDown
          size={14}
          className={`shrink-0 text-token-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* 浮动面板 */}
      {open && (
        <div
          ref={popoverRef}
          className="surface-popover absolute z-50 mt-1 w-full rounded-[12px] overflow-y-auto overflow-hidden shadow-lg max-h-[360px]"
        >
          <div className="p-2 space-y-3">
            {(['core', 'extended', 'media'] as const).map((cat) => {
              const items = grouped[cat];
              if (!items?.length) return null;
              return (
                <div key={cat}>
                  <div
                    className="text-[10px] font-semibold uppercase tracking-wider px-1 mb-1.5 text-token-muted"
                  >
                    {MODEL_TYPE_CATEGORIES[cat]}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {items.map((def) => {
                      const isSelected = value === def.value;
                      return (
                        <button
                          key={def.value}
                          type="button"
                          onClick={() => {
                            onChange(def.value);
                            setOpen(false);
                          }}
                          className="model-type-option flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] text-left transition-all group"
                          data-active={isSelected}
                        >
                          <span
                            className="model-type-icon shrink-0 w-7 h-7 rounded-[8px] flex items-center justify-center"
                          >
                            <def.icon size={14} />
                          </span>
                          <div className="flex-1 min-w-0">
                            <div
                              className="model-type-label text-[12px] font-medium leading-tight"
                            >
                              {def.label}
                            </div>
                            <div
                              className="text-[10px] leading-tight truncate mt-0.5 text-token-muted"
                            >
                              {def.description}
                            </div>
                          </div>
                          {isSelected && (
                            <Check size={14} className="shrink-0 text-token-accent" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** compact 模式内联网格（不变） */
function InlineGrid({
  grouped,
  value,
  onChange,
  disabled,
}: {
  grouped: Record<string, ModelTypeDefinition[]>;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="surface-inset rounded-[12px] overflow-hidden">
      <div className="p-2 space-y-3">
        {(['core', 'extended', 'media'] as const).map((cat) => {
          const items = grouped[cat];
          if (!items?.length) return null;
          return (
            <div key={cat}>
              <div
                className="text-[10px] font-semibold uppercase tracking-wider px-1 mb-1.5 text-token-muted"
              >
                {MODEL_TYPE_CATEGORIES[cat]}
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {items.map((def) => {
                  const isSelected = value === def.value;
                  return (
                    <button
                      key={def.value}
                      type="button"
                      disabled={disabled}
                      onClick={() => onChange(def.value)}
                      className="model-type-option flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] text-left transition-all group disabled:cursor-not-allowed disabled:opacity-50"
                      data-active={isSelected}
                    >
                      <span
                        className="model-type-icon shrink-0 w-7 h-7 rounded-[8px] flex items-center justify-center"
                      >
                        <def.icon size={14} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div
                          className="model-type-label text-[12px] font-medium leading-tight"
                        >
                          {def.label}
                        </div>
                        <div
                          className="text-[10px] leading-tight truncate mt-0.5 text-token-muted"
                        >
                          {def.description}
                        </div>
                      </div>
                      {isSelected && (
                        <Check size={14} className="shrink-0 text-token-accent" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 模型类型筛选栏（横向标签组，用于列表页顶部过滤）
 */
interface ModelTypeFilterBarProps {
  value: string;
  onChange: (value: string) => void;
}

export function ModelTypeFilterBar({ value, onChange }: ModelTypeFilterBarProps) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <FilterTag label="全部" isActive={value === 'all'} onClick={() => onChange('all')} />
      {MODEL_TYPE_DEFINITIONS.map((def) => (
        <FilterTag
          key={def.value}
          label={def.label}
          icon={def.icon}
          isActive={value === def.value}
          onClick={() => onChange(def.value)}
        />
      ))}
    </div>
  );
}

function FilterTag({
  label,
  icon: Icon,
  isActive,
  onClick,
}: {
  label: string;
  icon?: React.ComponentType<any>;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="model-type-option flex items-center gap-1 px-2 py-1 rounded-[8px] text-[11px] font-medium text-token-muted transition-all whitespace-nowrap"
      data-active={isActive}
    >
      {Icon && <Icon size={12} />}
      {label}
    </button>
  );
}
