import { cn } from '@/lib/cn';
import * as React from 'react';
import { useDataTheme } from '@/pages/report-agent/hooks/useDataTheme';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

type Size = 'xs' | 'sm' | 'md';

const DARK_STYLES: Record<Variant, React.CSSProperties> = {
  primary: {
    boxShadow: '0 4px 16px -2px rgba(99, 102, 241, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1) inset',
    isolation: 'isolate',
  },
  secondary: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.10)',
    boxShadow: '0 2px 8px -2px rgba(0, 0, 0, 0.2), 0 0 0 1px rgba(255, 255, 255, 0.02) inset',
  },
  danger: {
    background: 'rgba(239,68,68,0.10)',
    border: '1px solid rgba(239,68,68,0.25)',
    boxShadow: '0 2px 8px -2px rgba(239, 68, 68, 0.2)',
  },
  ghost: {
    background: 'transparent',
  },
};

// 浅色 Anthropic 暖白底:primary 暖橙实色,secondary 纯白卡片+hairline,danger 柔红实描边,ghost 透明。
const LIGHT_STYLES: Record<Variant, React.CSSProperties> = {
  primary: {
    background: 'var(--accent-claude)',
    boxShadow: '0 2px 6px rgba(204, 120, 92, 0.22), 0 1px 2px rgba(89, 65, 50, 0.06)',
    isolation: 'isolate',
  },
  secondary: {
    background: 'var(--bg-card)',
    border: '1px solid var(--hairline)',
    boxShadow: 'var(--shadow-card-sm)',
  },
  danger: {
    background: 'rgba(220, 38, 38, 0.06)',
    border: '1px solid rgba(220, 38, 38, 0.30)',
    boxShadow: '0 1px 3px rgba(220, 38, 38, 0.08)',
  },
  ghost: {
    background: 'transparent',
  },
};

const DARK_HOVER: Record<Variant, string> = {
  primary: 'btn-primary-anim hover:brightness-[1.05] hover:shadow-lg',
  secondary: 'hover:bg-white/10 hover:border-white/20 active:scale-[0.98]',
  danger: 'hover:bg-[rgba(239,68,68,0.15)] active:scale-[0.98]',
  ghost: 'hover:bg-white/6 active:scale-[0.98]',
};

// 浅色 hover/active 详见 globals.css 的 [data-theme="light"] .btn-light-* 规则
const LIGHT_HOVER: Record<Variant, string> = {
  primary: 'btn-light-primary',
  secondary: 'btn-light-secondary',
  danger: 'btn-light-danger',
  ghost: 'btn-light-ghost',
};

const DARK_TEXT: Record<Variant, string> = {
  primary: 'text-[#ffffff]',
  secondary: 'text-[color:var(--text-primary)]',
  danger: 'text-[rgba(239,68,68,0.95)]',
  ghost: 'text-[color:var(--text-primary)]',
};

const LIGHT_TEXT: Record<Variant, string> = {
  primary: 'text-[#ffffff]',
  secondary: 'text-[color:var(--text-primary)]',
  danger: 'text-[rgba(185,28,28,1)]',
  ghost: 'text-[color:var(--text-secondary)]',
};

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
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';

  const base =
    'inline-flex items-center justify-center gap-2 font-semibold transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed';

  const sizeCls =
    size === 'xs'
      ? 'h-[28px] px-3 rounded-[9px] text-[12px]'
      : size === 'sm'
        ? 'h-[28px] px-3 rounded-[9px] text-[12px]'
        : 'h-11 px-5 rounded-[14px] text-[14px]';

  const variantCls = isLight ? LIGHT_TEXT[variant] : DARK_TEXT[variant];
  const style = isLight ? LIGHT_STYLES[variant] : DARK_STYLES[variant];
  const hoverCls = isLight ? LIGHT_HOVER[variant] : DARK_HOVER[variant];

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
