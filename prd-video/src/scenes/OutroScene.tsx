import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { FloatingShapes } from "../components/FloatingShapes";
import { NeonTitle } from "../components/NeonTitle";
import { COLORS } from "../utils/colors";
import { springIn } from "../utils/animations";
import type { SceneData } from "../types";

export const OutroScene: React.FC<{ scene: SceneData; videoTitle: string }> = ({
  scene,
  videoTitle,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const subtitleProgress = springIn(frame, fps, 20);
  const lineWidth = interpolate(frame, [10, 50], [0, 300], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const bottomLineWidth = interpolate(frame, [40, 70], [0, 200], {
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
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Background accentColor={COLORS.neon.purple} variant="radial" backgroundImageUrl={scene.backgroundImageUrl} />
      <FloatingShapes accentColor={COLORS.neon.purple} seed={707} intensity="high" />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          textAlign: "center",
          padding: "0 120px",
        }}
      >
        {/* 顶部装饰线 */}
        <div
          style={{
            width: lineWidth,
            height: 2,
            background: `linear-gradient(90deg, transparent, ${COLORS.neon.purple}, transparent)`,
            margin: "0 auto 40px",
          }}
        />

        <NeonTitle text="Thanks for Watching" fontSize={56} color={COLORS.neon.purple} delay={5} />

        <div
          style={{
            opacity: Math.min(subtitleProgress, 1),
            transform: `translateY(${(1 - subtitleProgress) * 20}px)`,
            fontSize: 24,
            color: COLORS.text.secondary,
            marginTop: 24,
            lineHeight: 1.5,
          }}
        >
          {scene.narration}
        </div>

        {/* 底部装饰线 */}
        <div
          style={{
            width: bottomLineWidth,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${COLORS.neon.purple}60, transparent)`,
            margin: "32px auto 0",
          }}
        />

        <div
          style={{
            opacity: Math.min(springIn(frame, fps, 40), 1),
            fontSize: 18,
            color: COLORS.text.muted,
            marginTop: 24,
          }}
        >
          {videoTitle}
        </div>
      </div>
    </div>
  );
};
