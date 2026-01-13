import { cn } from '@/lib/cn';

export function Badge({
  children,
  variant = 'subtle',
  className,
  icon,
  size = 'default',
}: {
  children: React.ReactNode;
  variant?: 'subtle' | 'discount' | 'new' | 'featured' | 'success';
  className?: string;
  icon?: React.ReactNode;
  size?: 'default' | 'sm';
}) {
  // 避免使用 color-mix()，直接用 rgba 值
  const style: React.CSSProperties =
    variant === 'discount'
      ? {
          background: 'rgba(124, 252, 0, 0.18)',
          border: '1px solid rgba(124, 252, 0, 0.35)',
          color: 'var(--accent-green)',
        }
      : variant === 'new'
        ? {
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.14)',
            color: 'var(--text-primary)',
          }
        : variant === 'featured'
          ? {
              background: 'rgba(214, 178, 106, 0.18)',
              border: '1px solid rgba(214, 178, 106, 0.35)',
              color: 'var(--accent-gold-2)',
            }
          : variant === 'success'
            ? {
                background: 'rgba(34,197,94,0.12)',
                border: '1px solid rgba(34,197,94,0.28)',
                color: 'rgba(34,197,94,0.95)',
              }
            : {
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: 'var(--text-secondary)',
              };

  const sizeCls = size === 'sm' ? 'px-1.5 py-0.5 text-[10px] gap-1' : 'px-2.5 py-1 text-[11px] gap-1.5';

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-semibold tracking-wide',
        sizeCls,
        variant === 'featured' && 'h-5',
        className
      )}
      style={style}
    >
      {icon}
      {children}
    </span>
  );
}
