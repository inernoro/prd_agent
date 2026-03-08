import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { COLORS } from "../utils/colors";
import {
  springIn,
  staggerIn,
  sceneFadeOut,
  pulse,
  easedProgress,
  cameraZoom,
  flowingDot,
} from "../utils/animations";
import type { SceneData } from "../types";

export const StepsScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const steps = scene.narration
    .split(/[。；\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const fadeOut = sceneFadeOut(frame, durationInFrames);

  // 持续缩放推进
  const zoom = cameraZoom(frame, durationInFrames, 1.0, 1.05);

  // 活跃步骤数
  const activeSteps = steps.filter((_, i) => {
    const stepDelay = 20 + i * 18;
    return frame > stepDelay + 10;
  }).length;
  const progressWidth = interpolate(activeSteps, [0, steps.length], [0, 100], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // 扫描光位置
  const scanGlowX = interpolate(frame % 120, [0, 120], [0, 100], {
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
        accentColor={COLORS.neon.green}
        variant="split"
        backgroundImageUrl={scene.backgroundImageUrl}
        noiseSeed="steps"
      />
      <ParticleField count={50} accentColor={COLORS.neon.green} seed={202} speed={0.4} showTrails={false} />

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
        {/* 标题 */}
        <div
          style={{
            opacity: Math.min(springIn(frame, fps, 5), 1),
            fontSize: 44,
            fontWeight: 700,
            color: COLORS.text.primary,
            marginBottom: 16,
            textShadow: `0 0 24px ${COLORS.neon.green}30`,
          }}
        >
          {scene.topic}
        </div>

        {/* 进度条 */}
        <div
          style={{
            width: "100%",
            height: 6,
            borderRadius: 3,
            background: "rgba(255,255,255,0.05)",
            marginBottom: 36,
            overflow: "hidden",
            position: "relative",
          }}
        >
          <div
            style={{
              width: `${progressWidth}%`,
              height: "100%",
              borderRadius: 3,
              background: `linear-gradient(90deg, ${COLORS.neon.green}80, ${COLORS.neon.green})`,
              boxShadow: `0 0 16px ${COLORS.neon.green}50`,
              transition: "width 0.3s ease",
            }}
          />
          {/* 扫描光 */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: `${Math.min(scanGlowX, progressWidth)}%`,
              width: 60,
              height: "100%",
              background: `linear-gradient(90deg, transparent, ${COLORS.neon.green}aa, transparent)`,
              opacity: progressWidth > 5 ? 0.8 : 0,
              filter: "blur(2px)",
            }}
          />
        </div>

        {/* 步骤列表 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 22, position: "relative" }}>
          {/* 左侧连接线 + 流动光点 */}
          <svg
            style={{ position: "absolute", left: 24, top: 0, width: 4, height: "100%", overflow: "visible" }}
          >
            {steps.slice(0, -1).map((_, i) => {
              const lineProgress = easedProgress(frame, 25 + i * 18, 25);
              const y1 = i * 70 + 50;
              const y2 = (i + 1) * 70;

              // 流动光点
              const dotProgress = flowingDot(frame, 40, 30 + i * 18);
              const dotY = y1 + (y2 - y1) * dotProgress;
              const dotOpacity = lineProgress > 0.5 ? 0.8 : 0;

              return (
                <React.Fragment key={i}>
                  {/* 虚线连接 */}
                  <line
                    x1={2}
                    y1={y1}
                    x2={2}
                    y2={y1 + (y2 - y1) * lineProgress}
                    stroke={COLORS.neon.green}
                    strokeWidth={2}
                    opacity={0.3}
                    strokeDasharray="4 4"
                  />
                  {/* 流动光点 */}
                  <circle
                    cx={2}
                    cy={dotY}
                    r={3}
                    fill={COLORS.neon.green}
                    opacity={dotOpacity}
                    filter="url(#glow)"
                  />
                </React.Fragment>
              );
            })}
            <defs>
              <filter id="glow">
                <feGaussianBlur stdDeviation="2" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
          </svg>

          {steps.map((step, i) => {
            const progress = staggerIn(frame, fps, i, 14, 15);
            const opacity = Math.min(progress, 1);
            const translateX = (1 - Math.min(progress, 1)) * 50;
            const isActive = frame > 20 + i * 18 + 10;
            const nodePulse = isActive ? pulse(frame, 60 + i * 7, 0.7, 1) : 0.5;

            // 当前步骤放大聚焦
            const isCurrent = isActive && (i === steps.length - 1 || frame <= 20 + (i + 1) * 18 + 10);
            const scale = isCurrent ? 1.03 : isActive ? 1.0 : 0.95;

            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 18,
                  opacity,
                  transform: `translateX(${translateX}px) scale(${scale})`,
                  transformOrigin: "left center",
                }}
              >
                {/* 步骤编号 — 环形进度 + 脉冲发光 */}
                <div style={{ position: "relative", flexShrink: 0 }}>
                  <svg width={48} height={48} style={{ transform: "rotate(-90deg)" }}>
                    <circle cx={24} cy={24} r={20} fill="none" stroke={`${COLORS.neon.green}15`} strokeWidth={3} />
                    <circle
                      cx={24}
                      cy={24}
                      r={20}
                      fill="none"
                      stroke={isActive ? COLORS.neon.green : `${COLORS.neon.green}40`}
                      strokeWidth={3}
                      strokeDasharray={2 * Math.PI * 20}
                      strokeDashoffset={isActive ? 0 : 2 * Math.PI * 20}
                      strokeLinecap="round"
                    />
                  </svg>
                  <div
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 18,
                      fontWeight: 700,
                      color: isActive ? COLORS.neon.green : `${COLORS.neon.green}80`,
                      textShadow: isActive ? `0 0 8px ${COLORS.neon.green}40` : "none",
                    }}
                  >
                    {i + 1}
                  </div>
                  {/* 脉冲光环 */}
                  {isActive && (
                    <div
                      style={{
                        position: "absolute",
                        inset: -4,
                        borderRadius: "50%",
                        border: `1px solid ${COLORS.neon.green}30`,
                        opacity: nodePulse,
                        boxShadow: `0 0 ${nodePulse * 15}px ${COLORS.neon.green}20`,
                      }}
                    />
                  )}
                </div>

                <div
                  style={{
                    fontSize: 22,
                    color: isCurrent ? COLORS.text.primary : isActive ? COLORS.text.secondary : COLORS.text.muted,
                    lineHeight: 1.5,
                    paddingTop: 10,
                    fontWeight: isCurrent ? 600 : 400,
                  }}
                >
                  {step}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
