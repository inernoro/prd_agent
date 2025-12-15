import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

type Size = 'sm' | 'md';

export function Button({
  className,
  variant = 'secondary',
  size = 'md',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed';

  // 更紧凑的控件高度（更像参照图的“工具型 UI”）
  const sizeCls =
    size === 'sm'
      ? 'h-8 px-3 rounded-[10px] text-[13px]'
      : 'h-10 px-4 rounded-[12px] text-[13px]';

  const variantCls =
    variant === 'primary'
      ? 'text-[#1a1206]'
      : variant === 'danger'
        ? 'text-[rgba(239,68,68,0.95)]'
        : 'text-[color:var(--text-primary)]';

  const style: React.CSSProperties =
    variant === 'primary'
      ? { background: 'var(--gold-gradient)', boxShadow: 'var(--shadow-gold)' }
      : variant === 'secondary'
        ? { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)' }
        : variant === 'danger'
          ? { background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.28)' }
          : { background: 'transparent' };

  const hoverCls =
    variant === 'primary'
      ? 'hover:brightness-[1.02]'
      : variant === 'secondary'
        ? 'hover:bg-white/8 hover:border-white/20'
        : variant === 'danger'
          ? 'hover:bg-[rgba(239,68,68,0.14)]'
          : 'hover:bg-white/5';

  return (
    <button
      type="button"
      className={cn(base, sizeCls, variantCls, hoverCls, className)}
      style={style}
      {...props}
    />
  );
}
