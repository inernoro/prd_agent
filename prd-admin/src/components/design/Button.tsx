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
      // map-btn-size-* 只是给 CSS 用的尺寸钩子，本身不带任何样式。
      // 弹窗（.prd-dialog-content）靠它把默认 md 按钮压到控制台的 32px 档，
      // 而 xs/sm 本来就是 28px，不该被再改一次——没有这个钩子就只能在 CSS 里
      // 反选 Tailwind 的 h-[28px]，那是把工具类当接口用，改一次尺寸就断。
      className={cn(base, sizeCls, `map-btn map-btn-${variant} map-btn-size-${size} button-${variant}`, className)}
      {...props}
    />
  );
});

Button.displayName = 'Button';
