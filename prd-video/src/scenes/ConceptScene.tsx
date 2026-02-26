import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { GlassCard } from "../components/GlassCard";
import { COLORS } from "../utils/colors";
import { springIn, typewriterCount } from "../utils/animations";
import type { SceneData } from "../types";

export const ConceptScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const narrationChars = typewriterCount(frame, scene.narration, fps, 20, 12);
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
      <Background accentColor={COLORS.neon.purple} />

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
            marginBottom: 32,
            textShadow: `0 0 20px ${COLORS.neon.purple}30`,
          }}
        >
          {scene.topic}
        </div>

        <GlassCard accentColor={COLORS.neon.purple} delay={10} width="100%">
          <div
            style={{
              fontSize: 26,
              color: COLORS.text.secondary,
              lineHeight: 1.7,
            }}
          >
            {scene.narration.substring(0, narrationChars)}
            {narrationChars < scene.narration.length && (
              <span style={{ opacity: Math.floor(frame / 15) % 2 === 0 ? 1 : 0, color: COLORS.neon.purple }}>|</span>
            )}
          </div>
        </GlassCard>
      </div>
    </div>
  );
};
