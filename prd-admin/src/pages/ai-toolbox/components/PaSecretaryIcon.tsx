import { useId } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * 毒舌秘书统一图标 — Gemini 风四色星芒（内联 SVG，无 CDN）
 */
export function PaSecretaryIcon({
  size = 24,
  className,
  ...rest
}: LucideProps) {
  const px = typeof size === 'number' ? size : 24;
  const uid = useId().replace(/:/g, '');
  const gBlue = `pa-gem-blue-${uid}`;
  const gRed = `pa-gem-red-${uid}`;
  const gYellow = `pa-gem-yellow-${uid}`;
  const gGreen = `pa-gem-green-${uid}`;

  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
      {...rest}
    >
      <defs>
        <linearGradient id={gBlue} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4285f4" />
          <stop offset="100%" stopColor="#1a73e8" />
        </linearGradient>
        <linearGradient id={gRed} x1="1" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ea4335" />
          <stop offset="100%" stopColor="#d93025" />
        </linearGradient>
        <linearGradient id={gYellow} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#fbbc04" />
          <stop offset="100%" stopColor="#f9ab00" />
        </linearGradient>
        <linearGradient id={gGreen} x1="1" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#34a853" />
          <stop offset="100%" stopColor="#188038" />
        </linearGradient>
      </defs>
      {/* 四瓣星芒 — 参考 Gemini 图标几何 */}
      <path d="M12 3 L13.4 10.6 L21 12 L13.4 13.4 L12 21 L10.6 13.4 L3 12 L10.6 10.6 Z" fill={`url(#${gBlue})`} />
      <path d="M12 4.2 L12.9 10.2 L18.9 12 L12.9 13.8 L12 19.8 L10.1 13.8 L4.1 12 L10.1 10.2 Z" fill="#ffffff" opacity="0.88" />
      <path d="M12 3.6 L13 9.8 L19 11.2 L13 12.6 L12 18.8 L11 12.6 L5 11.2 L11 9.8 Z" fill={`url(#${gRed})`} opacity="0.72" />
      <path d="M12 5 L13.6 10 L18.4 11.4 L13.6 12.8 L12 17.8 L10.4 12.8 L5.6 11.4 L10.4 10 Z" fill={`url(#${gYellow})`} opacity="0.68" />
      <path d="M12 6.2 L13.2 9.8 L17.2 10.8 L13.2 11.8 L12 15.4 L10.8 11.8 L6.8 10.8 L10.8 9.8 Z" fill={`url(#${gGreen})`} opacity="0.65" />
      <circle cx="12" cy="12" r="2" fill="#ffffff" />
    </svg>
  );
}
