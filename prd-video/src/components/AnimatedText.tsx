import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { staggerIn, elasticIn } from "../utils/animations";
import { COLORS } from "../utils/colors";

/** 逐字符/逐词动画文字 */
export const AnimatedText: React.FC<{
  text: string;
  fontSize?: number;
  color?: string;
  /** 动画模式 */
  mode?: "char" | "word";
  /** 入场方式 */
  animation?: "spring" | "elastic" | "fade-up" | "fade-down";
  delay?: number;
  staggerFrames?: number;
  fontWeight?: number;
  textAlign?: React.CSSProperties["textAlign"];
  glowColor?: string;
  lineHeight?: number;
}> = ({
  text,
  fontSize = 48,
  color = COLORS.text.primary,
  mode = "char",
  animation = "spring",
  delay = 0,
  staggerFrames = 3,
  fontWeight = 700,
  textAlign = "left",
  glowColor,
  lineHeight = 1.3,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const units = mode === "char" ? text.split("") : text.split(/(\s+)/);

  return (
    <div
      style={{
        fontSize,
        fontWeight,
        color,
        textAlign,
        lineHeight,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: textAlign === "center" ? "center" : "flex-start",
        textShadow: glowColor
          ? `0 0 20px ${glowColor}60, 0 0 40px ${glowColor}30`
          : undefined,
      }}
    >
      {units.map((unit, i) => {
        // 空格直接渲染
        if (/^\s+$/.test(unit)) {
          return (
            <span key={i} style={{ whiteSpace: "pre" }}>
              {unit}
            </span>
          );
        }

        let progress: number;
        if (animation === "elastic") {
          progress = elasticIn(frame, fps, delay + i * staggerFrames);
        } else {
          progress = staggerIn(frame, fps, i, staggerFrames, delay);
        }

        const opacity = Math.min(progress, 1);
        let transform = "";

        switch (animation) {
          case "spring":
          case "elastic":
            transform = `translateY(${(1 - progress) * 20}px) scale(${0.5 + 0.5 * Math.min(progress, 1)})`;
            break;
          case "fade-up":
            transform = `translateY(${(1 - Math.min(progress, 1)) * 30}px)`;
            break;
          case "fade-down":
            transform = `translateY(${(Math.min(progress, 1) - 1) * 30}px)`;
            break;
        }

        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity,
              transform,
              whiteSpace: "pre",
            }}
          >
            {unit}
          </span>
        );
      })}
    </div>
  );
};
