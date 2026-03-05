import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { GlassCard } from "../components/GlassCard";
import { AnimatedText } from "../components/AnimatedText";
import { COLORS } from "../utils/colors";
import { springIn, sceneFadeOut, staggerIn, glowPulse } from "../utils/animations";
import type { SceneData } from "../types";

export const ConceptScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const fadeOut = sceneFadeOut(frame, durationInFrames);
  const badgeProgress = springIn(frame, fps, 8);

  // 把旁白分段落显示
  const paragraphs = scene.narration
    .split(/[。\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // 左侧装饰竖线
  const lineHeight = interpolate(frame, [5, 50], [0, 250], {
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
      <Background accentColor={COLORS.neon.purple} variant="diagonal" backgroundImageUrl={scene.backgroundImageUrl} noiseSeed="concept" />
      <ParticleField count={60} accentColor={COLORS.neon.purple} seed={101} speed={0.5} />

      <div style={{ position: "relative", zIndex: 1, padding: "0 120px", maxWidth: 1400, width: "100%" }}>
        {/* 标题行 */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
          {/* 圆形编号 */}
          <div
            style={{
              opacity: Math.min(badgeProgress, 1),
              transform: `scale(${0.5 + 0.5 * badgeProgress}) rotate(${(1 - badgeProgress) * 180}deg)`,
              width: 52,
              height: 52,
              borderRadius: "50%",
              background: `${COLORS.neon.purple}20`,
              border: `2px solid ${COLORS.neon.purple}50`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              fontWeight: 800,
              color: COLORS.neon.purple,
              flexShrink: 0,
              boxShadow: `0 0 20px ${COLORS.neon.purple}30`,
            }}
          >
            {scene.index + 1}
          </div>

          {/* 逐词入场标题 */}
          <AnimatedText
            text={scene.topic}
            fontSize={42}
            fontWeight={700}
            mode="word"
            animation="fade-up"
            delay={5}
            staggerFrames={4}
            glowColor={COLORS.neon.purple}
          />
        </div>

        <GlassCard accentColor={COLORS.neon.purple} delay={10} width="100%" shimmer gradientBorder>
          <div style={{ display: "flex", gap: 24 }}>
            {/* 左侧装饰竖线 */}
            <div
              style={{
                width: 3,
                height: lineHeight,
                background: `linear-gradient(180deg, ${COLORS.neon.purple}, ${COLORS.neon.purple}20)`,
                borderRadius: 2,
                flexShrink: 0,
                boxShadow: `0 0 10px ${COLORS.neon.purple}40`,
              }}
            />
            {/* 分段落 stagger 入场 */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 16 }}>
              {paragraphs.map((para, i) => {
                const p = staggerIn(frame, fps, i, 10, 20);
                return (
                  <div
                    key={i}
                    style={{
                      opacity: Math.min(p, 1),
                      transform: `translateX(${(1 - Math.min(p, 1)) * 30}px)`,
                      fontSize: 26,
                      color: COLORS.text.secondary,
                      lineHeight: 1.7,
                    }}
                  >
                    {para}
                  </div>
                );
              })}
            </div>
          </div>
        </GlassCard>

        {/* 底部画面描述 */}
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
