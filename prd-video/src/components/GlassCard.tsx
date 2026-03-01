import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { springIn } from "../utils/animations";
import { COLORS } from "../utils/colors";

/** 毛玻璃质感卡片 */
export const GlassCard: React.FC<{
  children: React.ReactNode;
  accentColor?: string;
  delay?: number;
  width?: string | number;
  padding?: number;
}> = ({
  children,
  accentColor = COLORS.neon.blue,
  delay = 0,
  width = "auto",
  padding = 40,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = springIn(frame, fps, delay, { damping: 14 });
  const opacity = Math.min(progress, 1);
  const scale = 0.95 + 0.05 * progress;

  return (
    <div
      style={{
        opacity,
        transform: `scale(${scale})`,
        width,
        padding,
        borderRadius: 16,
        background: COLORS.glass.bg,
        border: `1px solid ${COLORS.glass.border}`,
        boxShadow: `
          0 0 1px ${accentColor}30,
          inset 0 1px 0 ${COLORS.glass.highlight}
        `,
        backdropFilter: "blur(20px)",
      }}
    >
      {children}
    </div>
  );
};
