import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { COLORS } from "../utils/colors";

interface ShapeConfig {
  type: "circle" | "hexagon" | "diamond" | "ring" | "dot";
  x: number; // % of width
  y: number; // % of height
  size: number;
  speed: number; // movement speed multiplier
  rotationSpeed: number;
  opacity: number;
  color: string;
  delay: number; // fade-in delay in frames
}

/** 生成确定性的浮动形状配置 */
function generateShapes(seed: number, accentColor: string): ShapeConfig[] {
  const shapes: ShapeConfig[] = [];
  const types: ShapeConfig["type"][] = ["circle", "hexagon", "diamond", "ring", "dot"];
  const colors = [accentColor, COLORS.neon.purple, COLORS.neon.blue, COLORS.neon.cyan];

  // 使用简单的伪随机，基于 seed 确保每次渲染一致
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };

  const count = 12 + Math.floor(rand() * 6);
  for (let i = 0; i < count; i++) {
    shapes.push({
      type: types[Math.floor(rand() * types.length)],
      x: rand() * 100,
      y: rand() * 100,
      size: 8 + rand() * 40,
      speed: 0.3 + rand() * 0.7,
      rotationSpeed: (rand() - 0.5) * 2,
      opacity: 0.04 + rand() * 0.12,
      color: colors[Math.floor(rand() * colors.length)],
      delay: Math.floor(rand() * 30),
    });
  }
  return shapes;
}

/** SVG 形状渲染 */
const ShapeSvg: React.FC<{ type: ShapeConfig["type"]; size: number; color: string }> = ({
  type,
  size,
  color,
}) => {
  const half = size / 2;
  switch (type) {
    case "circle":
      return (
        <svg width={size} height={size}>
          <circle cx={half} cy={half} r={half * 0.8} fill="none" stroke={color} strokeWidth={1.5} />
        </svg>
      );
    case "hexagon": {
      const r = half * 0.85;
      const points = Array.from({ length: 6 }, (_, i) => {
        const angle = (Math.PI / 3) * i - Math.PI / 2;
        return `${half + r * Math.cos(angle)},${half + r * Math.sin(angle)}`;
      }).join(" ");
      return (
        <svg width={size} height={size}>
          <polygon points={points} fill="none" stroke={color} strokeWidth={1.5} />
        </svg>
      );
    }
    case "diamond":
      return (
        <svg width={size} height={size}>
          <polygon
            points={`${half},${half * 0.15} ${size * 0.85},${half} ${half},${size * 0.85} ${size * 0.15},${half}`}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
          />
        </svg>
      );
    case "ring":
      return (
        <svg width={size} height={size}>
          <circle cx={half} cy={half} r={half * 0.6} fill="none" stroke={color} strokeWidth={1} />
          <circle cx={half} cy={half} r={half * 0.35} fill="none" stroke={color} strokeWidth={0.8} opacity={0.5} />
        </svg>
      );
    case "dot":
      return (
        <svg width={size} height={size}>
          <circle cx={half} cy={half} r={half * 0.3} fill={color} />
        </svg>
      );
  }
};

/** 浮动装饰形状层 —— 为场景增加视觉丰富度 */
export const FloatingShapes: React.FC<{
  accentColor?: string;
  seed?: number;
  intensity?: "low" | "medium" | "high";
}> = ({ accentColor = COLORS.neon.blue, seed = 42, intensity = "medium" }) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();

  const shapes = React.useMemo(() => generateShapes(seed, accentColor), [seed, accentColor]);
  const visibleCount = intensity === "low" ? 8 : intensity === "high" ? shapes.length : 12;

  return (
    <div style={{ position: "absolute", inset: 0, width, height, overflow: "hidden", pointerEvents: "none" }}>
      {shapes.slice(0, visibleCount).map((shape, i) => {
        // 缓慢浮动
        const floatY = Math.sin((frame * shape.speed * 0.02) + i) * 20;
        const floatX = Math.cos((frame * shape.speed * 0.015) + i * 0.7) * 15;
        const rotation = frame * shape.rotationSpeed * 0.5;

        // 淡入
        const fadeIn = interpolate(frame, [shape.delay, shape.delay + 20], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        // 淡出
        const fadeOut = interpolate(frame, [durationInFrames - 20, durationInFrames], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${shape.x}%`,
              top: `${shape.y}%`,
              transform: `translate(${floatX}px, ${floatY}px) rotate(${rotation}deg)`,
              opacity: shape.opacity * fadeIn * fadeOut,
            }}
          >
            <ShapeSvg type={shape.type} size={shape.size} color={shape.color} />
          </div>
        );
      })}
    </div>
  );
};
