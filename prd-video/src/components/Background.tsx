import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { noise2D } from "@remotion/noise";
import { COLORS } from "../utils/colors";
import { kenBurns, vignetteOpacity } from "../utils/animations";

/** 动态多层背景 — 噪声渐变 + 视差光晕 + 扫描线 + 呼吸光带 + Ken Burns + 暗角 */
export const Background: React.FC<{
  accentColor?: string;
  showGrid?: boolean;
  variant?: "default" | "radial" | "diagonal" | "split";
  backgroundImageUrl?: string;
  noiseSeed?: string;
}> = ({
  accentColor = COLORS.neon.blue,
  showGrid = true,
  variant = "default",
  backgroundImageUrl,
  noiseSeed = "bg",
}) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();

  const gradientAngle = interpolate(frame, [0, 300], [0, 360], {
    extrapolateRight: "extend",
  });

  const scanLineY = interpolate(frame % 180, [0, 180], [0, height]);
  const scanLine2Y = interpolate(frame % 300, [0, 300], [height, 0]);

  const breathe = interpolate(frame % 120, [0, 60, 120], [0.8, 1.2, 0.8], {
    extrapolateRight: "clamp",
  });

  // 噪声驱动的光晕位置偏移
  const noiseX = noise2D(noiseSeed, frame * 0.005, 0) * 200;
  const noiseY = noise2D(noiseSeed, 0, frame * 0.005) * 150;
  const noiseScale = noise2D(noiseSeed, frame * 0.003, frame * 0.003) * 0.3 + 1;

  const hueShift = Math.sin(frame * 0.01) * 10;

  // Ken Burns 效果（背景图可用时启用）
  const kb = kenBurns(frame, durationInFrames, {
    startScale: 1.05,
    endScale: 1.15,
    startX: 10,
    endX: -10,
    startY: 5,
    endY: -5,
  });

  // 暗角效果
  const vignette = vignetteOpacity(frame, 0, 20);

  const bgGradient =
    variant === "diagonal"
      ? `linear-gradient(${135 + gradientAngle * 0.1}deg, ${COLORS.bg.primary} 0%, ${COLORS.bg.secondary} 40%, ${accentColor}08 100%)`
      : variant === "radial"
        ? `radial-gradient(ellipse at ${30 + noiseX * 0.05}% ${30 + noiseY * 0.05}%, ${accentColor}12 0%, ${COLORS.bg.secondary} 50%, ${COLORS.bg.primary} 100%)`
        : variant === "split"
          ? `linear-gradient(180deg, ${COLORS.bg.secondary} 0%, ${COLORS.bg.primary} 50%, ${accentColor}05 100%)`
          : `radial-gradient(ellipse at 50% 50%, ${COLORS.bg.secondary} 0%, ${COLORS.bg.primary} 70%)`;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        width,
        height,
        background: `
          ${bgGradient},
          linear-gradient(${gradientAngle}deg, ${accentColor}08 0%, transparent 50%)
        `,
        overflow: "hidden",
      }}
    >
      {/* AI 背景图层 — Ken Burns 缓慢推拉 */}
      {backgroundImageUrl && (
        <>
          <img
            src={backgroundImageUrl}
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              width: "110%",
              height: "110%",
              objectFit: "cover",
              transform: `translate(-50%, -50%) scale(${kb.scale}) translate(${kb.x}px, ${kb.y}px)`,
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: `linear-gradient(180deg, ${COLORS.bg.primary}cc 0%, ${COLORS.bg.primary}77 40%, ${COLORS.bg.primary}aa 100%)`,
            }}
          />
        </>
      )}

      {/* 噪声驱动的大光晕（视差层 1 — 最慢） */}
      <div
        style={{
          position: "absolute",
          top: `${35 + noiseY * 0.15}%`,
          left: `${40 + noiseX * 0.15}%`,
          transform: `translate(-50%, -50%) scale(${noiseScale})`,
          width: 900,
          height: 600,
          borderRadius: "50%",
          background: `radial-gradient(ellipse, ${accentColor}10 0%, transparent 70%)`,
          filter: "blur(40px)",
        }}
      />

      {/* 网格 */}
      {showGrid && (
        <svg
          style={{ position: "absolute", inset: 0, opacity: 0.06 }}
          width={width}
          height={height}
        >
          <defs>
            <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
              <path d="M 60 0 L 0 0 0 60" fill="none" stroke={accentColor} strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      )}

      {/* 主扫描线 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: scanLineY,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accentColor}30, transparent)`,
        }}
      />

      {/* 第二扫描线 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: scanLine2Y,
          height: 60,
          background: `linear-gradient(180deg, transparent, ${accentColor}06, transparent)`,
        }}
      />

      {/* 角落光晕 - 右上（呼吸 + 视差层 2） */}
      <div
        style={{
          position: "absolute",
          top: -200 + noiseY * 0.3,
          right: -200 + noiseX * 0.3,
          width: 600 * breathe,
          height: 600 * breathe,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${accentColor}15 0%, transparent 70%)`,
          filter: "blur(20px)",
        }}
      />

      {/* 角落光晕 - 左下 */}
      <div
        style={{
          position: "absolute",
          bottom: -200 - noiseY * 0.2,
          left: -200 - noiseX * 0.2,
          width: 500 * breathe,
          height: 500 * breathe,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${accentColor}0d 0%, transparent 70%)`,
          filter: "blur(15px)",
        }}
      />

      {/* 动态渐变流动光带（视差层 3 — 最快） */}
      <div
        style={{
          position: "absolute",
          top: "20%",
          left: "-10%",
          width: "120%",
          height: 200,
          transform: `rotate(${-5 + hueShift * 0.3}deg) translateY(${noiseY * 0.5}px)`,
          background: `linear-gradient(90deg, transparent 0%, ${accentColor}06 30%, ${accentColor}0a 50%, ${accentColor}06 70%, transparent 100%)`,
          filter: "blur(30px)",
        }}
      />

      {/* 中央微弱光斑 */}
      <div
        style={{
          position: "absolute",
          top: "40%",
          left: "50%",
          transform: `translate(-50%, -50%) scale(${noiseScale})`,
          width: 800,
          height: 400,
          borderRadius: "50%",
          background: `radial-gradient(ellipse, ${accentColor}08 0%, transparent 70%)`,
          opacity: breathe,
        }}
      />

      {/* 底部渐变光带 */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 120,
          background: `linear-gradient(0deg, ${accentColor}0a 0%, transparent 100%)`,
        }}
      />

      {/* 暗角 — 四角压暗增加电影感 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(ellipse at 50% 50%, transparent 50%, ${COLORS.bg.primary} 150%)`,
          opacity: vignette,
          pointerEvents: "none",
        }}
      />
    </div>
  );
};
