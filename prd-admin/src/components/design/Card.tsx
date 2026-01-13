import { cn } from '@/lib/cn';

/**
 * Card 组件 - 磨砂玻璃效果
 * 
 * 注意：完全避免使用 color-mix() 函数，因为：
 * 1. 部分浏览器/WebView 不支持（如 Tauri WebView、旧版 Chrome）
 * 2. 不支持时整个 CSS 属性会失效，导致背景/边框"消失"
 * 3. 已观察到此问题出现多次，故改用纯 rgba 值
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
  return (
    <div
      className={cn(
        'relative rounded-[20px] p-6 transition-all duration-200 overflow-hidden',
        className
      )}
      style={{
        // 半透明背景 + 磨砂玻璃效果
        backgroundColor: variant === 'gold' 
          ? 'rgba(16, 16, 19, 0.75)' 
          : 'rgba(18, 18, 22, 0.65)',
        backgroundImage:
          variant === 'gold'
            // gold: 顶部金色光晕
            ? 'radial-gradient(600px 400px at 50% 0%, rgba(214,178,106,0.15) 0%, transparent 65%)'
            // default: 微妙的渐变
            : 'linear-gradient(135deg, rgba(255,255,255,0.03) 0%, transparent 50%)',
        // 磨砂玻璃模糊效果
        backdropFilter: 'blur(16px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.2)',
        // 玻璃边框：顶部/左侧更亮，模拟光照
        borderTop: variant === 'gold' 
          ? '1px solid rgba(214, 178, 106, 0.25)' 
          : '1px solid rgba(255, 255, 255, 0.12)',
        borderLeft: variant === 'gold'
          ? '1px solid rgba(214, 178, 106, 0.15)'
          : '1px solid rgba(255, 255, 255, 0.08)',
        borderRight: '1px solid rgba(255, 255, 255, 0.04)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.02)',
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

