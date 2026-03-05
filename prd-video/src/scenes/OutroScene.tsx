import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { AnimatedText } from "../components/AnimatedText";
import { COLORS } from "../utils/colors";
import { springIn, easedProgress, pulse, glowPulse } from "../utils/animations";
import type { SceneData } from "../types";

export const OutroScene: React.FC<{ scene: SceneData; videoTitle: string }> = ({
  scene,
  videoTitle,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const subtitleProgress = springIn(frame, fps, 25);
  const lineWidth = easedProgress(frame, 10, 40);
  const bottomLineWidth = easedProgress(frame, 40, 30);

  // 渐变流动效果
  const gradientShift = interpolate(frame, [0, 120], [0, 360], { extrapolateRight: "extend" });

  // 品牌光效脉冲
  const brandGlow = glowPulse(frame, 60, 0.3, 0.8);

  // 标题缩放呼吸
  const titleBreath = pulse(frame, 90, 0.98, 1.02);

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
      <Background accentColor={COLORS.neon.purple} variant="radial" backgroundImageUrl={scene.backgroundImageUrl} noiseSeed="outro" />
      {/* 粒子向中心汇聚 */}
      <ParticleField count={120} accentColor={COLORS.neon.purple} seed={707} speed={1} converge showTrails />

      {/* 品牌光环 */}
      <div
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 400,
          height: 400,
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
        }}
      >
        {/* 顶部装饰线 */}
        <div
          style={{
            width: lineWidth * 400,
            height: 2,
            background: `linear-gradient(90deg, transparent, ${COLORS.neon.purple}, transparent)`,
            margin: "0 auto 40px",
            boxShadow: `0 0 10px ${COLORS.neon.purple}40`,
          }}
        />

        {/* 逐词弹入感谢文字 */}
        <div style={{ transform: `scale(${titleBreath})` }}>
          <AnimatedText
            text="Thanks for Watching"
            fontSize={56}
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
            width: bottomLineWidth * 200,
            height: 1,
            background: `linear-gradient(90deg, transparent, ${COLORS.neon.purple}60, transparent)`,
            margin: "32px auto 0",
          }}
        />

        {/* 视频标题 */}
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
