import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { springIn } from "../utils/animations";
import { COLORS } from "../utils/colors";

/** 步骤流程图 */
export const StepFlow: React.FC<{
  steps: string[];
  accentColor?: string;
  delay?: number;
}> = ({ steps, accentColor = COLORS.neon.green, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {steps.map((step, i) => {
        const stepDelay = delay + i * 12;
        const progress = springIn(frame, fps, stepDelay, { damping: 12 });
        const opacity = Math.min(progress, 1);
        const translateX = (1 - progress) * 40;

        return (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              opacity,
              transform: `translateX(${translateX}px)`,
            }}
          >
            {/* 步骤编号圆圈 */}
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                background: `${accentColor}20`,
                border: `2px solid ${accentColor}60`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 18,
                fontWeight: 700,
                color: accentColor,
                flexShrink: 0,
              }}
            >
              {i + 1}
            </div>

            {/* 连接线 */}
            {i < steps.length - 1 && (
              <div
                style={{
                  position: "absolute",
                  left: 19,
                  top: 40,
                  width: 2,
                  height: 16,
                  background: `${accentColor}30`,
                }}
              />
            )}

            {/* 步骤文本 */}
            <div
              style={{
                fontSize: 22,
                color: COLORS.text.primary,
                lineHeight: 1.4,
              }}
            >
              {step}
            </div>
          </div>
        );
      })}
    </div>
  );
};
