/** 产品评审员 Agent 卡片内联插画 */
export function ReviewAgentCardArt() {
  // Score ring: r=50, cy=132, 86% filled
  const r = 50;
  const circ = 2 * Math.PI * r; // 314.16
  const fill86 = circ * 0.86;   // 270.18

  return (
    <div className="absolute inset-0 z-0 overflow-hidden">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 300 400"
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          {/* Background radial glows */}
          <radialGradient id="rac-gTop" cx="50%" cy="0%" r="65%" gradientUnits="userSpaceOnUse"
            gradientTransform="scale(300,400)">
            <stop offset="0%" stopColor="#6366F1" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#6366F1" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="rac-gBtm" cx="10%" cy="100%" r="55%" gradientUnits="userSpaceOnUse"
            gradientTransform="scale(300,400)">
            <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
          </radialGradient>
          {/* Score ring gradient */}
          <linearGradient id="rac-ring" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#818CF8" />
            <stop offset="50%" stopColor="#22D3EE" />
            <stop offset="100%" stopColor="#10B981" />
          </linearGradient>
          {/* Bar gradients */}
          <linearGradient id="rac-b1" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#6366F1" />
            <stop offset="100%" stopColor="#818CF8" />
          </linearGradient>
          <linearGradient id="rac-b2" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#06B6D4" />
            <stop offset="100%" stopColor="#67E8F9" />
          </linearGradient>
          <linearGradient id="rac-b3" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#10B981" />
            <stop offset="100%" stopColor="#6EE7B7" />
          </linearGradient>
          <linearGradient id="rac-b4" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#F59E0B" />
            <stop offset="100%" stopColor="#FCD34D" />
          </linearGradient>
          <linearGradient id="rac-b5" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#EC4899" />
            <stop offset="100%" stopColor="#F9A8D4" />
          </linearGradient>
          {/* Glow filter */}
          <filter id="rac-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="rac-blur2">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
          <filter id="rac-blur4">
            <feGaussianBlur stdDeviation="4" />
          </filter>
          {/* Grid dot pattern */}
          <pattern id="rac-dot" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.8" fill="rgba(255,255,255,0.11)" />
          </pattern>
        </defs>

        {/* ── Base ── */}
        <rect width="300" height="400" fill="#07090F" />
        <rect width="300" height="400" fill="url(#rac-dot)" />
        <rect width="300" height="400" fill="url(#rac-gTop)" />
        <rect width="300" height="400" fill="url(#rac-gBtm)" />

        {/* ── Document Frame ── */}
        {/* outer glow */}
        <rect x="50" y="22" width="200" height="248" rx="16"
          fill="rgba(99,102,241,0.07)" filter="url(#rac-blur4)" />
        {/* frame */}
        <rect x="52" y="24" width="196" height="244" rx="14"
          fill="rgba(6,9,20,0.82)" stroke="rgba(99,102,241,0.45)" strokeWidth="1.5" />
        {/* header bg */}
        <rect x="52" y="24" width="196" height="40" rx="14"
          fill="rgba(99,102,241,0.22)" />
        {/* header bottom square-off */}
        <rect x="52" y="50" width="196" height="14" fill="rgba(99,102,241,0.22)" />
        {/* header divider */}
        <line x1="66" y1="64" x2="234" y2="64"
          stroke="rgba(99,102,241,0.3)" strokeWidth="0.6" />
        {/* header text */}
        <text x="150" y="47" textAnchor="middle"
          fill="rgba(255,255,255,0.55)" fontSize="8" fontFamily="monospace" letterSpacing="2.5">
          AI REVIEW SCORE
        </text>

        {/* corner accent dots */}
        <circle cx="67" cy="39" r="2" fill="rgba(99,102,241,0.7)" />
        <circle cx="233" cy="39" r="2" fill="rgba(34,211,238,0.6)" />

        {/* ── Score Ring ── */}
        {/* glow ring (blurred behind) */}
        <circle cx="150" cy="132" r={r}
          fill="none" stroke="url(#rac-ring)" strokeWidth="12"
          strokeDasharray={`${fill86.toFixed(2)} ${circ.toFixed(2)}`}
          transform="rotate(-90 150 132)"
          filter="url(#rac-blur4)" opacity="0.6" />
        {/* track */}
        <circle cx="150" cy="132" r={r}
          fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="10" />
        {/* fill arc */}
        <circle cx="150" cy="132" r={r}
          fill="none" stroke="url(#rac-ring)" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${fill86.toFixed(2)} ${circ.toFixed(2)}`}
          transform="rotate(-90 150 132)" />

        {/* inner circle glass */}
        <circle cx="150" cy="132" r="35" fill="rgba(15,20,40,0.6)" />

        {/* score number */}
        <text x="150" y="127" textAnchor="middle"
          fill="white" fontSize="26" fontWeight="bold" fontFamily="monospace">86</text>
        {/* /100 */}
        <text x="150" y="142" textAnchor="middle"
          fill="rgba(255,255,255,0.3)" fontSize="9" fontFamily="monospace">/ 100 分</text>

        {/* pass badge */}
        <rect x="120" y="150" width="60" height="17" rx="8.5"
          fill="rgba(16,185,129,0.18)" stroke="rgba(16,185,129,0.45)" strokeWidth="0.8" />
        <text x="150" y="162" textAnchor="middle"
          fill="#6EE7B7" fontSize="8.5" fontFamily="monospace">✓ 已通过</text>

        {/* ── Dimension Bars ── */}
        {([
          { label: '完整性', pct: 0.90, id: 'rac-b1', y: 188 },
          { label: '逻辑性', pct: 0.80, id: 'rac-b2', y: 202 },
          { label: '可行性', pct: 0.85, id: 'rac-b3', y: 216 },
          { label: '创新性', pct: 0.65, id: 'rac-b4', y: 230 },
          { label: '规范性', pct: 0.86, id: 'rac-b5', y: 244 },
        ] as const).map(({ label, pct, id, y }) => {
          const trackW = 120;
          const fillW = trackW * pct;
          return (
            <g key={label}>
              <text x="68" y={y + 6} textAnchor="end"
                fill="rgba(255,255,255,0.38)" fontSize="7" fontFamily="monospace">
                {label}
              </text>
              {/* track */}
              <rect x="72" y={y} width={trackW} height="6" rx="3"
                fill="rgba(255,255,255,0.06)" />
              {/* fill — glow */}
              <rect x="72" y={y} width={fillW} height="6" rx="3"
                fill={`url(#${id})`} filter="url(#rac-blur2)" opacity="0.5" />
              {/* fill */}
              <rect x="72" y={y} width={fillW} height="6" rx="3"
                fill={`url(#${id})`} opacity="0.85" />
              {/* pct label */}
              <text x="197" y={y + 6} textAnchor="start"
                fill="rgba(255,255,255,0.3)" fontSize="7" fontFamily="monospace">
                {Math.round(pct * 100)}%
              </text>
            </g>
          );
        })}

        {/* ── Decorative Nodes Outside Frame ── */}
        <circle cx="32" cy="110" r="3" fill="rgba(99,102,241,0.55)" />
        <line x1="32" y1="110" x2="52" y2="110"
          stroke="rgba(99,102,241,0.25)" strokeWidth="0.8" strokeDasharray="3 2" />

        <circle cx="268" cy="95" r="2.5" fill="rgba(34,211,238,0.55)" />
        <line x1="268" y1="95" x2="248" y2="95"
          stroke="rgba(34,211,238,0.25)" strokeWidth="0.8" strokeDasharray="3 2" />

        <circle cx="28" cy="195" r="2" fill="rgba(16,185,129,0.5)" />
        <line x1="28" y1="195" x2="52" y2="195"
          stroke="rgba(16,185,129,0.2)" strokeWidth="0.8" strokeDasharray="3 2" />

        <circle cx="272" cy="175" r="3" fill="rgba(245,158,11,0.5)" />
        <line x1="272" y1="175" x2="248" y2="175"
          stroke="rgba(245,158,11,0.2)" strokeWidth="0.8" strokeDasharray="3 2" />

        <circle cx="40" cy="300" r="2" fill="rgba(236,72,153,0.4)" />
        <circle cx="260" cy="285" r="2.5" fill="rgba(99,102,241,0.4)" />
        <circle cx="150" cy="310" r="1.5" fill="rgba(34,211,238,0.35)" />

        {/* ── Bottom Stats ── */}
        <line x1="52" y1="283" x2="248" y2="283"
          stroke="rgba(99,102,241,0.15)" strokeWidth="0.6" />

        <text x="95" y="298" textAnchor="middle"
          fill="rgba(255,255,255,0.2)" fontSize="7" fontFamily="monospace" letterSpacing="1">
          PASS RATE
        </text>
        <text x="95" y="312" textAnchor="middle"
          fill="rgba(99,102,241,0.8)" fontSize="12" fontWeight="bold" fontFamily="monospace">
          87.3%
        </text>

        <line x1="150" y1="288" x2="150" y2="318"
          stroke="rgba(255,255,255,0.08)" strokeWidth="0.6" />

        <text x="205" y="298" textAnchor="middle"
          fill="rgba(255,255,255,0.2)" fontSize="7" fontFamily="monospace" letterSpacing="1">
          REVIEWED
        </text>
        <text x="205" y="312" textAnchor="middle"
          fill="rgba(34,211,238,0.8)" fontSize="12" fontWeight="bold" fontFamily="monospace">
          1,247
        </text>

        {/* ── Bottom Glow Fade ── */}
        <rect x="0" y="320" width="300" height="80"
          fill="url(#rac-gBtm)" opacity="0.6" />

        {/* ── Scan Line Overlay ── */}
        <rect width="300" height="400" fill="none"
          stroke="rgba(255,255,255,0)" strokeWidth="0">
          <animate attributeName="y" from="-400" to="400" dur="4s" repeatCount="indefinite" />
        </rect>
        {/* subtle horizontal shimmer line */}
        <rect x="0" y="0" width="300" height="1.5"
          fill="rgba(99,102,241,0.25)" opacity="0.4">
          <animateTransform attributeName="transform" type="translate"
            from="0 0" to="0 400" dur="5s" repeatCount="indefinite" />
        </rect>
      </svg>
    </div>
  );
}
