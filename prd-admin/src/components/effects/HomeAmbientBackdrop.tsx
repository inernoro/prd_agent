/**
 * HomeAmbientBackdrop — 首页环境光背景层
 *
 * 解决"首页死板阴沉"的问题：纯 #0b0c10 单一色深 + 局部光源 hero → 整页像一块黑板。
 *
 * 分层（全部纯 CSS，0 JS，0 动画）：
 *   1. 全局 ambient blobs：3 个巨大 radial-gradient 色块（紫/青/玫红），8% 透明度 + blur 60px
 *      - 给整页营造 ambient 光场，让背景不再是单一色深
 *   2. Film grain：SVG feTurbulence 噪点层，3% 透明度 + mix-blend overlay
 *      - 消除数字化"死黑"，赋予背景微弱纹理温度（Linear/Vercel/Arc 同款技巧）
 *   3. Top spotlight：顶部 50vh 大椭圆白色径向渐变 2.5%
 *      - 把注意力拉向 hero，模拟"舞台聚光"
 *
 * 使用：mount 在 AgentLauncherPage 根容器里（或任何想要这套 ambient 的页面）。
 * 定位 fixed + pointer-events-none + z-index 0（配合内容 z-index 1）不影响交互。
 *
 * 性能：纯静态，无动画，无 JS。blob 用 `will-change: auto`，GPU 不会额外 composite。
 */
export function HomeAmbientBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0"
      style={{ zIndex: 0 }}
    >
      {/* ── Layer 1: 全局 ambient blobs ───────────────────────── */}

      {/* 紫色 blob · 左上（呼应 Hero 紫色光晕） */}
      <div
        className="absolute"
        style={{
          top: '-12%',
          left: '-8%',
          width: 820,
          height: 820,
          maxWidth: '95vw',
          maxHeight: '95vh',
          background:
            'radial-gradient(circle at center, rgba(124, 58, 237, 0.08) 0%, rgba(124, 58, 237, 0.04) 30%, transparent 65%)',
          filter: 'blur(60px)',
        }}
      />

      {/* 青色 blob · 中右（呼应 /home Hero 青色） */}
      <div
        className="absolute"
        style={{
          top: '25%',
          right: '-12%',
          width: 900,
          height: 900,
          maxWidth: '95vw',
          maxHeight: '95vh',
          background:
            'radial-gradient(circle at center, rgba(0, 240, 255, 0.06) 0%, rgba(0, 240, 255, 0.025) 35%, transparent 68%)',
          filter: 'blur(60px)',
        }}
      />

      {/* 玫红 blob · 底部中偏左（/home Hero 第三色） */}
      <div
        className="absolute"
        style={{
          bottom: '-15%',
          left: '25%',
          width: 780,
          height: 780,
          maxWidth: '95vw',
          maxHeight: '95vh',
          background:
            'radial-gradient(circle at center, rgba(244, 63, 94, 0.05) 0%, rgba(244, 63, 94, 0.02) 35%, transparent 65%)',
          filter: 'blur(70px)',
        }}
      />

      {/* ── Layer 2: Top spotlight ───────────────────────────── */}
      <div
        className="absolute inset-x-0 top-0"
        style={{
          height: '50vh',
          background:
            'radial-gradient(ellipse 75% 55% at 50% 0%, rgba(255, 255, 255, 0.028) 0%, rgba(255, 255, 255, 0.012) 35%, transparent 70%)',
        }}
      />

      {/* ── Layer 3: Film grain（胶片颗粒） ───────────────────── */}
      {/*
        SVG feTurbulence 生成 fractal noise，data URI 一次性嵌入。
        mix-blend-mode: overlay 让噪点只在亮处叠加，暗处几乎不可见。
        opacity 0.03 = 隐约的"温度"，放大能看到颗粒，正常距离只是感觉不再"死黑"。
      */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)' opacity='0.55'/></svg>")`,
          backgroundRepeat: 'repeat',
          opacity: 0.03,
          mixBlendMode: 'overlay',
        }}
      />
    </div>
  );
}
