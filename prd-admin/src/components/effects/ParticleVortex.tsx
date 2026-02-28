import { useRef, useEffect, useCallback } from 'react';

/**
 * 绿色粒子争夺 - 基于 thirdparty/ref/加载-绿色粒子争夺.html
 * Canvas 双缓冲 + 多层 blur 旋转叠加，支持鼠标交互
 */

interface ParticleVortexProps {
  /** 粒子数量，默认 300 */
  particleCount?: number;
  /** 是否启用鼠标跟随，默认 false */
  mouseFollow?: boolean;
  /** 拖尾填充色，需与宿主背景匹配以消除矩形边框，默认 'rgba(20,20,20,0.8)' */
  trailColor?: string;
  /** 额外 className */
  className?: string;
}

/* ---- Simplex Noise (精简内联) ---- */
const GRAD3 = new Float32Array([1,1,0,-1,1,0,1,-1,0,-1,-1,0,1,0,1,-1,0,1,1,0,-1,-1,0,-1,0,1,1,0,-1,1,0,1,-1,0,-1,-1]);
function buildPerm() {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }
  return { perm, permMod12 };
}
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
function noise2D(perm: Uint8Array, permMod12: Uint8Array, x: number, y: number) {
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = x0 > y0 ? 0 : 1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const ii = i & 255;
  const jj = j & 255;
  let n0 = 0, n1 = 0, n2 = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 >= 0) { const gi = 3 * permMod12[ii + perm[jj]]; t0 *= t0; n0 = t0 * t0 * (GRAD3[gi] * x0 + GRAD3[gi + 1] * y0); }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 >= 0) { const gi = 3 * permMod12[ii + i1 + perm[jj + j1]]; t1 *= t1; n1 = t1 * t1 * (GRAD3[gi] * x1 + GRAD3[gi + 1] * y1); }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 >= 0) { const gi = 3 * permMod12[ii + 1 + perm[jj + 1]]; t2 *= t2; n2 = t2 * t2 * (GRAD3[gi] * x2 + GRAD3[gi + 1] * y2); }
  return 70 * (n0 + n1 + n2);
}

/* ---- 工具函数 ---- */
const { PI, cos, sin, abs, random, atan2 } = Math;
const TAU = 2 * PI;
const rand = (n: number) => n * random();
const randIn = (min: number, max: number) => rand(max - min) + min;
const fadeInOut = (t: number, m: number) => { const hm = 0.5 * m; return abs((t + hm) % m - hm) / hm; };
const angle = (x1: number, y1: number, x2: number, y2: number) => atan2(y2 - y1, x2 - x1);
const lerp = (n1: number, n2: number, speed: number) => (1 - speed) * n1 + speed * n2;

/* ---- 粒子 ---- */
interface Particle {
  life: number;
  ttl: number;
  size: number;
  hue: number;
  position: [number, number];
  velocity: [number, number];
  alpha: number;
}

function createParticle(origin: [number, number]): Particle {
  const direction = rand(TAU);
  const speed = randIn(20, 40);
  const p: Particle = {
    life: 0,
    ttl: randIn(100, 300),
    size: randIn(2, 8),
    hue: randIn(80, 150),
    position: [origin[0] + rand(200) * cos(direction), origin[1] + rand(200) * sin(direction)],
    velocity: [cos(direction) * speed, sin(direction) * speed],
    get alpha() { return fadeInOut(this.life, this.ttl); },
  };
  return p;
}

function resetParticle(p: Particle, origin: [number, number]) {
  const direction = rand(TAU);
  const speed = randIn(20, 40);
  p.life = 0;
  p.ttl = randIn(100, 300);
  p.size = randIn(2, 8);
  p.hue = randIn(80, 150);
  p.position[0] = origin[0] + rand(200) * cos(direction);
  p.position[1] = origin[1] + rand(200) * sin(direction);
  p.velocity[0] = cos(direction) * speed;
  p.velocity[1] = sin(direction) * speed;
}

