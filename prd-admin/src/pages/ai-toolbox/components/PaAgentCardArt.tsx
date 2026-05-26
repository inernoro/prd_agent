/**
 * 毒舌秘书 Agent 卡片内联插画 — 与视觉创作智能体同级的展示。
 *
 * 设计：
 *   - 主题：MBB 顾问 + MECE 拆解 + 四象限。零 emoji，零 CDN 依赖。
 *   - 配色：琥珀（#F59E0B / #FCD34D）+ 青色（#22D3EE / #67E8F9）+ 紫蓝深底（#0B1020 → #1A1530）。
 *   - 元素：
 *     1) 左上 MBB 金字塔三角（咨询行业标志性的「issue tree」）
 *     2) 右下 四象限 2×2 网格（Q1 高亮）
 *     3) 中段 MECE 三组散点 + 连线
 *     4) Scan line 缓慢扫动（5s 循环）
 *   - Hover 效果由父卡片（FeaturedCard / ToolCard）的 `group-hover` 提供：
 *     a) 整图 scale-105
 *     b) 光带从左到右扫过（CSS keyframe，本组件内置）
 *     c) 内发光（box-shadow）
 *
 * 不要在这里加 props —— 与 ReviewAgentCardArt 一致，保持「插画即配置」纯展示。
 */
