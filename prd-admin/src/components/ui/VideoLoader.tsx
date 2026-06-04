import { useEffect, useState, type ReactNode } from 'react';

/**
 * MAP 统一加载组件体系（随机抽取版）
 *
 * 每次加载从「9 款字标设计 / 3 款紧凑 spinner」里随机抽一个，挂载期间保持不变。
 * 连续两次不重复（模块级 lastPick 守卫）。
 *
 * | 组件                    | 场景                        | 抽取池          |
 * |-------------------------|-----------------------------|-----------------|
 * | `PageTransitionLoader`  | Suspense / 页面级过渡        | 9 款字标         |
 * | `MapSectionLoader`      | 区块居中加载                 | 9 款字标（小号） |
 * | `MapSpinner`            | 行内 / 按钮 loading 态       | 3 款紧凑 spinner |
 */

const FONT = "'Inter', 'SF Pro Display', -apple-system, system-ui, sans-serif";
const ANIM_ID = 'map-loader-keyframes';

function injectKeyframes() {
  if (typeof document === 'undefined' || document.getElementById(ANIM_ID)) return;
  const style = document.createElement('style');
  style.id = ANIM_ID;
  style.textContent = `
@keyframes map-spin { to { transform: rotate(360deg); } }
@keyframes map-glow-pulse { 0%,100% { opacity: 0; } 50% { opacity: 0.12; } }
@keyframes map-l1-flow { to { background-position: 300% 0; } }
@keyframes map-l3-shine { 0% { left: -60%; } 60%,100% { left: 130%; } }
@keyframes map-l4-pulse { 0%,100% { opacity: 0.22; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.1); } }
@keyframes map-l5-draw {
  0% { stroke-dashoffset: 240; }
  45% { stroke-dashoffset: 0; }
  75% { stroke-dashoffset: 0; opacity: 1; }
  100% { stroke-dashoffset: -240; opacity: 0; }
}
@keyframes map-l6-drift { 0% { transform: translate(-8px,-4px) scale(1); } 100% { transform: translate(8px,4px) scale(1.1); } }
@keyframes map-l7-shift { 0% { transform: translate(3px,3px); opacity: 0.7; } 100% { transform: translate(7px,7px); opacity: 0.35; } }
@keyframes map-l9-sweep {
  0% { -webkit-mask-position: 120% 0; mask-position: 120% 0; }
  100% { -webkit-mask-position: -120% 0; mask-position: -120% 0; }
}
@keyframes map-l9-bar { 0% { transform: translateX(-120%); } 100% { transform: translateX(320%); } }
  `;
  document.head.appendChild(style);
}

// ─── 随机抽取（整页锁定，避免同一页面出现两种样式） ─────────
//
// 只在「整页加载」时掷一次，锁进模块级变量；之后整个会话内所有 loader
// 都复用同一款，绝不会一个页面里冒出不同样式。刷新页面才会换下一款。
// 笔触描边（设计 05，wordmark 索引 4）权重 ×2，作为最钟意的默认款。

const WORDMARK_WEIGHTS = [1, 1, 1, 1, 2, 1, 1, 1, 1]; // 索引 4 = 笔触描边，加权
const WORDMARK_POOL: number[] = [];
WORDMARK_WEIGHTS.forEach((w, i) => { for (let k = 0; k < w; k++) WORDMARK_POOL.push(i); });

let sessionWordmarkPick: number | null = null;
function getWordmarkPick(): number {
  if (sessionWordmarkPick === null) {
    sessionWordmarkPick = WORDMARK_POOL[Math.floor(Math.random() * WORDMARK_POOL.length)];
  }
  return sessionWordmarkPick;
}

let sessionSpinnerPick: number | null = null;
function getSpinnerPick(spinnerCount: number): number {
  if (sessionSpinnerPick === null) {
    sessionSpinnerPick = Math.floor(Math.random() * spinnerCount);
  }
  return sessionSpinnerPick;
}

// ─── 9 款字标设计 ───────────────────────────────────────────
// 每款是一个渲染函数，接收主字号 size，自行派生其余尺寸。