export function ParticleVortex({
  particleCount = 300,
  mouseFollow = false,
  trailColor = 'rgba(20,20,20,0.8)',
  className,
}: ParticleVortexProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const stateRef = useRef({
    hover: false,
    mouse: [0, 0] as [number, number],
    mouseFollow,
    trailColor,
  });

  // 同步 props
  useEffect(() => { stateRef.current.mouseFollow = mouseFollow; }, [mouseFollow]);
  useEffect(() => { stateRef.current.trailColor = trailColor; }, [trailColor]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas || !stateRef.current.mouseFollow) return;
    const rect = canvas.getBoundingClientRect();
    stateRef.current.hover = true;
    stateRef.current.mouse[0] = e.clientX - rect.left;
    stateRef.current.mouse[1] = e.clientY - rect.top;
  }, []);

  const handleMouseOut = useCallback(() => {
    stateRef.current.hover = false;
  }, []);

  useEffect(() => {
    const displayCanvas = canvasRef.current;
    if (!displayCanvas) return;

    const renderCanvas = document.createElement('canvas');
    const ctxA = renderCanvas.getContext('2d')!;
    const ctxB = displayCanvas.getContext('2d')!;

    let w = 0, h = 0;
    const origin: [number, number] = [0, 0];
    const { perm, permMod12 } = buildPerm();
    void noise2D(perm, permMod12, 0, 0); // warm up — keep tree-shaking from removing

    const particles: Particle[] = [];

    function resize() {
      const rect = displayCanvas!.getBoundingClientRect();
      w = rect.width * devicePixelRatio;
      h = rect.height * devicePixelRatio;
      renderCanvas.width = displayCanvas!.width = w;
      renderCanvas.height = displayCanvas!.height = h;
      origin[0] = w * 0.5;
      origin[1] = h * 0.5;
    }

    function initParticles() {
      particles.length = 0;
      for (let i = 0; i < particleCount; i++) {
        particles.push(createParticle(origin));
      }
    }

    function draw() {
      const st = stateRef.current;
      const mx = st.mouse[0] * devicePixelRatio;
      const my = st.mouse[1] * devicePixelRatio;

      ctxA.clearRect(0, 0, w, h);
      ctxB.fillStyle = stateRef.current.trailColor;
      ctxB.fillRect(0, 0, w, h);

      // 绘制 + 更新粒子
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const [px, py] = p.position;
        const [vx, vy] = p.velocity;

        // draw
        ctxA.save();
        ctxA.beginPath();
        ctxA.fillStyle = `hsla(${p.hue},50%,50%,${p.alpha})`;
        ctxA.arc(px, py, p.size, 0, TAU);
        ctxA.fill();
        ctxA.closePath();
        ctxA.restore();

        // update
        const mDir = angle(mx, my, px, py);
        const isHover = st.mouseFollow && st.hover;
        p.position[0] = lerp(px, px + vx, 0.05);
        p.position[1] = lerp(py, py + vy, 0.05);
        p.velocity[0] = lerp(vx, isHover ? cos(mDir) * 30 : 0, isHover ? 0.1 : 0.01);
        p.velocity[1] = lerp(vy, isHover ? sin(mDir) * 30 : 0, isHover ? 0.1 : 0.01);

        const outOfBounds = px > w + p.size || px < -p.size || py > h + p.size || py < -p.size;
        if (outOfBounds || p.life++ > p.ttl) resetParticle(p, origin);
      }

      // 多层旋转 blur 叠加
      for (let i = 20; i >= 1; i--) {
        const amt = i * 0.05;
        ctxB.save();
        ctxB.filter = `blur(${amt * 5}px)`;
        ctxB.globalAlpha = 1 - amt;
        ctxB.setTransform(1 - amt, 0, 0, 1 - amt, origin[0] * amt, origin[1] * amt);
        ctxB.translate(origin[0], origin[1]);
        ctxB.rotate(amt * 8);
        ctxB.translate(-origin[0], -origin[1]);
        ctxB.drawImage(renderCanvas, 0, 0, w, h);
        ctxB.restore();
      }

      // 辉光层
      ctxB.save();
      ctxB.filter = 'blur(8px) brightness(200%)';
      ctxB.drawImage(renderCanvas, 0, 0);
      ctxB.restore();

      // 叠加层
      ctxB.save();
      ctxB.globalCompositeOperation = 'lighter';
      ctxB.drawImage(renderCanvas, 0, 0);
      ctxB.restore();

      rafRef.current = requestAnimationFrame(draw);
    }

    resize();
    initParticles();
    draw();

    const el = displayCanvas;
    el.addEventListener('mousemove', handleMouseMove);
    el.addEventListener('mouseout', handleMouseOut);
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    return () => {
      cancelAnimationFrame(rafRef.current);
      el.removeEventListener('mousemove', handleMouseMove);
      el.removeEventListener('mouseout', handleMouseOut);
      ro.disconnect();
    };
  }, [particleCount, handleMouseMove, handleMouseOut]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: '100%', height: '100%', display: 'block' }}
    />
  );
}
