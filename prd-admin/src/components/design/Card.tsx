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
        // 更精致的圆角和内边距，增加呼吸感
        'rounded-[20px] p-6 transition-all duration-200',
        className
      )}
      style={{
        /**
         * 兼容兜底：部分环境（旧 WebView / 某些浏览器版本）不支持 color-mix()，
         * 会导致整个 background 声明无效 -> 卡片变"透明"从而看不清字。
         * 这里用 backgroundColor 作为可靠兜底；渐变用 backgroundImage（失败也不影响底色）。
         */
        backgroundColor: 'var(--bg-elevated)',
        backgroundImage:
          variant === 'gold'
            ? 'linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 94%, black) 0%, color-mix(in srgb, var(--bg-elevated) 88%, black) 100%), radial-gradient(600px 400px at 50% 0%, rgba(214,178,106,0.15) 0%, transparent 65%)'
            : 'linear-gradient(135deg, color-mix(in srgb, var(--bg-elevated) 96%, white) 0%, color-mix(in srgb, var(--bg-elevated) 92%, black) 100%)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: variant === 'gold' 
          ? 'color-mix(in srgb, var(--border-default) 80%, transparent)' 
          : 'color-mix(in srgb, var(--border-subtle) 60%, transparent)',
        boxShadow: variant === 'gold'
          ? '0 8px 32px -8px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.03) inset, 0 2px 8px rgba(214, 178, 106, 0.08)'
          : '0 4px 24px -4px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.02) inset',
      }}
    >
      {children}
    </div>
  );
}

