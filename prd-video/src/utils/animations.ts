import { spring, interpolate } from "remotion";

/** 弹性动画 preset */
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
