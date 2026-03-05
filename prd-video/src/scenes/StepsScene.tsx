import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { COLORS } from "../utils/colors";
import { springIn, staggerIn, sceneFadeOut, pulse, easedProgress } from "../utils/animations";
import type { SceneData } from "../types";

export const StepsScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const steps = scene.narration
    .split(/[。；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const fadeOut = sceneFadeOut(frame, durationInFrames);

  // 活跃步骤数（用于进度条和连线）
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
      <Background accentColor={COLORS.neon.green} variant="split" backgroundImageUrl={scene.backgroundImageUrl} noiseSeed="steps" />
      <ParticleField count={50} accentColor={COLORS.neon.green} seed={202} speed={0.4} showTrails={false} />

      <div style={{ position: "relative", zIndex: 1, padding: "0 120px", maxWidth: 1400, width: "100%" }}>
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

        {/* 进度条 */}
        <div
          style={{
            width: "100%",
            height: 4,
            borderRadius: 2,
            background: "rgba(255,255,255,0.05)",
            marginBottom: 36,
            overflow: "hidden",
            position: "relative",
          }}
        >
          <div
            style={{
              width: `${progressWidth}%`,
              height: "100%",
              borderRadius: 2,
              background: `linear-gradient(90deg, ${COLORS.neon.green}, ${COLORS.neon.green}aa)`,
              boxShadow: `0 0 12px ${COLORS.neon.green}40`,
            }}
          />
          {/* 扫描光 */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: `${progressWidth - 5}%`,
              width: 30,
              height: "100%",
              background: `linear-gradient(90deg, transparent, ${COLORS.neon.green}80, transparent)`,
              opacity: progressWidth > 5 ? 1 : 0,
            }}
          />
        </div>

        {/* 步骤列表 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20, position: "relative" }}>
          {/* 左侧连接线 */}
          <svg
            style={{ position: "absolute", left: 22, top: 0, width: 2, height: "100%", overflow: "visible" }}
          >
            {steps.slice(0, -1).map((_, i) => {
              const lineProgress = easedProgress(frame, 25 + i * 15, 20);
              const y1 = i * 64 + 44;
              const y2 = (i + 1) * 64;
              return (
                <line
                  key={i}
                  x1={1}
                  y1={y1}
                  x2={1}
                  y2={y1 + (y2 - y1) * lineProgress}
                  stroke={COLORS.neon.green}
                  strokeWidth={2}
                  opacity={0.3}
                  strokeDasharray="4 4"
                />
              );
            })}
          </svg>

          {steps.map((step, i) => {
            const progress = staggerIn(frame, fps, i, 12, 15);
            const opacity = Math.min(progress, 1);
            const translateX = (1 - Math.min(progress, 1)) * 40;
            const isActive = frame > (20 + i * 15 + 10);
            const nodePulse = isActive ? pulse(frame, 60 + i * 7, 0.7, 1) : 0.5;

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
                {/* 步骤编号 — 脉冲发光 */}
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
                    boxShadow: isActive
                      ? `0 0 ${nodePulse * 20}px ${COLORS.neon.green}30, inset 0 0 ${nodePulse * 10}px ${COLORS.neon.green}10`
                      : "none",
                    transform: `scale(${isActive ? nodePulse : 1})`,
                  }}
                >
                  {i + 1}
                </div>

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
