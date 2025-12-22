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
        // 不再用“透背景”的 hover，避免动态背景下元素显乱
        'hover:brightness-[1.02]',
        className
      )}
      style={{
        background:
          variant === 'gold'
            ? 'linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 92%, black) 0%, color-mix(in srgb, var(--bg-elevated) 86%, black) 100%), radial-gradient(520px 360px at 50% 0%, rgba(214,178,106,0.12) 0%, transparent 58%)'
            : 'linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 92%, black) 0%, color-mix(in srgb, var(--bg-elevated) 86%, black) 100%)',
        border:
          variant === 'gold'
            ? '1px solid color-mix(in srgb, var(--accent-gold) 45%, var(--border-default))'
            : '1px solid color-mix(in srgb, var(--border-subtle) 80%, rgba(255,255,255,0.12))',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {children}
    </div>
  );
}

