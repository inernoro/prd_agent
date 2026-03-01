import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { FloatingShapes } from "../components/FloatingShapes";
import { GlassCard } from "../components/GlassCard";
import { COLORS } from "../utils/colors";
import { springIn } from "../utils/animations";
import type { SceneData } from "../types";

export const DiagramScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
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

  // 中心连接线动画
  const connectionProgress = interpolate(frame, [30, 70], [0, 1], {
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
      <Background accentColor={COLORS.neon.pink} variant="radial" backgroundImageUrl={scene.backgroundImageUrl} />
      <FloatingShapes accentColor={COLORS.neon.pink} seed={505} intensity="medium" />

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
            textShadow: `0 0 20px ${COLORS.neon.pink}30`,
          }}
        >
          {scene.topic}
        </div>

        {/* 卡片网格 + 连接线 */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 20,
            justifyContent: "center",
            position: "relative",
          }}
        >
          {/* 中心连接装饰（用 SVG 画虚线连接） */}
          {points.length > 1 && (
            <svg
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                opacity: connectionProgress * 0.3,
              }}
            >
              <line
                x1="25%"
                y1="50%"
                x2="75%"
                y2="50%"
                stroke={COLORS.neon.pink}
                strokeWidth={1}
                strokeDasharray="6 4"
              />
            </svg>
          )}

          {points.map((point, i) => (
            <GlassCard
              key={i}
              accentColor={COLORS.neon.pink}
              delay={15 + i * 10}
              width={points.length <= 3 ? "100%" : "45%"}
              padding={24}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
                {/* 编号图标 */}
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: `${COLORS.neon.pink}18`,
                    border: `1.5px solid ${COLORS.neon.pink}35`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 16,
                    fontWeight: 700,
                    color: COLORS.neon.pink,
                    flexShrink: 0,
                    boxShadow: `0 0 12px ${COLORS.neon.pink}15`,
                  }}
                >
                  {i + 1}
                </div>
                <div style={{ fontSize: 20, color: COLORS.text.secondary, lineHeight: 1.5 }}>
                  {point}
                </div>
              </div>
            </GlassCard>
          ))}
        </div>
      </div>
    </div>
  );
};
