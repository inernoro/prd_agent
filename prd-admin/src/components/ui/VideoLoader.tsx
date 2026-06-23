import { useEffect, useState } from 'react';

/**
 * MAP 统一加载组件体系（极简白光版）
 *
 * 历史上这里有 9 款随机字标 + 320px 辉光 + 硬编码 #141418 底色，导致：
 *   - 加载页看起来像「一块巨大黑板上摆个发光 logo」
 *   - 随机抽到的设计带紫色/彩色渐变（用户明确不喜欢）
 *   - 底色写死 #141418，浅色主题下变成纯黑板（主题 bug）
 * 现在统一为：单款干净的白光 MAP 字标（跟随主题）+ 跟随主题的底色 + 去掉聚光辉光。
 *
 * | 组件                    | 场景                        |
 * |-------------------------|-----------------------------|
 * | `PageTransitionLoader`  | Suspense / 页面级过渡        |
 * | `MapSectionLoader`      | 区块居中加载                 |
 * | `MapSpinner`            | 行内 / 按钮 loading 态       |
 */

const FONT = "'Inter', 'SF Pro Display', -apple-system, system-ui, sans-serif";
const ANIM_ID = 'map-loader-keyframes';

function injectKeyframes() {
  if (typeof document === 'undefined' || document.getElementById(ANIM_ID)) return;
  const style = document.createElement('style');
  style.id = ANIM_ID;
  style.textContent = `
@keyframes map-spin { to { transform: rotate(360deg); } }
@keyframes map-sweep {
  0% { -webkit-mask-position: 120% 0; mask-position: 120% 0; }
  100% { -webkit-mask-position: -120% 0; mask-position: -120% 0; }
}
@keyframes map-glow { 0%,100% { opacity: 0.3; transform: scale(0.92); } 50% { opacity: 0.6; transform: scale(1.04); } }
  `;
  document.head.appendChild(style);
}

// ─── 干净的白光字标（跟随主题，无紫色/彩色） ────────────────
// 底字走 --text-muted（低存在感），白光扫过的高亮字走 --text-primary。
// 暗色主题下扫光是亮白；浅色主题下是深字扫光（白光的同构表达），均跟随主题。

function CleanWordmark({ size }: { size: number }) {
  return (
    <div
      aria-hidden
      style={{
        position: 'relative',
        fontSize: size,
        fontWeight: 800,
        letterSpacing: '0.14em',
        fontFamily: FONT,
        color: 'var(--text-muted, rgba(247,247,251,0.35))',
        userSelect: 'none',
        lineHeight: 1,
      }}
    >
      MAP
      <span
        style={{
          position: 'absolute',
          inset: 0,
          color: 'var(--text-primary, #f7f7fb)',
          WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 50%, transparent)',
          maskImage: 'linear-gradient(90deg, transparent, #000 50%, transparent)',
          WebkitMaskSize: '220% 100%',
          maskSize: '220% 100%',
          animation: 'map-sweep 1.8s linear infinite',
        }}
      >
        MAP
      </span>
    </div>
  );
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
        alignItems: 'center',
        justifyContent: 'center',
        // 透明:不再用不透明深色铺满内容区(那会盖掉 App 的 aurora 背景,
        // 看起来就像「一块巨大黑板」)。让真实背景透出,加载只是个过渡指示。
        background: 'transparent',
        zIndex: isFullscreen ? 9999 : 10,
        userSelect: 'none',
        pointerEvents: 'none',
      }}
    >
      {/* 柔光:让 MAP 过渡在任意背景上都清晰可见,但不形成黑板 */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          width: 280,
          height: 160,
          borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(255,255,255,0.10), transparent 70%)',
          animation: 'map-glow 1.8s ease-in-out infinite',
        }}
      />
      <CleanWordmark size={48} />
    </div>
  );
}

// ─── 区块级：内容区域居中加载 ──────────────────────────────

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
        gap: 14,
        padding: '48px 0',
        userSelect: 'none',
        ...style,
      }}
    >
      <CleanWordmark size={26} />
      {text && (
        <span style={{ fontSize: 13, color: 'var(--text-muted, #666)', marginTop: 2 }}>
          {text}
        </span>
      )}
    </div>
  );
}

// ─── 行内级：按钮 / 小区域 spinner ─────────────────────────
// 3 款紧凑 spinner：弧线 / 锥形环 / 双环。

function SpinnerArc({ size, stroke, thickness }: { size: number; stroke: string; thickness: number }) {
  const r = (size - thickness * 2) / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" style={{ animation: 'map-spin 1s linear infinite', flexShrink: 0 }}>
      <circle cx={size / 2} cy={size / 2} r={r} stroke={stroke} strokeWidth={thickness} opacity={0.15} />
      <circle cx={size / 2} cy={size / 2} r={r} stroke={stroke} strokeWidth={thickness} strokeLinecap="round" strokeDasharray={`${r * 1.8} ${r * 4.5}`} opacity={0.9} />
    </svg>
  );
}

function SpinnerConic({ size, stroke, thickness }: { size: number; stroke: string; thickness: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: '50%',
        background: `conic-gradient(from 0deg, transparent 0%, ${stroke} 90%, transparent 100%)`,
        WebkitMaskImage: `radial-gradient(farthest-side, transparent calc(100% - ${thickness}px), #000 calc(100% - ${thickness}px))`,
        maskImage: `radial-gradient(farthest-side, transparent calc(100% - ${thickness}px), #000 calc(100% - ${thickness}px))`,
        animation: 'map-spin 0.85s linear infinite',
      }}
    />
  );
}

function SpinnerDualRing({ size, stroke, thickness }: { size: number; stroke: string; thickness: number }) {
  const inner = size - thickness * 4;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `${thickness}px solid ${stroke}`, borderTopColor: 'transparent', borderRightColor: 'transparent', opacity: 0.85, animation: 'map-spin 0.8s linear infinite' }} />
      <div style={{ position: 'absolute', top: thickness * 2, left: thickness * 2, width: inner, height: inner, borderRadius: '50%', border: `${thickness}px solid ${stroke}`, borderBottomColor: 'transparent', borderLeftColor: 'transparent', opacity: 0.55, animation: 'map-spin 1.1s linear infinite reverse' }} />
    </div>
  );
}

const SPINNERS = [SpinnerArc, SpinnerConic, SpinnerDualRing];

let sessionSpinnerPick: number | null = null;
function getSpinnerPick(spinnerCount: number): number {
  if (sessionSpinnerPick === null) {
    sessionSpinnerPick = Math.floor(Math.random() * spinnerCount);
  }
  return sessionSpinnerPick;
}

/**
 * 行内加载指示器 — 从 3 款紧凑 spinner 随机抽取，替代 `<Loader2 className="animate-spin" />`。
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
  const [pick] = useState(() => getSpinnerPick(SPINNERS.length));
  useEffect(() => { injectKeyframes(); }, []);

  const stroke = color || 'var(--text-muted, rgba(255,255,255,0.45))';
  const thickness = size <= 16 ? 1.5 : 2;
  const Spinner = SPINNERS[pick];

  return (
    <span className={className} role="status" aria-label="加载中" style={{ display: 'inline-flex', flexShrink: 0, ...style }}>
      <Spinner size={size} stroke={stroke} thickness={thickness} />
    </span>
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
