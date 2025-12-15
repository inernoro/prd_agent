import { cn } from '@/lib/cn';

export function Card({
  className,
  children,
  variant = 'default',
}: {
  className?: string;
  children: React.ReactNode;
  variant?: 'default' | 'gold';
}) {
  return (
    <div
      className={cn(
        // 更紧凑、更扁平：默认 padding 更小，去掉上浮，靠描边/底色变化营造 hover
        'rounded-[16px] p-4 transition-colors duration-150',
        'hover:bg-white/4',
        className
      )}
      style={{
        background:
          variant === 'gold'
            ? 'linear-gradient(180deg, rgba(214,178,106,0.10) 0%, rgba(255,255,255,0.02) 45%, rgba(255,255,255,0.015) 100%)'
            : 'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)',
        border:
          variant === 'gold'
            ? '1px solid color-mix(in srgb, var(--accent-gold) 45%, var(--border-default))'
            : '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {children}
    </div>
  );
}

