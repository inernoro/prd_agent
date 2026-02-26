import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
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
      <Background accentColor={COLORS.neon.blue} />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 120px",
          maxWidth: 1400,
          width: "100%",
        }}
      >
        <div
          style={{
            opacity: Math.min(springIn(frame, fps, 5), 1),
            fontSize: 42,
            fontWeight: 700,
            color: COLORS.text.primary,
            marginBottom: 40,
            textShadow: `0 0 20px ${COLORS.neon.blue}30`,
          }}
        >
          {scene.topic}
        </div>

        <GlassCard accentColor={COLORS.neon.blue} delay={10} width="100%">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {points.map((point, i) => {
              const itemProgress = springIn(frame, fps, 15 + i * 8);
              return (
                <div
                  key={i}
                  style={{
                    opacity: Math.min(itemProgress, 1),
                    transform: `translateX(${(1 - itemProgress) * 20}px)`,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      color: COLORS.neon.blue,
                      fontSize: 22,
                      lineHeight: 1.5,
                    }}
                  >
                    {"\u2713"}
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
