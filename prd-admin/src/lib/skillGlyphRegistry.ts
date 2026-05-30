/**
 * 技能卡图标（v6：游戏技能图标方向）。
 *
 * 设计：暖彩手绘线条 + 六边「技能槽」框（悬浮缓缓旋转，像游戏点亮技能）+
 * 每个系统技能的专属象形符号；无专属符号的技能回退哈希抽象形态。
 * feTurbulence 轻度做旧成手绘抖线，暖色辉光。
 *
 * 纯函数：(seed) → SVG 片段。seed 形如 official-{key}（官方）或社区 id/title。
 */

export const GLYPH_SIZE = 92;
const CX = 46;
const CY = 46;

export function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}
function rng(seed: number): () => number {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
function deriveKey(seed: string): string {
  return seed.startsWith('official-') ? seed.slice('official-'.length) : seed;
}

/** 暖色板（赤陶/琥珀，色相 10~45） */
function pal(seed: string): [string, string, string] {
  const h = hash32(seed);
  const b = 10 + (h % 36);
  return [`hsl(${b} 74% 66%)`, `hsl(${(b + 14) % 360} 70% 58%)`, `hsl(${(b + 28) % 360} 64% 50%)`];
}
export function glyphGlow(seed: string): string {
  const b = 10 + (hash32(seed) % 36);
  return `hsla(${b} 80% 62% / .55)`;
}
export function glyphWarmBg(seed: string): string {
  const b = 10 + (hash32(seed) % 36);
  return `hsla(${b} 70% 55% / .16)`;
}
export function glyphCardGlow(seed: string): string {
  const b = 10 + (hash32(seed) % 36);
  return `hsla(${b} 75% 58% / .45)`;
}

// ── 六边技能槽框 ──────────────────────────────────────────────────────────
function polyPts(n: number, r: number, rot: number): string {
  let p = '';
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    p += `${i ? 'L' : 'M'}${(CX + Math.cos(a) * r).toFixed(2)},${(CY + Math.sin(a) * r).toFixed(2)} `;
  }
  return p + 'Z';
}
function frameHex(c: [string, string, string]): string {
  const out = polyPts(6, GLYPH_SIZE * 0.46, -Math.PI / 2);
  const inn = polyPts(6, GLYPH_SIZE * 0.4, -Math.PI / 2);
  let studs = '';
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
    studs += `<circle cx="${(CX + Math.cos(a) * GLYPH_SIZE * 0.46).toFixed(2)}" cy="${(CY + Math.sin(a) * GLYPH_SIZE * 0.46).toFixed(2)}" r="1.7" fill="${c[1]}"/>`;
  }
  return `<g class="frame"><path d="${out}" fill="none" stroke="${c[0]}" stroke-width="1.7" stroke-linejoin="round"/><path d="${inn}" fill="none" stroke="${c[2]}" stroke-width="1" stroke-linejoin="round" opacity="0.7"/>${studs}</g>`;
}

