import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { springIn } from "../utils/animations";
import { COLORS } from "../utils/colors";

/** 霓虹发光标题 */
export const NeonTitle: React.FC<{
  text: string;
  color?: string;
  fontSize?: number;
  delay?: number;
}> = ({ text, color = COLORS.neon.blue, fontSize = 72, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = springIn(frame, fps, delay, { damping: 10, stiffness: 80 });
  const opacity = Math.min(progress, 1);
  const scale = 0.8 + 0.2 * progress;
  const translateY = (1 - progress) * 30;

  return (
    <div
      style={{
        opacity,
        transform: `scale(${scale}) translateY(${translateY}px)`,
        fontSize,
        fontWeight: 800,
        color: COLORS.text.primary,
        textShadow: `
          0 0 10px ${color}80,
          0 0 30px ${color}40,
          0 0 60px ${color}20
        `,
        letterSpacing: "-0.02em",
        lineHeight: 1.2,
      }}
    >
      {text}
    </div>
  );
};
