import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { springIn, shimmerScan, glowPulse } from "../utils/animations";
import { COLORS } from "../utils/colors";

/** 毛玻璃质感卡片 — 光泽扫描 + 渐变边框 + 动态阴影 */
export const GlassCard: React.FC<{
  children: React.ReactNode;
  accentColor?: string;
  delay?: number;
  width?: string | number;
  padding?: number;
  /** 是否启用光泽扫描效果 */
  shimmer?: boolean;
  /** 边框渐变 */
  gradientBorder?: boolean;
}> = ({
  children,
  accentColor = COLORS.neon.blue,
  delay = 0,
  width = "auto",
  padding = 40,
  shimmer = true,
  gradientBorder = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = springIn(frame, fps, delay, { damping: 14 });
  const opacity = Math.min(progress, 1);
  const scale = 0.95 + 0.05 * progress;

  // 光泽扫描位置
  const shimmerX = shimmerScan(frame, 120, delay + 30);

  // 发光脉冲强度
  const glow = glowPulse(frame, 90, 0.2, 0.5);

  // 动态边框
  const borderStyle = gradientBorder
    ? `1px solid transparent`
    : `1px solid ${COLORS.glass.border}`;

  // 渐变边框使用 background-image 叠加实现
  const gradientBorderBg = gradientBorder
    ? `linear-gradient(${COLORS.glass.bg}, ${COLORS.glass.bg}) padding-box,
       linear-gradient(135deg, ${accentColor}40, ${COLORS.glass.border}, ${accentColor}20) border-box`
    : undefined;

  return (
    <div
      style={{
        opacity,
        transform: `scale(${scale})`,
        width,
        padding,
        borderRadius: 16,
        background: gradientBorderBg || COLORS.glass.bg,
        border: borderStyle,
        boxShadow: `
          0 0 ${glow * 20}px ${accentColor}${Math.round(glow * 15).toString(16).padStart(2, "0")},
          0 8px 32px rgba(0, 0, 0, 0.3),
          inset 0 1px 0 ${COLORS.glass.highlight}
        `,
        backdropFilter: "blur(20px)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* 光泽扫描 */}
      {shimmer && opacity > 0.5 && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background: `linear-gradient(
              105deg,
              transparent ${shimmerX - 15}%,
              ${accentColor}08 ${shimmerX - 5}%,
              ${accentColor}12 ${shimmerX}%,
              ${accentColor}08 ${shimmerX + 5}%,
              transparent ${shimmerX + 15}%
            )`,
          }}
        />
      )}

      {/* 顶部高光线 */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: "10%",
          right: "10%",
          height: 1,
          background: `linear-gradient(90deg, transparent, ${COLORS.glass.highlight}, transparent)`,
          opacity: opacity * 0.6,
        }}
      />

      {children}
    </div>
  );
};
