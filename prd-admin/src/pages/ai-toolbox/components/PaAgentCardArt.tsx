/**
 * 毒舌秘书 Agent 卡片插画 — 深蓝科技风 + hover 动态星芒
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
          <linearGradient id="pac-tech-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#050c1f" />
            <stop offset="42%" stopColor="#0a1d44" />
            <stop offset="100%" stopColor="#06132d" />
          </linearGradient>
          <radialGradient id="pac-orb-cyan" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(34,211,238,0.42)" />
            <stop offset="100%" stopColor="rgba(34,211,238,0)" />
          </radialGradient>
          <radialGradient id="pac-orb-indigo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(99,102,241,0.4)" />
            <stop offset="100%" stopColor="rgba(99,102,241,0)" />
          </radialGradient>
          <linearGradient id="pac-star-blue" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#4f8fff" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>
          <linearGradient id="pac-star-red" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff6f61" />
            <stop offset="100%" stopColor="#dc2626" />
          </linearGradient>
          <linearGradient id="pac-star-yellow" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#facc15" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
          <linearGradient id="pac-star-green" x1="1" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#4ade80" />
            <stop offset="100%" stopColor="#16a34a" />
          </linearGradient>
        </defs>

        <rect width="300" height="200" fill="url(#pac-tech-bg)" />
        <ellipse cx="54" cy="38" rx="88" ry="62" fill="url(#pac-orb-cyan)" className="pa-agent-orb-one" />
        <ellipse cx="244" cy="158" rx="94" ry="68" fill="url(#pac-orb-indigo)" className="pa-agent-orb-two" />

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
        {[0, 1, 2, 3, 4, 5].map(i => (
          <line
            key={`h${i}`}
            x1="0"
            y1={i * 34}
            x2="300"
            y2={i * 34}
            stroke="rgba(148,163,184,0.08)"
            strokeWidth="0.5"
          />
        ))}

        <g className="pa-agent-star-trail">
          <path d="M40 112 C72 84,104 80,136 100" stroke="rgba(56,189,248,0.45)" strokeWidth="1.4" fill="none" />
          <path d="M48 120 C84 96,116 96,152 116" stroke="rgba(99,102,241,0.36)" strokeWidth="1.1" fill="none" />
        </g>

        <g className="pa-agent-gem-star">
          <path
            d="M88 72 L94 96 L118 102 L94 108 L88 132 L82 108 L58 102 L82 96 Z"
            fill="url(#pac-star-blue)"
            opacity="0.92"
          />
          <path
            d="M88 78 L92 96 L110 100 L92 104 L88 122 L84 104 L66 100 L84 96 Z"
            fill="#ffffff"
            opacity="0.88"
          />
          <path
            d="M88 74 L91 92 L109 98 L91 104 L88 122 L85 104 L67 98 L85 92 Z"
            fill="url(#pac-star-red)"
            opacity="0.42"
          />
          <path
            d="M88 80 L90.5 95 L106 99 L90.5 103 L88 118 L85.5 103 L70 99 L85.5 95 Z"
            fill="url(#pac-star-yellow)"
            opacity="0.38"
          />
          <path
            d="M88 82 L90 94 L102 97 L90 100 L88 112 L86 100 L74 97 L86 94 Z"
            fill="url(#pac-star-green)"
            opacity="0.36"
          />
          <circle cx="88" cy="102" r="6.5" fill="rgba(255,255,255,0.92)" className="pa-agent-star-core" />
          <circle cx="88" cy="102" r="18" fill="rgba(59,130,246,0.14)" className="pa-agent-star-halo" />
        </g>

        <g className="pa-agent-notes-layer" opacity="0.9">
          {[54, 70, 86, 102].map((y, i) => (
            <rect
              key={y}
              x={148}
              y={y}
              width={122 - i * 12}
              height={6}
              rx={3}
              fill={`rgba(186,230,253,${0.86 - i * 0.14})`}
            />
          ))}
          <rect x="148" y="120" width="88" height="20" rx="6" fill="rgba(30,64,175,0.36)" />
          <path d="M158 129 L171 129 L168 125 L176 133 L162 133 Z" fill="#67e8f9" opacity="0.85" />
        </g>
      </svg>

      <div className="pa-agent-card-shimmer absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100" />

      <style>{`
        @keyframes pa-agent-star-idle {
          0%, 100% { transform: translateY(0) scale(1); filter: drop-shadow(0 0 0 rgba(34, 211, 238, 0)); }
          50% { transform: translateY(-1px) scale(1.015); filter: drop-shadow(0 0 5px rgba(34, 211, 238, 0.35)); }
        }
        @keyframes pa-agent-star-pulse {
          0%, 100% { transform: scale(1); opacity: 0.22; }
          50% { transform: scale(1.2); opacity: 0.5; }
        }
        @keyframes pa-agent-star-spin {
          0% { transform: translateY(-5px) scale(1.05) rotate(0deg); }
          100% { transform: translateY(-5px) scale(1.05) rotate(360deg); }
        }
        @keyframes pa-agent-trail-flow {
          0% { transform: translateX(0); opacity: 0.5; }
          50% { transform: translateX(5px); opacity: 0.9; }
          100% { transform: translateX(0); opacity: 0.5; }
        }
        .pa-agent-gem-star {
          animation: pa-agent-star-idle 2.4s ease-in-out infinite;
          transform-origin: 88px 102px;
          transition: transform 480ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .pa-agent-star-halo {
          animation: pa-agent-star-pulse 2.1s ease-in-out infinite;
          transform-origin: 88px 102px;
        }
        .pa-agent-star-trail {
          animation: pa-agent-trail-flow 2.6s ease-in-out infinite;
          transform-origin: center;
          transition: transform 480ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .group:hover .pa-agent-gem-star {
          animation: pa-agent-star-spin 1.7s linear infinite;
        }
        .group:hover .pa-agent-star-trail {
          transform: translateX(8px);
          opacity: 1;
        }
        .group:hover .pa-agent-notes-layer {
          transform: translateX(4px);
        }
        .pa-agent-notes-layer,
        .pa-agent-orb-one,
        .pa-agent-orb-two {
          transform-origin: center;
          transition: transform 480ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .group:hover .pa-agent-orb-one {
          transform: translate(-8px, 5px) scale(1.08);
        }
        .group:hover .pa-agent-orb-two {
          transform: translate(9px, -4px) scale(1.06);
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
            rgba(56, 189, 248, 0.26) 46%,
            rgba(99, 102, 241, 0.22) 54%,
            transparent 74%
          );
        }
        .group:hover .pa-agent-card-shimmer {
          animation: pa-agent-card-shimmer 1.2s ease-out infinite;
        }
      `}</style>
    </div>
  );
}
