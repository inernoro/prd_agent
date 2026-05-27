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
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" className="absolute inset-0 w-full h-full">
        <defs>
          <linearGradient id="pa-sky" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#061a39" />
            <stop offset="60%" stopColor="#0a2f62" />
            <stop offset="100%" stopColor="#102446" />
          </linearGradient>
          <radialGradient id="pa-cyan" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(34,211,238,0.75)" />
            <stop offset="100%" stopColor="rgba(34,211,238,0)" />
          </radialGradient>
          <radialGradient id="pa-amber" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(251,146,60,0.7)" />
            <stop offset="100%" stopColor="rgba(251,146,60,0)" />
          </radialGradient>
          <linearGradient id="pa-desk" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(9,30,59,0.25)" />
            <stop offset="100%" stopColor="rgba(4,14,31,0.9)" />
          </linearGradient>
        </defs>

        <rect width="300" height="200" fill="url(#pa-sky)" />
        <ellipse cx="250" cy="20" rx="70" ry="50" fill="url(#pa-cyan)" className="pa-agent-orb-one" />
        <ellipse cx="50" cy="172" rx="85" ry="35" fill="url(#pa-amber)" className="pa-agent-orb-two" />

        <rect x="0" y="124" width="300" height="76" fill="url(#pa-desk)" />

        {/* 拟人化秘书头像 + 耳麦 */}
        <g className="pa-agent-secretary-core">
          <circle cx="92" cy="82" r="22" fill="#ffd5b3" />
          <path d="M70 79 C72 56,113 52,118 80 C110 67,92 68,70 79Z" fill="#16233f" />
          <rect x="76" y="102" width="33" height="20" rx="10" fill="#2a4f88" />
          <path d="M113 82 C122 80,126 86,124 94" stroke="#22d3ee" strokeWidth="2.2" fill="none" />
          <circle cx="124" cy="95" r="3" fill="#22d3ee" />
          <circle cx="72" cy="82" r="3" fill="#0b1326" />
          <circle cx="88" cy="82" r="3" fill="#0b1326" />
        </g>

        {/* 工作区元素：便签、打勾、钢笔 */}
        <g className="pa-agent-notes-layer">
          <rect x="140" y="48" width="118" height="84" rx="10" fill="rgba(9,24,49,0.55)" stroke="rgba(90,167,255,0.3)" />
          <rect x="153" y="63" width="72" height="7" rx="3.5" fill="rgba(201,227,255,0.8)" />
          <rect x="153" y="78" width="56" height="6" rx="3" fill="rgba(201,227,255,0.6)" />
          <rect x="153" y="92" width="63" height="6" rx="3" fill="rgba(201,227,255,0.42)" />
          <rect x="153" y="106" width="50" height="6" rx="3" fill="rgba(201,227,255,0.3)" />
          <circle cx="236" cy="79" r="8" fill="rgba(251,146,60,0.9)" />
          <path d="M232 79 L235 82 L240 76" stroke="#fff9f0" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <path d="M220 138 L251 116" stroke="rgba(251,146,60,0.86)" strokeWidth="4" strokeLinecap="round" />
        </g>

        <g className="pa-agent-particles">
          <circle cx="132" cy="44" r="2.5" fill="#22d3ee" />
          <circle cx="176" cy="38" r="1.6" fill="#67e8f9" />
          <circle cx="204" cy="41" r="1.6" fill="#fb923c" />
          <circle cx="243" cy="46" r="2.4" fill="#fbbf24" />
        </g>
      </svg>

      <div className="pa-agent-card-shimmer absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100" />
      <style>{`
        .group:hover .pa-agent-secretary-core { transform: translateY(-3px); }
        .group:hover .pa-agent-notes-layer { transform: translateX(3px); }
        .group:hover .pa-agent-particles { transform: translateY(-2px) scale(1.03); }
        .pa-agent-secretary-core,.pa-agent-notes-layer,.pa-agent-particles,.pa-agent-orb-one,.pa-agent-orb-two {
          transform-origin: center;
          transition: transform 420ms ease, opacity 420ms ease;
        }
        .group:hover .pa-agent-orb-one { transform: translate(-6px, 4px) scale(1.08); }
        .group:hover .pa-agent-orb-two { transform: translate(7px, -3px) scale(1.1); }
        @keyframes pa-agent-card-shimmer {
          0% { transform: translateX(-100%); opacity: 0; }
          20% { opacity: 1; }
          80% { opacity: 1; }
          100% { transform: translateX(115%); opacity: 0; }
        }
        .pa-agent-card-shimmer {
          background: linear-gradient(110deg, transparent 26%, rgba(103,232,249,0.26) 48%, rgba(251,146,60,0.22) 56%, transparent 72%);
        }
        .group:hover .pa-agent-card-shimmer { animation: pa-agent-card-shimmer 1.35s ease-out infinite; }
      `}</style>
    </div>
  );
}
