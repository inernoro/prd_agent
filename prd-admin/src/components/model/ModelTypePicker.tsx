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
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[12px] text-left transition-all"
        style={{
          background: 'var(--bg-input)',
          border: `1px solid ${open ? 'var(--accent-alpha-30)' : 'var(--border-subtle)'}`,
          opacity: disabled ? 0.6 : 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {selected ? (
          <>
            <span
              className="shrink-0 w-8 h-8 rounded-[10px] flex items-center justify-center"
              style={{ background: 'var(--accent-alpha-10)', color: 'var(--accent)' }}
            >
              <selected.icon size={16} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {selected.label}
              </div>
              <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                {selected.description}
              </div>
            </div>
          </>
        ) : (
          <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
            选择模型类型...
          </span>
        )}
        <ChevronDown
          size={14}
          style={{
            color: 'var(--text-muted)',
            transform: open ? 'rotate(180deg)' : undefined,
            transition: 'transform 0.2s',
          }}
          className="shrink-0"
        />
      </button>

      {/* 浮动面板 */}
      {open && (
        <div
          ref={popoverRef}
          className="absolute z-50 mt-1 w-full rounded-[12px] overflow-hidden shadow-lg"
          style={{
            background: 'var(--bg-elevated, var(--bg-input))',
            border: '1px solid var(--border-subtle)',
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          <div className="p-2 space-y-3">
            {(['core', 'extended', 'media'] as const).map((cat) => {
              const items = grouped[cat];
              if (!items?.length) return null;
              return (
                <div key={cat}>
                  <div
                    className="text-[10px] font-semibold uppercase tracking-wider px-1 mb-1.5"
                    style={{ color: 'var(--text-muted)' }}
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
                          className="flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] text-left transition-all group"
                          style={{
                            background: isSelected ? 'var(--accent-alpha-10)' : 'transparent',
                            border: isSelected
                              ? '1px solid var(--accent-alpha-30)'
                              : '1px solid transparent',
                          }}
                          onMouseEnter={(e) => {
                            if (!isSelected) {
                              e.currentTarget.style.background = 'var(--bg-hover)';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!isSelected) {
                              e.currentTarget.style.background = 'transparent';
                            }
                          }}
                        >
                          <span
                            className="shrink-0 w-7 h-7 rounded-[8px] flex items-center justify-center"
                            style={{
                              background: isSelected ? 'var(--accent-alpha-20)' : 'var(--bg-tertiary)',
                              color: isSelected ? 'var(--accent)' : 'var(--text-secondary)',
                            }}
                          >
                            <def.icon size={14} />
                          </span>
                          <div className="flex-1 min-w-0">
                            <div
                              className="text-[12px] font-medium leading-tight"
                              style={{ color: isSelected ? 'var(--accent)' : 'var(--text-primary)' }}
                            >
                              {def.label}
                            </div>
                            <div
                              className="text-[10px] leading-tight truncate mt-0.5"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {def.description}
                            </div>
                          </div>
                          {isSelected && (
                            <Check size={14} className="shrink-0" style={{ color: 'var(--accent)' }} />
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
    <div
      className="rounded-[12px] overflow-hidden"
      style={{ background: 'var(--bg-input)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="p-2 space-y-3">
        {(['core', 'extended', 'media'] as const).map((cat) => {
          const items = grouped[cat];
          if (!items?.length) return null;
          return (
            <div key={cat}>
              <div
                className="text-[10px] font-semibold uppercase tracking-wider px-1 mb-1.5"
                style={{ color: 'var(--text-muted)' }}
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
                      className="flex items-center gap-2.5 px-2.5 py-2 rounded-[10px] text-left transition-all group"
                      style={{
                        background: isSelected ? 'var(--accent-alpha-10)' : 'transparent',
                        border: isSelected
                          ? '1px solid var(--accent-alpha-30)'
                          : '1px solid transparent',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        opacity: disabled ? 0.5 : 1,
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected && !disabled) e.currentTarget.style.background = 'var(--bg-hover)';
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span
                        className="shrink-0 w-7 h-7 rounded-[8px] flex items-center justify-center"
                        style={{
                          background: isSelected ? 'var(--accent-alpha-20)' : 'var(--bg-tertiary)',
                          color: isSelected ? 'var(--accent)' : 'var(--text-secondary)',
                        }}
                      >
                        <def.icon size={14} />
                      </span>
                      <div className="flex-1 min-w-0">
                        <div
                          className="text-[12px] font-medium leading-tight"
                          style={{ color: isSelected ? 'var(--accent)' : 'var(--text-primary)' }}
                        >
                          {def.label}
                        </div>
                        <div
                          className="text-[10px] leading-tight truncate mt-0.5"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {def.description}
                        </div>
                      </div>
                      {isSelected && (
                        <Check size={14} className="shrink-0" style={{ color: 'var(--accent)' }} />
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
      className="flex items-center gap-1 px-2 py-1 rounded-[8px] text-[11px] font-medium transition-all whitespace-nowrap"
      style={{
        background: isActive ? 'var(--accent-alpha-15)' : 'transparent',
        color: isActive ? 'var(--accent)' : 'var(--text-muted)',
        border: isActive ? '1px solid var(--accent-alpha-30)' : '1px solid transparent',
      }}
      onMouseEnter={(e) => {
        if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        if (!isActive) e.currentTarget.style.background = 'transparent';
      }}
    >
      {Icon && <Icon size={12} />}
      {label}
    </button>
  );
}
