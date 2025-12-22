import { useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/cn';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { useVisibility } from '@/hooks/useVisibility';

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export default function RecursiveGridBackdrop({
  className,
  depth = 100,
  speedDegPerSec = 1.2,
  runForMs,
  brakeDecelerationRate = 0.94,
  brakeMinSpeedDegPerSec = 0.02,
  strokeRunning,
  strokeBraking,
  brakeStrokeFadeMs = 280,
  scalePerLevel = 0.97,
  paddingVw = 0.5,
  paddingVh = 0.5,
  lineWidth = 1,
  stroke,
  persistKey,
  persistMode = 'off',
}: {
  className?: string;
  /** 嵌套层数（越大越密） */
  depth?: number;
  /** 旋转速度：度/秒 */
  speedDegPerSec?: number;
  /** 动画运行多久后冻结（ms）；0 表示不动；不传表示一直动 */
  runForMs?: number;
  /**
   * 刹车衰减率（参考 iOS 滑动的“速度指数衰减”模型）
   * - 取值 (0,1)，越小越快停；越接近 1 越慢停
   * - 该值按“60fps 一帧”定义，内部会按 dt 做幂次换算
   */
  brakeDecelerationRate?: number;
  /** 刹车到该速度以下就停止 RAF（度/秒） */
  brakeMinSpeedDegPerSec?: number;
  /**
   * 匀速阶段线条颜色（建议 rgba(...)）
   * - 如果传入，将优先于 stroke
   */
  strokeRunning?: string;
  /**
   * 刹车阶段线条颜色（建议 rgba(...)）
   * - 刹车触发后会从 strokeRunning/ stroke 过渡到该值
   */
  strokeBraking?: string;
  /** 刹车触发后，线条颜色过渡时长（ms） */
  brakeStrokeFadeMs?: number;
  /** 每一层缩放比例（原版 0.97） */
  scalePerLevel?: number;
  /** 每层宽度减少（vw，原版 0.5） */
  paddingVw?: number;
  /** 每层高度减少（vh，原版 0.5） */
  paddingVh?: number;
  /** 线宽（CSS px） */
  lineWidth?: number;
  /** 描边颜色（不传则走 CSS 变量默认） */
  stroke?: string;
  /** 跨页面延续旋转角度（sessionStorage key） */
  persistKey?: string;
  /** 持久化模式：读/写（默认 off） */
  persistMode?: 'off' | 'read' | 'write' | 'readwrite';
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const visible = useVisibility();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const strokeColor = useMemo(() => stroke ?? '', [stroke]);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;

    const parseRgba = (s: string) => {
      const m = s
        .replace(/\s+/g, '')
        .match(/^rgba?\((\d+),(\d+),(\d+)(?:,([0-9.]+))?\)$/i);
      if (!m) return null;
      const r = clamp(Number(m[1]), 0, 255);
      const g = clamp(Number(m[2]), 0, 255);
      const b = clamp(Number(m[3]), 0, 255);
      const a = m[4] == null ? 1 : clamp(Number(m[4]), 0, 1);
      return { r, g, b, a };
    };

    const mixRgba = (a: { r: number; g: number; b: number; a: number }, b: { r: number; g: number; b: number; a: number }, t: number) => {
      const k = clamp(t, 0, 1);
      const r = a.r + (b.r - a.r) * k;
      const g = a.g + (b.g - a.g) * k;
      const bb = a.b + (b.b - a.b) * k;
      const aa = a.a + (b.a - a.a) * k;
      return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(bb)},${aa.toFixed(3)})`;
    };

    // base stroke from prop or CSS variable
    const resolveBaseStroke = () => {
      if (strokeColor) return strokeColor;
      const cs = getComputedStyle(stage);
      const v = cs.getPropertyValue('--prd-recgrid-stroke').trim();
      return v || 'rgba(255, 105, 180, 0.8)'; // fallback close to original
    };

    const dpr = clamp(window.devicePixelRatio || 1, 1, 1.75);
    const n = clamp(Math.floor(depth), 6, 220);
    const s = clamp(scalePerLevel, 0.90, 0.99);
    const lw = clamp(lineWidth, 0.5, 2.5);
    const pv = clamp(paddingVw, 0, 3);
    const ph = clamp(paddingVh, 0, 3);
    const speed = Math.max(0.0001, speedDegPerSec);
    const decel = clamp(brakeDecelerationRate, 0.5, 0.9995);
    const minSpeed = clamp(brakeMinSpeedDegPerSec, 0.0001, 2);

    let raf = 0;
    let last = 0;
    let rotDeg = 0;
    let elapsedMs = 0;
    let lastPersist = 0;
    let velDegPerSec = speed;
    let braking = false;
    let brakeAtMs = 0;

    const canRead = persistMode === 'read' || persistMode === 'readwrite';
    const canWrite = persistMode === 'write' || persistMode === 'readwrite';
    const persistEveryMs = 180;
    const maxRun = runForMs == null ? Number.POSITIVE_INFINITY : Math.max(0, runForMs);

    if (persistKey && canRead) {
      try {
        const v = sessionStorage.getItem(persistKey);
        const num = v != null ? Number(v) : NaN;
        if (Number.isFinite(num)) rotDeg = num;
      } catch {
        // ignore
      }
    }

    const resize = () => {
      const rect = stage.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width * dpr));
      const h = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      // 关键：canvas 改尺寸会清空内容；即使动画已停止，也要重绘一次，避免“切页后背景消失”
      draw();
    };

    const draw = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      // slight soften like original (black bg handled by stage)
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.lineWidth = lw * dpr;
      const baseStrokeStr = strokeRunning || resolveBaseStroke();
      const brakingStrokeStr = strokeBraking || resolveBaseStroke();
      const baseParsed = parseRgba(baseStrokeStr);
      const brakeParsed = parseRgba(brakingStrokeStr);

      // 刹车触发瞬间：从“匀速阶段（更实）”切换到“刹车阶段（更淡）”，并做短暂过渡
      let strokeStr = baseStrokeStr;
      if (braking && baseParsed && brakeParsed) {
        const fade = Math.max(0, brakeStrokeFadeMs);
        const t = fade <= 0 ? 1 : clamp((elapsedMs - brakeAtMs) / fade, 0, 1);
        strokeStr = mixRgba(baseParsed, brakeParsed, t);
      } else if (!braking && !strokeRunning && baseParsed && baseParsed.a < 0.999) {
        // 用户要求“刹车前是透明度=1 的线条”：
        // 仅在未显式传入 strokeRunning 时才强制拉满（避免影响“静止态/背景态”自定义 alpha）
        strokeStr = `rgba(${baseParsed.r},${baseParsed.g},${baseParsed.b},1)`;
      }
      ctx.strokeStyle = strokeStr;
      ctx.globalAlpha = 0.9;

      // base rect (match original: 100% - 0.5vw/vh, then recursive scale)
      const baseW = Math.max(2, w - (pv / 100) * w * dpr);
      const baseH = Math.max(2, h - (ph / 100) * h * dpr);

      let curW = baseW;
      let curH = baseH;
      let angle = 0;

      // cumulative transform like nested divs:
      // each level applies rotate(rotDeg) + scale(0.97) on top of parent
      const rotRad = (rotDeg * Math.PI) / 180;
      for (let i = 0; i < n; i += 1) {
        angle += rotRad;
        ctx.save();
        ctx.rotate(angle);
        ctx.strokeRect(-curW / 2, -curH / 2, curW, curH);
        ctx.restore();
        curW *= s;
        curH *= s;
        if (curW < 2 || curH < 2) break;
      }

      ctx.restore();
    };

    const tick = (now: number) => {
      const isVisible = visible;
      if (!last) last = now;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // 只有可见时才推进时间轴（保证“2 秒动效”是真正可见的 2 秒）
      if (isVisible && !prefersReducedMotion) {
        if (!braking && elapsedMs >= maxRun) {
          braking = true;
          brakeAtMs = elapsedMs;
        }
        if (!braking) {
          rotDeg += speed * dt; // constant speed phase
          elapsedMs += dt * 1000;
        } else {
          // iOS-like exponential decay: v *= rate^(frames)
          const frames = dt * 60;
          velDegPerSec *= Math.pow(decel, frames);
          rotDeg += velDegPerSec * dt;
          elapsedMs += dt * 1000;
        }
      }
      draw();

      if (persistKey && canWrite) {
        if (now - lastPersist >= persistEveryMs) {
          lastPersist = now;
          try {
            sessionStorage.setItem(persistKey, String(rotDeg));
          } catch {
            // ignore
          }
        }
      }

      // 如果 runForMs 达到，就冻结（不再请求下一帧），但保留画面
      const shouldContinue =
        !prefersReducedMotion &&
        isVisible &&
        (maxRun === Number.POSITIVE_INFINITY || (!braking ? true : velDegPerSec > minSpeed));
      if (shouldContinue) raf = requestAnimationFrame(tick);
    };

    resize();
    const ro = new ResizeObserver(() => resize());
    ro.observe(stage);

    // initial paint
    draw();
    if (!prefersReducedMotion && (maxRun > 0 || maxRun === Number.POSITIVE_INFINITY)) {
      raf = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [
    depth,
    brakeDecelerationRate,
    brakeMinSpeedDegPerSec,
    brakeStrokeFadeMs,
    lineWidth,
    paddingVh,
    paddingVw,
    persistKey,
    persistMode,
    prefersReducedMotion,
    runForMs,
    scalePerLevel,
    speedDegPerSec,
    strokeBraking,
    strokeColor,
    strokeRunning,
    visible,
  ]);

  return (
    <div ref={stageRef} className={cn('prd-recgrid-stage', className)} aria-hidden>
      <canvas ref={canvasRef} className="prd-recgrid-canvas" />
      <div className="prd-recgrid-vignette" />
    </div>
  );
}


