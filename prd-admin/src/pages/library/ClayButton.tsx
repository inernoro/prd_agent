/**
 * ClayButton — 智识殿堂统一按钮
 *
 * 风格：claymorphism 厚黑边 + 硬投影 + 按下陷入感
 * 尺寸：sm | md | lg
 * 变体：primary(绿) | secondary(淡蓝) | white(纯白) | ghost(透明)
 */
import type { ReactNode } from 'react';

export type ClayBtnSize = 'sm' | 'md' | 'lg';
export type ClayBtnVariant = 'primary' | 'secondary' | 'white' | 'ghost';

const CLAY_SIZE_MAP: Record<
  ClayBtnSize,
  { pad: string; text: number; shadow: number; gap: number }
> = {
  sm: { pad: '10px 18px', text: 13, shadow: 3, gap: 6 },
  md: { pad: '12px 24px', text: 14, shadow: 4, gap: 8 },
  lg: { pad: '16px 28px', text: 15, shadow: 5, gap: 8 },
};

export function ClayButton({
  children,
  size = 'md',
  variant = 'primary',
  active,
  onClick,
  disabled,
}: {
  children: ReactNode;
  size?: ClayBtnSize;
  variant?: ClayBtnVariant;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const s = CLAY_SIZE_MAP[size];
  const bg =
    variant === 'primary'
      ? '#16A34A'
      : variant === 'secondary'
      ? '#BFDBFE'
      : variant === 'white'
      ? '#FFFFFF'
      : 'transparent';
  const color = variant === 'primary' ? '#FFFFFF' : '#1E1B4B';
  const border = variant === 'ghost' ? 'none' : '3px solid #1E1B4B';
  const shadow = variant === 'ghost' ? 'none' : `0 ${s.shadow}px 0 #1E1B4B`;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-2xl flex items-center justify-center transition-all hover:-translate-y-0.5 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
      style={{
        padding: s.pad,
        fontSize: s.text,
        fontWeight: 900,
        gap: s.gap,
        background: active ? '#16A34A' : bg,
        border,
        boxShadow: shadow,
        color: active ? '#FFFFFF' : color,
        fontFamily: "'Nunito', sans-serif",
        lineHeight: 1,
      }}
    >
      {children}
    </button>
  );
}
