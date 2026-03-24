import { useEffect, useState } from 'react';

/**
 * MAP 品牌过渡动画 — 用于页面懒加载等待期间。
 * #141418 底色 + MAP 字母依次浮现 + 底部扫光条。
 *
 * 两种模式：
 * - fullscreen（默认）：position:fixed 覆盖整个视口，用于首次加载 / 登录前
 * - inline：填满父容器，用于 AppShell 内页面切换（不遮挡侧边栏）
 */

const ANIM_ID = 'map-transition-keyframes';

function injectKeyframes() {
  if (document.getElementById(ANIM_ID)) return;
  const style = document.createElement('style');
  style.id = ANIM_ID;
  style.textContent = `
@keyframes map-letter-in {
  0%   { opacity: 0; transform: translateY(12px) scale(0.92); filter: blur(6px); }
  60%  { opacity: 1; transform: translateY(-2px) scale(1.02); filter: blur(0); }
  100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
}
@keyframes map-shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes map-bar-scan {
  0%   { transform: scaleX(0); opacity: 0.6; }
  50%  { transform: scaleX(1); opacity: 1; }
  100% { transform: scaleX(0); opacity: 0.6; }
}
@keyframes map-glow-pulse {
  0%, 100% { opacity: 0; }
  50%      { opacity: 0.12; }
}
  `;
  document.head.appendChild(style);
}

export function PageTransitionLoader({
  className,
  mode = 'fullscreen',
}: {
  className?: string;
  mode?: 'fullscreen' | 'inline';
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    injectKeyframes();
    const timer = setTimeout(() => setVisible(true), 80);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  const letters = [
    { char: 'M', delay: '0ms',   color: '#e8e8ec' },
    { char: 'A', delay: '120ms', color: '#a0a0b0' },
    { char: 'P', delay: '240ms', color: '#78788a' },
  ];

  const isFullscreen = mode === 'fullscreen';

  return (
    <div
      className={className}
      style={{
        position: isFullscreen ? 'fixed' : 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#141418',
        zIndex: isFullscreen ? 9999 : 10,
        userSelect: 'none',
        borderRadius: isFullscreen ? 0 : 'inherit',
      }}
    >
      {/* 背景光晕 */}
      <div
        style={{
          position: 'absolute',
          width: 320,
          height: 320,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,255,255,0.03) 0%, transparent 70%)',
          animation: 'map-glow-pulse 3s ease-in-out infinite',
        }}
      />

      {/* MAP 字母 */}
      <div style={{ display: 'flex', gap: 6, position: 'relative' }}>
        {letters.map(({ char, delay, color }) => (
          <span
            key={char}
            style={{
              fontSize: 52,
              fontWeight: 700,
              fontFamily: "'Inter', 'SF Pro Display', -apple-system, system-ui, sans-serif",
              letterSpacing: '0.08em',
              color,
              opacity: 0,
              background: `linear-gradient(90deg, ${color} 40%, rgba(255,255,255,0.6) 50%, ${color} 60%)`,
              backgroundSize: '200% 100%',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              animationName: 'map-letter-in, map-shimmer',
              animationDuration: '600ms, 2.4s',
              animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1), linear',
              animationDelay: `${delay}, 800ms`,
              animationIterationCount: '1, infinite',
              animationFillMode: 'forwards, none',
            }}
          >
            {char}
          </span>
        ))}
      </div>

      {/* 底部扫光条 */}
      <div
        style={{
          marginTop: 24,
          width: 120,
          height: 2,
          borderRadius: 1,
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent)',
          transformOrigin: 'center',
          animation: 'map-bar-scan 2s ease-in-out 400ms infinite',
        }}
      />
    </div>
  );
}

/**
 * Suspense fallback — 全屏 MAP 品牌过渡（首次加载/登录前/全屏路由）。
 */
export function SuspenseVideoLoader() {
  return <PageTransitionLoader mode="fullscreen" />;
}

/**
 * Suspense fallback — 内联 MAP 过渡（AppShell 内容区，不遮挡侧边栏）。
 */
export function InlinePageLoader() {
  return <PageTransitionLoader mode="inline" />;
}
