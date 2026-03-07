import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { AnimatedText } from "../components/AnimatedText";
import { COLORS } from "../utils/colors";
import {
  springIn,
  easedProgress,
  pulse,
  glowPulse,
  cameraZoom,
  energyRing,
} from "../utils/animations";
import type { SceneData } from "../types";

export const OutroScene: React.FC<{ scene: SceneData; videoTitle: string }> = ({
  scene,
  videoTitle,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const subtitleProgress = springIn(frame, fps, 25);
  const lineWidth = easedProgress(frame, 10, 40);
  const bottomLineWidth = easedProgress(frame, 40, 30);

  // 持续缩放
  const zoom = cameraZoom(frame, durationInFrames, 1.0, 1.06);

  // 渐变流动效果
  const gradientShift = interpolate(frame, [0, 120], [0, 360], { extrapolateRight: "extend" });

  // 品牌光效脉冲
  const brandGlow = glowPulse(frame, 60, 0.3, 0.8);

  // 标题缩放呼吸
  const titleBreath = pulse(frame, 90, 0.98, 1.02);

  // 光晕扩散效果
  const haloRing1 = energyRing(frame, 100, 400, 10);
  const haloRing2 = energyRing(frame, 140, 500, 40);

  // 底部滚动字幕偏移
  const creditsOffset = interpolate(frame, [60, durationInFrames], [40, -10], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const creditsOpacity = easedProgress(frame, 60, 30);

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
      <Background
        accentColor={COLORS.neon.purple}
        variant="radial"
        backgroundImageUrl={scene.backgroundImageUrl}
        noiseSeed="outro"
      />
      {/* 粒子向中心汇聚 */}
      <ParticleField count={120} accentColor={COLORS.neon.purple} seed={707} speed={1} converge showTrails />

      {/* 光晕扩散环 */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: haloRing1.radius * 2,
          height: haloRing1.radius * 2,
          borderRadius: "50%",
          border: `1px solid ${COLORS.neon.purple}`,
          opacity: haloRing1.opacity,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: haloRing2.radius * 2,
          height: haloRing2.radius * 2,
          borderRadius: "50%",
          border: `1px solid ${COLORS.neon.blue}`,
          opacity: haloRing2.opacity,
          pointerEvents: "none",
        }}
      />

      {/* 品牌光环 */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 450,
          height: 450,
          borderRadius: "50%",
          background: `conic-gradient(from ${gradientShift}deg, ${COLORS.neon.purple}15, ${COLORS.neon.blue}10, ${COLORS.neon.cyan}15, ${COLORS.neon.purple}10, ${COLORS.neon.purple}15)`,
          filter: "blur(60px)",
          opacity: brandGlow,
        }}
      />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          textAlign: "center",
          padding: "0 120px",
          transform: `scale(${zoom})`,
        }}
      >
        {/* 顶部装饰线 */}
        <div
          style={{
            width: lineWidth * 400,
            height: 2,
            background: `linear-gradient(90deg, transparent, ${COLORS.neon.purple}, transparent)`,
            margin: "0 auto 44px",
            boxShadow: `0 0 12px ${COLORS.neon.purple}40`,
          }}
        />

        {/* 逐词弹入感谢文字 */}
        <div style={{ transform: `scale(${titleBreath})` }}>
          <AnimatedText
            text="Thanks for Watching"
            fontSize={60}
            fontWeight={800}
            mode="word"
            animation="elastic"
            delay={5}
            staggerFrames={5}
            textAlign="center"
            glowColor={COLORS.neon.purple}
          />
        </div>

        <div
          style={{
            opacity: Math.min(subtitleProgress, 1),
            transform: `translateY(${(1 - subtitleProgress) * 25}px)`,
            fontSize: 24,
            color: COLORS.text.secondary,
            marginTop: 28,
            lineHeight: 1.6,
          }}
        >
          {scene.narration}
        </div>

        {/* 底部装饰线 */}
        <div
          style={{
            width: bottomLineWidth * 200,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${COLORS.neon.purple}60, transparent)`,
            margin: "36px auto 0",
          }}
        />

        {/* 视频标题 — 滚动字幕效果 */}
        <div
          style={{
            opacity: creditsOpacity,
            transform: `translateY(${creditsOffset}px)`,
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
