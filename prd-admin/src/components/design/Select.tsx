import { cn } from '@/lib/cn';
import { ChevronDown } from 'lucide-react';
import * as React from 'react';

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement> & {
    /** 仅用于调整整体高度（与 Button 的尺寸体系对齐） */
    uiSize?: 'sm' | 'md';
  }
>(function Select({ className, style, uiSize = 'md', disabled, ...props }, ref) {
  const sizeCls = uiSize === 'sm' ? 'h-9 rounded-[12px] text-sm' : 'h-10 rounded-[14px] text-[13px]';

  return (
    <div className={cn('relative', disabled ? 'opacity-60' : '')}>
      <select
        ref={ref}
        disabled={disabled}
        className={cn(
          'w-full px-3 pr-9 outline-none transition-colors',
          'hover:border-white/20',
          'focus-visible:ring-2 focus-visible:ring-white/20',
          sizeCls,
          className
        )}
        style={{
          background: 'var(--bg-input)',
          border: '1px solid rgba(255,255,255,0.12)',
          color: 'var(--text-primary)',
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

