import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { FloatingShapes } from "../components/FloatingShapes";
import { COLORS } from "../utils/colors";
import { springIn } from "../utils/animations";
import type { SceneData } from "../types";

export const StepsScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // 从旁白中提取步骤
  const steps = scene.narration
    .split(/[。；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const fadeOut = interpolate(
    frame,
    [durationInFrames - 15, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // 进度条（随步骤逐渐填充）
  const activeSteps = steps.filter((_, i) => {
    const stepDelay = 20 + i * 15;
    return frame > stepDelay + 10;
  }).length;
  const progressWidth = interpolate(activeSteps, [0, steps.length], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: fadeOut,
      }}
    >
      <Background accentColor={COLORS.neon.green} variant="split" />
      <FloatingShapes accentColor={COLORS.neon.green} seed={202} intensity="low" />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 120px",
          maxWidth: 1400,
          width: "100%",
        }}
      >
        {/* 标题 */}
        <div
          style={{
            opacity: Math.min(springIn(frame, fps, 5), 1),
            fontSize: 42,
            fontWeight: 700,
            color: COLORS.text.primary,
            marginBottom: 16,
            textShadow: `0 0 20px ${COLORS.neon.green}30`,
          }}
        >
          {scene.topic}
        </div>

        {/* 顶部进度条 */}
        <div
          style={{
            width: "100%",
            height: 4,
            borderRadius: 2,
            background: `${COLORS.glass.bg}`,
            marginBottom: 36,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${progressWidth}%`,
              height: "100%",
              borderRadius: 2,
              background: `linear-gradient(90deg, ${COLORS.neon.green}, ${COLORS.neon.green}aa)`,
              boxShadow: `0 0 12px ${COLORS.neon.green}40`,
              transition: "width 0.3s",
            }}
          />
        </div>

        {/* 步骤列表 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {steps.map((step, i) => {
            const stepDelay = 20 + i * 15;
            const progress = springIn(frame, fps, stepDelay, { damping: 12 });
            const opacity = Math.min(progress, 1);
            const translateX = (1 - progress) * 40;
            const isActive = frame > stepDelay + 10;

            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 16,
                  opacity,
                  transform: `translateX(${translateX}px)`,
                }}
              >
                {/* 步骤编号 */}
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: isActive ? `${COLORS.neon.green}25` : `${COLORS.neon.green}10`,
                    border: `2px solid ${isActive ? COLORS.neon.green : `${COLORS.neon.green}40`}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 18,
                    fontWeight: 700,
                    color: isActive ? COLORS.neon.green : `${COLORS.neon.green}80`,
                    flexShrink: 0,
                    boxShadow: isActive ? `0 0 16px ${COLORS.neon.green}20` : "none",
                  }}
                >
                  {i + 1}
                </div>

                {/* 步骤文本 */}
                <div
                  style={{
                    fontSize: 22,
                    color: isActive ? COLORS.text.primary : COLORS.text.secondary,
                    lineHeight: 1.5,
                    paddingTop: 8,
                  }}
                >
                  {step}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
