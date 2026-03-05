import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { GlassCard } from "../components/GlassCard";
import { COLORS } from "../utils/colors";
import { springIn, sceneFadeOut, easedProgress, glowPulse } from "../utils/animations";
import type { SceneData } from "../types";

export const ComparisonScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const parts = scene.narration.split(/[，。；]/).filter((s) => s.trim().length > 0);
  const mid = Math.floor(parts.length / 2);
  const leftContent = parts.slice(0, mid).join("，");
  const rightContent = parts.slice(mid).join("，");

  const fadeOut = sceneFadeOut(frame, durationInFrames);
  const leftProgress = springIn(frame, fps, 15);
  const rightProgress = springIn(frame, fps, 25);
  const vsProgress = springIn(frame, fps, 20, { damping: 8 });

  // 动态分隔线
  const dividerHeight = easedProgress(frame, 20, 40);

  // 闪电 VS 脉冲
  const vsPulse = glowPulse(frame, 40, 0.6, 1);

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
      <Background accentColor={COLORS.neon.orange} variant="default" backgroundImageUrl={scene.backgroundImageUrl} noiseSeed="compare" />
      <ParticleField count={50} accentColor={COLORS.neon.orange} seed={404} speed={0.4} showTrails={false} />

      <div style={{ position: "relative", zIndex: 1, padding: "0 100px", maxWidth: 1500, width: "100%" }}>
        {/* 标题 */}
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

        {/* 对比区域 */}
        <div style={{ display: "flex", gap: 32, width: "100%", alignItems: "stretch" }}>
          {/* 左侧 — Before */}
          <div
            style={{
              flex: 1,
              opacity: Math.min(leftProgress, 1),
              transform: `translateX(${(1 - leftProgress) * -50}px) perspective(800px) rotateY(${(1 - Math.min(leftProgress, 1)) * 15}deg)`,
            }}
          >
            <GlassCard accentColor={COLORS.neon.orange} delay={15} padding={32} width="100%" shimmer gradientBorder>
              <div style={{ position: "relative" }}>
                {/* 顶部色条 */}
                <div style={{ position: "absolute", top: -32, left: 0, right: 0, height: 3, borderRadius: "0 0 3px 3px", background: `linear-gradient(90deg, ${COLORS.neon.orange}, transparent)` }} />
                <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.neon.orange, marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.neon.orange, boxShadow: `0 0 8px ${COLORS.neon.orange}` }} />
                  Before
                </div>
                <div style={{ fontSize: 20, color: COLORS.text.secondary, lineHeight: 1.6 }}>
                  {leftContent || scene.narration}
                </div>
              </div>
            </GlassCard>
          </div>

          {/* VS 分隔 */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, opacity: Math.min(vsProgress, 1) }}>
            <div style={{ width: 2, height: dividerHeight * 120, background: `linear-gradient(180deg, transparent, ${COLORS.text.muted}40)`, borderRadius: 1 }} />
            <div
              style={{
                fontSize: 18,
                fontWeight: 800,
                color: COLORS.neon.orange,
                background: `${COLORS.neon.orange}15`,
                border: `1px solid ${COLORS.neon.orange}30`,
                padding: "8px 18px",
                borderRadius: 24,
                letterSpacing: "0.05em",
                boxShadow: `0 0 ${vsPulse * 20}px ${COLORS.neon.orange}30`,
                transform: `scale(${0.9 + vsPulse * 0.15})`,
              }}
            >
              VS
            </div>
            <div style={{ width: 2, height: dividerHeight * 120, background: `linear-gradient(180deg, ${COLORS.text.muted}40, transparent)`, borderRadius: 1 }} />
          </div>

          {/* 右侧 — After */}
          <div
            style={{
              flex: 1,
              opacity: Math.min(rightProgress, 1),
              transform: `translateX(${(1 - rightProgress) * 50}px) perspective(800px) rotateY(${(Math.min(rightProgress, 1) - 1) * 15}deg)`,
            }}
          >
            <GlassCard accentColor={COLORS.neon.green} delay={25} padding={32} width="100%" shimmer gradientBorder>
              <div style={{ position: "relative" }}>
                <div style={{ position: "absolute", top: -32, left: 0, right: 0, height: 3, borderRadius: "0 0 3px 3px", background: `linear-gradient(90deg, ${COLORS.neon.green}, transparent)` }} />
                <div style={{ fontSize: 16, fontWeight: 700, color: COLORS.neon.green, marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.08em", display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.neon.green, boxShadow: `0 0 8px ${COLORS.neon.green}` }} />
                  After
                </div>
                <div style={{ fontSize: 20, color: COLORS.text.secondary, lineHeight: 1.6 }}>
                  {rightContent || scene.visualDescription}
                </div>
              </div>
            </GlassCard>
          </div>
        </div>
      </div>
    </div>
  );
};
