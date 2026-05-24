/**
 * 官方/技能卡的「编辑气质」图标生成器。
 *
 * 设计语言（用户敲定）：黑色手绘抽象线条为主体 + 少量陶土橙圆点作视觉锚点，
 * 纸张/炭黑/陶土的安静理性调性。无辉光、无多彩、无重框。
 *
 * - 部分系统技能有「专属象形符号」（SYMBOLS，按 skill key）
 * - 其余回退到哈希抽象形态（3 选 1：concentric / radiate / sprig）
 * - feTurbulence 轻度做旧成手绘抖线；唯一品牌色陶土只点在锚点圆点上
 *
 * 纯函数：(seed) → SVG 片段，无副作用，好测好扩展。
 */

export const GLYPH_INK = '#141413';
export const GLYPH_TERRA = '#D97757';
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

/** 从 seed（可能是 official-{key} 或社区 id/title）取出可匹配 SYMBOLS 的 key。 */
function deriveKey(seed: string): string {
  return seed.startsWith('official-') ? seed.slice('official-'.length) : seed;
}

const INK = GLYPH_INK;
const TERRA = GLYPH_TERRA;
const dot = (x: number, y: number, r: number) => `<circle class="dot" cx="${x}" cy="${y}" r="${r}" fill="${TERRA}"/>`;

/** 专属象形符号：原创炭黑线描 + 1~2 颗陶土锚点。按 skill key 匹配。 */
const SYMBOLS: Record<string, () => string> = {
  'acceptance-checklist': () => `
    <rect x="33" y="29" width="26" height="32" rx="2.5" fill="none" stroke="${INK}" stroke-width="1.6"/>
    <rect x="40" y="25" width="12" height="6" rx="2" fill="none" stroke="${INK}" stroke-width="1.4"/>
    <line x1="38" y1="40" x2="50" y2="40" stroke="${INK}" stroke-width="1.2"/>
    <line x1="38" y1="47" x2="50" y2="47" stroke="${INK}" stroke-width="1.2"/>
    <path d="M37,54 l3.5,3.5 l7,-8" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    ${dot(54, 35, 2.4)}`,
  'human-verify': () => `
    <path d="M29,46 Q46,31 63,46 Q46,61 29,46 Z" fill="none" stroke="${INK}" stroke-width="1.6"/>
    <circle cx="46" cy="46" r="7" fill="none" stroke="${INK}" stroke-width="1.4"/>
    ${dot(46, 46, 2.6)}`,
  'risk-matrix': () => `
    <rect x="31" y="31" width="30" height="30" rx="2" fill="none" stroke="${INK}" stroke-width="1.6"/>
    <line x1="46" y1="31" x2="46" y2="61" stroke="${INK}" stroke-width="1.1"/>
    <line x1="31" y1="46" x2="61" y2="46" stroke="${INK}" stroke-width="1.1"/>
    ${dot(53.5, 38.5, 3)}`,
  'code-hygiene': () => `
    <line x1="57" y1="29" x2="42" y2="48" stroke="${INK}" stroke-width="1.7" stroke-linecap="round"/>
    <path d="M42,48 L33,52 L37,61 L48,57 Z" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M35,54 l3,5 M39,52 l3,5 M43,51 l2.5,5" stroke="${INK}" stroke-width="1" stroke-linecap="round"/>
    ${dot(59, 40, 2.6)}`,
  'technical-documentation': () => `
    <path d="M46,33 Q38,29 30,32 V58 Q38,55 46,59 Q54,55 62,58 V32 Q54,29 46,33 Z" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
    <line x1="46" y1="33" x2="46" y2="59" stroke="${INK}" stroke-width="1.1"/>
    <path d="M34,40 q4,-1.5 8,0 M34,46 q4,-1.5 8,0 M50,40 q4,-1.5 8,0 M50,46 q4,-1.5 8,0" stroke="${INK}" stroke-width="0.9" fill="none"/>
    ${dot(46, 30, 2.2)}`,
  'laowang': () => `
    <path d="M28,60 L42,38 L50,50 L56,42 L64,60" fill="none" stroke="${INK}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>
    <line x1="26" y1="60" x2="66" y2="60" stroke="${INK}" stroke-width="1.3"/>
    ${dot(42, 30, 3.2)}`,
  'theme-transition': () => `
    <circle cx="46" cy="46" r="13" fill="none" stroke="${INK}" stroke-width="1.6"/>
    <path d="M46,33 A13,13 0 0,0 46,59 Z" fill="${INK}" opacity="0.12"/>
    <path d="M46,29 v-3 M46,66 v-3 M29,46 h-3 M66,46 h-3 M34,34 l-2,-2 M58,58 l2,2 M58,34 l2,-2 M34,58 l-2,2" stroke="${INK}" stroke-width="1" stroke-linecap="round"/>
    ${dot(46, 46, 2.2)}`,
  'find-skills': () => `
    <circle cx="33" cy="39" r="1.8" fill="${INK}"/><circle cx="41" cy="35" r="1.8" fill="${INK}"/>
    <circle cx="45" cy="46" r="11" fill="none" stroke="${INK}" stroke-width="1.7"/>
    <line x1="53" y1="54" x2="62" y2="63" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>
    ${dot(50, 42, 2.4)}`,
  'create-skill-file': () => `
    <path d="M36,28 H52 L60,36 V64 H36 Z" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M52,28 V36 H60" fill="none" stroke="${INK}" stroke-width="1.3"/>
    <path d="M46,44 v10 M41,49 h10" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>
    ${dot(46, 49, 2.2)}`,
  'conflict-resolution': () => `
    <path d="M34,28 V52 Q34,60 46,60 Q58,60 58,52 V28" fill="none" stroke="${INK}" stroke-width="1.6"/>
    <circle cx="34" cy="26" r="3" fill="none" stroke="${INK}" stroke-width="1.5"/>
    <circle cx="58" cy="26" r="3" fill="none" stroke="${INK}" stroke-width="1.5"/>
    ${dot(46, 62, 3)}`,
  'task-handoff-checklist': () => `
    <path d="M30,46 H56" stroke="${INK}" stroke-width="1.7" stroke-linecap="round"/>
    <path d="M50,40 l7,6 l-7,6" fill="none" stroke="${INK}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="30" cy="46" r="4" fill="none" stroke="${INK}" stroke-width="1.5"/>
    ${dot(30, 46, 2)}`,
  'ui-ux-pro-max': () => `
    <rect x="30" y="30" width="32" height="32" rx="2.5" fill="none" stroke="${INK}" stroke-width="1.6"/>
    <line x1="30" y1="40" x2="62" y2="40" stroke="${INK}" stroke-width="1.2"/>
    <line x1="44" y1="40" x2="44" y2="62" stroke="${INK}" stroke-width="1.2"/>
    ${dot(37, 35, 2.2)}`,
  'remotion-scene-codegen': () => `
    <rect x="30" y="34" width="32" height="24" rx="2.5" fill="none" stroke="${INK}" stroke-width="1.6"/>
    <path d="M30,40 l32,-6 M34,33 l3,6 M42,31.5 l3,6 M50,30 l3,6" stroke="${INK}" stroke-width="1.1"/>
    <path d="M43,42 l8,4 l-8,4 Z" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linejoin="round"/>
    ${dot(51, 46, 2.2)}`,
};

