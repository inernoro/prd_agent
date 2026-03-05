import { spring, interpolate, Easing } from "remotion";

// ============================================================
// 1. 基础入场/退场
// ============================================================

/** 弹性入场 */
export function springIn(
  frame: number,
  fps: number,
  delay: number = 0,
  config?: { damping?: number; mass?: number; stiffness?: number }
): number {
  return spring({
    frame: frame - delay,
    fps,
    config: {
      damping: config?.damping ?? 12,
      mass: config?.mass ?? 0.5,
      stiffness: config?.stiffness ?? 100,
    },
  });
}

/** 渐入透明度 */
export function fadeIn(
  frame: number,
  startFrame: number,
  durationFrames: number
): number {
  return interpolate(frame, [startFrame, startFrame + durationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/** 渐出透明度 */
export function fadeOut(
  frame: number,
  startFrame: number,
  durationFrames: number
): number {
  return interpolate(frame, [startFrame, startFrame + durationFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

/** 从下方滑入 */
export function slideInFromBottom(
  frame: number,
  fps: number,
  delay: number = 0
): number {
  const progress = springIn(frame, fps, delay);
  return interpolate(progress, [0, 1], [60, 0]);
}

// ============================================================
// 2. 文字动画
// ============================================================

/** 打字机效果：返回应该显示的字符数 */
export function typewriterCount(
  frame: number,
  text: string,
  fps: number,
  startFrame: number = 0,
  charsPerSecond: number = 15
): number {
  const elapsed = Math.max(0, frame - startFrame);
  const charsPerFrame = charsPerSecond / fps;
  return Math.min(Math.floor(elapsed * charsPerFrame), text.length);
}

/** 数字滚动动画 */
export function counterValue(
  frame: number,
  target: number,
  durationFrames: number,
  startFrame: number = 0
): number {
  const progress = interpolate(
    frame,
    [startFrame, startFrame + durationFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  return Math.round(target * progress);
}

// ============================================================
// 3. Stagger 交错动画
// ============================================================

/** 交错入场：为第 i 个元素计算 spring 进度 */
export function staggerIn(
  frame: number,
  fps: number,
  index: number,
  staggerFrames: number = 6,
  baseDelay: number = 0,
  config?: { damping?: number; mass?: number; stiffness?: number }
): number {
  const delay = baseDelay + index * staggerFrames;
  return springIn(frame, fps, delay, {
    damping: 14,
    mass: 0.4,
    stiffness: 120,
    ...config,
  });
}

/** 波浪交错：基于缓动的柔和波浪入场 */
export function waveIn(
  frame: number,
  index: number,
  total: number,
  startFrame: number = 0,
  durationFrames: number = 40
): number {
  const waveDelay = (index / Math.max(total - 1, 1)) * durationFrames * 0.5;
  return interpolate(
    frame,
    [startFrame + waveDelay, startFrame + waveDelay + durationFrames * 0.6],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) }
  );
}

// ============================================================
// 4. 弹性 & 物理动画
// ============================================================

/** 弹性过冲动画 */
export function elasticIn(
  frame: number,
  fps: number,
  delay: number = 0
): number {
  return spring({
    frame: frame - delay,
    fps,
    config: { damping: 8, mass: 0.3, stiffness: 200 },
  });
}

/** 弹跳落地效果 */
export function bounceIn(
  frame: number,
  startFrame: number,
  durationFrames: number
): number {
  return interpolate(
    frame,
    [startFrame, startFrame + durationFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bounce }
  );
}

/** 回弹效果 */
export function backIn(
  frame: number,
  startFrame: number,
  durationFrames: number
): number {
  return interpolate(
    frame,
    [startFrame, startFrame + durationFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.back(1.7) }
  );
}

// ============================================================
// 5. 连续运动 / 循环动画
// ============================================================

/** 脉冲呼吸效果 */
export function pulse(
  frame: number,
  periodFrames: number = 60,
  min: number = 0.6,
  max: number = 1.0
): number {
  const phase = (frame % periodFrames) / periodFrames;
  const sine = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
  return min + sine * (max - min);
}

/** 浮动悬停效果 */
export function float(
  frame: number,
  amplitudeY: number = 10,
  amplitudeX: number = 5,
  speed: number = 0.03,
  seed: number = 0
): { x: number; y: number } {
  return {
    x: Math.cos(frame * speed + seed * 1.7) * amplitudeX,
    y: Math.sin(frame * speed * 1.3 + seed) * amplitudeY,
  };
}

/** 旋转 */
export function rotate(
  frame: number,
  degreesPerSecond: number = 30,
  fps: number = 30
): number {
  return (frame / fps) * degreesPerSecond;
}

// ============================================================
// 6. 路径 & 空间动画
// ============================================================

/** 沿圆弧运动 */
export function circularMotion(
  frame: number,
  radius: number,
  speed: number = 0.02,
  offsetAngle: number = 0
): { x: number; y: number } {
  const angle = frame * speed + offsetAngle;
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  };
}

/** 贝塞尔缓动插值 */
export function easedProgress(
  frame: number,
  startFrame: number,
  durationFrames: number,
  easing: (t: number) => number = Easing.out(Easing.cubic)
): number {
  return interpolate(
    frame,
    [startFrame, startFrame + durationFrames],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing }
  );
}

// ============================================================
// 7. 视觉效果辅助
// ============================================================

/** 光泽扫描效果：返回扫描线位置百分比 */
export function shimmerScan(
  frame: number,
  periodFrames: number = 90,
  delay: number = 0
): number {
  const elapsed = Math.max(0, frame - delay);
  const phase = (elapsed % periodFrames) / periodFrames;
  return interpolate(phase, [0, 1], [-20, 120]);
}

/** 涟漪扩散效果 */
export function ripple(
  frame: number,
  startFrame: number,
  durationFrames: number,
  maxRadius: number = 200
): { radius: number; opacity: number } {
  const progress = easedProgress(frame, startFrame, durationFrames, Easing.out(Easing.cubic));
  return {
    radius: progress * maxRadius,
    opacity: 1 - progress,
  };
}

/** 发光脉冲 */
export function glowPulse(
  frame: number,
  periodFrames: number = 60,
  minIntensity: number = 0.3,
  maxIntensity: number = 1.0
): number {
  return pulse(frame, periodFrames, minIntensity, maxIntensity);
}

/** 场景标准淡出 */
export function sceneFadeOut(
  frame: number,
  durationInFrames: number,
  fadeFrames: number = 15
): number {
  return interpolate(
    frame,
    [durationInFrames - fadeFrames, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
}

// ============================================================
// 8. 缓动预设导出
// ============================================================

export const EASINGS = {
  smoothOut: Easing.out(Easing.cubic),
  smoothInOut: Easing.inOut(Easing.cubic),
  elastic: Easing.elastic(1),
  bounce: Easing.bounce,
  back: Easing.back(1.7),
  snap: Easing.out(Easing.exp),
} as const;
