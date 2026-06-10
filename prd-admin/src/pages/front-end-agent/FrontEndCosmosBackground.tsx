import { useEffect, useRef } from 'react';

interface Star {
  x: number;
  y: number;
  z: number;
  twinkle: number;
  twinkleSpeed: number;
  hue: number;
  warm: boolean;
}

interface Meteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  warm: boolean;
  width: number;
}

interface DustMote {
  x: number;
  y: number;
  size: number;
  drift: number;
  speed: number;
  alpha: number;
}

const STAR_COUNT = 420;
const DUST_COUNT = 64;
const METEOR_BASE_INTERVAL_MS = 950;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function initStars(width: number, height: number): Star[] {
  const stars: Star[] = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const warm = Math.random() > 0.42;
    stars.push({
      x: Math.random() * width,
      y: Math.random() * height,
      z: Math.random(),
      twinkle: Math.random() * Math.PI * 2,
      twinkleSpeed: rand(0.003, 0.022),
      hue: warm ? rand(32, 52) : rand(205, 248),
      warm,
    });
  }
  return stars;
}

function initDust(width: number, height: number): DustMote[] {
  const dust: DustMote[] = [];
  for (let i = 0; i < DUST_COUNT; i++) {
    dust.push({
      x: Math.random() * width,
      y: Math.random() * height,
      size: rand(0.3, 1.4),
      drift: Math.random() * Math.PI * 2,
      speed: rand(0.08, 0.28),
      alpha: rand(0.08, 0.35),
    });
  }
  return dust;
}

function spawnMeteor(width: number, height: number): Meteor {
  const fromTop = Math.random() > 0.28;
  const x = fromTop ? rand(0, width) : rand(width * 0.45, width);
  const y = fromTop ? rand(-60, height * 0.32) : rand(0, height * 0.5);
  const angle = rand(Math.PI * 0.52, Math.PI * 0.8);
  const speed = rand(3.2, 7.5);
  const warm = Math.random() > 0.38;
  return {
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    life: 0,
    maxLife: rand(36, warm ? 110 : 78),
    warm,
    width: warm ? rand(1.4, 2.4) : rand(0.9, 1.6),
  };
}

function meteorTailColor(m: Meteor, t: number): [string, string] {
  if (m.warm) {
    return [`rgba(255, 214, 158, ${0.72 * t})`, 'rgba(255, 180, 90, 0)'];
  }
  return [`rgba(210, 228, 255, ${0.62 * t})`, 'rgba(186, 214, 255, 0)'];
}

