import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { COLORS } from "../utils/colors";

/** 动态粒子 + 网格 + 光晕 + 呼吸光带背景 */
export const Background: React.FC<{
  accentColor?: string;
  showGrid?: boolean;
  variant?: "default" | "radial" | "diagonal" | "split";
}> = ({ accentColor = COLORS.neon.blue, showGrid = true, variant = "default" }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // 缓慢移动的渐变
  const gradientAngle = interpolate(frame, [0, 300], [0, 360], {
    extrapolateRight: "extend",
  });

  // 扫描线 Y 位置
  const scanLineY = interpolate(frame % 180, [0, 180], [0, height]);

  // 呼吸效果
  const breathe = interpolate(frame % 120, [0, 60, 120], [0.8, 1.2, 0.8], {
    extrapolateRight: "clamp",
  });

  // 第二条扫描线（反向、更慢）
  const scanLine2Y = interpolate(frame % 300, [0, 300], [height, 0]);

  // 变体背景
  const bgGradient = variant === "diagonal"
    ? `linear-gradient(${135 + gradientAngle * 0.1}deg, ${COLORS.bg.primary} 0%, ${COLORS.bg.secondary} 40%, ${accentColor}08 100%)`
    : variant === "radial"
      ? `radial-gradient(ellipse at 30% 30%, ${accentColor}12 0%, ${COLORS.bg.secondary} 50%, ${COLORS.bg.primary} 100%)`
      : variant === "split"
        ? `linear-gradient(180deg, ${COLORS.bg.secondary} 0%, ${COLORS.bg.primary} 50%, ${accentColor}05 100%)`
        : `radial-gradient(ellipse at 50% 50%, ${COLORS.bg.secondary} 0%, ${COLORS.bg.primary} 70%)`;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        width,
        height,
        background: `
          ${bgGradient},
          linear-gradient(${gradientAngle}deg, ${accentColor}08 0%, transparent 50%)
        `,
        overflow: "hidden",
      }}
    >
      {/* 网格 */}
      {showGrid && (
        <svg
          style={{ position: "absolute", inset: 0, opacity: 0.06 }}
          width={width}
          height={height}
        >
          <defs>
            <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
              <path d="M 60 0 L 0 0 0 60" fill="none" stroke={accentColor} strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      )}

      {/* 主扫描线 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: scanLineY,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accentColor}30, transparent)`,
        }}
      />

      {/* 第二扫描线（反向、更宽更柔和） */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: scanLine2Y,
          height: 60,
          background: `linear-gradient(180deg, transparent, ${accentColor}06, transparent)`,
        }}
      />

      {/* 角落光晕 - 右上（呼吸） */}
      <div
        style={{
          position: "absolute",
          top: -200,
          right: -200,
          width: 600 * breathe,
          height: 600 * breathe,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${accentColor}12 0%, transparent 70%)`,
        }}
      />

      {/* 角落光晕 - 左下 */}
      <div
        style={{
          position: "absolute",
          bottom: -200,
          left: -200,
          width: 500 * breathe,
          height: 500 * breathe,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${accentColor}0a 0%, transparent 70%)`,
        }}
      />

      {/* 中央微弱光斑 */}
      <div
        style={{
          position: "absolute",
          top: "40%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 800,
          height: 400,
          borderRadius: "50%",
          background: `radial-gradient(ellipse, ${accentColor}06 0%, transparent 70%)`,
          opacity: breathe,
        }}
      />

      {/* 底部渐变光带 */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 120,
          background: `linear-gradient(0deg, ${accentColor}08 0%, transparent 100%)`,
        }}
      />
    </div>
  );
};
