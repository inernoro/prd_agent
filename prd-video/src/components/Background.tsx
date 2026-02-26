import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { COLORS } from "../utils/colors";

/** 动态粒子 + 网格背景 */
export const Background: React.FC<{
  accentColor?: string;
  showGrid?: boolean;
}> = ({ accentColor = COLORS.neon.blue, showGrid = true }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // 缓慢移动的渐变
  const gradientAngle = interpolate(frame, [0, 300], [0, 360], {
    extrapolateRight: "extend",
  });

  // 扫描线 Y 位置
  const scanLineY = interpolate(frame % 180, [0, 180], [0, height]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        width,
        height,
        background: `
          radial-gradient(ellipse at 50% 50%, ${COLORS.bg.secondary} 0%, ${COLORS.bg.primary} 70%),
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

      {/* 扫描线 */}
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

      {/* 角落光晕 */}
      <div
        style={{
          position: "absolute",
          top: -200,
          right: -200,
          width: 600,
          height: 600,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${accentColor}10 0%, transparent 70%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: -200,
          left: -200,
          width: 500,
          height: 500,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${accentColor}08 0%, transparent 70%)`,
        }}
      />
    </div>
  );
};
