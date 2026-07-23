/**
 * 宝石六芒(CdsGem)的服务端渲染版 — 供 loading-pages / proxy 等待页内嵌。
 *
 * 几何与矿色是 cds/web/src/components/brand/CdsGem.tsx 的 1:1 移植(12 切面:
 * 6 核心三角 + 6 星尖,R=28 撑满 viewBox 87.5%)。动效为「组装-碎裂叙事」
 * (2026-07-22 用户定稿,状态系统设定 v2 的 loader 签名同步换代):
 * 逐面弹入组装 → 驻留段轮流呼吸(不再死板静止)→ 逐面旋转碎裂 → 循环。
 *
 * 改几何/矿色请两处同步(本文件 + CdsGem.tsx);动效签名同理
 * (本文件 GEM_STORY_CSS + cds/web/src/index.css 的 cds-gem-story)。
 */

export type ServerGemMineral =
  | 'ember' | 'iris' | 'amethyst' | 'amber' | 'galaxy'
  | 'emerald' | 'moonstone' | 'garnet' | 'graphite' | 'aqua';

/** 矿色色阶(暗 → 亮,6 阶)— 与 CdsGem.tsx GEM_SHADES 一致。 */
export const SERVER_GEM_SHADES: Record<ServerGemMineral, readonly [string, string, string, string, string, string]> = {
  ember: ['#7c2d12', '#9a3412', '#c2410c', '#ea580c', '#f97316', '#fb923c'],
  iris: ['#2e1065', '#4c1d95', '#6d28d9', '#4f46e5', '#3b82f6', '#38bdf8'],
  amethyst: ['#2e1065', '#4c1d95', '#6d28d9', '#7c3aed', '#8b5cf6', '#a78bfa'],
  amber: ['#713f12', '#92400e', '#b45309', '#d97706', '#f59e0b', '#fbbf24'],
  galaxy: ['#1e1b4b', '#312e81', '#3730a3', '#1d4ed8', '#0284c7', '#22d3ee'],
  emerald: ['#064e3b', '#065f46', '#047857', '#059669', '#10b981', '#34d399'],
  moonstone: ['#334155', '#475569', '#64748b', '#94a3b8', '#cbd5e1', '#e2e8f0'],
  garnet: ['#7f1d1d', '#991b1b', '#b91c1c', '#dc2626', '#ef4444', '#f87171'],
  graphite: ['#27272a', '#3f3f46', '#52525b', '#71717a', '#a1a1aa', '#d4d4d8'],
  aqua: ['#164e63', '#155e75', '#0e7490', '#0891b2', '#06b6d4', '#22d3ee'],
};

/** 分支状态 → 矿色(对齐 CdsGem.tsx 的 gemModeForStatus + GEM_MODE_MINERAL)。 */
export function serverGemMineralForStatus(status: string): ServerGemMineral {
  if (status === 'building') return 'amber';
  if (status === 'starting' || status === 'restarting' || status === 'deploying') return 'galaxy';
  if (status === 'error') return 'garnet';
  if (status === 'frozen' || status === 'hibernated') return 'aqua';
  return 'iris';
}

interface ServerGemFacet { points: string; shadeIdx: number; i: number }

const SERVER_GEM_FACETS: readonly ServerGemFacet[] = (() => {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const pt = (R: number, deg: number): [number, number] => [
    32 + R * Math.cos(rad(deg)),
    32 + R * Math.sin(rad(deg)),
  ];
  const fmt = (pts: Array<[number, number]>): string =>
    pts.map((p) => p.map((n) => +n.toFixed(2)).join(',')).join(' ');
  const R = 28;
  const r = R / Math.sqrt(3);
  const hex = [0, 1, 2, 3, 4, 5].map((k) => pt(r, -60 + k * 60));
  const facets: ServerGemFacet[] = [];
  for (let k = 0; k < 6; k++) {
    facets.push({ points: fmt([[32, 32], hex[k], hex[(k + 1) % 6]]), shadeIdx: k % 6, i: 2 * k });
  }
  for (let k = 0; k < 6; k++) {
    facets.push({ points: fmt([pt(R, -90 + k * 60), hex[(k + 5) % 6], hex[k]]), shadeIdx: (k + 3) % 6, i: 2 * k + 1 });
  }
  return facets;
})();

/**
 * 组装-碎裂叙事的 CSS(keyframes + 类)。内嵌进等待页 <style>。
 * 周期通过 --cds-gem-dur 覆盖(默认 2.9s);切面相位由 --gi 内联变量错开。
 */
export const GEM_STORY_CSS = `
.cds-gem-story{display:inline-block;overflow:visible;filter:drop-shadow(0 0 14px rgba(99,102,241,.28))}
.cds-gem-story .cds-gem-story-facet{transform-origin:center;transform-box:fill-box;animation:cds-gem-story var(--cds-gem-dur,2.9s) cubic-bezier(.4,.1,.4,.9) infinite both;animation-delay:calc(var(--gi,0)*.07s)}
@keyframes cds-gem-story{
  0%{transform:scale(0);opacity:0}
  9%{transform:scale(1.1);opacity:1}
  13%{transform:scale(1);opacity:1}
  30%{opacity:1}
  45%{opacity:.68}
  60%{opacity:1}
  76%{transform:scale(1);opacity:1}
  88%{transform:scale(.5) rotate(-10deg);opacity:0}
  100%{transform:scale(0);opacity:0}
}
@media (prefers-reduced-motion:reduce){.cds-gem-story .cds-gem-story-facet{animation:none}}
`.trim();

/** 生成内嵌 SVG(12 切面 + --gi 相位变量)。durSeconds 覆盖周期(默认 2.9s)。 */
export function buildGemStorySvg(mineral: ServerGemMineral, sizePx: number, durSeconds?: number): string {
  const shades = SERVER_GEM_SHADES[mineral] ?? SERVER_GEM_SHADES.iris;
  const durStyle = durSeconds ? `--cds-gem-dur:${durSeconds}s;` : '';
  const polys = SERVER_GEM_FACETS.map((f) => {
    const c = shades[f.shadeIdx];
    return `<polygon class="cds-gem-story-facet" points="${f.points}" fill="${c}" stroke="${c}" stroke-width="0.5" stroke-linejoin="round" style="--gi:${f.i}"/>`;
  }).join('');
  return `<svg class="cds-gem-story" width="${sizePx}" height="${sizePx}" viewBox="0 0 64 64" role="img" aria-label="CDS" style="${durStyle}">${polys}</svg>`;
}
