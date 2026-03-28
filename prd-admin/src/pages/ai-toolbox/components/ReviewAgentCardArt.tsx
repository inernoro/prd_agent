/** 产品评审员 Agent 卡片内联插画 */
export function ReviewAgentCardArt() {
  const r = 50;
  const circ = 2 * Math.PI * r;
  const fill86 = circ * 0.86;

  return (
    <div className="absolute inset-0 z-0 overflow-hidden">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 300 400"
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          {/* Background radial glows — explicit pixel coords in userSpaceOnUse */}
          <radialGradient id="rac-gTop" cx="150" cy="10" r="220" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#6366F1" stopOpacity="0.65" />
            <stop offset="70%" stopColor="#6366F1" stopOpacity="0.15" />
            <stop offset="100%" stopColor="#6366F1" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="rac-gBtm" cx="30" cy="390" r="210" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.5" />
            <stop offset="70%" stopColor="#22D3EE" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="rac-gRight" cx="290" cy="180" r="160" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
          </radialGradient>

          {/* Score ring gradient — userSpaceOnUse diagonal across ring bounding box */}
          <linearGradient id="rac-ring" x1="100" y1="82" x2="200" y2="182" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#818CF8" />
            <stop offset="50%" stopColor="#22D3EE" />
            <stop offset="100%" stopColor="#10B981" />
          </linearGradient>

          {/* Bar gradients */}
          <linearGradient id="rac-b1" x1="72" y1="0" x2="192" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#6366F1" /><stop offset="100%" stopColor="#818CF8" />
          </linearGradient>
          <linearGradient id="rac-b2" x1="72" y1="0" x2="192" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#06B6D4" /><stop offset="100%" stopColor="#67E8F9" />
          </linearGradient>
          <linearGradient id="rac-b3" x1="72" y1="0" x2="192" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#10B981" /><stop offset="100%" stopColor="#6EE7B7" />
          </linearGradient>
          <linearGradient id="rac-b4" x1="72" y1="0" x2="192" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#F59E0B" /><stop offset="100%" stopColor="#FCD34D" />
          </linearGradient>
          <linearGradient id="rac-b5" x1="72" y1="0" x2="192" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#EC4899" /><stop offset="100%" stopColor="#F9A8D4" />
          </linearGradient>

          {/* Glow filter */}
          <filter id="rac-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <filter id="rac-blur2" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" />
          </filter>
          <filter id="rac-blur5" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" />
          </filter>

          {/* Dot grid */}
          <pattern id="rac-dot" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.9" fill="rgba(255,255,255,0.13)" />
          </pattern>
        </defs>

        {/* ── Base ── */}
        <rect width="300" height="400" fill="#060A14" />
        <rect width="300" height="400" fill="url(#rac-dot)" />
        <rect width="300" height="400" fill="url(#rac-gTop)" />
        <rect width="300" height="400" fill="url(#rac-gBtm)" />
        <rect width="300" height="400" fill="url(#rac-gRight)" />

        {/* ── Document Frame ── */}
        {/* glow blur behind */}
        <rect x="50" y="20" width="200" height="252" rx="16"
          fill="none" stroke="rgba(99,102,241,0.6)" strokeWidth="2"
          filter="url(#rac-blur5)" />
        {/* frame */}
        <rect x="52" y="22" width="196" height="248" rx="14"
          fill="rgba(6,9,22,0.85)" stroke="rgba(99,102,241,0.5)" strokeWidth="1.5" />
        {/* header bg */}
        <rect x="52" y="22" width="196" height="40" rx="14"
          fill="rgba(99,102,241,0.28)" />
        <rect x="52" y="48" width="196" height="14" fill="rgba(99,102,241,0.28)" />
        {/* header divider */}
        <line x1="66" y1="62" x2="234" y2="62"
          stroke="rgba(99,102,241,0.4)" strokeWidth="0.8" />
        {/* header label */}
        <text x="150" y="45" textAnchor="middle"
          fill="rgba(255,255,255,0.65)" fontSize="8" fontFamily="monospace" letterSpacing="2.5">
          AI REVIEW SCORE
        </text>
        {/* corner accent dots */}
        <circle cx="68" cy="37" r="2.5" fill="rgba(99,102,241,0.9)" filter="url(#rac-blur2)" />
        <circle cx="68" cy="37" r="2" fill="#818CF8" />
        <circle cx="232" cy="37" r="2.5" fill="rgba(34,211,238,0.9)" filter="url(#rac-blur2)" />
        <circle cx="232" cy="37" r="2" fill="#22D3EE" />

        {/* ── Score Ring — glow layer ── */}
        <circle cx="150" cy="130" r={r}
          fill="none" stroke="url(#rac-ring)" strokeWidth="13"
          strokeDasharray={`${fill86.toFixed(2)} ${circ.toFixed(2)}`}
          transform="rotate(-90 150 130)"
          filter="url(#rac-blur5)" opacity="0.7" />
        {/* track */}
        <circle cx="150" cy="130" r={r}
          fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="10" />
        {/* fill arc */}
        <circle cx="150" cy="130" r={r}
          fill="none" stroke="url(#rac-ring)" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${fill86.toFixed(2)} ${circ.toFixed(2)}`}
          transform="rotate(-90 150 130)" />
        {/* inner glass */}
        <circle cx="150" cy="130" r="34" fill="rgba(10,16,40,0.75)" />
        {/* score number */}
        <text x="150" y="125" textAnchor="middle"
          fill="white" fontSize="26" fontWeight="bold" fontFamily="monospace">86</text>
        <text x="150" y="140" textAnchor="middle"
          fill="rgba(255,255,255,0.35)" fontSize="9" fontFamily="monospace">/ 100 分</text>

        {/* pass badge */}
        <rect x="119" y="150" width="62" height="18" rx="9"
          fill="rgba(16,185,129,0.22)" stroke="rgba(16,185,129,0.55)" strokeWidth="0.8"
          filter="url(#rac-blur2)" />
        <rect x="119" y="150" width="62" height="18" rx="9"
          fill="rgba(16,185,129,0.18)" stroke="rgba(16,185,129,0.5)" strokeWidth="0.8" />
        <text x="150" y="162" textAnchor="middle"
          fill="#6EE7B7" fontSize="8.5" fontFamily="monospace">✓ 已通过</text>

        {/* ── Dimension Bars ── */}
        {([
          { label: '完整性', pct: 0.90, id: 'rac-b1', y: 185 },
          { label: '逻辑性', pct: 0.80, id: 'rac-b2', y: 199 },
          { label: '可行性', pct: 0.85, id: 'rac-b3', y: 213 },
          { label: '创新性', pct: 0.65, id: 'rac-b4', y: 227 },
          { label: '规范性', pct: 0.86, id: 'rac-b5', y: 241 },
        ] as const).map(({ label, pct, id, y }) => {
          const trackW = 120;
          const fillW = trackW * pct;
          return (
            <g key={label}>
              <text x="69" y={y + 6} textAnchor="end"
                fill="rgba(255,255,255,0.45)" fontSize="7" fontFamily="monospace">{label}</text>
              <rect x="72" y={y} width={trackW} height="6" rx="3"
                fill="rgba(255,255,255,0.07)" />
              {/* glow fill */}
              <rect x="72" y={y} width={fillW} height="6" rx="3"
                fill={`url(#${id})`} filter="url(#rac-blur2)" opacity="0.55" />
              {/* solid fill */}
              <rect x="72" y={y} width={fillW} height="6" rx="3"
                fill={`url(#${id})`} opacity="0.9" />
              <text x="197" y={y + 6} textAnchor="start"
                fill="rgba(255,255,255,0.35)" fontSize="7" fontFamily="monospace">
                {Math.round(pct * 100)}%
              </text>
            </g>
          );
        })}

        {/* ── Decorative Nodes ── */}
        <circle cx="32" cy="108" r="4" fill="rgba(99,102,241,0.4)" filter="url(#rac-blur2)" />
        <circle cx="32" cy="108" r="2.5" fill="rgba(99,102,241,0.8)" />
        <line x1="36" y1="108" x2="52" y2="108"
          stroke="rgba(99,102,241,0.3)" strokeWidth="0.8" strokeDasharray="3 2" />

        <circle cx="268" cy="93" r="3.5" fill="rgba(34,211,238,0.4)" filter="url(#rac-blur2)" />
        <circle cx="268" cy="93" r="2" fill="rgba(34,211,238,0.85)" />
        <line x1="248" y1="93" x2="264" y2="93"
          stroke="rgba(34,211,238,0.3)" strokeWidth="0.8" strokeDasharray="3 2" />

        <circle cx="28" cy="193" r="3" fill="rgba(16,185,129,0.4)" filter="url(#rac-blur2)" />
        <circle cx="28" cy="193" r="1.8" fill="rgba(16,185,129,0.8)" />
        <line x1="31" y1="193" x2="52" y2="193"
          stroke="rgba(16,185,129,0.25)" strokeWidth="0.8" strokeDasharray="3 2" />

        <circle cx="272" cy="173" r="3.5" fill="rgba(245,158,11,0.4)" filter="url(#rac-blur2)" />
        <circle cx="272" cy="173" r="2" fill="rgba(245,158,11,0.85)" />
        <line x1="248" y1="173" x2="268" y2="173"
          stroke="rgba(245,158,11,0.25)" strokeWidth="0.8" strokeDasharray="3 2" />

        <circle cx="42" cy="298" r="2.5" fill="rgba(236,72,153,0.5)" />
        <circle cx="258" cy="283" r="3" fill="rgba(99,102,241,0.5)" />
        <circle cx="150" cy="308" r="2" fill="rgba(34,211,238,0.4)" />

        {/* ── Bottom Stats ── */}
        <line x1="52" y1="280" x2="248" y2="280"
          stroke="rgba(99,102,241,0.2)" strokeWidth="0.7" />

        <text x="95" y="296" textAnchor="middle"
          fill="rgba(255,255,255,0.25)" fontSize="7" fontFamily="monospace" letterSpacing="1">PASS RATE</text>
        <text x="95" y="311" textAnchor="middle"
          fill="rgba(99,102,241,0.95)" fontSize="13" fontWeight="bold" fontFamily="monospace">87.3%</text>

        <line x1="150" y1="285" x2="150" y2="317"
          stroke="rgba(255,255,255,0.09)" strokeWidth="0.7" />

        <text x="205" y="296" textAnchor="middle"
          fill="rgba(255,255,255,0.25)" fontSize="7" fontFamily="monospace" letterSpacing="1">REVIEWED</text>
        <text x="205" y="311" textAnchor="middle"
          fill="rgba(34,211,238,0.95)" fontSize="13" fontWeight="bold" fontFamily="monospace">1,247</text>

        {/* ── Shimmer scan line ── */}
        <rect x="0" y="0" width="300" height="2" fill="rgba(99,102,241,0.35)" opacity="0.5">
          <animateTransform attributeName="transform" type="translate"
            from="0 -2" to="0 402" dur="5s" repeatCount="indefinite" />
        </rect>
      </svg>
    </div>
  );
}
