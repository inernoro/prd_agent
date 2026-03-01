import { cn } from '@/lib/cn';
import * as React from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

type Size = 'xs' | 'sm' | 'md';

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    size?: Size;
  }
>(function Button(
  { className, variant = 'secondary', size = 'md', type = 'button', ...props },
  ref
) {
  const base =
    'inline-flex items-center justify-center gap-2 font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed';

  // 更精致的控件高度和圆角
  const sizeCls =
    size === 'xs'
      ? 'h-[28px] px-3 rounded-[9px] text-[12px]'
      : size === 'sm'
        ? 'h-[28px] px-3 rounded-[9px] text-[12px]'
        : 'h-11 px-5 rounded-[14px] text-[14px]';

  const variantCls =
    variant === 'primary'
      ? 'text-[#ffffff]'
      : variant === 'danger'
        ? 'text-[rgba(239,68,68,0.95)]'
        : 'text-[color:var(--text-primary)]';

  const style: React.CSSProperties =
    variant === 'primary'
      ? { 
          background: 'var(--gold-gradient)', 
          boxShadow: '0 4px 16px -2px rgba(99, 102, 241, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1) inset',
          // 隔离阴影效果，防止与 GlassCard 的 backdrop-filter 产生异常渲染
          isolation: 'isolate',
        }
      : variant === 'secondary'
        ? { 
            background: 'rgba(255,255,255,0.05)', 
            border: '1px solid rgba(255,255,255,0.10)',
            boxShadow: '0 2px 8px -2px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(255, 255, 255, 0.02) inset',
          }
        : variant === 'danger'
          ? { 
              background: 'rgba(239,68,68,0.10)', 
              border: '1px solid rgba(239,68,68,0.25)',
              boxShadow: '0 2px 8px -2px rgba(239, 68, 68, 0.2)',
            }
          : { background: 'transparent' };

  const hoverCls =
    variant === 'primary'
      ? 'btn-primary-anim hover:brightness-[1.05] hover:shadow-lg'
      : variant === 'secondary'
        ? 'hover:bg-white/10 hover:border-white/20 active:scale-[0.98]'
        : variant === 'danger'
          ? 'hover:bg-[rgba(239,68,68,0.15)] active:scale-[0.98]'
          : 'hover:bg-white/6 active:scale-[0.98]';

  return (
    <button
      ref={ref}
      type={type}
      className={cn(base, sizeCls, variantCls, hoverCls, className)}
      style={style}
      {...props}
    />
  );
});

Button.displayName = 'Button';
