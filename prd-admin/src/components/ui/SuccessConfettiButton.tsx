/**
 * SuccessConfettiButton - 完结撒花按钮
 *
 * 带有三阶段动效的提交按钮：
 * 1. ready: 待提交状态，带呼吸动画
 * 2. loading: 加载中，显示点点动画
 * 3. complete: 完成状态，触发撒花动效
 *
 * 使用场景：任何需要提交操作的地方，如表单提交、缺陷提交等
 */
import { cn } from '@/lib/cn';
import { Check, Play, TimerOff } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';

type Phase = 'ready' | 'loading' | 'complete';

type Props = {
  className?: string;
  title?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  readyText?: string;
  loadingText?: string;
  successText?: string;
  showLoadingText?: boolean;
  /** 透传按钮 style（支持覆盖 CSS 变量如 --sa-h/--sa-font 等） */
  style?: React.CSSProperties;
  /** phase 变化回调（用于外部联动动效/状态） */
  onPhaseChange?: (phase: Phase) => void;
  /**
   * 成功后是否自动回到 ready
   * - autoReset：保持 successHoldMs 后回到 ready（默认行为）
   * - hold：停留在 complete，直到组件卸载或外部重新渲染
   */
  completeMode?: 'autoReset' | 'hold';
  /**
   * 返回 false 表示失败（会回到 ready，不进入 success/confetti）。
   * 不传则默认模拟一次成功流程。
   */
  onAction?: () => Promise<unknown> | unknown;
  /** loading 阶段点击触发：用于“停止/取消” */
  onCancel?: () => void;
  loadingMinMs?: number;
  successHoldMs?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function usePrefersReducedMotion() {
  return React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  }, []);
}

function AnimatedText({ text }: { text: string }) {
  const chars = React.useMemo(() => (text || '').split(''), [text]);
  return (
    <span className="sa-button-text" aria-hidden="true">
      {chars.map((ch, idx) => {
        const dr = (chars.length - idx - 1) * 30;
        const styleVars: Record<'--d' | '--dr', string> = {
          '--d': `${idx * 30}ms`,
          '--dr': `${dr}ms`,
        };
        const style = styleVars as unknown as React.CSSProperties;
        return (
          <span key={`${idx}:${ch}`} style={style}>
            {ch === ' ' ? '\u00A0' : ch}
          </span>
        );
      })}
    </span>
  );
}

type Confetto = {
  randomModifier: number;
  color: { front: string; back: string };
  dimensions: { x: number; y: number };
  position: { x: number; y: number };
  rotation: number;
  scale: { x: number; y: number };
  velocity: { x: number; y: number };
};

type Sequin = {
  color: string;
  radius: number;
  position: { x: number; y: number };
  velocity: { x: number; y: number };
};

