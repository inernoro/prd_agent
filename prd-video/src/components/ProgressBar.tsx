import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { springIn } from "../utils/animations";
import { COLORS } from "../utils/colors";

/** 动态进度条 */
export const ProgressBar: React.FC<{
  progress: number;
  label?: string;
  color?: string;
  delay?: number;
}> = ({ progress, label, color = COLORS.neon.green, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cardProgress = springIn(frame, fps, delay);
  const barWidth = interpolate(
    frame,
    [delay + 10, delay + 60],
    [0, progress],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <div style={{ opacity: Math.min(cardProgress, 1), width: "100%" }}>
      {label && (
        <div
          style={{
            fontSize: 16,
            color: COLORS.text.secondary,
            marginBottom: 8,
          }}
        >
          {label}
        </div>
      )}
      <div
        style={{
          width: "100%",
          height: 8,
          borderRadius: 4,
          background: COLORS.glass.bg,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${barWidth}%`,
            height: "100%",
            borderRadius: 4,
            background: `linear-gradient(90deg, ${color}, ${color}cc)`,
            boxShadow: `0 0 10px ${color}40`,
            transition: "width 0.3s",
          }}
        />
      </div>
    </div>
  );
};
