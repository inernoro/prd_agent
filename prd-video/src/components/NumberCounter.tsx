import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { counterValue, springIn } from "../utils/animations";
import { COLORS } from "../utils/colors";

/** 数字滚动动画 */
export const NumberCounter: React.FC<{
  target: number;
  suffix?: string;
  label?: string;
  color?: string;
  delay?: number;
  fontSize?: number;
}> = ({
  target,
  suffix = "",
  label,
  color = COLORS.neon.blue,
  delay = 0,
  fontSize = 64,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cardProgress = springIn(frame, fps, delay);
  const value = counterValue(frame, target, 60, delay + 5);

  return (
    <div
      style={{
        opacity: Math.min(cardProgress, 1),
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize,
          fontWeight: 800,
          color,
          textShadow: `0 0 20px ${color}40`,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
        {suffix}
      </div>
      {label && (
        <div
          style={{
            fontSize: 18,
            color: COLORS.text.secondary,
            marginTop: 8,
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
};
