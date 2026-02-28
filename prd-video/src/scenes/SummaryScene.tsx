import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { FloatingShapes } from "../components/FloatingShapes";
import { GlassCard } from "../components/GlassCard";
import { COLORS } from "../utils/colors";
import { springIn } from "../utils/animations";
import type { SceneData } from "../types";

export const SummaryScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const points = scene.narration
    .split(/[。；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const fadeOut = interpolate(
    frame,
    [durationInFrames - 15, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // 完成百分比动画
  const completionPct = interpolate(frame, [30, 80], [0, 100], {
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
      <Background accentColor={COLORS.neon.blue} variant="split" />
      <FloatingShapes accentColor={COLORS.neon.blue} seed={606} intensity="low" />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 120px",
          maxWidth: 1400,
          width: "100%",
        }}
      >
        {/* 标题行 */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
          <div
            style={{
              opacity: Math.min(springIn(frame, fps, 5), 1),
              fontSize: 42,
              fontWeight: 700,
              color: COLORS.text.primary,
              textShadow: `0 0 20px ${COLORS.neon.blue}30`,
            }}
          >
            {scene.topic}
          </div>
          {/* 完成度标签 */}
          <div
            style={{
              opacity: Math.min(springIn(frame, fps, 30), 1),
              padding: "4px 14px",
              borderRadius: 12,
              background: `${COLORS.neon.blue}15`,
              border: `1px solid ${COLORS.neon.blue}30`,
              fontSize: 14,
              fontWeight: 700,
              color: COLORS.neon.blue,
            }}
          >
            {Math.round(completionPct)}%
          </div>
        </div>

        <GlassCard accentColor={COLORS.neon.blue} delay={10} width="100%">
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {points.map((point, i) => {
              const itemProgress = springIn(frame, fps, 15 + i * 8);
              const isChecked = frame > (20 + i * 12);
              return (
                <div
                  key={i}
                  style={{
                    opacity: Math.min(itemProgress, 1),
                    transform: `translateX(${(1 - itemProgress) * 20}px)`,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 14,
                  }}
                >
                  {/* 勾选圈 */}
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      background: isChecked ? `${COLORS.neon.blue}25` : "transparent",
                      border: `2px solid ${isChecked ? COLORS.neon.blue : `${COLORS.neon.blue}40`}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                      color: COLORS.neon.blue,
                      flexShrink: 0,
                      boxShadow: isChecked ? `0 0 10px ${COLORS.neon.blue}20` : "none",
                    }}
                  >
                    {isChecked ? "\u2713" : ""}
                  </div>
                  <div style={{ fontSize: 22, color: COLORS.text.secondary, lineHeight: 1.5 }}>
                    {point}
                  </div>
                </div>
              );
            })}
          </div>
        </GlassCard>
      </div>
    </div>
  );
};
