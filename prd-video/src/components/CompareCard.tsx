import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { springIn } from "../utils/animations";
import { COLORS } from "../utils/colors";

/** 对比卡片（Before/After 或 左右对比） */
export const CompareCard: React.FC<{
  leftTitle: string;
  leftContent: string;
  rightTitle: string;
  rightContent: string;
  leftColor?: string;
  rightColor?: string;
  delay?: number;
}> = ({
  leftTitle,
  leftContent,
  rightTitle,
  rightContent,
  leftColor = COLORS.neon.orange,
  rightColor = COLORS.neon.green,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const leftProgress = springIn(frame, fps, delay);
  const rightProgress = springIn(frame, fps, delay + 15);

  return (
    <div style={{ display: "flex", gap: 24, width: "100%" }}>
      {/* 左侧 */}
      <div
        style={{
          flex: 1,
          opacity: Math.min(leftProgress, 1),
          transform: `translateX(${(1 - leftProgress) * -30}px)`,
          padding: 28,
          borderRadius: 12,
          background: COLORS.glass.bg,
          border: `1px solid ${leftColor}30`,
        }}
      >
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: leftColor,
            marginBottom: 16,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {leftTitle}
        </div>
        <div style={{ fontSize: 20, color: COLORS.text.secondary, lineHeight: 1.6 }}>
          {leftContent}
        </div>
      </div>

      {/* VS 分隔 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          fontSize: 20,
          fontWeight: 700,
          color: COLORS.text.muted,
        }}
      >
        VS
      </div>

      {/* 右侧 */}
      <div
        style={{
          flex: 1,
          opacity: Math.min(rightProgress, 1),
          transform: `translateX(${(1 - rightProgress) * 30}px)`,
          padding: 28,
          borderRadius: 12,
          background: COLORS.glass.bg,
          border: `1px solid ${rightColor}30`,
        }}
      >
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: rightColor,
            marginBottom: 16,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {rightTitle}
        </div>
        <div style={{ fontSize: 20, color: COLORS.text.secondary, lineHeight: 1.6 }}>
          {rightContent}
        </div>
      </div>
    </div>
  );
};
