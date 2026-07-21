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

  const sizeCls =
    size === 'xs'
      ? 'h-[28px] px-3 rounded-[9px] text-[12px]'
      : size === 'sm'
        ? 'h-[28px] px-3 rounded-[9px] text-[12px]'
        : 'h-11 px-5 rounded-[14px] text-[14px]';

  return (
    <button
      ref={ref}
      type={type}
      className={cn(base, sizeCls, `map-btn map-btn-${variant} button-${variant}`, className)}
      {...props}
    />
  );
});

Button.displayName = 'Button';
