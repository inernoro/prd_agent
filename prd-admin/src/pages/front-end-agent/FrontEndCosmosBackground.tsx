import { useEffect, useRef } from 'react';

interface Star {
  x: number;
  y: number;
  z: number;
  twinkle: number;
  twinkleSpeed: number;
  hue: number;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

const STAR_COUNT = 220;
const METEOR_INTERVAL_MS = 4200;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function initStars(width: number, height: number): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: Math.random() * width,
      y: Math.random() * height,
      z: Math.random(),
      twinkle: Math.random() * Math.PI * 2,
      twinkleSpeed: rand(0.004, 0.018),
      hue: rand(200, 255),
    });
  }
  return stars;
}

function spawnMeteor(width: number, height: number): Meteor {
  const fromTop = Math.random() > 0.35;
  const x = fromTop ? rand(0, width) : rand(width * 0.55, width);
  const y = fromTop ? rand(-40, height * 0.25) : rand(0, height * 0.45);
  const angle = rand(Math.PI * 0.55, Math.PI * 0.78);
  const speed = rand(2.8, 5.2);
  const maxLife = rand(48, 90);
  return {
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life: 0,
    maxLife,
  };
}

/**
 * 凄凉粒子宇宙背景：深空星尘、冷色星云、偶发流星。
 * pointer-events-none，不阻挡页面交互。
 */
export function FrontEndCosmosBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let dpr = 1;
    let stars: Star[] = [];
    let meteors: Meteor[] = [];
    let raf = 0;
    let lastMeteorAt = 0;
    let drift = 0;

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = initStars(w, h);
      meteors = [];
    }

    function drawBackground() {
      const g = ctx!.createRadialGradient(w * 0.5, h * 0.42, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
      g.addColorStop(0, 'rgba(18, 24, 48, 0.55)');
      g.addColorStop(0.45, 'rgba(6, 10, 22, 0.82)');
      g.addColorStop(1, 'rgba(2, 4, 10, 0.98)');
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, w, h);

      const nebula = ctx!.createRadialGradient(w * 0.22, h * 0.18, 0, w * 0.22, h * 0.18, w * 0.35);
      nebula.addColorStop(0, 'rgba(56, 88, 168, 0.12)');
      nebula.addColorStop(1, 'rgba(56, 88, 168, 0)');
      ctx!.fillStyle = nebula;
      ctx!.fillRect(0, 0, w, h);

      const nebula2 = ctx!.createRadialGradient(w * 0.82, h * 0.72, 0, w * 0.82, h * 0.72, w * 0.28);
      nebula2.addColorStop(0, 'rgba(88, 52, 128, 0.1)');
      nebula2.addColorStop(1, 'rgba(88, 52, 128, 0)');
      ctx!.fillStyle = nebula2;
      ctx!.fillRect(0, 0, w, h);
    }

    function drawFrame(ts: number) {
      if (!reducedMotion && ts - lastMeteorAt > METEOR_INTERVAL_MS && Math.random() > 0.35) {
        meteors.push(spawnMeteor(w, h));
        lastMeteorAt = ts;
      }

      drift += reducedMotion ? 0 : 0.00035;
      ctx!.clearRect(0, 0, w, h);
      drawBackground();

      for (const star of stars) {
        if (!reducedMotion) {
          star.x += Math.sin(drift + star.z * 6) * (0.02 + star.z * 0.05);
          star.y += Math.cos(drift * 0.7 + star.z * 4) * (0.015 + star.z * 0.04);
          if (star.x < -4) star.x = w + 4;
          if (star.x > w + 4) star.x = -4;
          if (star.y < -4) star.y = h + 4;
          if (star.y > h + 4) star.y = -4;
          star.twinkle += star.twinkleSpeed;
        }

        const pulse = reducedMotion ? 0.65 : 0.35 + Math.sin(star.twinkle) * 0.35;
        const size = (0.4 + star.z * 1.6) * (star.z > 0.85 ? 1.35 : 1);
        const alpha = (0.12 + star.z * 0.55) * pulse;

        ctx!.beginPath();
        ctx!.fillStyle = `hsla(${star.hue}, 42%, ${58 + star.z * 28}%, ${alpha})`;
        ctx!.arc(star.x, star.y, size, 0, Math.PI * 2);
        ctx!.fill();

        if (star.z > 0.9 && !reducedMotion) {
          ctx!.beginPath();
          ctx!.strokeStyle = `hsla(${star.hue}, 55%, 78%, ${alpha * 0.35})`;
          ctx!.lineWidth = 0.6;
          ctx!.moveTo(star.x - size * 3, star.y);
          ctx!.lineTo(star.x + size * 3, star.y);
          ctx!.moveTo(star.x, star.y - size * 3);
          ctx!.lineTo(star.x, star.y + size * 3);
          ctx!.stroke();
        }
      }

      meteors = meteors.filter((m) => {
        m.life += 1;
        m.x += m.vx;
        m.y += m.vy;
        const t = 1 - m.life / m.maxLife;
        if (t <= 0) return false;

        const tailLen = 42 * t;
        const grad = ctx!.createLinearGradient(m.x, m.y, m.x - m.vx * tailLen, m.y - m.vy * tailLen);
        grad.addColorStop(0, `rgba(186, 214, 255, ${0.55 * t})`);
        grad.addColorStop(1, 'rgba(186, 214, 255, 0)');
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = 1.2 * t;
        ctx!.beginPath();
        ctx!.moveTo(m.x, m.y);
        ctx!.lineTo(m.x - m.vx * tailLen, m.y - m.vy * tailLen);
        ctx!.stroke();
        return true;
      });

      const vignette = ctx!.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.2, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx!.fillStyle = vignette;
      ctx!.fillRect(0, 0, w, h);

      raf = requestAnimationFrame(drawFrame);
    }

    resize();
    raf = requestAnimationFrame(drawFrame);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full block" />
      <div className="fea-cosmos-nebula fea-cosmos-nebula-a absolute -left-24 top-10 w-80 h-80 rounded-full bg-indigo-500/[0.08] blur-3xl" />
      <div className="fea-cosmos-nebula fea-cosmos-nebula-b absolute right-0 bottom-0 w-96 h-96 rounded-full bg-violet-600/[0.06] blur-3xl" />
      <div className="fea-cosmos-nebula fea-cosmos-nebula-c absolute left-1/3 top-1/2 w-64 h-64 rounded-full bg-cyan-400/[0.04] blur-3xl" />
      <div className="absolute inset-0 bg-gradient-to-b from-[#02040a]/20 via-transparent to-[#02040a]/75" />
      <div
        className="absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.45) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.45) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
        }}
      />
    </div>
  );
}
