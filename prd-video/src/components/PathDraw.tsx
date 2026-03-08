import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { evolvePath } from "@remotion/paths";
import { COLORS } from "../utils/colors";

/** SVG 路径描边动画组件 */
export const PathDraw: React.FC<{
  /** SVG path d 属性 */
  d: string;
  color?: string;
  strokeWidth?: number;
  width?: number;
  height?: number;
  delay?: number;
  durationFrames?: number;
  /** 是否显示发光效果 */
  glow?: boolean;
  /** 渐变终止色（可选） */
  gradientEndColor?: string;
}> = ({
  d,
  color = COLORS.neon.blue,
  strokeWidth = 2,
  width = 800,
  height = 400,
  delay = 0,
  durationFrames = 60,
  glow = true,
  gradientEndColor,
}) => {
  const frame = useCurrentFrame();

  const progress = interpolate(
    frame,
    [delay, delay + durationFrames],
    [0, 1],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    }
  );

  const { strokeDasharray, strokeDashoffset } = evolvePath(progress, d);

  const gradientId = `path-grad-${delay}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ overflow: "visible" }}
    >
      {gradientEndColor && (
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={color} />
            <stop offset="100%" stopColor={gradientEndColor} />
          </linearGradient>
        </defs>
      )}

      {/* 发光底层 */}
      {glow && (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth * 4}
          strokeDasharray={strokeDasharray}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          opacity={0.15}
          filter="blur(8px)"
        />
      )}

      {/* 主路径 */}
      <path
        d={d}
        fill="none"
        stroke={gradientEndColor ? `url(#${gradientId})` : color}
        strokeWidth={strokeWidth}
        strokeDasharray={strokeDasharray}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
      />
    </svg>
  );
};

/** 连接两个点的曲线路径描边（用于流程图/步骤连线） */
export const ConnectionLine: React.FC<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color?: string;
  delay?: number;
  durationFrames?: number;
  /** 曲线弯曲程度 */
  curvature?: number;
  glow?: boolean;
}> = ({
  x1,
  y1,
  x2,
  y2,
  color = COLORS.neon.green,
  delay = 0,
  durationFrames = 40,
  curvature = 0.3,
  glow = true,
}) => {
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  // 控制点偏移（垂直于连线方向）
  const cx = midX - dy * curvature;
  const cy = midY + dx * curvature;

  const d = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
  const w = Math.abs(dx) + 100;
  const h = Math.abs(dy) + 100;

  return (
    <PathDraw
      d={d}
      color={color}
      width={w}
      height={h}
      delay={delay}
      durationFrames={durationFrames}
      glow={glow}
    />
  );
};