/**
 * 怀旧星夜背景：暖冷交织星尘、密集流星、浮游光粒。
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
    let dust: DustMote[] = [];
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
      dust = initDust(w, h);
      meteors = [];
    }

    function drawBackground() {
      const g = ctx!.createRadialGradient(w * 0.48, h * 0.38, 0, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
      g.addColorStop(0, 'rgba(42, 28, 18, 0.42)');
      g.addColorStop(0.35, 'rgba(18, 14, 28, 0.78)');
      g.addColorStop(1, 'rgba(6, 5, 10, 0.98)');
      ctx!.fillStyle = g;
      ctx!.fillRect(0, 0, w, h);

      const band = ctx!.createLinearGradient(0, h * 0.15, w, h * 0.55);
      band.addColorStop(0, 'rgba(120, 72, 40, 0)');
      band.addColorStop(0.45, 'rgba(88, 56, 88, 0.07)');
      band.addColorStop(1, 'rgba(40, 48, 96, 0)');
      ctx!.fillStyle = band;
      ctx!.fillRect(0, 0, w, h);

      const nebula = ctx!.createRadialGradient(w * 0.18, h * 0.22, 0, w * 0.18, h * 0.22, w * 0.38);
      nebula.addColorStop(0, 'rgba(180, 120, 60, 0.1)');
      nebula.addColorStop(1, 'rgba(180, 120, 60, 0)');
      ctx!.fillStyle = nebula;
      ctx!.fillRect(0, 0, w, h);

      const nebula2 = ctx!.createRadialGradient(w * 0.85, h * 0.68, 0, w * 0.85, h * 0.68, w * 0.32);
      nebula2.addColorStop(0, 'rgba(88, 52, 128, 0.12)');
      nebula2.addColorStop(1, 'rgba(88, 52, 128, 0)');
      ctx!.fillStyle = nebula2;
      ctx!.fillRect(0, 0, w, h);
    }

    function spawnMeteorBurst(ts: number) {
      const roll = Math.random();
      const count = roll > 0.82 ? 4 : roll > 0.48 ? 2 : 1;
      for (let i = 0; i < count; i++) {
        meteors.push(spawnMeteor(w, h));
      }
      lastMeteorAt = ts + rand(-300, 500);
    }

    function drawFrame(ts: number) {
      if (!reducedMotion && ts - lastMeteorAt > METEOR_BASE_INTERVAL_MS * rand(0.65, 1.1)) {
        spawnMeteorBurst(ts);
      }

      drift += reducedMotion ? 0 : 0.00042;
      ctx!.clearRect(0, 0, w, h);
      drawBackground();

      for (const mote of dust) {
        if (!reducedMotion) {
          mote.x += Math.cos(mote.drift + drift * 2) * mote.speed;
          mote.y += Math.sin(mote.drift * 0.8 + drift) * mote.speed * 0.6;
          if (mote.x < -2) mote.x = w + 2;
          if (mote.x > w + 2) mote.x = -2;
          if (mote.y < -2) mote.y = h + 2;
          if (mote.y > h + 2) mote.y = -2;
        }
        ctx!.beginPath();
        ctx!.fillStyle = `rgba(255, 210, 150, ${mote.alpha})`;
        ctx!.arc(mote.x, mote.y, mote.size, 0, Math.PI * 2);
        ctx!.fill();
      }

      for (const star of stars) {
        if (!reducedMotion) {
          star.x += Math.sin(drift + star.z * 6) * (0.018 + star.z * 0.04);
          star.y += Math.cos(drift * 0.7 + star.z * 4) * (0.014 + star.z * 0.035);
          if (star.x < -4) star.x = w + 4;
          if (star.x > w + 4) star.x = -4;
          if (star.y < -4) star.y = h + 4;
          if (star.y > h + 4) star.y = -4;
          star.twinkle += star.twinkleSpeed;
        }

        const pulse = reducedMotion ? 0.65 : 0.32 + Math.sin(star.twinkle) * 0.38;
        const size = (0.35 + star.z * 1.7) * (star.z > 0.88 ? 1.4 : 1);
        const alpha = (0.1 + star.z * 0.58) * pulse;
        const light = star.warm ? 62 + star.z * 30 : 58 + star.z * 28;
        const sat = star.warm ? 68 : 42;

        ctx!.beginPath();
        ctx!.fillStyle = `hsla(${star.hue}, ${sat}%, ${light}%, ${alpha})`;
        ctx!.arc(star.x, star.y, size, 0, Math.PI * 2);
        ctx!.fill();

        if (star.z > 0.86 && !reducedMotion) {
          ctx!.beginPath();
          ctx!.strokeStyle = `hsla(${star.hue}, ${sat + 8}%, ${light + 12}%, ${alpha * 0.4})`;
          ctx!.lineWidth = 0.55;
          const arm = size * (star.warm ? 3.5 : 2.8);
          ctx!.moveTo(star.x - arm, star.y);
          ctx!.lineTo(star.x + arm, star.y);
          ctx!.moveTo(star.x, star.y - arm);
          ctx!.lineTo(star.x, star.y + arm);
          ctx!.stroke();
        }
      }

      meteors = meteors.filter((m) => {
        m.life += 1;
        m.x += m.vx;
        m.y += m.vy;
        const t = 1 - m.life / m.maxLife;
        if (t <= 0) return false;

        const tailLen = (m.warm ? 58 : 48) * t;
        const [head, tail] = meteorTailColor(m, t);
        const grad = ctx!.createLinearGradient(
          m.x, m.y,
          m.x - m.vx * tailLen, m.y - m.vy * tailLen,
        );
        grad.addColorStop(0, head);
        grad.addColorStop(1, tail);
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = m.width * t;
        ctx!.lineCap = 'round';
        ctx!.beginPath();
        ctx!.moveTo(m.x, m.y);
        ctx!.lineTo(m.x - m.vx * tailLen, m.y - m.vy * tailLen);
        ctx!.stroke();

        if (m.warm && t > 0.55) {
          ctx!.beginPath();
          ctx!.fillStyle = `rgba(255, 236, 190, ${0.35 * t})`;
          ctx!.arc(m.x, m.y, 1.8 * t, 0, Math.PI * 2);
          ctx!.fill();
        }
        return true;
      });

      const vignette = ctx!.createRadialGradient(
        w * 0.5, h * 0.48, Math.min(w, h) * 0.18,
        w * 0.5, h * 0.5, Math.max(w, h) * 0.78,
      );
      vignette.addColorStop(0, 'rgba(0,0,0,0)');
      vignette.addColorStop(1, 'rgba(12, 8, 4, 0.62)');
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
      <div className="fea-cosmos-nebula fea-cosmos-nebula-a absolute -left-28 top-6 w-96 h-96 rounded-full bg-amber-600/[0.09] blur-3xl" />
      <div className="fea-cosmos-nebula fea-cosmos-nebula-b absolute -right-16 bottom-0 w-[28rem] h-[28rem] rounded-full bg-violet-700/[0.08] blur-3xl" />
      <div className="fea-cosmos-nebula fea-cosmos-nebula-c absolute left-1/3 top-1/2 w-72 h-72 rounded-full bg-rose-900/[0.05] blur-3xl" />
      <div className="fea-cosmos-nebula fea-cosmos-nebula-d absolute right-1/4 top-12 w-48 h-48 rounded-full bg-sky-500/[0.05] blur-3xl" />
      <div className="fea-css-meteors absolute inset-0 overflow-hidden">
        <span className="fea-css-meteor fea-css-meteor-1" />
        <span className="fea-css-meteor fea-css-meteor-2" />
        <span className="fea-css-meteor fea-css-meteor-3" />
        <span className="fea-css-meteor fea-css-meteor-4" />
        <span className="fea-css-meteor fea-css-meteor-5" />
        <span className="fea-css-meteor fea-css-meteor-6" />
        <span className="fea-css-meteor fea-css-meteor-7" />
        <span className="fea-css-meteor fea-css-meteor-8" />
      </div>
      <div className="absolute inset-0 bg-gradient-to-b from-[#1a1208]/25 via-transparent to-[#08060c]/80" />
      <div className="fea-film-grain absolute inset-0" />
      <div className="fea-scanlines absolute inset-0" />
    </div>
  );
}