const WORDMARK_DESIGNS: Array<(size: number) => ReactNode> = [
  // 01 流体渐变（Stripe 风）
  (size) => (
    <div
      style={{
        fontSize: size,
        fontWeight: 800,
        letterSpacing: '0.06em',
        fontFamily: FONT,
        backgroundImage: 'linear-gradient(110deg,#7c5cff,#22d3ee,#ec4899,#7c5cff)',
        backgroundSize: '300% 100%',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        WebkitTextFillColor: 'transparent',
        animation: 'map-l1-flow 4s linear infinite',
        filter: 'drop-shadow(0 0 18px rgba(124,92,255,0.35))',
      }}
    >
      MAP
    </div>
  ),

  // 02 极简锥形环 + 单字（Linear / Vercel 风）
  (size) => {
    const ring = Math.round(size * 1.55);
    const t = Math.max(2, Math.round(size / 18));
    return (
      <div style={{ position: 'relative', width: ring, height: ring, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            background: 'conic-gradient(from 0deg, transparent 0%, #e8e8ec 90%, transparent 100%)',
            WebkitMaskImage: `radial-gradient(farthest-side, transparent calc(100% - ${t}px), #000 calc(100% - ${t}px))`,
            maskImage: `radial-gradient(farthest-side, transparent calc(100% - ${t}px), #000 calc(100% - ${t}px))`,
            animation: 'map-spin 0.9s linear infinite',
          }}
        />
        <span style={{ fontSize: size * 0.5, fontWeight: 800, color: '#e8e8ec', fontFamily: FONT }}>M</span>
      </div>
    );
  },

  // 03 玻璃拟态 + 扫光
  (size) => (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        padding: `${size * 0.42}px ${size * 0.72}px`,
        borderRadius: size * 0.42,
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.10)',
        WebkitBackdropFilter: 'blur(12px)',
        backdropFilter: 'blur(12px)',
        boxShadow: '0 8px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12)',
      }}
    >
      <span style={{ fontSize: size * 0.84, fontWeight: 800, letterSpacing: '0.1em', color: '#f4f4f8', fontFamily: FONT }}>MAP</span>
      <div
        style={{
          content: '',
          position: 'absolute',
          top: 0,
          left: '-60%',
          width: '50%',
          height: '100%',
          background: 'linear-gradient(100deg, transparent, rgba(255,255,255,0.35), transparent)',
          transform: 'skewX(-18deg)',
          animation: 'map-l3-shine 2.4s ease-in-out infinite',
        }}
      />
    </div>
  ),

  // 04 点阵脉冲
  (size) => <DotMatrix size={size} />,

  // 05 笔触描边（SVG 逐笔绘制）
  (size) => {
    const w = size * 2.7;
    const h = size * 1.25;
    const sw = Math.max(4, size / 9);
    const common = {
      fill: 'none' as const,
      stroke: '#e8e8ec',
      strokeWidth: sw,
      strokeLinecap: 'round' as const,
      strokeLinejoin: 'round' as const,
      strokeDasharray: 240,
      strokeDashoffset: 240,
      animation: 'map-l5-draw 2.4s ease-in-out infinite',
    };
    return (
      <svg width={w} height={h} viewBox="0 0 200 90">
        <path d="M15 70 L15 25 L40 60 L65 25 L65 70" style={common} />
        <path d="M90 70 L107 25 L124 70 M97 55 L117 55" style={{ ...common, animationDelay: '0.15s' }} />
        <path d="M150 70 L150 25 L175 25 Q188 25 188 42 Q188 50 175 50 L150 50" style={{ ...common, animationDelay: '0.3s' }} />
      </svg>
    );
  },

  // 06 极光辉光
  (size) => (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          position: 'absolute',
          inset: -size * 0.7,
          borderRadius: '50%',
          background:
            'radial-gradient(circle at 30% 40%, rgba(99,179,237,0.5), transparent 60%), radial-gradient(circle at 70% 60%, rgba(192,132,252,0.5), transparent 60%)',
          filter: 'blur(28px)',
          animation: 'map-l6-drift 5s ease-in-out infinite alternate',
        }}
      />
      <span style={{ position: 'relative', fontSize: size, fontWeight: 800, letterSpacing: '0.08em', color: '#f4f4f8', fontFamily: FONT }}>MAP</span>
    </div>
  ),

  // 07 层叠立体
  (size) => (
    <div style={{ position: 'relative' }}>
      <span
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          fontSize: size,
          fontWeight: 900,
          letterSpacing: '0.06em',
          color: '#6d5cff',
          fontFamily: FONT,
          animation: 'map-l7-shift 2s ease-in-out infinite alternate',
        }}
      >
        MAP
      </span>
      <span style={{ position: 'relative', fontSize: size, fontWeight: 900, letterSpacing: '0.06em', color: '#f4f4f8', fontFamily: FONT }}>MAP</span>
    </div>
  ),

  // 08 轨道环绕
  (size) => {
    const box = Math.round(size * 1.9);
    const dot = Math.max(6, Math.round(size / 6));
    return (
      <div style={{ position: 'relative', width: box, height: box, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ position: 'absolute', inset: 0, animation: 'map-spin 2.4s linear infinite' }}>
          <span style={{ position: 'absolute', top: -dot / 2, left: '50%', transform: 'translateX(-50%)', width: dot, height: dot, borderRadius: '50%', background: '#22d3ee', boxShadow: '0 0 12px #22d3ee' }} />
        </div>
        <div style={{ position: 'absolute', inset: 0, animation: 'map-spin 1.6s linear infinite reverse' }}>
          <span style={{ position: 'absolute', top: -dot / 2, left: '50%', transform: 'translateX(-50%)', width: dot, height: dot, borderRadius: '50%', background: '#ec4899', boxShadow: '0 0 12px #ec4899' }} />
        </div>
        <span style={{ fontSize: size * 0.55, fontWeight: 800, color: '#e8e8ec', fontFamily: FONT }}>M</span>
      </div>
    );
  },

  // 09 骨架扫光 + 进度条
  (size) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: size * 0.32 }}>
      <div style={{ position: 'relative', fontSize: size, fontWeight: 800, letterSpacing: '0.12em', color: '#2c2c36', fontFamily: FONT }}>
        MAP
        <span
          style={{
            position: 'absolute',
            inset: 0,
            color: '#f4f4f8',
            WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 50%, transparent)',
            maskImage: 'linear-gradient(90deg, transparent, #000 50%, transparent)',
            WebkitMaskSize: '220% 100%',
            maskSize: '220% 100%',
            animation: 'map-l9-sweep 1.8s linear infinite',
          }}
        >
          MAP
        </span>
      </div>
      <div style={{ width: size * 2.4, height: 3, borderRadius: 3, background: '#26262e', overflow: 'hidden' }}>
        <div style={{ width: '40%', height: '100%', borderRadius: 3, background: 'linear-gradient(90deg,#7c5cff,#22d3ee)', animation: 'map-l9-bar 1.4s ease-in-out infinite' }} />
      </div>
    </div>
  ),
];