const PROCEDURAL = ['concentric', 'radiate', 'sprig'] as const;

function gConcentric(seed: string): string {
  const rnd = rng(hash32(seed + ':c'));
  let s = '';
  for (let i = 0; i < 3; i++) {
    const r = GLYPH_SIZE * (0.15 + i * 0.12);
    const segs = 3 + Math.floor(rnd() * 4);
    const dash = (2 * Math.PI * r) / segs;
    s += `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${INK}" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="${(dash * 0.6).toFixed(1)} ${(dash * 0.4).toFixed(1)}" transform="rotate(${(rnd() * 360).toFixed(0)} ${CX} ${CY})"/>`;
  }
  return s + dot(CX, CY, 2.6);
}
function gRadiate(seed: string): string {
  const rnd = rng(hash32(seed + ':r'));
  const rays = 9 + Math.floor(rnd() * 4);
  const rot = rnd() * Math.PI * 2;
  let s = '';
  for (let i = 0; i < rays; i++) {
    const a = rot + (i / rays) * Math.PI * 2;
    const long = i % 2 === 0;
    const len = GLYPH_SIZE * (long ? 0.4 : 0.26);
    const inner = GLYPH_SIZE * 0.1;
    s += `<line x1="${CX + Math.cos(a) * inner}" y1="${CY + Math.sin(a) * inner}" x2="${CX + Math.cos(a) * len}" y2="${CY + Math.sin(a) * len}" stroke="${INK}" stroke-width="${long ? 1.5 : 1}" stroke-linecap="round"/>`;
  }
  return s + dot(CX, CY, 2.6);
}
function gSprig(seed: string): string {
  const rnd = rng(hash32(seed + ':s'));
  const pairs = 3 + Math.floor(rnd() * 2);
  let s = '';
  const baseY = CY + GLYPH_SIZE * 0.34;
  const topY = CY - GLYPH_SIZE * 0.34;
  s += `<path d="M${CX},${baseY} Q${CX + (rnd() - 0.5) * 8},${CY} ${CX},${topY}" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>`;
  for (let i = 0; i < pairs; i++) {
    const t = (i + 1) / (pairs + 1);
    const y = baseY + (topY - baseY) * t;
    const ln = GLYPH_SIZE * (0.2 - 0.02 * i);
    for (const d of [-1, 1]) {
      s += `<path d="M${CX},${y} Q${CX + d * ln * 0.6},${y - GLYPH_SIZE * 0.02} ${CX + d * ln},${y - GLYPH_SIZE * 0.08} Q${CX + d * ln * 0.5},${y + GLYPH_SIZE * 0.05} ${CX},${y}" fill="none" stroke="${INK}" stroke-width="1.1"/>`;
    }
  }
  return s + dot(CX, topY, 2.4);
}
const PROC_BUILDERS = { concentric: gConcentric, radiate: gRadiate, sprig: gSprig };

/** 生成 svg 内部 <g> 内容：优先专属符号，否则哈希抽象兜底。 */
export function buildGlyphInner(seed: string): string {
  const key = deriveKey(seed);
  if (SYMBOLS[key]) return SYMBOLS[key]();
  const shape = PROCEDURAL[hash32(seed) % PROCEDURAL.length];
  return PROC_BUILDERS[shape](seed);
}

export function glyphFilterSeed(seed: string): number {
  return hash32(seed) % 1000;
}
