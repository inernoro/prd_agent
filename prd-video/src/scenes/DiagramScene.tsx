import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { GlassCard } from "../components/GlassCard";
import { COLORS } from "../utils/colors";
import { springIn, staggerIn, sceneFadeOut, easedProgress, pulse } from "../utils/animations";
import type { SceneData } from "../types";

export const DiagramScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width: videoWidth } = useVideoConfig();

  const points = scene.narration
    .split(/[。；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const fadeOut = sceneFadeOut(frame, durationInFrames);

  // 节点位置计算（环形布局）
  const centerX = 650;
  const centerY = 250;
  const radius = Math.min(200, 80 + points.length * 30);

  // 中心节点脉冲
  const centerPulse = pulse(frame, 60, 0.85, 1.15);

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
      <Background accentColor={COLORS.neon.pink} variant="radial" backgroundImageUrl={scene.backgroundImageUrl} noiseSeed="diagram" />
      <ParticleField count={60} accentColor={COLORS.neon.pink} seed={505} speed={0.5} />

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
            textShadow: `0 0 20px ${COLORS.neon.pink}30`,
          }}
        >
          {scene.topic}
        </div>

        {/* 关系图区域 */}
        <div style={{ position: "relative", width: "100%", minHeight: 500 }}>
          {/* SVG 连线层 */}
          <svg
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
            viewBox={`0 0 ${1300} ${500}`}
          >
            {/* 从中心到各节点的连线 */}
            {points.map((_, i) => {
              const angle = (i / points.length) * Math.PI * 2 - Math.PI / 2;
              const nx = centerX + Math.cos(angle) * radius;
              const ny = centerY + Math.sin(angle) * radius;

              const lineProgress = easedProgress(frame, 20 + i * 8, 30);
              const linePulse = pulse(frame, 70 + i * 11, 0.3, 0.7);

              // 曲线控制点
              const cx = centerX + Math.cos(angle) * radius * 0.4;
              const cy = centerY + Math.sin(angle) * radius * 0.4;

              const endX = centerX + (nx - centerX) * lineProgress;
              const endY = centerY + (ny - centerY) * lineProgress;

              return (
                <React.Fragment key={`line-${i}`}>
                  {/* 发光底层 */}
                  <line
                    x1={centerX}
                    y1={centerY}
                    x2={endX}
                    y2={endY}
                    stroke={COLORS.neon.pink}
                    strokeWidth={4}
                    opacity={linePulse * 0.2}
                    filter="blur(4px)"
                  />
                  {/* 主线 */}
                  <line
                    x1={centerX}
                    y1={centerY}
                    x2={endX}
                    y2={endY}
                    stroke={COLORS.neon.pink}
                    strokeWidth={1.5}
                    opacity={lineProgress * 0.6}
                    strokeDasharray="6 4"
                  />
                  {/* 端点发光圆 */}
                  {lineProgress > 0.9 && (
                    <circle
                      cx={nx}
                      cy={ny}
                      r={4 * linePulse}
                      fill={COLORS.neon.pink}
                      opacity={0.8}
                    />
                  )}
                </React.Fragment>
              );
            })}

            {/* 中心节点 */}
            <circle
              cx={centerX}
              cy={centerY}
              r={30 * centerPulse}
              fill={`${COLORS.neon.pink}20`}
              stroke={COLORS.neon.pink}
              strokeWidth={2}
            />
            <circle
              cx={centerX}
              cy={centerY}
              r={45 * centerPulse}
              fill="none"
              stroke={COLORS.neon.pink}
              strokeWidth={1}
              opacity={0.2}
            />
          </svg>

          {/* 卡片节点 */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 20,
              justifyContent: "center",
              position: "relative",
              zIndex: 2,
              marginTop: 40,
            }}
          >
            {points.map((point, i) => (
              <GlassCard
                key={i}
                accentColor={COLORS.neon.pink}
                delay={15 + i * 8}
                width={points.length <= 3 ? "100%" : "45%"}
                padding={24}
                shimmer
                gradientBorder
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
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
                      boxShadow: `0 0 12px ${COLORS.neon.pink}20`,
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
    </div>
  );
};
