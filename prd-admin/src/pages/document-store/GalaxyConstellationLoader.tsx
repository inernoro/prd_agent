// 文档星系专属加载动效：星座连线（用户从候选里选定的「B」，并把几何规则化）。
// 两层同心环（各 6 颗，错开半角，均匀分布）+ 内外辐条，星点渐次亮起 → 连线生长 →
// 光脉冲沿边流动 → 整网呼吸循环。配色取自 DocumentGalaxyView 的 TYPE_COLOR（SSOT 一致）。
// 替换星系的通用 MapSectionLoader（构建星系 / 加载文档 / 加载星系三处）。
import { useEffect, useRef } from 'react';

const TYPE = ['#4ade80', '#60a5fa', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee', '#fb923c'];
const GOLD = '#ffe08a';

export function GalaxyConstellationLoader({ text, size = 176 }: { text?: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = size * dpr;
    cv.height = size * dpr;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const cx = size / 2;
    const cy = size / 2;
    // 规则几何：内环 6 + 外环 6，均匀角距，外环错开半角 → 六边对齐的整齐网格
    const RING = 6;
    const rIn = size * 0.22;
    const rOut = size * 0.4;
    const stars: { x: number; y: number; c: string }[] = [];
    for (let i = 0; i < RING; i++) {
      const a = (i / RING) * Math.PI * 2 - Math.PI / 2;
      stars.push({ x: cx + Math.cos(a) * rIn, y: cy + Math.sin(a) * rIn, c: TYPE[i % TYPE.length] });
    }
    for (let i = 0; i < RING; i++) {
      const a = (i / RING) * Math.PI * 2 - Math.PI / 2 + Math.PI / RING;
      stars.push({ x: cx + Math.cos(a) * rOut, y: cy + Math.sin(a) * rOut, c: TYPE[(i + 3) % TYPE.length] });
    }
    // 边：内环相邻成环 + 外环相邻成环 + 内→外辐条
    const edges: [number, number][] = [];
    for (let i = 0; i < RING; i++) edges.push([i, (i + 1) % RING]);
    for (let i = 0; i < RING; i++) edges.push([RING + i, RING + ((i + 1) % RING)]);
    for (let i = 0; i < RING; i++) edges.push([i, RING + i]);

    let raf = 0;
    const period = 4200;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, size, size);
      const p = (t % period) / period;
      const starP = Math.min(1, p / 0.32);
      const lineP = Math.max(0, Math.min(1, (p - 0.28) / 0.42));
      const fade = p > 0.86 ? 1 - (p - 0.86) / 0.14 : 1;

      ctx.lineWidth = 1;
      for (let e = 0; e < edges.length; e++) {
        const prog = lineP * edges.length - e;
        if (prog <= 0) continue;
        const pp = Math.min(1, prog);
        const a = stars[edges[e][0]];
        const b = stars[edges[e][1]];
        ctx.strokeStyle = `rgba(150,175,225,${0.32 * fade})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(a.x + (b.x - a.x) * pp, a.y + (b.y - a.y) * pp);
        ctx.stroke();
        if (pp >= 1) {
          const fp = ((t * 0.0006) + e * 0.27) % 1;
          ctx.globalAlpha = 0.9 * fade;
          ctx.shadowBlur = 8;
          ctx.shadowColor = '#cfe0ff';
          ctx.fillStyle = '#cfe0ff';
          ctx.beginPath();
          ctx.arc(a.x + (b.x - a.x) * fp, a.y + (b.y - a.y) * fp, 1.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
        }
      }

      for (let j = 0; j < stars.length; j++) {
        const ap = Math.min(1, Math.max(0, starP * stars.length * 1.4 - j));
        if (ap <= 0) continue;
        const s = stars[j];
        const halo = 0.6 + 0.4 * Math.sin(t * 0.003 + j);
        ctx.globalAlpha = ap * fade * 0.5;
        ctx.shadowBlur = 12;
        ctx.shadowColor = s.c;
        ctx.fillStyle = s.c;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 3 + halo, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = ap * fade;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      ctx.globalAlpha = fade;
      ctx.shadowBlur = 18;
      ctx.shadowColor = GOLD;
      ctx.fillStyle = GOLD;
      ctx.beginPath();
      ctx.arc(cx, cy, 4.2 * (1 + 0.2 * Math.sin(t * 0.004)), 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <canvas ref={ref} style={{ width: size, height: size, display: 'block' }} />
      <div
        style={{
          fontWeight: 800,
          letterSpacing: 4,
          fontSize: 15,
          background: 'linear-gradient(180deg,#fafbff,#9aa0b4)',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      >
        MAP
      </div>
      {text && <div style={{ fontSize: 12, color: '#7a7c8a' }}>{text}</div>}
    </div>
  );
}
