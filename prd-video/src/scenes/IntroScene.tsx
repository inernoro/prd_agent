import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { FloatingShapes } from "../components/FloatingShapes";
import { NeonTitle } from "../components/NeonTitle";
import { COLORS } from "../utils/colors";
import { springIn } from "../utils/animations";
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

  // 装饰线动画
  const lineWidth = interpolate(frame, [30, 60], [0, 300], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // 顶部装饰线
  const topLineWidth = interpolate(frame, [15, 45], [0, 600], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // 标签进入
  const tagProgress = springIn(frame, fps, 35);

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
      <Background accentColor={COLORS.neon.blue} variant="radial" />
      <FloatingShapes accentColor={COLORS.neon.blue} seed={42} intensity="medium" />

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
            width: topLineWidth,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${COLORS.neon.blue}40, transparent)`,
            margin: "0 auto 48px",
          }}
        />

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

        {/* 类型标签 */}
        <div
          style={{
            opacity: Math.min(tagProgress, 1),
            transform: `scale(${0.8 + 0.2 * tagProgress})`,
            marginTop: 32,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 20px",
            borderRadius: 20,
            background: `${COLORS.neon.blue}15`,
            border: `1px solid ${COLORS.neon.blue}30`,
          }}
        >
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: COLORS.neon.blue,
              boxShadow: `0 0 8px ${COLORS.neon.blue}`,
            }}
          />
          <span style={{ fontSize: 14, color: COLORS.neon.blue, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Tutorial Video
          </span>
        </div>
      </div>

      {/* 底部装饰线 */}
      <div
        style={{
          position: "absolute",
          bottom: 60,
          left: "50%",
          transform: "translateX(-50%)",
          width: lineWidth,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${COLORS.neon.blue}, transparent)`,
        }}
      />
    </div>
  );
};
