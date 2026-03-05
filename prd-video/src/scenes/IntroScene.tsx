import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { AnimatedText } from "../components/AnimatedText";
import { COLORS } from "../utils/colors";
import { springIn, sceneFadeOut, pulse, easedProgress } from "../utils/animations";
import type { SceneData } from "../types";

export const IntroScene: React.FC<{ scene: SceneData; videoTitle: string }> = ({
  scene,
  videoTitle,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const fadeOut = sceneFadeOut(frame, durationInFrames);
  const topLineWidth = easedProgress(frame, 15, 40);
  const bottomLineWidth = easedProgress(frame, 30, 35);
  const tagProgress = springIn(frame, fps, 35);
  const subtitleProgress = springIn(frame, fps, 25, { damping: 16 });
  const ringPulse = pulse(frame, 90, 0.4, 1);

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
        opacity: fadeOut,
      }}
    >
      <Background accentColor={COLORS.neon.blue} variant="radial" backgroundImageUrl={scene.backgroundImageUrl} noiseSeed="intro" />
      <ParticleField count={100} accentColor={COLORS.neon.blue} seed={42} speed={0.8} converge showTrails />

      <div style={{ position: "relative", zIndex: 1, textAlign: "center", padding: "0 120px" }}>
        {/* 顶部装饰线 */}
        <div style={{ width: topLineWidth * 600, height: 1, background: `linear-gradient(90deg, transparent, ${COLORS.neon.blue}60, transparent)`, margin: "0 auto 48px" }} />

        {/* 脉冲光环 */}
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 500 * ringPulse, height: 500 * ringPulse, borderRadius: "50%", border: `1px solid ${COLORS.neon.blue}15`, pointerEvents: "none" }} />
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 700 * ringPulse, height: 700 * ringPulse, borderRadius: "50%", border: `1px solid ${COLORS.neon.blue}08`, pointerEvents: "none" }} />

        {/* 逐字符弹入标题 */}
        <AnimatedText text={videoTitle} fontSize={68} fontWeight={800} mode="char" animation="elastic" delay={5} staggerFrames={2} textAlign="center" glowColor={COLORS.neon.blue} />

        {/* 副标题 */}
        <div style={{ opacity: Math.min(subtitleProgress, 1), transform: `translateY(${(1 - subtitleProgress) * 20}px)`, fontSize: 28, color: COLORS.text.secondary, marginTop: 24, lineHeight: 1.5 }}>
          {scene.narration}
        </div>

        {/* 类型标签 */}
        <div style={{ opacity: Math.min(tagProgress, 1), transform: `scale(${0.8 + 0.2 * tagProgress})`, marginTop: 32, display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 20px", borderRadius: 20, background: `${COLORS.neon.blue}15`, border: `1px solid ${COLORS.neon.blue}30` }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.neon.blue, boxShadow: `0 0 8px ${COLORS.neon.blue}` }} />
          <span style={{ fontSize: 14, color: COLORS.neon.blue, letterSpacing: "0.1em", textTransform: "uppercase" }}>Tutorial Video</span>
        </div>
      </div>

      {/* 底部装饰线 */}
      <div style={{ position: "absolute", bottom: 60, left: "50%", transform: "translateX(-50%)", width: bottomLineWidth * 300, height: 2, background: `linear-gradient(90deg, transparent, ${COLORS.neon.blue}, transparent)` }} />
    </div>
  );
};
