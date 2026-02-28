import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { FloatingShapes } from "../components/FloatingShapes";
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

  // 左侧装饰竖线
  const lineHeight = interpolate(frame, [5, 40], [0, 200], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // 场景编号标签
  const badgeProgress = springIn(frame, fps, 8);

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
      <Background accentColor={COLORS.neon.purple} variant="diagonal" />
      <FloatingShapes accentColor={COLORS.neon.purple} seed={101} intensity="low" />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 120px",
          maxWidth: 1400,
          width: "100%",
        }}
      >
        {/* 标题行：编号 + 标题 */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
          {/* 圆形编号 */}
          <div
            style={{
              opacity: Math.min(badgeProgress, 1),
              transform: `scale(${0.5 + 0.5 * badgeProgress})`,
              width: 48,
              height: 48,
              borderRadius: "50%",
              background: `${COLORS.neon.purple}20`,
              border: `2px solid ${COLORS.neon.purple}50`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 20,
              fontWeight: 800,
              color: COLORS.neon.purple,
              flexShrink: 0,
            }}
          >
            {scene.index + 1}
          </div>
          <div
            style={{
              opacity: Math.min(springIn(frame, fps, 5), 1),
              fontSize: 42,
              fontWeight: 700,
              color: COLORS.text.primary,
              textShadow: `0 0 20px ${COLORS.neon.purple}30`,
            }}
          >
            {scene.topic}
          </div>
        </div>

        <GlassCard accentColor={COLORS.neon.purple} delay={10} width="100%">
          <div style={{ display: "flex", gap: 24 }}>
            {/* 左侧装饰竖线 */}
            <div
              style={{
                width: 3,
                height: lineHeight,
                background: `linear-gradient(180deg, ${COLORS.neon.purple}, ${COLORS.neon.purple}20)`,
                borderRadius: 2,
                flexShrink: 0,
              }}
            />
            <div
              style={{
                fontSize: 26,
                color: COLORS.text.secondary,
                lineHeight: 1.7,
                flex: 1,
              }}
            >
              {scene.narration.substring(0, narrationChars)}
              {narrationChars < scene.narration.length && (
                <span style={{ opacity: Math.floor(frame / 15) % 2 === 0 ? 1 : 0, color: COLORS.neon.purple }}>|</span>
              )}
            </div>
          </div>
        </GlassCard>

        {/* 底部画面描述（如果有） */}
        {scene.visualDescription && (
          <div
            style={{
              opacity: interpolate(frame, [40, 55], [0, 0.4], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
              marginTop: 20,
              fontSize: 14,
              color: COLORS.text.muted,
              fontStyle: "italic",
            }}
          >
            {scene.visualDescription}
          </div>
        )}
      </div>
    </div>
  );
};