export function SuccessConfettiButton({
  className,
  title,
  disabled,
  size = 'sm',
  readyText = '动效',
  loadingText = '...',
  successText = 'OK',
  showLoadingText = false,
  style,
  onPhaseChange,
  completeMode = 'autoReset',
  onAction,
  onCancel,
  loadingMinMs = 650,
  successHoldMs = 3300,
}: Props) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const canPortal = typeof document !== 'undefined';

  const [phase, setPhase] = React.useState<Phase>('ready');
  const [widthPx, setWidthPx] = React.useState<number | null>(null);
  const [breatheOn, setBreatheOn] = React.useState(false);
  const runningRef = React.useRef(false);
  const runTokenRef = React.useRef(0);
  const btnRef = React.useRef<HTMLButtonElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const sizerRef = React.useRef<HTMLSpanElement | null>(null);
  const rafRef = React.useRef<number | null>(null);
  const timeoutsRef = React.useRef<number[]>([]);

  const confettiRef = React.useRef<Confetto[]>([]);
  const sequinsRef = React.useRef<Sequin[]>([]);

  const clearTimers = React.useCallback(() => {
    timeoutsRef.current.forEach((t) => window.clearTimeout(t));
    timeoutsRef.current = [];
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    return () => {
      runTokenRef.current += 1;
      runningRef.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  React.useEffect(() => {
    onPhaseChange?.(phase);
  }, [onPhaseChange, phase]);

  const resizeCanvas = React.useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }, []);

  React.useEffect(() => {
    if (prefersReducedMotion) return;
    const onResize = () => resizeCanvas();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [prefersReducedMotion, resizeCanvas]);

  const randomRange = (min: number, max: number) => Math.random() * (max - min) + min;

  const initConfettoVelocity = React.useCallback(
    (xRange: [number, number], yRange: [number, number]) => {
      const x = randomRange(xRange[0], xRange[1]);
      const range = yRange[1] - yRange[0] + 1;
      let y = yRange[1] - Math.abs(randomRange(0, range) + randomRange(0, range) - range);
      if (y >= yRange[1] - 1) y += Math.random() < 0.25 ? randomRange(1, 3) : 0;
      return { x, y: -y };
    },
    []
  );

  const initBurst = React.useCallback(() => {
    const button = btnRef.current;
    const canvas = canvasRef.current;
    if (!button || !canvas) return;

    resizeCanvas();

    const rect = button.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const confettiCount = 20;
    const sequinCount = 10;

    const colors = [
      { front: '#7b5cff', back: '#6245e0' },
      { front: '#b3c7ff', back: '#8fa5e5' },
      { front: '#5c86ff', back: '#345dd1' },
    ];

    const confetti: Confetto[] = [];
    const sequins: Sequin[] = [];

    for (let i = 0; i < confettiCount; i++) {
      const color = colors[Math.floor(randomRange(0, colors.length))]!;
      confetti.push({
        randomModifier: randomRange(0, 99),
        color,
        dimensions: { x: randomRange(5, 9), y: randomRange(8, 15) },
        position: {
          x: randomRange(cx - rect.width / 4, cx + rect.width / 4),
          y: randomRange(cy + rect.height / 2 + 8, cy + 1.5 * rect.height - 8),
        },
        rotation: randomRange(0, 2 * Math.PI),
        scale: { x: 1, y: 1 },
        velocity: initConfettoVelocity([-9, 9], [6, 11]),
      });
    }

    for (let i = 0; i < sequinCount; i++) {
      const color = colors[Math.floor(randomRange(0, colors.length))]!.back;
      sequins.push({
        color,
        radius: randomRange(1, 2),
        position: {
          x: randomRange(cx - rect.width / 3, cx + rect.width / 3),
          y: randomRange(cy + rect.height / 2 + 8, cy + 1.5 * rect.height - 8),
        },
        velocity: { x: randomRange(-6, 6), y: randomRange(-8, -12) },
      });
    }

    confettiRef.current = confetti;
    sequinsRef.current = sequins;
  }, [initConfettoVelocity, resizeCanvas]);

  const startRender = React.useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const gravityConfetti = 0.3;
    const gravitySequins = 0.55;
    const dragConfetti = 0.075;
    const dragSequins = 0.02;
    const terminalVelocity = 3;

    const tick = () => {
      const confetti = confettiRef.current;
      const sequins = sequinsRef.current;

      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      for (let i = 0; i < confetti.length; i++) {
        const c = confetti[i]!;

        c.velocity.x -= c.velocity.x * dragConfetti;
        c.velocity.y = Math.min(c.velocity.y + gravityConfetti, terminalVelocity);
        c.velocity.x += Math.random() > 0.5 ? Math.random() : -Math.random();

        c.position.x += c.velocity.x;
        c.position.y += c.velocity.y;

        c.scale.y = Math.cos((c.position.y + c.randomModifier) * 0.09);

        const width = c.dimensions.x * c.scale.x;
        const height = c.dimensions.y * c.scale.y;

        ctx.save();
        ctx.translate(c.position.x, c.position.y);
        ctx.rotate(c.rotation);
        ctx.fillStyle = c.scale.y > 0 ? c.color.front : c.color.back;
        ctx.fillRect(-width / 2, -height / 2, width, height);
        ctx.restore();
      }

      for (let i = 0; i < sequins.length; i++) {
        const s = sequins[i]!;
        s.velocity.x -= s.velocity.x * dragSequins;
        s.velocity.y += gravitySequins;

        s.position.x += s.velocity.x;
        s.position.y += s.velocity.y;

        ctx.save();
        ctx.translate(s.position.x, s.position.y);
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(0, 0, s.radius, 0, 2 * Math.PI);
        ctx.fill();
        ctx.restore();
      }

      // 清理屏外
      confettiRef.current = confettiRef.current.filter((c) => c.position.y < window.innerHeight + 60);
      sequinsRef.current = sequinsRef.current.filter((s) => s.position.y < window.innerHeight + 60);

      if (confettiRef.current.length === 0 && sequinsRef.current.length === 0) {
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        rafRef.current = null;
        return;
      }

      rafRef.current = window.requestAnimationFrame(tick);
    };

    rafRef.current = window.requestAnimationFrame(tick);
  }, []);

  const triggerConfetti = React.useCallback(() => {
    if (prefersReducedMotion) return;
    initBurst();
    startRender();
  }, [initBurst, prefersReducedMotion, startRender]);

  const minSuccessHoldMs = React.useMemo(() => {
    // CSS: .sa-complete 的 success 文本入场延迟 1000ms，字符按 30ms 递增，再给 260ms 过渡缓冲
    const n = (successText || '').length;
    const charDelay = Math.max(0, n - 1) * 30;
    return 1000 + charDelay + 260;
  }, [successText]);

  const styleVars = React.useMemo(() => {
    if (size === 'md') {
      const v: Record<'--sa-h' | '--sa-px' | '--sa-radius' | '--sa-font' | '--sa-minw', string> = {
        '--sa-h': '40px',
        '--sa-px': '16px',
        '--sa-radius': '12px',
        '--sa-font': '13px',
        // md 模式允许更明显的“OK 收缩”
        '--sa-minw': '92px',
      };
      return v as unknown as React.CSSProperties;
    }
    const v: Record<'--sa-h' | '--sa-px' | '--sa-radius' | '--sa-font' | '--sa-minw', string> = {
      '--sa-h': '30px',
      '--sa-px': '14px',
      '--sa-radius': '10px',
      '--sa-font': '12px',
      '--sa-minw': '86px',
    };
    return v as unknown as React.CSSProperties;
  }, [size]);

  const measureAndSetWidth = React.useCallback(() => {
    const el = sizerRef.current;
    if (!el) return;
    const measured = Math.ceil(el.getBoundingClientRect().width);
    const min = size === 'md' ? 92 : 86;
    const next = Math.max(min, measured);
    setWidthPx(next);
  }, [size]);

  React.useLayoutEffect(() => {
    // 初次与每次 phase/文案变化时重新测量宽度，并触发一次“呼吸”动画
    measureAndSetWidth();
    // 下一帧再测一次，避免字体/图标加载导致的首帧误差
    setBreatheOn(false);
    const t = window.requestAnimationFrame(() => {
      measureAndSetWidth();
      setBreatheOn(true);
    });
    return () => window.cancelAnimationFrame(t);
  }, [measureAndSetWidth, phase, readyText, loadingText, successText, showLoadingText, size]);

  const run = React.useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const token = (runTokenRef.current += 1);

    try {
      setPhase('loading');
      const startAt = Date.now();
      let ok = true;
      try {
        const res = onAction ? await onAction() : await sleep(900);
        if (res === false) ok = false;
      } catch {
        ok = false;
      }

      const elapsed = Date.now() - startAt;
      if (elapsed < loadingMinMs) await sleep(loadingMinMs - elapsed);

      if (runTokenRef.current !== token) return;
      if (!ok) {
        setPhase('ready');
        runningRef.current = false;
        return;
      }

      setPhase('complete');
      triggerConfetti();

      if (completeMode === 'hold') {
        runningRef.current = false;
        return;
      }

      const holdMs = Math.max(successHoldMs, minSuccessHoldMs);
      timeoutsRef.current.push(
        window.setTimeout(() => {
          if (runTokenRef.current !== token) return;
          setPhase('ready');
          runningRef.current = false;
        }, holdMs)
      );
    } finally {
      // no-op：runningRef 会在回到 ready 或 cancel 时解除
    }
  }, [completeMode, loadingMinMs, minSuccessHoldMs, onAction, successHoldMs, triggerConfetti]);

  const cancel = React.useCallback(() => {
    if (phase !== 'loading') return;
    if (!onCancel) return;
    runTokenRef.current += 1;
    clearTimers();
    try {
      onCancel();
    } finally {
      setPhase('ready');
      runningRef.current = false;
    }
  }, [clearTimers, onCancel, phase]);

  const phaseCls = phase === 'ready' ? 'sa-ready' : phase === 'loading' ? 'sa-loading' : 'sa-complete';
  const effectiveDisabled = phase === 'ready' ? !!disabled : !onCancel; // loading 时允许点击取消（如果提供 onCancel）

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        disabled={effectiveDisabled}
        title={title}
        className={cn('sa-btn', phaseCls, breatheOn ? 'sa-breathe' : '', className)}
        style={{ ...styleVars, ...style, width: widthPx != null ? `${widthPx}px` : undefined }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (phase === 'loading' && onCancel) cancel();
          else void run();
        }}
        aria-label={title || readyText}
      >
        {/* 用于测量宽度：让外框跟着内容“呼吸/缩放”，不会再出现框小字大的错位 */}
        <span ref={sizerRef} className="sa-sizer" aria-hidden="true">
          {phase === 'ready' ? (
            <>
              <Play size={size === 'md' ? 16 : 14} />
              <span>{readyText}</span>
            </>
          ) : phase === 'loading' ? (
            <>
              <span style={{ width: 22, height: 22, display: 'inline-block' }} />
              <span>{showLoadingText ? loadingText : readyText}</span>
              {onCancel ? <TimerOff size={size === 'md' ? 16 : 14} /> : null}
            </>
          ) : (
            <>
              <Check size={size === 'md' ? 16 : 14} />
              <span>{successText}</span>
            </>
          )}
        </span>

        <span className="sa-message sa-submitMessage">
          <Play className="sa-icon" size={size === 'md' ? 16 : 14} aria-hidden="true" />
          <AnimatedText text={readyText} />
          <span className="sr-only">{readyText}</span>
        </span>

        <span className="sa-message sa-loadingMessage" aria-hidden="true">
          <svg className="sa-loadingSvg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 19 17">
            <circle className="sa-loadingCircle" cx="2.2" cy="10" r="1.6" />
            <circle className="sa-loadingCircle" cx="9.5" cy="10" r="1.6" />
            <circle className="sa-loadingCircle" cx="16.8" cy="10" r="1.6" />
          </svg>
          {showLoadingText ? (
            <span className="sa-loadingText">{loadingText}</span>
          ) : (
            <span className="sr-only">{loadingText}</span>
          )}
          {onCancel ? <TimerOff className="sa-cancelHint" size={size === 'md' ? 16 : 14} aria-hidden="true" /> : null}
        </span>

        <span className="sa-message sa-successMessage" aria-hidden="true">
          <Check className="sa-icon sa-successIcon" size={size === 'md' ? 16 : 14} aria-hidden="true" />
          <AnimatedText text={successText} />
        </span>
      </button>

      {canPortal
        ? createPortal(<canvas ref={canvasRef} className="sa-confetti-canvas" />, document.body)
        : <canvas ref={canvasRef} className="sa-confetti-canvas" />}
    </>
  );
}
