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
        /**
         * 兼容兜底：部分环境（旧 WebView / 某些浏览器版本）不支持 color-mix()，
         * 会导致整个 background 声明无效 -> 卡片变“透明”从而看不清字。
         * 这里用 backgroundColor 作为可靠兜底；渐变用 backgroundImage（失败也不影响底色）。
         */
        backgroundColor: 'var(--bg-elevated)',
        backgroundImage:
          variant === 'gold'
            ? 'linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 92%, black) 0%, color-mix(in srgb, var(--bg-elevated) 86%, black) 100%), radial-gradient(520px 360px at 50% 0%, rgba(214,178,106,0.12) 0%, transparent 58%)'
            : 'linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 92%, black) 0%, color-mix(in srgb, var(--bg-elevated) 86%, black) 100%)',
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: variant === 'gold' ? 'var(--border-default)' : 'var(--border-subtle)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {children}
    </div>
  );
}

