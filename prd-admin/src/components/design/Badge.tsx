import { cn } from '@/lib/cn';

export function Badge({
  children,
  variant = 'subtle',
  className,
  icon,
  size = 'default',
}: {
  children: React.ReactNode;
  variant?: 'subtle' | 'discount' | 'new' | 'featured' | 'success' | 'danger' | 'warning';
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
            background: 'var(--nested-block-bg)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-primary)',
          }
        : variant === 'featured'
          ? {
              background: 'rgba(99, 102, 241, 0.18)',
              border: '1px solid rgba(99, 102, 241, 0.35)',
              color: 'var(--accent-gold-2)',
            }
          // 三个语义档：底走 12% 同色调（两个主题都成立），字必须走双写的 --accent-fg-*。
          // 原来字也写死 500 档，浅色下等于「浅琥珀字压浅琥珀底」——全站审计在 tapd-bug-agent
          // 抓到「需确认 / 待补充」1.74:1，同一枚 Badge 出现在多少页就错多少页。
          : variant === 'success'
            ? {
                background: 'rgba(34,197,94,0.12)',
                border: '1px solid rgba(34,197,94,0.28)',
                color: 'var(--accent-fg-success)',
              }
            : variant === 'danger'
              ? {
                  background: 'rgba(239,68,68,0.12)',
                  border: '1px solid rgba(239,68,68,0.28)',
                  color: 'var(--accent-fg-danger)',
                }
              : variant === 'warning'
                ? {
                    background: 'rgba(245,158,11,0.12)',
                    border: '1px solid rgba(245,158,11,0.28)',
                    color: 'var(--accent-fg-amber)',
                  }
                : {
                    background: 'var(--nested-block-bg)',
                    border: '1px solid var(--border-subtle)',
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