// 点阵字母（04 专用）
const GLYPHS: Record<string, string[]> = {
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
};

function DotMatrix({ size }: { size: number }) {
  const cell = Math.max(4, Math.round(size / 7));
  const gap = Math.max(2, Math.round(cell * 0.35));
  return (
    <div style={{ display: 'flex', gap: cell * 1.4 }}>
      {(['M', 'A', 'P'] as const).map((ch, gi) => (
        <div key={ch} style={{ display: 'flex', gap }}>
          {Array.from({ length: 5 }).map((_, c) => (
            <div key={c} style={{ display: 'flex', flexDirection: 'column', gap }}>
              {GLYPHS[ch].map((row, r) => {
                const on = row[c] === '1';
                return (
                  <div
                    key={r}
                    style={{
                      width: cell,
                      height: cell,
                      borderRadius: '50%',
                      background: on ? '#e8e8ec' : '#33333d',
                      animation: on ? 'map-l4-pulse 1.4s ease-in-out infinite' : undefined,
                      animationDelay: on ? `${(gi * 5 + c) * 0.05 + r * 0.03}s` : undefined,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      ))}
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
  const [pick] = useState(getWordmarkPick);

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
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#141418',
        zIndex: isFullscreen ? 9999 : 10,
        userSelect: 'none',
        borderRadius: isFullscreen ? 0 : 'inherit',
      }}
    >
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
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {WORDMARK_DESIGNS[pick](56)}
      </div>
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
  const [pick] = useState(getWordmarkPick);
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
        gap: 16,
        padding: '48px 0',
        userSelect: 'none',
        ...style,
      }}
    >
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {WORDMARK_DESIGNS[pick](30)}
      </div>
      {text && (
        <span style={{ fontSize: 13, color: 'var(--text-muted, #666)', marginTop: 4 }}>
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