// ── 专属象形符号（暖彩线描）──────────────────────────────────────────────
const SYMBOLS: Record<string, (c: [string, string, string]) => string> = {
  'acceptance-checklist': (c) => `
    <rect x="34" y="30" width="24" height="30" rx="2.5" fill="none" stroke="${c[0]}" stroke-width="1.7"/>
    <rect x="40" y="26" width="12" height="6" rx="2" fill="none" stroke="${c[0]}" stroke-width="1.5"/>
    <line x1="38" y1="40" x2="50" y2="40" stroke="${c[2]}" stroke-width="1.3"/>
    <line x1="38" y1="46" x2="50" y2="46" stroke="${c[2]}" stroke-width="1.3"/>
    <path d="M38,53 l3,3 l6,-7" fill="none" stroke="${c[1]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  'human-verify': (c) => `
    <path d="M30,46 Q46,32 62,46 Q46,60 30,46 Z" fill="none" stroke="${c[0]}" stroke-width="1.7"/>
    <circle cx="46" cy="46" r="6.5" fill="none" stroke="${c[1]}" stroke-width="1.5"/>
    <circle cx="46" cy="46" r="2.4" fill="${c[0]}"/>`,
  'risk-matrix': (c) => `
    <rect x="32" y="32" width="28" height="28" rx="2" fill="none" stroke="${c[0]}" stroke-width="1.7"/>
    <line x1="46" y1="32" x2="46" y2="60" stroke="${c[2]}" stroke-width="1.2"/>
    <line x1="32" y1="46" x2="60" y2="46" stroke="${c[2]}" stroke-width="1.2"/>
    <rect x="47" y="33" width="12" height="12" fill="${c[0]}" opacity="0.32"/>`,
  'code-hygiene': (c) => `
    <line x1="56" y1="30" x2="42" y2="48" stroke="${c[0]}" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M42,48 L34,52 L38,60 L48,56 Z" fill="none" stroke="${c[0]}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M36,53 l3,5 M40,51 l3,5 M44,50 l2.5,5" stroke="${c[2]}" stroke-width="1" stroke-linecap="round"/>
    <path d="M58,42 l0,5 M55.5,44.5 l5,0" stroke="${c[1]}" stroke-width="1.5" stroke-linecap="round"/>`,
  'laowang': (c) => `
    <path d="M28,60 L42,38 L50,50 L56,42 L64,60 Z" fill="${c[0]}" fill-opacity="0.2" stroke="${c[0]}" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M46,22 l2.2,4.6 l5,0.6 l-3.6,3.5 l0.9,5 l-4.5,-2.4 l-4.5,2.4 l0.9,-5 l-3.6,-3.5 l5,-0.6 Z" fill="${c[1]}" stroke="${c[0]}" stroke-width="1"/>`,
  'theme-transition': (c) => `
    <circle cx="46" cy="46" r="13" fill="none" stroke="${c[0]}" stroke-width="1.7"/>
    <path d="M46,33 A13,13 0 0,0 46,59 Z" fill="${c[0]}" opacity="0.3"/>
    <path d="M46,28 v-4 M46,68 v-4 M28,46 h-4 M68,46 h4 M33,33 l-3,-3 M59,59 l3,3 M59,33 l3,-3 M33,59 l-3,3" stroke="${c[1]}" stroke-width="1.1" stroke-linecap="round"/>`,
  'find-skills': (c) => `
    <circle cx="34" cy="40" r="2" fill="${c[2]}"/><circle cx="42" cy="36" r="2" fill="${c[2]}"/><circle cx="50" cy="42" r="2" fill="${c[2]}"/>
    <circle cx="45" cy="46" r="11" fill="none" stroke="${c[0]}" stroke-width="1.8"/>
    <line x1="53" y1="54" x2="62" y2="63" stroke="${c[0]}" stroke-width="2.4" stroke-linecap="round"/>`,
  'create-skill-file': (c) => `
    <path d="M36,28 H52 L60,36 V64 H36 Z" fill="none" stroke="${c[0]}" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M52,28 V36 H60" fill="none" stroke="${c[2]}" stroke-width="1.3"/>
    <path d="M46,44 v10 M41,49 h10" stroke="${c[1]}" stroke-width="1.8" stroke-linecap="round"/>`,
  'conflict-resolution': (c) => `
    <path d="M34,28 V52 Q34,60 46,60 Q58,60 58,52 V28" fill="none" stroke="${c[0]}" stroke-width="1.7"/>
    <circle cx="34" cy="26" r="3" fill="none" stroke="${c[0]}" stroke-width="1.5"/>
    <circle cx="58" cy="26" r="3" fill="none" stroke="${c[0]}" stroke-width="1.5"/>
    <circle cx="46" cy="62" r="3" fill="${c[1]}"/>`,
  'task-handoff-checklist': (c) => `
    <path d="M30,46 H56" stroke="${c[0]}" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M50,40 l7,6 l-7,6" fill="none" stroke="${c[0]}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="30" cy="46" r="4" fill="none" stroke="${c[1]}" stroke-width="1.6"/>`,
  'ui-ux-pro-max': (c) => `
    <rect x="30" y="30" width="32" height="32" rx="2.5" fill="none" stroke="${c[0]}" stroke-width="1.7"/>
    <line x1="30" y1="40" x2="62" y2="40" stroke="${c[2]}" stroke-width="1.3"/>
    <line x1="44" y1="40" x2="44" y2="62" stroke="${c[2]}" stroke-width="1.3"/>
    <circle cx="37" cy="35" r="1.6" fill="${c[1]}"/>`,
  'remotion-scene-codegen': (c) => `
    <rect x="30" y="34" width="32" height="24" rx="2.5" fill="none" stroke="${c[0]}" stroke-width="1.7"/>
    <path d="M30,40 l32,-6 M34,33 l3,6 M42,31.5 l3,6 M50,30 l3,6" stroke="${c[2]}" stroke-width="1.1"/>
    <path d="M43,42 l8,4 l-8,4 Z" fill="${c[1]}" stroke="${c[0]}" stroke-width="1" stroke-linejoin="round"/>`,
};

