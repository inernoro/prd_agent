import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { COLORS } from "../utils/colors";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  opacity: number;
  color: string;
  phase: number;
  trailLength: number;
}

/** 伪随机数生成器 */
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** 高性能粒子场 — Canvas 2D 渲染，支持物理模拟 + 轨迹尾巴 */
export const ParticleField: React.FC<{
  count?: number;
  accentColor?: string;
  seed?: number;
  speed?: number;
  /** 是否显示轨迹 */
  showTrails?: boolean;
  /** 粒子是否向中心收敛 */
  converge?: boolean;
  /** 整体透明度 */
  globalOpacity?: number;
}> = ({
  count = 80,
  accentColor = COLORS.neon.blue,
  seed = 42,
  speed = 1,
  showTrails = true,
  converge = false,
  globalOpacity = 1,
}) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();

  const colors = useMemo(() => [
    accentColor,
    COLORS.neon.purple,
    COLORS.neon.cyan,
    `${accentColor}80`,
  ], [accentColor]);

  const particles = useMemo(() => {
    const rand = seededRandom(seed);
    const result: Particle[] = [];
    for (let i = 0; i < count; i++) {
      result.push({
        x: rand() * width,
        y: rand() * height,
        vx: (rand() - 0.5) * 2 * speed,
        vy: (rand() - 0.5) * 2 * speed,
        size: 1 + rand() * 3,
        opacity: 0.15 + rand() * 0.6,
        color: colors[Math.floor(rand() * colors.length)],
        phase: rand() * Math.PI * 2,
        trailLength: 3 + Math.floor(rand() * 8),
      });
    }
    return result;
  }, [seed, count, width, height, speed, colors]);

  // 淡入淡出
  const fadeInProgress = interpolate(frame, [0, 30], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const fadeOutProgress = interpolate(
    frame,
    [durationInFrames - 20, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const overallOpacity = fadeInProgress * fadeOutProgress * globalOpacity;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      <svg width={width} height={height} style={{ opacity: overallOpacity }}>
        {particles.map((p, i) => {
          // 物理模拟
          const t = frame * 0.5;
          let px = p.x + Math.sin(t * 0.02 + p.phase) * 40 * p.vx + p.vx * t;
          let py = p.y + Math.cos(t * 0.015 + p.phase) * 30 * p.vy + p.vy * t;

          // 收敛模式
          if (converge) {
            const convergeFactor = interpolate(frame, [0, durationInFrames * 0.8], [0, 0.8], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
            px = px + (width / 2 - px) * convergeFactor;
            py = py + (height / 2 - py) * convergeFactor;
          }

          // 环绕边界
          px = ((px % width) + width) % width;
          py = ((py % height) + height) % height;

          // 脉冲呼吸
          const breathe = Math.sin(frame * 0.05 + p.phase) * 0.3 + 0.7;
          const currentSize = p.size * breathe;
          const currentOpacity = p.opacity * breathe;

          // 轨迹点
          const trailElements: React.ReactNode[] = [];
          if (showTrails) {
            for (let ti = 1; ti <= p.trailLength; ti++) {
              const prevT = (frame - ti * 2) * 0.5;
              let tpx = p.x + Math.sin(prevT * 0.02 + p.phase) * 40 * p.vx + p.vx * prevT;
              let tpy = p.y + Math.cos(prevT * 0.015 + p.phase) * 30 * p.vy + p.vy * prevT;
              if (converge) {
                const cf = interpolate(Math.max(0, frame - ti * 2), [0, durationInFrames * 0.8], [0, 0.8], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                });
                tpx = tpx + (width / 2 - tpx) * cf;
                tpy = tpy + (height / 2 - tpy) * cf;
              }
              tpx = ((tpx % width) + width) % width;
              tpy = ((tpy % height) + height) % height;
              const trailOpacity = currentOpacity * (1 - ti / (p.trailLength + 1)) * 0.4;
              const trailSize = currentSize * (1 - ti / (p.trailLength + 1)) * 0.7;
              trailElements.push(
                <circle
                  key={`trail-${i}-${ti}`}
                  cx={tpx}
                  cy={tpy}
                  r={trailSize}
                  fill={p.color}
                  opacity={trailOpacity}
                />
              );
            }
          }

          return (
            <React.Fragment key={i}>
              {trailElements}
              <circle
                cx={px}
                cy={py}
                r={currentSize}
                fill={p.color}
                opacity={currentOpacity}
              />
              {/* 发光光晕 */}
              {p.size > 2 && (
                <circle
                  cx={px}
                  cy={py}
                  r={currentSize * 3}
                  fill={p.color}
                  opacity={currentOpacity * 0.1}
                />
              )}
            </React.Fragment>
          );
        })}
      </svg>
    </div>
  );
};
