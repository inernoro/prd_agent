import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { GlassCard } from "../components/GlassCard";
import { AnimatedText } from "../components/AnimatedText";
import { COLORS } from "../utils/colors";
import {
  springIn,
  sceneFadeOut,
  staggerIn,
  typewriterCount,
  cameraZoom,
  easedProgress,
  pulse,
} from "../utils/animations";
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

  // 持续缩放
  const zoom = cameraZoom(frame, durationInFrames, 1.0, 1.04);

  // 左侧时间轴进度条
  const timelineProgress = easedProgress(frame, 10, durationInFrames * 0.8);

  // 卡片 3D 翻转入场
  const cardFlip = springIn(frame, fps, 12, { damping: 16, stiffness: 80 });
  const cardRotateY = interpolate(Math.min(cardFlip, 1), [0, 1], [45, 0]);

  // 装饰竖线发光脉冲
  const lineGlow = pulse(frame, 70, 8, 16);

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
      <Background
        accentColor={COLORS.neon.purple}
        variant="diagonal"
        backgroundImageUrl={scene.backgroundImageUrl}
        noiseSeed="concept"
      />
      <ParticleField count={60} accentColor={COLORS.neon.purple} seed={101} speed={0.5} />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 120px",
          maxWidth: 1400,
          width: "100%",
          transform: `scale(${zoom})`,
        }}
      >
        {/* 标题行 */}
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 32 }}>
          {/* 圆形编号 — 3D 旋转入场 */}
          <div
            style={{
              opacity: Math.min(badgeProgress, 1),
              transform: `scale(${0.5 + 0.5 * badgeProgress}) rotate(${(1 - badgeProgress) * 180}deg)`,
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: `${COLORS.neon.purple}20`,
              border: `2px solid ${COLORS.neon.purple}50`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 24,
              fontWeight: 800,
              color: COLORS.neon.purple,
              flexShrink: 0,
              boxShadow: `0 0 24px ${COLORS.neon.purple}30`,
            }}
          >
            {scene.index + 1}
          </div>

          {/* 逐词入场标题 */}
          <AnimatedText
            text={scene.topic}
            fontSize={44}
            fontWeight={700}
            mode="word"
            animation="fade-up"
            delay={5}
            staggerFrames={4}
            glowColor={COLORS.neon.purple}
          />
        </div>

        {/* 内容卡片 — 3D 翻转入场 */}
        <div
          style={{
            perspective: 1200,
          }}
        >
          <div
            style={{
              transform: `rotateY(${cardRotateY}deg)`,
              opacity: Math.min(cardFlip, 1),
              transformOrigin: "left center",
            }}
          >
            <GlassCard accentColor={COLORS.neon.purple} delay={10} width="100%" shimmer gradientBorder>
              <div style={{ display: "flex", gap: 24 }}>
                {/* 左侧时间轴进度条 */}
                <div style={{ position: "relative", width: 4, flexShrink: 0 }}>
                  {/* 底色 */}
                  <div
                    style={{
                      width: "100%",
                      height: 280,
                      borderRadius: 2,
                      background: `${COLORS.neon.purple}10`,
                    }}
                  />
                  {/* 进度 */}
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      width: "100%",
                      height: timelineProgress * 280,
                      borderRadius: 2,
                      background: `linear-gradient(180deg, ${COLORS.neon.purple}, ${COLORS.neon.purple}40)`,
                      boxShadow: `0 0 ${lineGlow}px ${COLORS.neon.purple}40`,
                    }}
                  />
                  {/* 进度头部发光点 */}
                  <div
                    style={{
                      position: "absolute",
                      top: timelineProgress * 280 - 4,
                      left: -3,
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: COLORS.neon.purple,
                      boxShadow: `0 0 12px ${COLORS.neon.purple}`,
                      opacity: timelineProgress > 0.02 ? 1 : 0,
                    }}
                  />
                </div>

                {/* 段落 — 打字机逐字效果 */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 18 }}>
                  {paragraphs.map((para, i) => {
                    const paraDelay = 25 + i * 30;
                    const visible = typewriterCount(frame, para, fps, paraDelay, 20);
                    const p = staggerIn(frame, fps, i, 10, 20);
                    return (
                      <div
                        key={i}
                        style={{
                          opacity: Math.min(p, 1),
                          fontSize: 26,
                          color: COLORS.text.secondary,
                          lineHeight: 1.7,
                        }}
                      >
                        {para.substring(0, visible)}
                        {visible < para.length && visible > 0 && (
                          <span
                            style={{
                              color: COLORS.neon.purple,
                              opacity: Math.floor(frame / 15) % 2 === 0 ? 1 : 0,
                            }}
                          >
                            |
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </GlassCard>
          </div>
        </div>

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
