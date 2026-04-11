import { cn } from '@/lib/cn';

interface AuroraBackgroundProps {
  className?: string;
}

/**
 * 极光渐变背景 — 4 层彩色球体缓慢漂移 + mix-blend-mode 叠加在 Starfield 之上
 *
 * 设计目标：
 * - 替代"单色星空 2015 感"，给宇宙加上彩色光雾（cyan / violet / rose / electric blue）
 * - 每个球体独立动画 + 不同周期，永不重复
 * - mix-blend-mode: screen 让 Starfield 粒子能透过来，形成"星云"叠加感
 * - 性能：使用 transform 动画 + will-change，GPU 合成，滚动不掉帧
 */
export function AuroraBackground({ className }: AuroraBackgroundProps) {
  return (
    <div
      className={cn('absolute inset-0 overflow-hidden pointer-events-none', className)}
      aria-hidden
    >
      {/* Blob 1 — cyan 左上 */}
      <div
        className="absolute rounded-full"
        style={{
          top: '-18%',
          left: '-12%',
          width: '72vw',
          height: '72vw',
          background:
            'radial-gradient(circle at center, rgba(0, 240, 255, 0.55) 0%, rgba(0, 240, 255, 0.08) 45%, rgba(0, 240, 255, 0) 65%)',
          filter: 'blur(60px)',
          mixBlendMode: 'screen',
          animation: 'aurora-drift-1 24s ease-in-out infinite',
          willChange: 'transform',
        }}
      />

      {/* Blob 2 — violet 右上 */}
      <div
        className="absolute rounded-full"
        style={{
          top: '-8%',
          right: '-20%',
          width: '70vw',
          height: '70vw',
          background:
            'radial-gradient(circle at center, rgba(124, 58, 237, 0.62) 0%, rgba(124, 58, 237, 0.10) 45%, rgba(124, 58, 237, 0) 65%)',
          filter: 'blur(70px)',
          mixBlendMode: 'screen',
          animation: 'aurora-drift-2 30s ease-in-out infinite',
          willChange: 'transform',
        }}
      />

      {/* Blob 3 — rose 左下 */}
      <div
        className="absolute rounded-full"
        style={{
          bottom: '-22%',
          left: '10%',
          width: '64vw',
          height: '64vw',
          background:
            'radial-gradient(circle at center, rgba(244, 63, 94, 0.45) 0%, rgba(244, 63, 94, 0.06) 45%, rgba(244, 63, 94, 0) 65%)',
          filter: 'blur(80px)',
          mixBlendMode: 'screen',
          animation: 'aurora-drift-3 36s ease-in-out infinite',
          willChange: 'transform',
        }}
      />

      {/* Blob 4 — electric blue 中间 */}
      <div
        className="absolute rounded-full"
        style={{
          top: '32%',
          left: '28%',
          width: '50vw',
          height: '50vw',
          background:
            'radial-gradient(circle at center, rgba(59, 130, 246, 0.50) 0%, rgba(59, 130, 246, 0.08) 45%, rgba(59, 130, 246, 0) 65%)',
          filter: 'blur(70px)',
          mixBlendMode: 'screen',
          animation: 'aurora-drift-4 28s ease-in-out infinite',
          willChange: 'transform',
        }}
      />

      {/* 细噪点层（给光晕加质感，避免"塑料感"） */}
      <div
        className="absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />

      <style>{`
        @keyframes aurora-drift-1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33%       { transform: translate(6vw, 5vh) scale(1.15); }
          66%       { transform: translate(-3vw, 7vh) scale(0.9); }
        }
        @keyframes aurora-drift-2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50%       { transform: translate(-8vw, 6vh) scale(1.18); }
        }
        @keyframes aurora-drift-3 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          40%       { transform: translate(6vw, -5vh) scale(0.85); }
          80%       { transform: translate(-5vw, -8vh) scale(1.1); }
        }
        @keyframes aurora-drift-4 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50%       { transform: translate(-6vw, 5vh) scale(1.22); }
        }
      `}</style>
    </div>
  );
}
