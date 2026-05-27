/**
 * 毒舌秘书 Agent 卡片内联插画 — 科幻深蓝 + 女秘书形象
 *
 * 视觉语言：深空蓝底、HUD 网格、全息清单、拟人化女秘书 bust（耳麦 + 长发 + 职业装）
 * Hover：秘书轻微上浮、全息面板平移、粒子与光晕联动（无 npm / 无 CDN）
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
          <linearGradient id="pac-sky" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#030b18" />
            <stop offset="45%" stopColor="#0a2248" />
            <stop offset="100%" stopColor="#061a38" />
          </linearGradient>
          <linearGradient id="pac-horizon" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(34,211,238,0.12)" />
            <stop offset="100%" stopColor="rgba(2,8,23,0.95)" />
          </linearGradient>
          <radialGradient id="pac-nebula-a" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(56,189,248,0.55)" />
            <stop offset="100%" stopColor="rgba(56,189,248,0)" />
          </radialGradient>
          <radialGradient id="pac-nebula-b" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(129,140,248,0.45)" />
            <stop offset="100%" stopColor="rgba(129,140,248,0)" />
          </radialGradient>
          <linearGradient id="pac-hair" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1e3a5f" />
            <stop offset="100%" stopColor="#0b1224" />
          </linearGradient>
          <linearGradient id="pac-suit" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>
          <pattern id="pac-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path
              d="M24 0 L0 0 0 24"
              fill="none"
              stroke="rgba(103,232,249,0.08)"
              strokeWidth="0.6"
            />
          </pattern>
        </defs>

        <rect width="300" height="200" fill="url(#pac-sky)" />
        <rect width="300" height="200" fill="url(#pac-grid)" opacity="0.85" />

        <ellipse cx="248" cy="28" rx="78" ry="52" fill="url(#pac-nebula-a)" className="pa-agent-orb-one" />
        <ellipse cx="42" cy="168" rx="90" ry="38" fill="url(#pac-nebula-b)" className="pa-agent-orb-two" />

        {/* 科幻地平线 */}
        <path
          d="M0 138 Q150 118 300 138 L300 200 L0 200 Z"
          fill="url(#pac-horizon)"
        />
        <line
          x1="0"
          y1="138"
          x2="300"
          y2="138"
          stroke="rgba(103,232,249,0.35)"
          strokeWidth="0.8"
        />

        {/* 女秘书 bust — 主体 */}
        <g className="pa-agent-secretary-core">
          {/* 长发 */}
          <path
            d="M78 58 C72 32,108 28,118 52 C122 68,120 88,112 102 C108 112,98 118,88 118 C76 118,68 110,64 98 C58 82,62 68,78 58Z"
            fill="url(#pac-hair)"
          />
          <path
            d="M64 72 C58 88,60 108,70 118"
            stroke="rgba(103,232,249,0.25)"
            strokeWidth="1.2"
            fill="none"
          />
          {/* 脸 */}
          <ellipse cx="92" cy="72" rx="20" ry="23" fill="#f8d4bc" />
          <path
            d="M72 68 C74 48,110 46,114 68 C108 56,88 56,72 68Z"
            fill="#0f172a"
          />
          <ellipse cx="84" cy="74" rx="2.2" ry="2.5" fill="#0f172a" />
          <ellipse cx="100" cy="74" rx="2.2" ry="2.5" fill="#0f172a" />
          <path d="M88 80 Q92 82 96 80" stroke="rgba(180,100,90,0.5)" strokeWidth="0.8" fill="none" />
          {/* 颈 + 西装 */}
          <path d="M82 94 L102 94 L108 118 L76 118 Z" fill="url(#pac-suit)" />
          <path d="M76 118 L108 118 L112 132 L72 132 Z" fill="rgba(15,23,42,0.85)" />
          {/* 科幻耳麦 */}
          <path
            d="M112 70 C124 66,130 74,128 86"
            stroke="#22d3ee"
            strokeWidth="2.4"
            fill="none"
            strokeLinecap="round"
          />
          <circle cx="128" cy="87" r="4" fill="#0ea5e9" opacity="0.35" />
          <circle cx="128" cy="87" r="2.2" fill="#67e8f9" />
          {/* 胸前全息徽章 */}
          <circle cx="92" cy="108" r="7" fill="none" stroke="rgba(103,232,249,0.5)" strokeWidth="0.8" />
          <text
            x="92"
            y="111"
            textAnchor="middle"
            fill="#e0f2fe"
            fontSize="7"
            fontWeight="700"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
          >
            秘
          </text>
        </g>

        {/* 全息工作面板 */}
        <g className="pa-agent-notes-layer">
          <path
            d="M148 42 L262 42 L268 128 L142 128 Z"
            fill="rgba(8,20,45,0.72)"
            stroke="rgba(103,232,249,0.45)"
            strokeWidth="1"
          />
          <path
            d="M148 42 L262 42 L255 50 L155 50 Z"
            fill="rgba(34,211,238,0.12)"
          />
          {[58, 72, 86, 100].map((y, i) => (
            <rect
              key={y}
              x={162}
              y={y}
              width={i === 0 ? 88 : 72 - i * 6}
              height={5}
              rx={2.5}
              fill={`rgba(186,230,253,${0.85 - i * 0.15})`}
            />
          ))}
          <circle cx="248" cy="74" r="9" fill="rgba(14,165,233,0.85)" />
          <path
            d="M244 74 L247 77 L252 71"
            stroke="#f0f9ff"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M230 118 L258 96"
            stroke="rgba(251,191,36,0.9)"
            strokeWidth="3.5"
            strokeLinecap="round"
          />
        </g>

        {/* 漂浮粒子 */}
        <g className="pa-agent-particles">
          <circle cx="136" cy="36" r="2.2" fill="#67e8f9" />
          <circle cx="178" cy="30" r="1.4" fill="#a5b4fc" />
          <circle cx="210" cy="34" r="1.6" fill="#38bdf8" />
          <circle cx="246" cy="40" r="2" fill="#818cf8" />
          <circle cx="158" cy="118" r="1.2" fill="#22d3ee" opacity="0.7" />
        </g>

        {/* 扫描线 */}
        <rect
          x="0"
          y="0"
          width="300"
          height="2"
          fill="rgba(103,232,249,0.2)"
          className="pa-agent-scanline"
        />
      </svg>

      <div className="pa-agent-card-shimmer absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100" />

      <style>{`
        .pa-agent-scanline {
          animation: pa-agent-scan-drift 5s linear infinite;
        }
        @keyframes pa-agent-scan-drift {
          0% { transform: translateY(-4px); opacity: 0; }
          15% { opacity: 0.7; }
          85% { opacity: 0.5; }
          100% { transform: translateY(200px); opacity: 0; }
        }
        .group:hover .pa-agent-secretary-core {
          transform: translateY(-5px) scale(1.02);
        }
        .group:hover .pa-agent-notes-layer {
          transform: translateX(4px) skewX(-1deg);
        }
        .group:hover .pa-agent-particles {
          transform: translateY(-3px);
        }
        .pa-agent-secretary-core,
        .pa-agent-notes-layer,
        .pa-agent-particles,
        .pa-agent-orb-one,
        .pa-agent-orb-two {
          transform-origin: center;
          transition: transform 480ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .group:hover .pa-agent-orb-one {
          transform: translate(-8px, 5px) scale(1.1);
        }
        .group:hover .pa-agent-orb-two {
          transform: translate(10px, -4px) scale(1.12);
        }
        @keyframes pa-agent-card-shimmer {
          0% { transform: translateX(-100%); opacity: 0; }
          25% { opacity: 1; }
          75% { opacity: 1; }
          100% { transform: translateX(115%); opacity: 0; }
        }
        .pa-agent-card-shimmer {
          background: linear-gradient(
            110deg,
            transparent 24%,
            rgba(103, 232, 249, 0.32) 46%,
            rgba(129, 140, 248, 0.28) 54%,
            transparent 74%
          );
        }
        .group:hover .pa-agent-card-shimmer {
          animation: pa-agent-card-shimmer 1.4s ease-out infinite;
        }
      `}</style>
    </div>
  );
}
