import { cn } from '@/lib/cn';
import * as React from 'react';

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  label,
  labelIcon,
  ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  /** 可选：左侧文字标签 */
  label?: string;
  /** 可选：左侧标签图标（与 label 搭配） */
  labelIcon?: React.ReactNode;
  /** 可选：无障碍标签（label 未传时建议提供） */
  ariaLabel?: string;
}) {
  const id = React.useId();
  const btn = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={label ? id : undefined}
      onClick={() => onCheckedChange(!checked)}
      disabled={disabled}
      className={cn(
        'relative h-7 w-12 rounded-full transition-colors disabled:opacity-60',
        'focus-visible:ring-2 focus-visible:ring-white/20',
        className
      )}
      style={{
        background: checked ? 'rgba(34,197,94,0.22)' : 'rgba(255,255,255,0.10)',
        border: checked ? '1px solid rgba(34,197,94,0.35)' : '1px solid rgba(255,255,255,0.14)',
      }}
    >
      <span
        className="absolute top-1 left-1 h-5 w-5 rounded-full transition-transform"
        style={{
          transform: checked ? 'translateX(20px)' : 'translateX(0px)',
          background: checked ? 'rgba(34,197,94,0.95)' : 'rgba(247,247,251,0.65)',
        }}
      />
    </button>
  );

  if (!label) return btn;

  return (
    <div className="flex items-center gap-2">
      <span id={id} className="inline-flex items-center gap-1.5 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
        {labelIcon ? <span className="shrink-0">{labelIcon}</span> : null}
        <span>{label}</span>
      </span>
      {btn}
    </div>
  );
}

