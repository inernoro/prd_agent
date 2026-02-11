import { cn } from '@/lib/cn';
import { glassPanel } from '@/lib/glassStyles';

/**
 * Card 组件 - 磨砂玻璃/Obsidian 效果
 *
 * 注意：完全避免使用 color-mix() 函数，因为：
 * 1. 部分浏览器/WebView 不支持（如 Tauri WebView、旧版 Chrome）
 * 2. 不支持时整个 CSS 属性会失效，导致背景/边框"消失"
 * 3. 已观察到此问题出现多次，故改用纯 rgba 值
 *
 * 背景使用 CSS 变量，性能模式下自动切换为实底值。
 */
export function Card({
  className,
  children,
  variant = 'default',
}: {
  className?: string;
  children: React.ReactNode;
  variant?: 'default' | 'gold';
}) {
  const goldGlow = 'radial-gradient(600px 400px at 50% 0%, rgba(214,178,106,0.15) 0%, transparent 65%)';
  const defaultSheen = 'linear-gradient(135deg, rgba(255,255,255,0.03) 0%, transparent 50%)';

  return (
    <div
      className={cn(
        'relative rounded-[20px] p-6 transition-all duration-200 overflow-hidden',
        className
      )}
      style={{
        ...glassPanel,
        // 叠加装饰渐变
        background: `${variant === 'gold' ? goldGlow : defaultSheen}, ${glassPanel.background}`,
        // 方向性边框：顶部/左侧更亮，模拟光照
        borderTop: variant === 'gold'
          ? '1px solid rgba(214, 178, 106, 0.25)'
          : '1px solid var(--glass-border, rgba(255, 255, 255, 0.12))',
        borderLeft: variant === 'gold'
          ? '1px solid rgba(214, 178, 106, 0.15)'
          : '1px solid var(--glass-border, rgba(255, 255, 255, 0.08))',
        borderRight: '1px solid var(--border-faint, rgba(255, 255, 255, 0.04))',
        borderBottom: '1px solid var(--border-faint, rgba(255, 255, 255, 0.02))',
        // 投影 + 内发光
        boxShadow: variant === 'gold'
          ? '0 20px 40px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(214, 178, 106, 0.05) inset, 0 1px 0 rgba(255, 255, 255, 0.05) inset'
          : '0 16px 32px -8px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.03) inset, 0 1px 0 rgba(255, 255, 255, 0.04) inset',
      }}
    >
      {children}
    </div>
  );
}

