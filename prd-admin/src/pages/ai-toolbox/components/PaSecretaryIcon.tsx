import { useId } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * 毒舌秘书统一图标 — Gemini 风四色星芒（内联 SVG，无 CDN）
 */
export function PaSecretaryIcon({
  size = 24,
  color = 'currentColor',
  className,
  ...rest
}: LucideProps) {
  const px = typeof size === 'number' ? size : 24;
  const uid = useId().replace(/:/g, '');
  const gBlue = `pa-gem-blue-${uid}`;
  const gRed = `pa-gem-red-${uid}`;
  const gYellow = `pa-gem-yellow-${uid}`;
  const gGreen = `pa-gem-green-${uid}`;
  const gCore = `pa-gem-core-${uid}`;

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
          <stop offset="100%" stopColor="#c5221f" />
        </linearGradient>
        <linearGradient id={gYellow} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#fbbc04" />
          <stop offset="100%" stopColor="#f9ab00" />
        </linearGradient>
        <linearGradient id={gGreen} x1="1" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#34a853" />
          <stop offset="100%" stopColor="#188038" />
        </linearGradient>
        <radialGradient id={gCore} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="100%" stopColor={color} stopOpacity="0.15" />
        </radialGradient>
      </defs>
      {/* 四色星芒 */}
      <path
        d="M12 2.5 L13.8 10.2 L21.5 12 L13.8 13.8 L12 21.5 L10.2 13.8 L2.5 12 L10.2 10.2 Z"
        fill={`url(#${gBlue})`}
        opacity="0.92"
      />
      <path d="M12 3.2 L12.8 9.2 L18.8 12 L12.8 14.8 L12 20.8 L11.2 14.8 L5.2 12 L11.2 9.2 Z" fill={`url(#${gCore})`} />
      <path d="M12 2.8 L13.2 8.8 L19.2 10 L13.2 11.2 L12 17.2 L10.8 11.2 L4.8 10 L10.8 8.8 Z" fill={`url(#${gRed})`} opacity="0.55" />
      <path d="M12 4 L14.2 9.5 L19.8 11.2 L14.2 12.9 L12 18.4 L9.8 12.9 L4.2 11.2 L9.8 9.5 Z" fill={`url(#${gYellow})`} opacity="0.5" />
      <path d="M12 5.2 L13.5 10 L18.2 11.5 L13.5 13 L12 17.8 L10.5 13 L5.8 11.5 L10.5 10 Z" fill={`url(#${gGreen})`} opacity="0.48" />
      <circle cx="12" cy="12" r="2.2" fill="#ffffff" opacity="0.9" />
    </svg>
  );
}
