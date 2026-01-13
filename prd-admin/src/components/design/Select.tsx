import { cn } from '@/lib/cn';
import { ChevronDown } from 'lucide-react';
import * as React from 'react';

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & {
    /** 仅用于调整整体高度（与 Button 的尺寸体系对齐） */
    uiSize?: 'sm' | 'md';
    /** 左侧图标 */
    leftIcon?: React.ReactNode;
  }
>(function Select({ className, style, uiSize = 'md', disabled, leftIcon, ...props }, ref) {
  const sizeCls = uiSize === 'sm' ? 'h-[28px] rounded-[9px] text-[12px]' : 'h-10 rounded-[14px] text-[13px]';
  const paddingLeft = leftIcon ? 'pl-9' : 'px-3';

  return (
    <div className={cn('relative', disabled ? 'opacity-60' : '')}>
      {leftIcon && (
        <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-muted)' }}>
          {leftIcon}
        </div>
      )}
      <select
        ref={ref}
        disabled={disabled}
        className={cn(
          'w-full pr-9 outline-none transition-colors',
          paddingLeft,
          'hover:border-white/20',
          'focus-visible:ring-2 focus-visible:ring-white/20',
          sizeCls,
          className
        )}
        style={{
          background: 'var(--bg-input)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'var(--text-primary)',
          // 让原生下拉面板按暗色方案渲染，避免白底 + 白字的可读性问题
          colorScheme: 'dark',
          appearance: 'none',
          WebkitAppearance: 'none',
          ...style,
        }}
        {...props}
      />
      <ChevronDown
        aria-hidden
        size={16}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
        style={{ color: 'var(--text-muted)' }}
      />
    </div>
  );
});

Select.displayName = 'Select';

