import { useId } from 'react';

/**
 * 毒舌秘书空状态大图 — AI 科技风全息人像（80px 视口，供对话首页 hero）
 */
export function PaSecretaryHeroArt({ size = 72 }: { size?: number }) {
  const uid = useId().replace(/:/g, '');
  const ringId = `pa-hero-ring-${uid}`;
  const glowId = `pa-hero-glow-${uid}`;
  const suitId = `pa-hero-suit-${uid}`;
  const hairId = `pa-hero-hair-${uid}`;
  const hudId = `pa-hero-hud-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 80 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <radialGradient id={glowId} cx="50%" cy="42%" r="55%">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#0f172a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={ringId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="50%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
        <linearGradient id={suitId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#1e40af" />
        </linearGradient>
        <linearGradient id={hairId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1e3a5f" />
          <stop offset="100%" stopColor="#020617" />
        </linearGradient>
        <linearGradient id={hudId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity="0.2" />
          <stop offset="50%" stopColor="#67e8f9" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.2" />
        </linearGradient>
      </defs>

      <circle cx="40" cy="40" r="36" fill={`url(#${glowId})`} />
      <circle
        cx="40"
        cy="40"
        r="34"
        stroke={`url(#${ringId})`}
        strokeWidth="1.2"
        fill="none"
        opacity="0.9"
      />

      {/* HUD 弧 */}
      <path
        d="M12 48 A28 28 0 0 1 68 48"
        stroke={`url(#${hudId})`}
        strokeWidth="1"
        fill="none"
        strokeDasharray="3 4"
      />

      {/* 长发 */}
      <path
        d="M26 34 C24 18,56 16,54 34 C52 46,48 54,40 56 C32 54,28 46,26 34Z"
        fill={`url(#${hairId})`}
      />
      {/* 脸 */}
      <ellipse cx="40" cy="36" rx="11" ry="13" fill="#f5d0bc" />
      <path d="M29 33 C31 22,49 21,51 33 C46 26,34 27,29 33Z" fill="#0f172a" />
      <ellipse cx="35" cy="36" rx="1.4" ry="1.6" fill="#0f172a" />
      <ellipse cx="45" cy="36" rx="1.4" ry="1.6" fill="#0f172a" />
      <circle cx="35.5" cy="35.2" r="0.45" fill="#fff" opacity="0.75" />
      <path d="M36 41 Q40 43 44 41" stroke="rgba(160,90,80,0.45)" strokeWidth="0.7" fill="none" />

      {/* 颈 + 西装 */}
      <path d="M33 48 L47 48 L50 62 L30 62 Z" fill={`url(#${suitId})`} />
      <path d="M30 62 L50 62 L52 70 L28 70 Z" fill="rgba(15,23,42,0.9)" />

      {/* 耳麦 */}
      <path
        d="M51 34 C58 31,62 38,60 46"
        stroke="#22d3ee"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="60" cy="46" r="2.5" fill="#67e8f9" />
      <circle cx="60" cy="46" r="5" fill="#22d3ee" opacity="0.2" />

      {/* 胸前 AI 核 */}
      <circle cx="40" cy="56" r="5" fill="none" stroke="rgba(103,232,249,0.6)" strokeWidth="0.8" />
      <circle cx="40" cy="56" r="2" fill="#38bdf8" />
    </svg>
  );
}
