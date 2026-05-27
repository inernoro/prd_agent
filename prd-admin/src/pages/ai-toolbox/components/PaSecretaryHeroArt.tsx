import { useId } from 'react';

/**
 * 毒舌秘书空状态大图 — 深蓝科技风（参考首页卡片 PaAgentCardArt）
 * 圆角深蓝渐变底 + 科技网格 + 星芒（idle 呼吸 + 光环脉冲）
 */
export function PaSecretaryHeroArt({ size = 88 }: { size?: number }) {
  const uid = useId().replace(/:/g, '');
  const bgId = `pa-hero-bg-${uid}`;
  const orbCyan = `pa-hero-orb-cyan-${uid}`;
  const orbIndigo = `pa-hero-orb-indigo-${uid}`;
  const starBlue = `pa-hero-star-blue-${uid}`;
  const starRed = `pa-hero-star-red-${uid}`;
  const starYellow = `pa-hero-star-yellow-${uid}`;
  const starGreen = `pa-hero-star-green-${uid}`;
  const clipId = `pa-hero-clip-${uid}`;

  return (
    <div className="pa-hero-art-root" style={{ width: size, height: size }}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 120 120"
        width={size}
        height={size}
        aria-hidden
      >
        <defs>
          <clipPath id={clipId}>
            <rect x="0" y="0" width="120" height="120" rx="26" ry="26" />
          </clipPath>
          <linearGradient id={bgId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#050c1f" />
            <stop offset="48%" stopColor="#0a1d44" />
            <stop offset="100%" stopColor="#06132d" />
          </linearGradient>
          <radialGradient id={orbCyan} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(34,211,238,0.55)" />
            <stop offset="100%" stopColor="rgba(34,211,238,0)" />
          </radialGradient>
          <radialGradient id={orbIndigo} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(99,102,241,0.5)" />
            <stop offset="100%" stopColor="rgba(99,102,241,0)" />
          </radialGradient>
          <linearGradient id={starBlue} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#4f8fff" />
            <stop offset="100%" stopColor="#1d4ed8" />
          </linearGradient>
          <linearGradient id={starRed} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff6f61" />
            <stop offset="100%" stopColor="#dc2626" />
          </linearGradient>
          <linearGradient id={starYellow} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#facc15" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
          <linearGradient id={starGreen} x1="1" y1="1" x2="0" y2="0">
            <stop offset="0%" stopColor="#4ade80" />
            <stop offset="100%" stopColor="#16a34a" />
          </linearGradient>
        </defs>

        <g clipPath={`url(#${clipId})`}>
          <rect width="120" height="120" fill={`url(#${bgId})`} />
          <ellipse cx="22" cy="20" rx="48" ry="36" fill={`url(#${orbCyan})`} className="pa-hero-orb-one" />
          <ellipse cx="98" cy="100" rx="52" ry="40" fill={`url(#${orbIndigo})`} className="pa-hero-orb-two" />

          {[0, 1, 2, 3, 4, 5, 6].map(i => (
            <line
              key={`v${i}`}
              x1={i * 20}
              y1="0"
              x2={i * 20}
              y2="120"
              stroke="rgba(148,163,184,0.12)"
              strokeWidth="0.4"
            />
          ))}
          {[0, 1, 2, 3, 4, 5, 6].map(i => (
            <line
              key={`h${i}`}
              x1="0"
              y1={i * 20}
              x2="120"
              y2={i * 20}
              stroke="rgba(148,163,184,0.08)"
              strokeWidth="0.4"
            />
          ))}

          {/* 星芒 — 居中 */}
          <g className="pa-hero-star" transform="translate(60 60)">
            <circle r="30" fill="rgba(59,130,246,0.16)" className="pa-hero-star-halo" />
            <path
              d="M0 -34 L7 -7 L34 0 L7 7 L0 34 L-7 7 L-34 0 L-7 -7 Z"
              fill={`url(#${starBlue})`}
              opacity="0.94"
            />
            <path
              d="M0 -26 L5 -6 L26 0 L5 6 L0 26 L-5 6 L-26 0 L-5 -6 Z"
              fill="#ffffff"
              opacity="0.92"
            />
            <path
              d="M0 -22 L4.5 -5 L22 0 L4.5 5 L0 22 L-4.5 5 L-22 0 L-4.5 -5 Z"
              fill={`url(#${starRed})`}
              opacity="0.42"
            />
            <path
              d="M0 -18 L4 -4 L18 0 L4 4 L0 18 L-4 4 L-18 0 L-4 -4 Z"
              fill={`url(#${starYellow})`}
              opacity="0.38"
            />
            <path
              d="M0 -14 L3 -3 L14 0 L3 3 L0 14 L-3 3 L-14 0 L-3 -3 Z"
              fill={`url(#${starGreen})`}
              opacity="0.36"
            />
            <circle r="6" fill="rgba(255,255,255,0.94)" className="pa-hero-star-core" />
          </g>

          {/* 轨迹光线 */}
          <g className="pa-hero-star-trail">
            <path d="M16 76 C36 60,56 58,82 70" stroke="rgba(56,189,248,0.45)" strokeWidth="0.9" fill="none" />
            <path d="M20 84 C42 70,62 70,90 82" stroke="rgba(99,102,241,0.35)" strokeWidth="0.7" fill="none" />
          </g>
        </g>

        {/* 描边 */}
        <rect
          x="0.5"
          y="0.5"
          width="119"
          height="119"
          rx="25.5"
          ry="25.5"
          fill="none"
          stroke="rgba(148,163,184,0.18)"
          strokeWidth="1"
        />
      </svg>

      <style>{`
        @keyframes pa-hero-star-idle {
          0%, 100% { transform: translate(60px, 60px) scale(1); filter: drop-shadow(0 0 0 rgba(34, 211, 238, 0)); }
          50% { transform: translate(60px, 60px) scale(1.04); filter: drop-shadow(0 0 6px rgba(34, 211, 238, 0.5)); }
        }
        @keyframes pa-hero-star-pulse {
          0%, 100% { transform: scale(1); opacity: 0.25; }
          50% { transform: scale(1.22); opacity: 0.55; }
        }
        @keyframes pa-hero-star-spin {
          0% { transform: translate(60px, 60px) scale(1.06) rotate(0deg); }
          100% { transform: translate(60px, 60px) scale(1.06) rotate(360deg); }
        }
        @keyframes pa-hero-trail-flow {
          0% { transform: translateX(-2px); opacity: 0.55; }
          50% { transform: translateX(4px); opacity: 0.95; }
          100% { transform: translateX(-2px); opacity: 0.55; }
        }
        .pa-hero-art-root { display: inline-block; line-height: 0; }
        .pa-hero-star {
          animation: pa-hero-star-idle 2.6s ease-in-out infinite;
          transform-origin: 60px 60px;
        }
        .pa-hero-art-root:hover .pa-hero-star {
          animation: pa-hero-star-spin 4s linear infinite;
        }
        .pa-hero-star-halo {
          transform-origin: center;
          animation: pa-hero-star-pulse 2.2s ease-in-out infinite;
        }
        .pa-hero-star-trail {
          animation: pa-hero-trail-flow 2.8s ease-in-out infinite;
        }
        .pa-hero-orb-one,
        .pa-hero-orb-two {
          transform-origin: center;
          transition: transform 480ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .pa-hero-art-root:hover .pa-hero-orb-one {
          transform: translate(-3px, 2px) scale(1.08);
        }
        .pa-hero-art-root:hover .pa-hero-orb-two {
          transform: translate(4px, -2px) scale(1.06);
        }
      `}</style>
    </div>
  );
}
