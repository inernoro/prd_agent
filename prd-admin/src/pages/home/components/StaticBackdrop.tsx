/**
 * StaticBackdrop — 零动画静态背景（retro-futurism 融合版）
 *
 * 融合来源：
 *   · Linear.app  —— 纯深色底 + 顶部单一光晕 + 点阵网格
 *   · Vercel.com  —— 点阵 mask fade 做法
 *   · Synthwave   —— 底部 Tron 透视地平线网格（CSS 3D perspective）
 *   · Cyberpunk   —— CRT 横向扫描线 overlay（极细 opacity）
 *   · Raycast     —— 细噪点消塑料感
 *
 * 所有层都是纯 CSS，zero animation，zero canvas，zero JS。
 */
export function StaticBackdrop() {
  return (
    <div
      className="fixed inset-0 z-0 pointer-events-none overflow-hidden"
      aria-hidden
      style={{ background: '#050510' }}
    >
      {/* Layer 1 · 顶部点阵网格（Vercel 风，mask 让顶部浓底部淡） */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255, 255, 255, 0.075) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
          maskImage:
            'radial-gradient(ellipse 80% 55% at 50% 10%, black 0%, black 40%, transparent 85%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 55% at 50% 10%, black 0%, black 40%, transparent 85%)',
        }}
      />

      {/* Layer 2 · 顶部紫色径向光晕（Linear 签名） */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 95% 65% at 50% -5%, rgba(124, 58, 237, 0.42) 0%, rgba(124, 58, 237, 0.14) 22%, rgba(59, 130, 246, 0.06) 45%, transparent 70%)
          `,
        }}
      />

      {/* Layer 3 · Synthwave 地平线光带（日落渐变条） */}
      <div
        className="absolute inset-x-0 bottom-[42%] h-[2px] pointer-events-none"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, rgba(244, 63, 94, 0) 15%, rgba(244, 63, 94, 0.55) 35%, rgba(168, 85, 247, 0.8) 50%, rgba(0, 240, 255, 0.55) 65%, rgba(0, 240, 255, 0) 85%, transparent 100%)',
          boxShadow:
            '0 0 24px rgba(168, 85, 247, 0.6), 0 -1px 40px rgba(244, 63, 94, 0.4)',
        }}
      />

      {/* Layer 4 · Synthwave 太阳（半圆渐隐光斑） */}
      <div
        className="absolute pointer-events-none"
        style={{
          bottom: '42%',
          left: '50%',
          transform: 'translate(-50%, 50%)',
          width: 'clamp(320px, 32vw, 520px)',
          height: 'clamp(320px, 32vw, 520px)',
          background:
            'radial-gradient(circle at center, rgba(244, 63, 94, 0.35) 0%, rgba(168, 85, 247, 0.18) 35%, rgba(0, 240, 255, 0.04) 60%, transparent 75%)',
          filter: 'blur(8px)',
        }}
      />

      {/* Layer 5 · Tron 透视地板（核心 retro 元素） */}
      <div
        className="absolute inset-x-0 bottom-0 h-[42%] pointer-events-none"
        style={{ perspective: '360px', perspectiveOrigin: '50% 0%' }}
      >
        <div
          className="absolute inset-x-[-30%] top-0 bottom-0"
          style={{
            background: `
              repeating-linear-gradient(
                180deg,
                transparent 0,
                transparent 39px,
                rgba(168, 85, 247, 0.45) 39px,
                rgba(168, 85, 247, 0.45) 40px
              ),
              repeating-linear-gradient(
                90deg,
                transparent 0,
                transparent 39px,
                rgba(0, 240, 255, 0.45) 39px,
                rgba(0, 240, 255, 0.45) 40px
              )
            `,
            transform: 'rotateX(62deg)',
            transformOrigin: '50% 0%',
            maskImage:
              'linear-gradient(180deg, transparent 0%, black 35%, black 100%)',
            WebkitMaskImage:
              'linear-gradient(180deg, transparent 0%, black 35%, black 100%)',
          }}
        />
        {/* 地板与背景的过渡暗色 */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(5, 5, 16, 0.35) 0%, rgba(5, 5, 16, 0.85) 100%)',
          }}
        />
      </div>

      {/* Layer 6 · CRT 扫描线 overlay（极细，0.025 透明度） */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.025) 0px, rgba(255, 255, 255, 0.025) 1px, transparent 1px, transparent 3px)',
          mixBlendMode: 'overlay',
        }}
      />

      {/* Layer 7 · 细噪点（消塑料感） */}
      <div
        className="absolute inset-0 opacity-[0.04] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* Layer 8 · 顶部暗渐变（保顶栏下文字可读） */}
      <div
        className="absolute inset-x-0 top-0 h-40"
        style={{
          background:
            'linear-gradient(180deg, rgba(5, 5, 16, 0.85) 0%, rgba(5, 5, 16, 0) 100%)',
        }}
      />
    </div>
  );
}
