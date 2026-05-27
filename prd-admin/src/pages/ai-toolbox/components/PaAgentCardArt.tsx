/**
 * 毒舌秘书 Agent 卡片内联插画 — AI 秘书主题（v3 改版）
 *
 * 设计思路：
 *   - 主题从「MBB 顾问 + 四象限」改为「AI 秘书」语言
 *   - 视觉元素：
 *       1) 一张展开的笔记本（双页装订）—— 隐喻「正在记你说的话」
 *       2) 左页：3 行清单 + 复选框（其中 2 行打勾）—— 隐喻「能落盘」
 *       3) 右页：印章 + 一行毒舌点评 —— 隐喻「毒舌不堆鸡汤」
 *       4) 上方一支羽毛笔正在书写 + 一颗 AI 思维「火花」—— 隐喻「AI 在动笔」
 *       5) 左下角咖啡杯热气 —— 温暖感
 *   - 配色：羊皮卷米色（#F5E8C8 → #E5D2A5）打底 + 深棕笔触（#3D2817）
 *           + 琥珀印章（#D97706 / #F59E0B）+ 一抹青色高亮（#22D3EE）保持品牌延续
 *   - 不依赖 CDN、不引入任何 npm 资源
 *
 * Hover 由父卡片的 `group-hover` 提供：
 *   1) 整图 scale-105（FeaturedCard / ToolCard 已内置）
 *   2) 光带从左扫过（CSS keyframe，本组件内置）
 *   3) 内发光 box-shadow
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
          {/* ── 底色：羊皮卷米色渐变 ── */}
          <linearGradient id="pac-bg-base" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FAF1D6" />
            <stop offset="50%" stopColor="#F2E2B5" />
            <stop offset="100%" stopColor="#E4CD96" />
          </linearGradient>

          {/* 暗角晕染，营造仿羊皮卷质感 */}
          <radialGradient id="pac-vignette" cx="50%" cy="50%" r="80%">
            <stop offset="60%" stopColor="rgba(160, 110, 50, 0)" />
            <stop offset="100%" stopColor="rgba(120, 80, 30, 0.45)" />
          </radialGradient>

          {/* 笔记本纸张：略带温暖纯白 */}
          <linearGradient id="pac-paper" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFFCEF" />
            <stop offset="100%" stopColor="#F4ECCC" />
          </linearGradient>

          {/* 笔记本封皮：深棕 */}
          <linearGradient id="pac-cover" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5C3A20" />
            <stop offset="100%" stopColor="#3D2817" />
          </linearGradient>

          {/* 印章：琥珀光晕 */}
          <radialGradient id="pac-stamp" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor="#FCD34D" />
            <stop offset="55%" stopColor="#D97706" />
            <stop offset="100%" stopColor="#92400E" />
          </radialGradient>

          {/* 羽毛笔金属笔尖渐变 */}
          <linearGradient id="pac-nib" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FBBF24" />
            <stop offset="50%" stopColor="#D97706" />
            <stop offset="100%" stopColor="#78350F" />
          </linearGradient>

          {/* AI 火花柔光 */}
          <radialGradient id="pac-spark" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.95" />
            <stop offset="60%" stopColor="#22D3EE" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
          </radialGradient>

          {/* 咖啡热气 */}
          <radialGradient id="pac-steam" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.65)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </radialGradient>

          {/* 纸张纹理点阵（极淡） */}
          <pattern id="pac-paper-dot" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
            <circle cx="0.5" cy="0.5" r="0.4" fill="rgba(120,80,30,0.04)" />
          </pattern>

          {/* 柔光滤镜 */}
          <filter id="pac-soft" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
          <filter id="pac-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        {/* ── 底层背景：羊皮卷 ── */}
        <rect width="300" height="200" fill="url(#pac-bg-base)" />
        <rect width="300" height="200" fill="url(#pac-paper-dot)" />

        {/* ── 笔记本本体（双页装订） ── */}
        {/* 封皮 + 桌面阴影 */}
        <ellipse cx="150" cy="178" rx="125" ry="6" fill="rgba(80,50,20,0.18)" filter="url(#pac-soft)" />
        {/* 左封皮 */}
        <rect x="32" y="60" width="120" height="108" rx="6" fill="url(#pac-cover)" />
        {/* 右封皮 */}
        <rect x="148" y="60" width="120" height="108" rx="6" fill="url(#pac-cover)" />
        {/* 中线装订 */}
        <rect x="148" y="60" width="4" height="108" fill="rgba(0,0,0,0.45)" />
        <line x1="150" y1="60" x2="150" y2="168" stroke="rgba(252,211,77,0.35)" strokeWidth="0.6" strokeDasharray="3 2" />

        {/* 左页纸 */}
        <rect x="40" y="68" width="106" height="94" rx="2" fill="url(#pac-paper)" />
        {/* 右页纸 */}
        <rect x="152" y="68" width="106" height="94" rx="2" fill="url(#pac-paper)" />

        {/* ── 左页：3 行清单（前两行打勾） ── */}
        {[
          { y: 82, done: true,  text: '今日要事 — IMP 项目' },
          { y: 100, done: true, text: '回复同事关于交付的提问' },
          { y: 118, done: false, text: '准备明早 9 点站会议程' },
        ].map((row, i) => (
          <g key={i}>
            {/* 复选框 */}
            <rect x="48" y={row.y - 5} width="9" height="9" rx="1.5"
              fill={row.done ? '#D97706' : 'transparent'}
              stroke="#92400E" strokeWidth="0.9" />
            {row.done && (
              <path
                d={`M 50 ${row.y - 0.5} L 52 ${row.y + 1.5} L 55.5 ${row.y - 2.5}`}
                fill="none" stroke="#FFFCEF" strokeWidth="1.3"
                strokeLinecap="round" strokeLinejoin="round"
              />
            )}
            {/* 文本行（用矩形线代替具象文字，避免可读性问题 + 国际化通用） */}
            <rect x="62" y={row.y - 3} width={row.done ? 70 : 80} height="2"
              fill="rgba(60,40,20,0.55)" opacity={row.done ? 0.45 : 0.85} />
            <rect x="62" y={row.y + 1} width={row.done ? 48 : 60} height="1.6"
              fill="rgba(60,40,20,0.35)" opacity={row.done ? 0.32 : 0.6} />
          </g>
        ))}

        {/* 左页底部 — 「待办 3 项」标签 */}
        <text x="48" y="148" fill="rgba(60,40,20,0.5)"
          fontSize="6" fontFamily="ui-serif, Georgia, serif" letterSpacing="0.5">
          M E M O
        </text>
        <line x1="48" y1="152" x2="138" y2="152" stroke="rgba(120,80,30,0.25)" strokeWidth="0.5" />

        {/* ── 右页：印章 + 一行毒舌点评 ── */}
        {/* 印章 - 外环 */}
        <circle cx="205" cy="98" r="22" fill="none" stroke="#92400E" strokeWidth="1.4" opacity="0.85" />
        <circle cx="205" cy="98" r="20" fill="url(#pac-stamp)" opacity="0.7" filter="url(#pac-soft)" />
        <circle cx="205" cy="98" r="18.5" fill="none" stroke="rgba(255,252,239,0.45)" strokeWidth="0.6" />
        {/* 印章中心文字（中文「秘」字） */}
        <text x="205" y="103.5" textAnchor="middle"
          fill="#FFFCEF" fontSize="17" fontWeight="900"
          fontFamily="ui-serif, Georgia, serif" opacity="0.95">
          秘
        </text>
        {/* 印章上下边缘绕字（视觉装饰） */}
        <path id="pac-stamp-curve-top" d="M 188 90 A 17 17 0 0 1 222 90" fill="none" />
        <text fontSize="4.2" fill="rgba(255,252,239,0.8)" letterSpacing="1.5" fontFamily="ui-monospace, monospace">
          <textPath href="#pac-stamp-curve-top" startOffset="50%" textAnchor="middle">SAVAGE · SECRETARY</textPath>
        </text>

        {/* 右页底部 — 一行毒舌点评 */}
        <text x="158" y="138" fill="rgba(60,40,20,0.6)"
          fontSize="6" fontFamily="ui-serif, Georgia, serif" letterSpacing="0.4">
          today&apos;s verdict
        </text>
        <line x1="158" y1="142" x2="252" y2="142" stroke="rgba(120,80,30,0.3)" strokeWidth="0.5" />
        <rect x="158" y="146" width="88" height="2" fill="rgba(60,40,20,0.55)" />
        <rect x="158" y="151" width="60" height="1.6" fill="rgba(60,40,20,0.4)" />

        {/* ── 上方羽毛笔正在书写（斜插姿势 + 笔尖压在右页清单上方） ── */}
        {/* 笔杆 — 米色羽毛 */}
        <path
          d="M 260 38 Q 252 30 240 36 Q 226 44 215 55 Q 208 62 204 70"
          fill="none" stroke="#3D2817" strokeWidth="2.4" strokeLinecap="round"
        />
        {/* 羽毛分叉 */}
        <path d="M 260 38 Q 268 30 274 24" fill="none" stroke="#5C3A20" strokeWidth="1.4" strokeLinecap="round" opacity="0.8" />
        <path d="M 256 41 Q 260 35 266 31" fill="none" stroke="#5C3A20" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
        <path d="M 252 44 Q 254 38 260 34" fill="none" stroke="#5C3A20" strokeWidth="1" strokeLinecap="round" opacity="0.55" />
        <path d="M 248 47 Q 250 42 256 39" fill="none" stroke="#5C3A20" strokeWidth="0.9" strokeLinecap="round" opacity="0.5" />

        {/* 笔尖（金属感 + 小三角） */}
        <path d="M 204 70 L 202 75 L 207 73 Z" fill="url(#pac-nib)" />
        <path d="M 202 75 L 200 79" stroke="#92400E" strokeWidth="0.6" opacity="0.5" />

        {/* ── AI 火花（青色，象征 AI 在思考） ── */}
        <g>
          <circle cx="186" cy="48" r="6" fill="url(#pac-spark)" />
          <circle cx="186" cy="48" r="1.8" fill="#22D3EE" />
          <path d="M 186 42 L 186 54 M 180 48 L 192 48"
            stroke="#67E8F9" strokeWidth="0.8" strokeLinecap="round" opacity="0.85" />
          <path d="M 182 44 L 190 52 M 190 44 L 182 52"
            stroke="rgba(165,243,252,0.65)" strokeWidth="0.5" strokeLinecap="round" />
        </g>
        {/* 第二颗较小的火花 */}
        <g>
          <circle cx="170" cy="36" r="3.5" fill="url(#pac-spark)" />
          <circle cx="170" cy="36" r="0.9" fill="#22D3EE" />
        </g>

        {/* ── 左下角咖啡杯 + 热气 ── */}
        <g>
          {/* 杯身 */}
          <path d="M 50 158 L 52 174 Q 52 178 56 178 L 70 178 Q 74 178 74 174 L 76 158 Z"
            fill="#3D2817" />
          {/* 杯口高光 */}
          <ellipse cx="63" cy="158" rx="13" ry="2.4" fill="#5C3A20" />
          <ellipse cx="63" cy="158" rx="10" ry="1.4" fill="#1F1208" />
          {/* 把手 */}
          <path d="M 76 162 Q 84 163 84 168 Q 84 173 76 174"
            fill="none" stroke="#3D2817" strokeWidth="2" />
          {/* 热气 */}
          <g opacity="0.75">
            <ellipse cx="58" cy="148" rx="3" ry="6" fill="url(#pac-steam)" />
            <ellipse cx="65" cy="143" rx="3.5" ry="7" fill="url(#pac-steam)" />
            <ellipse cx="71" cy="148" rx="2.8" ry="5.5" fill="url(#pac-steam)" />
          </g>
        </g>

        {/* 整体暗角，烘托羊皮卷氛围（贴在最上层但 pointer-events:none） */}
        <rect width="300" height="200" fill="url(#pac-vignette)" pointerEvents="none" />

        {/* Scan line — 极淡，4s 慢速循环 */}
        <rect x="0" y="0" width="300" height="1.6" fill="rgba(217,119,6,0.18)" opacity="0.6">
          <animateTransform attributeName="transform" type="translate"
            from="0 -2" to="0 202" dur="6s" repeatCount="indefinite" />
        </rect>
      </svg>

      {/* Hover 光带 — 父 group hover 时由左滑右 */}
      <div className="pa-agent-card-shimmer absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100" />

      {/* Hover 内发光 */}
      <div
        className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{
          boxShadow: 'inset 0 0 60px rgba(217, 119, 6, 0.14), inset 0 0 24px rgba(34, 211, 238, 0.08)',
        }}
      />

      {/* 光带动画样式（与 v2 共用 class 名，覆盖颜色更暖） */}
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
            rgba(252, 211, 77, 0.28) 48%,
            rgba(217, 119, 6, 0.18) 56%,
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
