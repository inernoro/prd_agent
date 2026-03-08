import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { AnimatedText } from "../components/AnimatedText";
import { COLORS } from "../utils/colors";
import {
  springIn,
  sceneFadeOut,
  easedProgress,
  cameraZoom,
  energyRing,
  glowPulse,
} from "../utils/animations";
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

  // 持续缩放 — 整个场景缓慢推进
  const zoom = cameraZoom(frame, durationInFrames, 1.0, 1.06);

  // 能量脉冲环 — 从中心扩散
  const ring1 = energyRing(frame, 90, 500, 20);
  const ring2 = energyRing(frame, 120, 600, 50);

  // 底部扫描光线
  const scanX = interpolate(frame % 150, [0, 150], [-20, 120], {
    extrapolateRight: "clamp",
  });

  // 标题发光描边脉冲
  const titleGlow = glowPulse(frame, 80, 15, 35);

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
      <Background
        accentColor={COLORS.neon.blue}
        variant="radial"
        backgroundImageUrl={scene.backgroundImageUrl}
        noiseSeed="intro"
      />
      <ParticleField
        count={100}
        accentColor={COLORS.neon.blue}
        seed={42}
        speed={0.8}
        converge
        showTrails
      />

      {/* 能量脉冲环 */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: ring1.radius * 2,
          height: ring1.radius * 2,
          borderRadius: "50%",
          border: `2px solid ${COLORS.neon.blue}`,
          opacity: ring1.opacity,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: ring2.radius * 2,
          height: ring2.radius * 2,
          borderRadius: "50%",
          border: `1px solid ${COLORS.neon.cyan}`,
          opacity: ring2.opacity,
          pointerEvents: "none",
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
            width: topLineWidth * 600,
            height: 2,
            background: `linear-gradient(90deg, transparent, ${COLORS.neon.blue}, transparent)`,
            margin: "0 auto 48px",
            boxShadow: `0 0 12px ${COLORS.neon.blue}40`,
          }}
        />

        {/* 逐字符弹入标题 — 发光描边 */}
        <div style={{ filter: `drop-shadow(0 0 ${titleGlow}px ${COLORS.neon.blue}60)` }}>
          <AnimatedText
            text={videoTitle}
            fontSize={72}
            fontWeight={800}
            mode="char"
            animation="elastic"
            delay={5}
            staggerFrames={2}
            textAlign="center"
            glowColor={COLORS.neon.blue}
          />
        </div>

        {/* 副标题 */}
        <div
          style={{
            opacity: Math.min(subtitleProgress, 1),
            transform: `translateY(${(1 - subtitleProgress) * 30}px)`,
            fontSize: 28,
            color: COLORS.text.secondary,
            marginTop: 28,
            lineHeight: 1.6,
          }}
        >
          {scene.narration}
        </div>

        {/* 类型标签 */}
        <div
          style={{
            opacity: Math.min(tagProgress, 1),
            transform: `scale(${0.8 + 0.2 * tagProgress})`,
            marginTop: 36,
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 24px",
            borderRadius: 24,
            background: `${COLORS.neon.blue}15`,
            border: `1px solid ${COLORS.neon.blue}30`,
            boxShadow: `0 0 20px ${COLORS.neon.blue}15`,
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
          <span
            style={{
              fontSize: 14,
              color: COLORS.neon.blue,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
            }}
          >
            Tutorial Video
          </span>
        </div>
      </div>

      {/* 底部扫描光线 */}
      <div
        style={{
          position: "absolute",
          bottom: 50,
          left: 0,
          right: 0,
          height: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `${scanX}%`,
            width: 200,
            height: "100%",
            background: `linear-gradient(90deg, transparent, ${COLORS.neon.blue}, transparent)`,
            filter: "blur(1px)",
          }}
        />
      </div>

      {/* 底部装饰线 */}
      <div
        style={{
          position: "absolute",
          bottom: 60,
          left: "50%",
          transform: "translateX(-50%)",
          width: bottomLineWidth * 300,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${COLORS.neon.blue}, transparent)`,
          boxShadow: `0 0 8px ${COLORS.neon.blue}30`,
        }}
      />
    </div>
  );
};
