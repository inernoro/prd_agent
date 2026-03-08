import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { GlassCard } from "../components/GlassCard";
import { COLORS } from "../utils/colors";
import {
  springIn,
  staggerIn,
  sceneFadeOut,
  easedProgress,
  bounceIn,
  counterValue,
  cameraZoom,
  pulse,
  glowPulse,
} from "../utils/animations";
import type { SceneData } from "../types";

/** 多环嵌套进度 SVG */
const MultiRingProgress: React.FC<{
  progress: number;
  size: number;
  color: string;
}> = ({ progress, size, color }) => {
  const rings = [
    { r: size / 2 - 6, width: 5, opacity: 1.0 },
    { r: size / 2 - 18, width: 3, opacity: 0.6 },
    { r: size / 2 - 28, width: 2, opacity: 0.3 },
  ];

  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      {rings.map((ring, i) => {
        const circumference = 2 * Math.PI * ring.r;
        const ringProgress = Math.min(progress * (1 + i * 0.15), 1);
        return (
          <React.Fragment key={i}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={ring.r}
              fill="none"
              stroke={`${color}10`}
              strokeWidth={ring.width}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={ring.r}
              fill="none"
              stroke={color}
              strokeWidth={ring.width}
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - ringProgress)}
              strokeLinecap="round"
              opacity={ring.opacity}
              filter={i === 0 ? `drop-shadow(0 0 8px ${color}60)` : undefined}
            />
          </React.Fragment>
        );
      })}
    </svg>
  );
};

export const SummaryScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const points = scene.narration
    .split(/[。；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const fadeOut = sceneFadeOut(frame, durationInFrames);

  // 持续缩放
  const zoom = cameraZoom(frame, durationInFrames, 1.0, 1.04);

  // 多环进度动画
  const circularProgress = easedProgress(frame, 15, 60);

  // 百分比数字 — 弹跳效果
  const pctValue = counterValue(frame, 100, 60, 15);
  const pctScale = pctValue === 100 ? 1 + pulse(frame, 40, 0, 0.08) : 1;

  // 高亮扫过条带
  const highlightX = interpolate(frame % 180, [0, 180], [-30, 130], {
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
      <Background
        accentColor={COLORS.neon.blue}
        variant="split"
        backgroundImageUrl={scene.backgroundImageUrl}
        noiseSeed="summary"
      />
      <ParticleField count={50} accentColor={COLORS.neon.blue} seed={606} speed={0.3} showTrails={false} />

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
        {/* 标题行 + 多环进度 */}
        <div style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 36 }}>
          {/* 多环进度 */}
          <div
            style={{
              position: "relative",
              opacity: Math.min(springIn(frame, fps, 8), 1),
            }}
          >
            <MultiRingProgress progress={circularProgress} size={80} color={COLORS.neon.blue} />
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 20,
                fontWeight: 800,
                color: COLORS.neon.blue,
                transform: `scale(${pctScale})`,
              }}
            >
              {pctValue}%
            </div>
          </div>

          <div
            style={{
              opacity: Math.min(springIn(frame, fps, 5), 1),
              fontSize: 44,
              fontWeight: 700,
              color: COLORS.text.primary,
              textShadow: `0 0 24px ${COLORS.neon.blue}30`,
            }}
          >
            {scene.topic}
          </div>
        </div>

        <GlassCard accentColor={COLORS.neon.blue} delay={10} width="100%" shimmer gradientBorder>
          {/* 高亮扫过效果 */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: `${highlightX}%`,
              width: 60,
              height: "100%",
              background: `linear-gradient(90deg, transparent, ${COLORS.neon.blue}08, transparent)`,
              pointerEvents: "none",
            }}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
            {points.map((point, i) => {
              const itemProgress = staggerIn(frame, fps, i, 8, 15);
              const isChecked = frame > 25 + i * 10;
              const checkProgress = isChecked ? bounceIn(frame, 25 + i * 10, 20) : 0;

              // 完成时粒子爆炸效果（简化为光晕）
              const completionGlow = isChecked
                ? glowPulse(frame, 30, 0, 12) * Math.max(0, 1 - (frame - 25 - i * 10) / 30)
                : 0;

              return (
                <div
                  key={i}
                  style={{
                    opacity: Math.min(itemProgress, 1),
                    transform: `translateX(${(1 - Math.min(itemProgress, 1)) * 25}px)`,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 14,
                  }}
                >
                  {/* 勾选圈 — 弹跳入场 + 完成光晕 */}
                  <div style={{ position: "relative", flexShrink: 0 }}>
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        background: isChecked ? `${COLORS.neon.blue}25` : "transparent",
                        border: `2px solid ${isChecked ? COLORS.neon.blue : `${COLORS.neon.blue}40`}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 16,
                        color: COLORS.neon.blue,
                        boxShadow: isChecked
                          ? `0 0 ${12 + completionGlow}px ${COLORS.neon.blue}40`
                          : "none",
                        transform: `scale(${isChecked ? 0.8 + checkProgress * 0.2 : 1})`,
                      }}
                    >
                      {isChecked && (
                        <span style={{ opacity: checkProgress, transform: `scale(${checkProgress})` }}>
                          ✓
                        </span>
                      )}
                    </div>
                    {/* 完成瞬间的光环扩散 */}
                    {completionGlow > 0.1 && (
                      <div
                        style={{
                          position: "absolute",
                          inset: -8,
                          borderRadius: "50%",
                          border: `1px solid ${COLORS.neon.blue}`,
                          opacity: completionGlow / 12,
                        }}
                      />
                    )}
                  </div>

                  <div
                    style={{
                      fontSize: 22,
                      color: isChecked ? COLORS.text.primary : COLORS.text.secondary,
                      lineHeight: 1.5,
                      fontWeight: isChecked ? 500 : 400,
                    }}
                  >
                    {point}
                  </div>
                </div>
              );
            })}
          </div>
        </GlassCard>
      </div>
    </div>
  );
};