const PROC = ['concentric', 'radiate', 'sprig'] as const;
function gConcentric(seed: string, c: [string, string, string]): string {
  const rnd = rng(hash32(seed + ':c'));
  let s = '';
  for (let i = 0; i < 3; i++) {
    const r = GLYPH_SIZE * (0.13 + i * 0.1);
    const segs = 3 + Math.floor(rnd() * 4);
    const dash = (2 * Math.PI * r) / segs;
    s += `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${i === 1 ? c[1] : c[0]}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="${(dash * 0.6).toFixed(1)} ${(dash * 0.4).toFixed(1)}" transform="rotate(${(rnd() * 360).toFixed(0)} ${CX} ${CY})"/>`;
  }
  return s + `<circle cx="${CX}" cy="${CY}" r="2.6" fill="${c[0]}"/>`;
}
function gRadiate(seed: string, c: [string, string, string]): string {
  const rnd = rng(hash32(seed + ':r'));
  const rays = 9 + Math.floor(rnd() * 4);
  const rot = rnd() * Math.PI * 2;
  let s = '';
  for (let i = 0; i < rays; i++) {
    const a = rot + (i / rays) * Math.PI * 2;
    const long = i % 2 === 0;
    const len = GLYPH_SIZE * (long ? 0.36 : 0.24);
    const inner = GLYPH_SIZE * 0.1;
    s += `<line x1="${CX + Math.cos(a) * inner}" y1="${CY + Math.sin(a) * inner}" x2="${CX + Math.cos(a) * len}" y2="${CY + Math.sin(a) * len}" stroke="${long ? c[0] : c[1]}" stroke-width="${long ? 1.6 : 1.1}" stroke-linecap="round"/>`;
  }
  return s + `<circle cx="${CX}" cy="${CY}" r="2.6" fill="${c[0]}"/>`;
}
function gSprig(seed: string, c: [string, string, string]): string {
  const rnd = rng(hash32(seed + ':s'));
  const pairs = 3 + Math.floor(rnd() * 2);
  let s = '';
  const baseY = CY + GLYPH_SIZE * 0.3;
  const topY = CY - GLYPH_SIZE * 0.3;
  s += `<path d="M${CX},${baseY} Q${CX + (rnd() - 0.5) * 8},${CY} ${CX},${topY}" fill="none" stroke="${c[2]}" stroke-width="1.6" stroke-linecap="round"/>`;
  for (let i = 0; i < pairs; i++) {
    const t = (i + 1) / (pairs + 1);
    const y = baseY + (topY - baseY) * t;
    const ln = GLYPH_SIZE * (0.18 - 0.02 * i);
    for (const d of [-1, 1]) {
      s += `<path d="M${CX},${y} Q${CX + d * ln * 0.6},${y - GLYPH_SIZE * 0.02} ${CX + d * ln},${y - GLYPH_SIZE * 0.07} Q${CX + d * ln * 0.5},${y + GLYPH_SIZE * 0.05} ${CX},${y}" fill="${c[0]}" fill-opacity="0.35" stroke="${c[1]}" stroke-width="1.1"/>`;
    }
  }
  return s + `<circle cx="${CX}" cy="${topY}" r="2.4" fill="${c[0]}"/>`;
}
const PROC_BUILDERS = { concentric: gConcentric, radiate: gRadiate, sprig: gSprig };

/** 生成 svg 内部内容：六边框 + （专属符号 | 哈希抽象兜底）。 */
export function buildGlyphInner(seed: string): string {
  const c = pal(seed);
  const key = deriveKey(seed);
  const sym = SYMBOLS[key]
    ? SYMBOLS[key](c)
    : PROC_BUILDERS[PROC[hash32(seed) % PROC.length]](seed, c);
  return frameHex(c) + sym;
}

export function glyphFilterSeed(seed: string): number {
  return hash32(seed) % 1000;
}
