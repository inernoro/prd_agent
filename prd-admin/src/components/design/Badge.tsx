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
  const style: React.CSSProperties =
    variant === 'discount'
      ? {
          background: 'color-mix(in srgb, var(--accent-green) 18%, transparent)',
          border: '1px solid color-mix(in srgb, var(--accent-green) 35%, transparent)',
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
              background: 'color-mix(in srgb, var(--accent-gold) 18%, transparent)',
              border: '1px solid color-mix(in srgb, var(--accent-gold) 35%, transparent)',
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