export function PaAgentCardArt() {
  return (
    <div className="absolute inset-0 z-0 overflow-hidden">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 300 200"
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          {/* 底色：深紫蓝渐变 */}
          <linearGradient id="pac-bg" x1="0" y1="0" x2="300" y2="200" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#0B1020" />
            <stop offset="50%" stopColor="#0F1226" />
            <stop offset="100%" stopColor="#1A1530" />
          </linearGradient>

          {/* 琥珀光晕（左上） */}
          <radialGradient id="pac-amber" cx="70" cy="40" r="120" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#F59E0B" stopOpacity="0.45" />
            <stop offset="60%" stopColor="#F59E0B" stopOpacity="0.10" />
            <stop offset="100%" stopColor="#F59E0B" stopOpacity="0" />
          </radialGradient>

          {/* 青色光晕（右下） */}
          <radialGradient id="pac-cyan" cx="240" cy="170" r="140" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.40" />
            <stop offset="65%" stopColor="#22D3EE" stopOpacity="0.08" />
            <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
          </radialGradient>

          {/* MBB 金字塔三角描边渐变 */}
          <linearGradient id="pac-pyramid" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FDE68A" />
            <stop offset="100%" stopColor="#F59E0B" />
          </linearGradient>

          {/* 四象限填充 */}
          <linearGradient id="pac-q1" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#F59E0B" stopOpacity="0.40" />
            <stop offset="100%" stopColor="#EA580C" stopOpacity="0.20" />
          </linearGradient>
          <linearGradient id="pac-q2" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#0EA5E9" stopOpacity="0.10" />
          </linearGradient>

          {/* 点阵纹理 */}
          <pattern id="pac-dot" x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.7" fill="rgba(255,255,255,0.08)" />
          </pattern>

          {/* 柔光滤镜 */}
          <filter id="pac-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
          <filter id="pac-glow-soft" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.5" />
          </filter>
        </defs>

        {/* ── 底层 ── */}
        <rect width="300" height="200" fill="url(#pac-bg)" />
        <rect width="300" height="200" fill="url(#pac-dot)" />
        <rect width="300" height="200" fill="url(#pac-amber)" />
        <rect width="300" height="200" fill="url(#pac-cyan)" />

        {/* ── 左上 MBB 金字塔（issue tree） ── */}
        {/* 顶层 1 块 */}
        <rect x="58" y="36" width="36" height="14" rx="2"
          fill="rgba(245,158,11,0.18)"
          stroke="url(#pac-pyramid)" strokeWidth="1.2" />
        <text x="76" y="46" textAnchor="middle"
          fill="#FDE68A" fontSize="7" fontFamily="monospace" letterSpacing="0.5">
          P0
        </text>

        {/* 中层 2 块 */}
        <rect x="36" y="56" width="34" height="13" rx="2"
          fill="rgba(245,158,11,0.12)"
          stroke="rgba(252,211,77,0.7)" strokeWidth="1" />
        <rect x="82" y="56" width="34" height="13" rx="2"
          fill="rgba(245,158,11,0.12)"
          stroke="rgba(252,211,77,0.7)" strokeWidth="1" />

        {/* 底层 3 块 */}
        <rect x="20" y="75" width="28" height="11" rx="2"
          fill="rgba(245,158,11,0.08)"
          stroke="rgba(252,211,77,0.5)" strokeWidth="0.8" />
        <rect x="62" y="75" width="28" height="11" rx="2"
          fill="rgba(245,158,11,0.08)"
          stroke="rgba(252,211,77,0.5)" strokeWidth="0.8" />
        <rect x="104" y="75" width="28" height="11" rx="2"
          fill="rgba(245,158,11,0.08)"
          stroke="rgba(252,211,77,0.5)" strokeWidth="0.8" />

        {/* 金字塔层级连接线 */}
        <line x1="76" y1="50" x2="53" y2="56" stroke="rgba(252,211,77,0.4)" strokeWidth="0.8" />
        <line x1="76" y1="50" x2="99" y2="56" stroke="rgba(252,211,77,0.4)" strokeWidth="0.8" />
        <line x1="53" y1="69" x2="34" y2="75" stroke="rgba(252,211,77,0.3)" strokeWidth="0.7" />
        <line x1="53" y1="69" x2="76" y2="75" stroke="rgba(252,211,77,0.3)" strokeWidth="0.7" />
        <line x1="99" y1="69" x2="76" y2="75" stroke="rgba(252,211,77,0.3)" strokeWidth="0.7" />
        <line x1="99" y1="69" x2="118" y2="75" stroke="rgba(252,211,77,0.3)" strokeWidth="0.7" />

        {/* MBB 标签 */}
        <text x="76" y="106" textAnchor="middle"
          fill="rgba(252,211,77,0.85)" fontSize="6" fontFamily="monospace" letterSpacing="2">
          MECE · ISSUE TREE
        </text>

        {/* ── 中段 MECE 散点 + 连线 ── */}
        {[
          { cx: 145, cy: 80 }, { cx: 158, cy: 90 }, { cx: 152, cy: 100 },
          { cx: 168, cy: 75 }, { cx: 175, cy: 95 }, { cx: 162, cy: 110 },
        ].map((p, i) => (
          <g key={i}>
            <circle cx={p.cx} cy={p.cy} r="2.2"
              fill="rgba(255,255,255,0.55)" filter="url(#pac-glow-soft)" />
            <circle cx={p.cx} cy={p.cy} r="1.2"
              fill="rgba(252,211,77,0.95)" />
          </g>
        ))}

        {/* ── 右下 四象限 2×2 网格 ── */}
        {(() => {
          const ox = 192;
          const oy = 116;
          const cellW = 42;
          const cellH = 34;
          const gap = 3;
          return (
            <g>
              {/* Q1 高亮（左上，紧急且重要） */}
              <rect x={ox} y={oy} width={cellW} height={cellH} rx="4"
                fill="url(#pac-q1)" stroke="rgba(252,211,77,0.85)" strokeWidth="1.3" />
              <text x={ox + cellW / 2} y={oy + cellH / 2 + 2} textAnchor="middle"
                fill="#FDE68A" fontSize="13" fontWeight="bold" fontFamily="monospace">
                Q1
              </text>
              <text x={ox + cellW / 2} y={oy + cellH - 5} textAnchor="middle"
                fill="rgba(252,211,77,0.7)" fontSize="5.5" fontFamily="monospace">
                立刻干
              </text>

              {/* Q2（右上） */}
              <rect x={ox + cellW + gap} y={oy} width={cellW} height={cellH} rx="4"
                fill="url(#pac-q2)" stroke="rgba(34,211,238,0.5)" strokeWidth="0.9" />
              <text x={ox + cellW + gap + cellW / 2} y={oy + cellH / 2 + 2} textAnchor="middle"
                fill="#67E8F9" fontSize="11" fontFamily="monospace">
                Q2
              </text>
              <text x={ox + cellW + gap + cellW / 2} y={oy + cellH - 5} textAnchor="middle"
                fill="rgba(103,232,249,0.55)" fontSize="5.5" fontFamily="monospace">
                计划干
              </text>

              {/* Q3（左下） */}
              <rect x={ox} y={oy + cellH + gap} width={cellW} height={cellH} rx="4"
                fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.15)" strokeWidth="0.7" />
              <text x={ox + cellW / 2} y={oy + cellH + gap + cellH / 2 + 2} textAnchor="middle"
                fill="rgba(255,255,255,0.6)" fontSize="11" fontFamily="monospace">
                Q3
              </text>
              <text x={ox + cellW / 2} y={oy + cellH + gap + cellH - 5} textAnchor="middle"
                fill="rgba(255,255,255,0.35)" fontSize="5.5" fontFamily="monospace">
                快速干
              </text>

              {/* Q4（右下） */}
              <rect x={ox + cellW + gap} y={oy + cellH + gap} width={cellW} height={cellH} rx="4"
                fill="rgba(255,255,255,0.025)" stroke="rgba(255,255,255,0.1)" strokeWidth="0.6" />
              <text x={ox + cellW + gap + cellW / 2} y={oy + cellH + gap + cellH / 2 + 2} textAnchor="middle"
                fill="rgba(255,255,255,0.45)" fontSize="11" fontFamily="monospace">
                Q4
              </text>
              <text x={ox + cellW + gap + cellW / 2} y={oy + cellH + gap + cellH - 5} textAnchor="middle"
                fill="rgba(255,255,255,0.28)" fontSize="5.5" fontFamily="monospace">
                养着干
              </text>
            </g>
          );
        })()}

        {/* ── 装饰节点 ── */}
        <circle cx="16" cy="48" r="2.5" fill="rgba(252,211,77,0.6)" filter="url(#pac-glow-soft)" />
        <circle cx="16" cy="48" r="1.4" fill="#FCD34D" />
        <line x1="18" y1="48" x2="34" y2="48" stroke="rgba(252,211,77,0.35)" strokeWidth="0.7" strokeDasharray="2 2" />

        <circle cx="284" cy="32" r="2.5" fill="rgba(34,211,238,0.55)" filter="url(#pac-glow-soft)" />
        <circle cx="284" cy="32" r="1.4" fill="#67E8F9" />

        <circle cx="148" cy="36" r="1.8" fill="rgba(252,211,77,0.55)" />
        <circle cx="190" cy="60" r="2.0" fill="rgba(34,211,238,0.55)" filter="url(#pac-glow-soft)" />

        {/* ── 扫描线（5s 慢速循环，营造活感）── */}
        <rect x="0" y="0" width="300" height="1.4" fill="rgba(252,211,77,0.32)" opacity="0.6">
          <animateTransform attributeName="transform" type="translate"
            from="0 -2" to="0 202" dur="5s" repeatCount="indefinite" />
        </rect>
      </svg>

      {/* Hover 光带 — 从左到右扫过；不被父 group hover 时无效 */}
      <div className="pa-agent-card-shimmer absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100" />

      {/* Hover 内发光 */}
      <div
        className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          boxShadow: 'inset 0 0 60px rgba(34, 211, 238, 0.10), inset 0 0 24px rgba(245, 158, 11, 0.08)',
        }}
      />

      {/* 光带动画样式 — 局部 scope */}
      <style>{`
        @keyframes pa-agent-card-shimmer {
          0%   { transform: translateX(-100%); opacity: 0; }
          25%  { opacity: 1; }
          75%  { opacity: 1; }
          100% { transform: translateX(120%); opacity: 0; }
        }
        .pa-agent-card-shimmer {
          background: linear-gradient(
            110deg,
            transparent 30%,
            rgba(252, 211, 77, 0.18) 48%,
            rgba(34, 211, 238, 0.14) 56%,
            transparent 70%
          );
          background-size: 200% 100%;
          transition: opacity 300ms ease-out;
        }
        .group:hover .pa-agent-card-shimmer {
          animation: pa-agent-card-shimmer 1.4s ease-out infinite;
        }
      `}</style>
    </div>
  );
}
