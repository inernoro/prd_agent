import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { NeonTitle } from "../components/NeonTitle";
import { COLORS } from "../utils/colors";
import { springIn, fadeIn } from "../utils/animations";
import type { SceneData } from "../types";

export const IntroScene: React.FC<{ scene: SceneData; videoTitle: string }> = ({
  scene,
  videoTitle,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const subtitleProgress = springIn(frame, fps, 20);
  const fadeOutProgress = interpolate(
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
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: fadeOutProgress,
      }}
    >
      <Background accentColor={COLORS.neon.blue} />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          textAlign: "center",
          padding: "0 120px",
        }}
      >
        <NeonTitle text={videoTitle} fontSize={68} delay={5} />

        <div
          style={{
            opacity: Math.min(subtitleProgress, 1),
            transform: `translateY(${(1 - subtitleProgress) * 20}px)`,
            fontSize: 28,
            color: COLORS.text.secondary,
            marginTop: 24,
            lineHeight: 1.5,
          }}
        >
          {scene.narration}
        </div>
      </div>

      {/* 底部装饰线 */}
      <div
        style={{
          position: "absolute",
          bottom: 60,
          left: "50%",
          transform: "translateX(-50%)",
          width: interpolate(frame, [30, 60], [0, 200], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          height: 2,
          background: `linear-gradient(90deg, transparent, ${COLORS.neon.blue}, transparent)`,
        }}
      />
    </div>
  );
};
