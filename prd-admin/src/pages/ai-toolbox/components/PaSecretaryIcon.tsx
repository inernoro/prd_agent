import { useId } from 'react';
import type { LucideProps } from 'lucide-react';

/**
 * 毒舌秘书统一图标 — 科幻深蓝 + 拟人化女秘书 bust（内联 SVG，无 CDN）
 * 用于百宝箱 / 首页网格 / 侧栏 / 对话空状态等小尺寸场景
 */
export function PaSecretaryIcon({
  size = 24,
  color = 'currentColor',
  className,
  ...rest
}: LucideProps) {
  const px = typeof size === 'number' ? size : 24;
  const uid = useId().replace(/:/g, '');
  const hairId = `pa-sec-hair-${uid}`;
  const suitId = `pa-sec-suit-${uid}`;
  const glowId = `pa-sec-glow-${uid}`;
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
        <linearGradient id={hairId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1e3a5f" />
          <stop offset="100%" stopColor="#0f172a" />
        </linearGradient>
        <linearGradient id={suitId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b82f6" />
          <stop offset="100%" stopColor="#1e3a8a" />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#67e8f9" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* 肩线 + 西装 */}
      <path
        d="M4 20 C6 14,8 12,12 12 C16 12,18 14,20 20"
        stroke={`url(#${suitId})`}
        strokeWidth="1.6"
        fill="rgba(30,64,175,0.35)"
      />
      <path d="M7 20 L17 20" stroke={color} strokeOpacity="0.25" strokeWidth="0.8" />
      {/* 长发轮廓 */}
      <path
        d="M8.5 11 C8 6,11 4,12 4 C13 4,16 6,15.5 11 C15 14,14 16,12 16.5 C10 16.5,9 14,8.5 11Z"
        fill={`url(#${hairId})`}
      />
      {/* 脸部 */}
      <ellipse cx="12" cy="10.2" rx="3.1" ry="3.6" fill="#f5d0bc" />
      <path
        d="M9.2 9.8 C9.5 7.5,14.5 7.4,14.8 9.8 C14 8.2,10 8.2,9.2 9.8Z"
        fill="#0f172a"
      />
      {/* 科幻耳麦 + 光点 */}
      <path
        d="M15.2 9.5 C17.5 9,18.5 10.5,18.2 12.2"
        stroke="#22d3ee"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="18.4" cy="12.4" r="1.1" fill="#67e8f9" />
      <circle cx="18.4" cy="12.4" r="2.2" fill={`url(#${glowId})`} />
      {/* 眼睛 */}
      <circle cx="10.8" cy="10.4" r="0.55" fill="#0f172a" />
      <circle cx="13.2" cy="10.4" r="0.55" fill="#0f172a" />
      <circle cx="11" cy="10.1" r="0.2" fill="#fff" opacity="0.7" />
    </svg>
  );
}
