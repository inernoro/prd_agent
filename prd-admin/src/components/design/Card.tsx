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
        // 更紧凑、更扁平：默认 padding 更小
        // 注：移除 hover:brightness 滤镜，该滤镜会导致 Windows 下字体渲染闪烁（hover 时变细，移开后变粗/模糊）
        'rounded-[16px] p-4',
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

