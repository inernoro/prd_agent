/** PR审查棱镜 Agent 卡片内联插画 */
export function PrReviewPrismCardArt() {
  return (
    <div className="absolute inset-0 z-0 overflow-hidden">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 300 400"
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <radialGradient id="prp-gTop" cx="160" cy="20" r="220" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.6" />
            <stop offset="70%" stopColor="#8B5CF6" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="prp-gBottom" cx="30" cy="380" r="210" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.46" />
            <stop offset="65%" stopColor="#22D3EE" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#22D3EE" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="prp-line" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#A78BFA" />
            <stop offset="100%" stopColor="#67E8F9" />
          </linearGradient>
        </defs>

        <rect width="300" height="400" fill="#060915" />
        <rect width="300" height="400" fill="url(#prp-gTop)" />
        <rect width="300" height="400" fill="url(#prp-gBottom)" />

        <rect x="36" y="36" width="228" height="196" rx="14" fill="rgba(9,14,34,0.74)" stroke="rgba(167,139,250,0.35)" />
        <rect x="36" y="36" width="228" height="34" rx="14" fill="rgba(139,92,246,0.18)" />
        <text x="52" y="58" fill="rgba(255,255,255,0.62)" fontSize="10" fontFamily="monospace">PR REVIEW PRISM</text>

        <rect x="52" y="88" width="192" height="10" rx="5" fill="rgba(255,255,255,0.08)" />
        <rect x="52" y="88" width="138" height="10" rx="5" fill="url(#prp-line)" opacity="0.85" />
        <text x="248" y="96" textAnchor="end" fill="rgba(255,255,255,0.56)" fontSize="8" fontFamily="monospace">L1: PASS</text>

        <rect x="52" y="110" width="192" height="10" rx="5" fill="rgba(255,255,255,0.08)" />
        <rect x="52" y="110" width="118" height="10" rx="5" fill="#60A5FA" opacity="0.78" />
        <text x="248" y="118" textAnchor="end" fill="rgba(255,255,255,0.56)" fontSize="8" fontFamily="monospace">RISK: 3.5</text>

        <rect x="52" y="132" width="192" height="10" rx="5" fill="rgba(255,255,255,0.08)" />
        <rect x="52" y="132" width="164" height="10" rx="5" fill="#34D399" opacity="0.82" />
        <text x="248" y="140" textAnchor="end" fill="rgba(255,255,255,0.56)" fontSize="8" fontFamily="monospace">CONF: 82%</text>

        <rect x="36" y="250" width="228" height="104" rx="14" fill="rgba(9,14,34,0.72)" stroke="rgba(103,232,249,0.25)" />
        <text x="52" y="272" fill="rgba(255,255,255,0.56)" fontSize="9" fontFamily="monospace">DECISION CARD</text>
        <circle cx="58" cy="290" r="3.5" fill="#F87171" />
        <text x="70" y="294" fill="rgba(255,255,255,0.64)" fontSize="9">阻断项 ×2</text>
        <circle cx="58" cy="312" r="3.5" fill="#FBBF24" />
        <text x="70" y="316" fill="rgba(255,255,255,0.64)" fontSize="9">建议项 ×4</text>
        <circle cx="58" cy="334" r="3.5" fill="#60A5FA" />
        <text x="70" y="338" fill="rgba(255,255,255,0.64)" fontSize="9">关注问题 ×3</text>

        <line x1="20" y1="20" x2="280" y2="380" stroke="rgba(167,139,250,0.1)" strokeWidth="1" />
        <line x1="280" y1="30" x2="18" y2="360" stroke="rgba(103,232,249,0.08)" strokeWidth="1" />
      </svg>
    </div>
  );
}
