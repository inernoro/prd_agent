/**
 * 毒舌秘书 Agent 卡片内联插画 — Gemini 风浅色网格 + 四色星芒
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
          <linearGradient id="pac-gem-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f8f9fc" />
            <stop offset="55%" stopColor="#eef2f8" />
            <stop offset="100%" stopColor="#e8edf5" />
          </linearGradient>
          <radialGradient id="pac-blob-a" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(66,133,244,0.35)" />
            <stop offset="100%" stopColor="rgba(66,133,244,0)" />
          </radialGradient>
          <radialGradient id="pac-blob-b" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(234,67,53,0.22)" />
            <stop offset="100%" stopColor="rgba(234,67,53,0)" />
          </radialGradient>
          <radialGradient id="pac-blob-c" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(52,168,83,0.2)" />
            <stop offset="100%" stopColor="rgba(52,168,83,0)" />
          </radialGradient>
          <linearGradient id="pac-star-blue" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#4285f4" />
            <stop offset="100%" stopColor="#1a73e8" />
          </linearGradient>
          <linearGradient id="pac-star-red" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ea4335" />
            <stop offset="100%" stopColor="#c5221f" />
          </linearGradient>
          <linearGradient id="pac-star-yellow" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#fbbc04" />
            <stop offset="100%" stopColor="#f9ab00" />
          </linearGradient>
          <linearGradient id="pac-star-green" x1="1" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#34a853" />
            <stop offset="100%" stopColor="#188038" />
          </linearGradient>
        </defs>

        <rect width="300" height="200" fill="url(#pac-gem-bg)" />
        <ellipse cx="72" cy="48" rx="100" ry="70" fill="url(#pac-blob-a)" className="pa-agent-orb-one" />
        <ellipse cx="248" cy="152" rx="90" ry="60" fill="url(#pac-blob-b)" className="pa-agent-orb-two" />
        <ellipse cx="220" cy="36" rx="70" ry="48" fill="url(#pac-blob-c)" />

        {/* 轻网格 */}
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(i => (
          <line
            key={`v${i}`}
            x1={i * 28}
            y1="0"
            x2={i * 28}
            y2="200"
            stroke="rgba(148,163,184,0.12)"
            strokeWidth="0.5"
          />
        ))}

        {/* 中心星芒 */}
        <g className="pa-agent-gem-star">
          <path
            d="M88 72 L94 96 L118 102 L94 108 L88 132 L82 108 L58 102 L82 96 Z"
            fill="url(#pac-star-blue)"
            opacity="0.92"
          />
          <path
            d="M88 78 L92 96 L110 100 L92 104 L88 122 L84 104 L66 100 L84 96 Z"
            fill="#ffffff"
            opacity="0.85"
          />
          <path
            d="M88 74 L91 92 L109 98 L91 104 L88 122 L85 104 L67 98 L85 92 Z"
            fill="url(#pac-star-red)"
            opacity="0.45"
          />
          <path
            d="M88 80 L90.5 95 L106 99 L90.5 103 L88 118 L85.5 103 L70 99 L85.5 95 Z"
            fill="url(#pac-star-yellow)"
            opacity="0.42"
          />
          <path
            d="M88 82 L90 94 L102 97 L90 100 L88 112 L86 100 L74 97 L86 94 Z"
            fill="url(#pac-star-green)"
            opacity="0.4"
          />
          <circle cx="88" cy="102" r="6" fill="rgba(255,255,255,0.9)" />
        </g>

        {/* 右侧简洁清单条 */}
        <g className="pa-agent-notes-layer" opacity="0.9">
          {[52, 68, 84, 100].map((y, i) => (
            <rect
              key={y}
              x={148}
              y={y}
              width={120 - i * 12}
              height={6}
              rx={3}
              fill={`rgba(100,116,139,${0.22 - i * 0.03})`}
            />
          ))}
          <rect x="148" y="118" width="88" height="22" rx="6" fill="rgba(66,133,244,0.12)" />
          <path
            d="M158 130 L172 130 L168 126 L176 134 L162 134 Z"
            fill="#4285f4"
            opacity="0.75"
          />
        </g>
      </svg>

      <div className="pa-agent-card-shimmer absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100" />

      <style>{`
        .group:hover .pa-agent-gem-star {
          transform: translateY(-4px) scale(1.04);
        }
        .group:hover .pa-agent-notes-layer {
          transform: translateX(3px);
        }
        .pa-agent-gem-star,
        .pa-agent-notes-layer,
        .pa-agent-orb-one,
        .pa-agent-orb-two {
          transform-origin: center;
          transition: transform 480ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .group:hover .pa-agent-orb-one {
          transform: translate(-6px, 4px) scale(1.08);
        }
        .group:hover .pa-agent-orb-two {
          transform: translate(8px, -3px) scale(1.06);
        }
        @keyframes pa-agent-card-shimmer {
          0% { transform: translateX(-100%); opacity: 0; }
          25% { opacity: 0.85; }
          75% { opacity: 0.85; }
          100% { transform: translateX(115%); opacity: 0; }
        }
        .pa-agent-card-shimmer {
          background: linear-gradient(
            110deg,
            transparent 24%,
            rgba(66, 133, 244, 0.18) 46%,
            rgba(52, 168, 83, 0.14) 54%,
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
