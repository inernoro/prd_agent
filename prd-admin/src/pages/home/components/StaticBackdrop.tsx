/**
 * StaticBackdrop — 零动画的静态背景层
 *
 * 参照 Linear.app + Vercel.com 的做法：
 *   1. 纯深色底                — 比纯黑温暖 4%（#050508）
 *   2. 点阵网格                — 1px 点，32px 间距，mask 让它在顶部浓、底部淡
 *   3. 顶部单一紫色光晕        — radial-gradient，静态不动
 *   4. 底部微弱玫瑰光晕        — 给最终 CTA 暖尾音
 *   5. 细噪点                  — mix-blend-overlay，消塑料感
 *
 * 所有层都是纯 CSS，zero animation，zero canvas，zero JS。
 * 整个页面滚动时，这个 div 是 fixed 的，始终贴在视口后面。
 */
export function StaticBackdrop() {
  return (
    <div
      className="fixed inset-0 z-0 pointer-events-none"
      aria-hidden
      style={{ background: '#050508' }}
    >
      {/* Layer 1 · 点阵网格（顶部浓，底部淡） */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255, 255, 255, 0.065) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
          backgroundPosition: '0 0',
          maskImage:
            'radial-gradient(ellipse 80% 70% at 50% 12%, black 0%, black 40%, transparent 85%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 70% at 50% 12%, black 0%, black 40%, transparent 85%)',
        }}
      />

      {/* Layer 2 · 顶部紫色径向光晕（静态） */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 95% 70% at 50% -8%, rgba(124, 58, 237, 0.40) 0%, rgba(124, 58, 237, 0.12) 22%, rgba(59, 130, 246, 0.05) 45%, transparent 70%)
          `,
        }}
      />

      {/* Layer 3 · 底部玫瑰微光（给 FinalCta 区域一点暖意） */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 70% 35% at 50% 100%, rgba(244, 63, 94, 0.18) 0%, rgba(244, 63, 94, 0.05) 30%, transparent 55%)
          `,
        }}
      />

      {/* Layer 4 · 细噪点（消塑料感） */}
      <div
        className="absolute inset-0 opacity-[0.035] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* Layer 5 · 顶部暗渐变（保证顶栏下文字可读） */}
      <div
        className="absolute inset-x-0 top-0 h-40"
        style={{
          background:
            'linear-gradient(180deg, rgba(5, 5, 8, 0.85) 0%, rgba(5, 5, 8, 0) 100%)',
        }}
      />
    </div>
  );
}
