import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { CompareCard } from "../components/CompareCard";
import { COLORS } from "../utils/colors";
import { springIn } from "../utils/animations";
import type { SceneData } from "../types";

export const ComparisonScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // 尝试从旁白中分割出两部分进行对比
  const parts = scene.narration.split(/[，。；]/).filter((s) => s.trim().length > 0);
  const mid = Math.floor(parts.length / 2);
  const leftContent = parts.slice(0, mid).join("，");
  const rightContent = parts.slice(mid).join("，");

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
      <Background accentColor={COLORS.neon.orange} />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 100px",
          maxWidth: 1500,
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
            textAlign: "center",
            textShadow: `0 0 20px ${COLORS.neon.orange}30`,
          }}
        >
          {scene.topic}
        </div>

        <CompareCard
          leftTitle="Before"
          leftContent={leftContent || scene.narration}
          rightTitle="After"
          rightContent={rightContent || scene.visualDescription}
          delay={15}
        />
      </div>
    </div>
  );
};
