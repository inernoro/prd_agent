/**
 * StaticBackdrop — 全站静态背景（精简版）
 *
 * 修正：之前的 synthwave 地平线/太阳/Tron 地板是 fixed 在视口 42% 位置，
 * 任何滚到该位置的 section 都会穿过亮带，产生诡异"银色光带"伪影。
 * 现在把这些 retro 装饰元素搬到 HeroSection 内部作为本地装饰，
 * StaticBackdrop 只保留"干净的全站底色 + 点阵 + 顶部紫光晕 + 扫描线 + 噪点"。
 *
 * 层级：
 *   1 · 纯深色底 #050510
 *   2 · 顶部点阵网格（Vercel 风，mask fade）
 *   3 · 顶部紫色径向光晕（Linear 签名）
 *   4 · CRT 横向扫描线（0.02 opacity, mix-blend-overlay）
 *   5 · 细噪点
 *   6 · 顶栏下暗渐变
 *
 * 零动画，零 canvas，零 JS。
 */
export function StaticBackdrop() {
  return (
    <div
      className="fixed inset-0 z-0 pointer-events-none overflow-hidden"
      aria-hidden
      style={{ background: '#050510' }}
    >
      {/* Layer 1 · 顶部点阵网格 */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(255, 255, 255, 0.07) 1px, transparent 1px)',
          backgroundSize: '36px 36px',
          maskImage:
            'radial-gradient(ellipse 85% 55% at 50% 10%, black 0%, black 40%, transparent 85%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 85% 55% at 50% 10%, black 0%, black 40%, transparent 85%)',
        }}
      />

      {/* Layer 2 · 顶部冷白径向光晕（Linear 签名 · 去紫版）
         slate-300 冷白 + 微弱 teal，完全不用紫色 —— 避免"AI 紫"的套路感 */}
      <div
        className="absolute inset-0"
        style={{
          background: `
            radial-gradient(ellipse 95% 65% at 50% -5%, rgba(203, 213, 225, 0.28) 0%, rgba(148, 163, 184, 0.10) 22%, rgba(14, 116, 144, 0.05) 45%, transparent 70%)
          `,
        }}
      />

      {/* Layer 3 · CRT 横向扫描线 overlay（极细） */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'repeating-linear-gradient(180deg, rgba(255, 255, 255, 0.022) 0px, rgba(255, 255, 255, 0.022) 1px, transparent 1px, transparent 3px)',
          mixBlendMode: 'overlay',
        }}
      />

      {/* Layer 4 · 细噪点 */}
      <div
        className="absolute inset-0 opacity-[0.04] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* Layer 5 · 顶栏下暗渐变（保 nav 下文字可读） */}
      <div
        className="absolute inset-x-0 top-0 h-40"
        style={{
          background:
            'linear-gradient(180deg, rgba(5, 5, 16, 0.9) 0%, rgba(5, 5, 16, 0) 100%)',
        }}
      />
    </div>
  );
}
