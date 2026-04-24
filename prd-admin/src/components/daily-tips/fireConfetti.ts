/**
 * 真 · 撒花特效 —— 复用 SuccessConfettiButton 的 canvas confetti 算法,
 * 提取成独立工具函数,可在任意时机调用(无需依赖按钮组件)。
 *
 * 调用 `fireConfetti()` 在屏幕上撒一阵彩纸,直到所有粒子落出视口自动清理。
 * 用于:多步 Tour 完成、缺陷提交成功、首次发布知识库等"完结庆祝"场景。
 *
 * 算法 / 视觉 100% 对齐 components/ui/SuccessConfettiButton.tsx 的
 * initBurst + startRender 实现,只是把按钮位置改成屏幕中下部 origin。
 */

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

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function randomRange(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function initConfettoVelocity(xRange: [number, number], yRange: [number, number]) {
  const x = randomRange(xRange[0], xRange[1]);
  const range = yRange[1] - yRange[0] + 1;
  let y = yRange[1] - Math.abs(randomRange(0, range) + randomRange(0, range) - range);
  if (y >= yRange[1] - 1) y += Math.random() < 0.25 ? randomRange(1, 3) : 0;
  return { x, y: -y };
}

interface FireConfettiOptions {
  /** 撒花的源点 x。默认屏幕水平中心 */
  originX?: number;
  /** 撒花的源点 y。默认屏幕高度 75%(从下半部往上喷,符合"庆祝"语义) */
  originY?: number;
  /** 彩纸数量。默认 28(略多于按钮场景的 20,因为屏幕居中视觉密度需要) */
  count?: number;
  /** 亮片数量。默认 14 */
  sequinCount?: number;
}

/**
 * 在屏幕上撒一阵真 canvas 彩纸 + 亮片,自动清理。
 * 默认从屏幕底部 75% 高度往上喷,符合"完结庆祝"语义。
 */
export function fireConfetti(opts: FireConfettiOptions = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (prefersReducedMotion()) return;

  const cx = opts.originX ?? window.innerWidth / 2;
  const cy = opts.originY ?? window.innerHeight * 0.75;
  const confettiCount = opts.count ?? 28;
  const sequinCount = opts.sequinCount ?? 14;

  // 单独 canvas 挂 body,z 顶层,pointer-events 透传
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:99999;';
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  document.body.appendChild(canvas);

  // 配色 100% 对齐 SuccessConfettiButton 的紫蓝色系
  const colors = [
    { front: '#7b5cff', back: '#6245e0' },
    { front: '#b3c7ff', back: '#8fa5e5' },
    { front: '#5c86ff', back: '#345dd1' },
  ];

  // ── 初始化粒子(从 origin 周围发射) ──
  const confetti: Confetto[] = [];
  const sequins: Sequin[] = [];
  const spread = 90; // 比按钮场景大,因为屏幕中心需要更宽撒点

  for (let i = 0; i < confettiCount; i++) {
    const color = colors[Math.floor(randomRange(0, colors.length))]!;
    confetti.push({
      randomModifier: randomRange(0, 99),
      color,
      dimensions: { x: randomRange(5, 9), y: randomRange(8, 15) },
      position: {
        x: randomRange(cx - spread, cx + spread),
        y: randomRange(cy - 6, cy + 18),
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
        x: randomRange(cx - spread * 0.7, cx + spread * 0.7),
        y: randomRange(cy - 6, cy + 18),
      },
      velocity: { x: randomRange(-6, 6), y: randomRange(-8, -12) },
    });
  }

  // ── 物理参数 100% 对齐按钮版 ──
  const gravityConfetti = 0.3;
  const gravitySequins = 0.55;
  const dragConfetti = 0.075;
  const dragSequins = 0.02;
  const terminalVelocity = 3;

  let rafId: number | null = null;
  let pool = confetti;
  let pool2 = sequins;

  const tick = () => {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
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

    for (let i = 0; i < pool2.length; i++) {
      const s = pool2[i]!;
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

    pool = pool.filter((c) => c.position.y < window.innerHeight + 60);
    pool2 = pool2.filter((s) => s.position.y < window.innerHeight + 60);

    if (pool.length === 0 && pool2.length === 0) {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      canvas.remove();
      rafId = null;
      return;
    }

    rafId = window.requestAnimationFrame(tick);
  };

  rafId = window.requestAnimationFrame(tick);

  // 兜底:5s 后强制清理(防止某些边界条件粒子一直不掉)
  window.setTimeout(() => {
    if (rafId != null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    canvas.remove();
  }, 5000);
}
