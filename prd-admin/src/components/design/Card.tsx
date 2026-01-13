import { cn } from '@/lib/cn';

/**
 * Card 组件
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
        'rounded-[20px] p-6 transition-all duration-200',
        className
      )}
      style={{
        // 纯色背景兜底 + 渐变叠加（不使用 color-mix）
        backgroundColor: '#121216',
        backgroundImage:
          variant === 'gold'
            // gold: 深色渐变 + 顶部金色光晕
            ? 'linear-gradient(135deg, rgba(16,16,19,1) 0%, rgba(10,10,12,1) 100%), radial-gradient(600px 400px at 50% 0%, rgba(214,178,106,0.12) 0%, transparent 65%)'
            // default: 微亮到微暗的渐变
            : 'linear-gradient(135deg, rgba(20,20,24,1) 0%, rgba(14,14,17,1) 100%)',
        border: variant === 'gold' 
          ? '1px solid rgba(255, 255, 255, 0.1)' 
          : '1px solid rgba(255, 255, 255, 0.06)',
        boxShadow: variant === 'gold'
          ? '0 8px 32px -8px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.03) inset, 0 2px 8px rgba(214, 178, 106, 0.08)'
          : '0 4px 24px -4px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.02) inset',
      }}
    >
      {children}
    </div>
  );
}

