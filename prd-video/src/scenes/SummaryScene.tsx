import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { GlassCard } from "../components/GlassCard";
import { COLORS } from "../utils/colors";
import { springIn, staggerIn, sceneFadeOut, easedProgress, bounceIn, counterValue } from "../utils/animations";
import type { SceneData } from "../types";

/** 环形进度 SVG */
const CircularProgress: React.FC<{
  progress: number;
  size: number;
  color: string;
}> = ({ progress, size, color }) => {
  const r = size / 2 - 4;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference * (1 - Math.min(progress, 1));

  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      {/* 背景圆 */}
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`${color}15`} strokeWidth={4} />
      {/* 进度圆 */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={4}
        strokeDasharray={circumference}
        strokeDashoffset={strokeDashoffset}
        strokeLinecap="round"
        filter={`drop-shadow(0 0 6px ${color}60)`}
      />
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

  // 环形进度动画
  const circularProgress = easedProgress(frame, 15, 60);

  // 百分比数字
  const pctValue = counterValue(frame, 100, 60, 15);

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
      <Background accentColor={COLORS.neon.blue} variant="split" backgroundImageUrl={scene.backgroundImageUrl} noiseSeed="summary" />
      <ParticleField count={50} accentColor={COLORS.neon.blue} seed={606} speed={0.3} showTrails={false} />

      <div style={{ position: "relative", zIndex: 1, padding: "0 120px", maxWidth: 1400, width: "100%" }}>
        {/* 标题行 + 环形进度 */}
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 32 }}>
          {/* 环形进度 */}
          <div
            style={{
              position: "relative",
              opacity: Math.min(springIn(frame, fps, 8), 1),
            }}
          >
            <CircularProgress progress={circularProgress} size={64} color={COLORS.neon.blue} />
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                fontWeight: 800,
                color: COLORS.neon.blue,
                transform: "rotate(0deg)",
              }}
            >
              {pctValue}%
            </div>
          </div>

          <div
            style={{
              opacity: Math.min(springIn(frame, fps, 5), 1),
              fontSize: 42,
              fontWeight: 700,
              color: COLORS.text.primary,
              textShadow: `0 0 20px ${COLORS.neon.blue}30`,
            }}
          >
            {scene.topic}
          </div>
        </div>

        <GlassCard accentColor={COLORS.neon.blue} delay={10} width="100%" shimmer gradientBorder>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {points.map((point, i) => {
              const itemProgress = staggerIn(frame, fps, i, 8, 15);
              const isChecked = frame > (25 + i * 10);
              const checkProgress = isChecked ? bounceIn(frame, 25 + i * 10, 20) : 0;

              return (
                <div
                  key={i}
                  style={{
                    opacity: Math.min(itemProgress, 1),
                    transform: `translateX(${(1 - Math.min(itemProgress, 1)) * 20}px)`,
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 14,
                  }}
                >
                  {/* 勾选圈 — 弹跳入场 */}
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: isChecked ? `${COLORS.neon.blue}25` : "transparent",
                      border: `2px solid ${isChecked ? COLORS.neon.blue : `${COLORS.neon.blue}40`}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                      color: COLORS.neon.blue,
                      flexShrink: 0,
                      boxShadow: isChecked ? `0 0 12px ${COLORS.neon.blue}30` : "none",
                      transform: `scale(${isChecked ? 0.8 + checkProgress * 0.2 : 1})`,
                    }}
                  >
                    {isChecked && (
                      <span style={{ opacity: checkProgress, transform: `scale(${checkProgress})` }}>
                        ✓
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 22,
                      color: isChecked ? COLORS.text.primary : COLORS.text.secondary,
                      lineHeight: 1.5,
                      textDecoration: isChecked ? "none" : "none",
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
