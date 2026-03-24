import { useEffect, useState } from 'react';

/**
 * MAP 统一加载组件体系
 *
 * 三个层级，视觉语言统一（扫光条 + 品牌色）：
 *
 * | 组件                    | 场景                        | 尺寸        |
 * |-------------------------|-----------------------------|-------------|
 * | `PageTransitionLoader`  | Suspense / 页面级过渡        | 全屏 / 内联 |
 * | `MapSectionLoader`      | 区块居中加载（替代居中 Loader2）| 自适应父容器 |
 * | `MapSpinner`            | 行内 / 按钮 loading 态       | 14-32px     |
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
@keyframes map-spin-scan {
  0%   { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}
  `;
  document.head.appendChild(style);
}

// ─── 页面级：Suspense / 路由过渡 ───────────────────────────

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
      role="status"
      aria-label="加载中"
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

// ─── 区块级：内容区域居中加载 ──────────────────────────────

/**
 * 区块级加载指示器 — 居中 MAP 字母（小号）+ 扫光条 + 可选提示文字。
 * 替代各处手写的 `<div className="flex items-center justify-center"><Loader2 className="animate-spin" /></div>`
 *
 * @example
 * ```tsx
 * {loading ? <MapSectionLoader text="正在加载数据…" /> : <Content />}
 * ```
 */
export function MapSectionLoader({
  text,
  className,
  style,
}: {
  text?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  useEffect(() => { injectKeyframes(); }, []);

  const letters = [
    { char: 'M', delay: '0ms',   color: '#c0c0cc' },
    { char: 'A', delay: '80ms',  color: '#8e8e9e' },
    { char: 'P', delay: '160ms', color: '#6a6a7a' },
  ];

  return (
    <div
      className={className}
      role="status"
      aria-label={text || '加载中'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: '48px 0',
        userSelect: 'none',
        ...style,
      }}
    >
      <div style={{ display: 'flex', gap: 4, position: 'relative' }}>
        {letters.map(({ char, delay, color }) => (
          <span
            key={char}
            style={{
              fontSize: 28,
              fontWeight: 700,
              fontFamily: "'Inter', 'SF Pro Display', -apple-system, system-ui, sans-serif",
              letterSpacing: '0.08em',
              color,
              opacity: 0,
              background: `linear-gradient(90deg, ${color} 40%, rgba(255,255,255,0.5) 50%, ${color} 60%)`,
              backgroundSize: '200% 100%',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              animationName: 'map-letter-in, map-shimmer',
              animationDuration: '500ms, 2.4s',
              animationTimingFunction: 'cubic-bezier(0.16, 1, 0.3, 1), linear',
              animationDelay: `${delay}, 600ms`,
              animationIterationCount: '1, infinite',
              animationFillMode: 'forwards, none',
            }}
          >
            {char}
          </span>
        ))}
      </div>

      <div
        style={{
          width: 64,
          height: 1.5,
          borderRadius: 1,
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',
          transformOrigin: 'center',
          animation: 'map-bar-scan 2s ease-in-out 300ms infinite',
        }}
      />

      {text && (
        <span style={{ fontSize: 13, color: 'var(--text-muted, #666)', marginTop: 4 }}>
          {text}
        </span>
      )}
    </div>
  );
}

// ─── 行内级：按钮 / 小区域 spinner ─────────────────────────

/**
 * 行内加载指示器 — 品牌风格的小型 spinner，替代 `<Loader2 className="animate-spin" />`。
 * 一条弧形扫光线旋转，视觉与扫光条统一。
 *
 * @example
 * ```tsx
 * <button disabled={saving}>
 *   {saving ? <MapSpinner size={16} /> : <Save size={16} />}
 *   保存
 * </button>
 * ```
 */
export function MapSpinner({
  size = 18,
  color,
  className,
  style,
}: {
  size?: number;
  color?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  useEffect(() => { injectKeyframes(); }, []);

  const stroke = color || 'var(--text-muted, rgba(255,255,255,0.45))';
  const thickness = size <= 16 ? 1.5 : 2;
  const r = (size - thickness * 2) / 2;

  return (
    <svg
      className={className}
      role="status"
      aria-label="加载中"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      fill="none"
      style={{
        animation: 'map-spin-scan 1s linear infinite',
        flexShrink: 0,
        ...style,
      }}
    >
      {/* 底圈（极淡） */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={stroke}
        strokeWidth={thickness}
        opacity={0.15}
      />
      {/* 扫光弧 */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={stroke}
        strokeWidth={thickness}
        strokeLinecap="round"
        strokeDasharray={`${r * 1.8} ${r * 4.5}`}
        opacity={0.9}
      />
    </svg>
  );
}

// ─── 便捷导出 ──────────────────────────────────────────────

/** Suspense fallback — 全屏 MAP 品牌过渡（首次加载 / 登录前 / 全屏路由） */
export function SuspenseVideoLoader() {
  return <PageTransitionLoader mode="fullscreen" />;
}

/** Suspense fallback — 内联 MAP 过渡（AppShell 内容区，不遮挡侧边栏） */
export function InlinePageLoader() {
  return <PageTransitionLoader mode="inline" />;
}
