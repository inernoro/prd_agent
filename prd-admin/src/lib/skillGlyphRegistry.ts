/**
 * 官方技能卡「手绘古典线描」标志生成器。
 *
 * 设计目标（与用户敲定的 v5 demo 一致）：
 * - 暖彩线描（珊瑚/琥珀/玫瑰金）+ 轻度手绘抖线 + 柔和辉光，古典版画的人文味
 * - 三种形态：罗盘星芒 / 植物枝叶 / 同心星图
 * - 形态 + 色相由「tag」决定（registry），无匹配 tag 时回退到名字哈希
 * - 同一技能永远同一图案（确定性），不同技能尽量错开
 *
 * 纯函数：只吃 (seed, tags) 吐 SVG 片段，无副作用，方便单测。
 */

export type GlyphShape = 'compass' | 'botanical' | 'astro' | 'emblem';

export interface GlyphStyle {
  shape: GlyphShape;
  /** 暖色相基准（度）。各组 tag 落在不同暖区，肉眼可分辨「系列」 */
  hueBase: number;
}

/**
 * tag → 风格 注册表。命中数组里任一关键字（小写包含匹配）即采用该组风格。
 * 顺序即优先级：靠前的先匹配。新增官方技能类别时往这里加一行。
 */
export const TAG_STYLE_GROUPS: { match: string[]; style: GlyphStyle }[] = [
  // 精英 → 金色徽章/星章（最高规格）· 暖金
  { match: ['精英', 'elite'], style: { shape: 'emblem', hueBase: 45 } },
  // 工程 / 工具 / 运维 / 部署 → 罗盘星芒（导航/精密感）· 赤陶橙
  { match: ['cli', '部署', 'devops', 'cds', '执行', '运维', '工具', '环境', 'deploy'], style: { shape: 'compass', hueBase: 18 } },
  // 创意 / 内容 / 设计 / 文档 → 植物枝叶（生长/有机感）· 琥珀金
  { match: ['创意', '设计', '文档', '写作', '内容', '视觉', '图像', '视频', 'ui', 'ux', '涌现'], style: { shape: 'botanical', hueBase: 36 } },
  // 分析 / 数据 / 报告 / 周报 / 需求 → 同心星图（观测/洞察感）· 玫瑰
  { match: ['分析', '数据', '周报', '评审', '审查', '报告', '统计', '洞察', '质量', '需求', '技能'], style: { shape: 'astro', hueBase: 6 } },
];

// 名字哈希兜底只在这三种里选（emblem 仅限「精英」tag 显式触发，不参与随机）
const SHAPES: GlyphShape[] = ['compass', 'botanical', 'astro'];

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

/** 解析风格：先按 tag 命中 registry，否则名字哈希兜底。 */
export function resolveGlyphStyle(seed: string, tags?: string[]): GlyphStyle {
  if (tags && tags.length) {
    const lower = tags.map((t) => t.toLowerCase());
    for (const group of TAG_STYLE_GROUPS) {
      if (group.match.some((kw) => lower.some((t) => t.includes(kw)))) {
        return group.style;
      }
    }
  }
  const h = hash32(seed);
  return { shape: SHAPES[h % 3], hueBase: 10 + (h % 36) };
}

function palette(hueBase: number): [string, string, string] {
  return [
    `hsl(${hueBase} 74% 64%)`,
    `hsl(${(hueBase + 14) % 360} 70% 58%)`,
    `hsl(${(hueBase + 28) % 360} 66% 52%)`,
  ];
}

export function glyphGlow(style: GlyphStyle): string {
  return `hsla(${style.hueBase} 80% 62% / .55)`;
}
export function glyphWarmBg(style: GlyphStyle): string {
  return `hsla(${style.hueBase} 70% 55% / .16)`;
}
export function glyphCardGlow(style: GlyphStyle): string {
  return `hsla(${style.hueBase} 75% 58% / .45)`;
}

const SIZE = 92;
const CX = 46;
const CY = 46;

function gCompass(seed: string, c: [string, string, string]): string {
  const rnd = rng(hash32(seed + ':c'));
  const rays = 11 + Math.floor(rnd() * 5);
  const rot = rnd() * Math.PI * 2;
  let s = '';
  for (let i = 0; i < rays; i++) {
    const a = rot + (i / rays) * Math.PI * 2;
    const long = i % 2 === 0;
    const len = SIZE * (long ? 0.42 : 0.26);
    const inner = SIZE * 0.1;
    s += `<line x1="${CX + Math.cos(a) * inner}" y1="${CY + Math.sin(a) * inner}" x2="${CX + Math.cos(a) * len}" y2="${CY + Math.sin(a) * len}" stroke="${long ? c[0] : c[1]}" stroke-width="${long ? 1.7 : 1.1}" stroke-linecap="round"/>`;
  }
  s += `<circle cx="${CX}" cy="${CY}" r="${SIZE * 0.12}" fill="none" stroke="${c[0]}" stroke-width="1.6"/>`;
  s += `<circle cx="${CX}" cy="${CY}" r="${SIZE * 0.052}" fill="${c[0]}"/>`;
  return s;
}

function gBotanical(seed: string, c: [string, string, string]): string {
  const rnd = rng(hash32(seed + ':b'));
  const pairs = 3 + Math.floor(rnd() * 3);
  let s = '';
  const baseY = CY + SIZE * 0.34;
  const topY = CY - SIZE * 0.36;
  s += `<path d="M${CX},${baseY} Q${CX + (rnd() - 0.5) * 10},${CY} ${CX},${topY}" fill="none" stroke="${c[2]}" stroke-width="1.7" stroke-linecap="round"/>`;
  for (let i = 0; i < pairs; i++) {
    const t = (i + 1) / (pairs + 1);
    const y = baseY + (topY - baseY) * t;
    const ln = SIZE * (0.21 - 0.02 * i);
    for (const d of [-1, 1]) {
      const ex = CX + d * ln;
      const ey = y - SIZE * 0.08;
      s += `<path d="M${CX},${y} Q${CX + d * ln * 0.6},${y - SIZE * 0.02} ${ex},${ey} Q${CX + d * ln * 0.5},${y + SIZE * 0.05} ${CX},${y}" fill="${c[0]}" fill-opacity="0.4" stroke="${c[1]}" stroke-width="1.1"/>`;
    }
  }
  s += `<circle cx="${CX}" cy="${topY}" r="${SIZE * 0.05}" fill="${c[0]}"/>`;
  return s;
}

function gAstro(seed: string, c: [string, string, string]): string {
  const rnd = rng(hash32(seed + ':a'));
  let s = '';
  for (let i = 0; i < 3; i++) {
    const r = SIZE * (0.15 + i * 0.12);
    const segs = 3 + Math.floor(rnd() * 4);
    const dash = (2 * Math.PI * r) / segs;
    s += `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="${i === 1 ? c[1] : c[0]}" stroke-width="1.5" stroke-linecap="round" stroke-dasharray="${(dash * 0.62).toFixed(1)} ${(dash * 0.38).toFixed(1)}" transform="rotate(${(rnd() * 360).toFixed(0)} ${CX} ${CY})"/>`;
  }
  const stars = 4 + Math.floor(rnd() * 4);
  for (let i = 0; i < stars; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = SIZE * (0.12 + rnd() * 0.3);
    const x = CX + Math.cos(a) * rr;
    const y = CY + Math.sin(a) * rr;
    const sr = 1.4 + rnd() * 1.4;
    s += `<path d="M${x},${y - sr} L${x + sr * 0.4},${y} L${x},${y + sr} L${x - sr * 0.4},${y} Z" fill="${c[0]}"/>`;
  }
  s += `<circle cx="${CX}" cy="${CY}" r="${SIZE * 0.04}" fill="${c[0]}"/>`;
  return s;
}

// 精英徽章：八角芒星 + 内嵌小星 + 外圈点缀（金色，规格最高）
function gEmblem(seed: string, c: [string, string, string]): string {
  const rnd = rng(hash32(seed + ':e'));
  const points = 8;
  const outer = SIZE * 0.4;
  const inner = SIZE * 0.17;
  const rot = -Math.PI / 2 + (rnd() - 0.5) * 0.1;
  let star = '';
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rot + (i / (points * 2)) * Math.PI * 2;
    star += `${i === 0 ? 'M' : 'L'}${(CX + Math.cos(a) * r).toFixed(2)},${(CY + Math.sin(a) * r).toFixed(2)} `;
  }
  star += 'Z';
  let s = '';
  // 外圈轨道点
  const dots = 8;
  for (let i = 0; i < dots; i++) {
    const a = (i / dots) * Math.PI * 2 + rot;
    s += `<circle cx="${(CX + Math.cos(a) * SIZE * 0.46).toFixed(2)}" cy="${(CY + Math.sin(a) * SIZE * 0.46).toFixed(2)}" r="1.4" fill="${c[1]}"/>`;
  }
  // 主星（描边 + 半透明填充）
  s += `<path d="${star}" fill="${c[0]}" fill-opacity="0.28" stroke="${c[0]}" stroke-width="1.7" stroke-linejoin="round"/>`;
  // 内核同心星
  s += `<circle cx="${CX}" cy="${CY}" r="${SIZE * 0.13}" fill="none" stroke="${c[1]}" stroke-width="1.3"/>`;
  s += `<circle cx="${CX}" cy="${CY}" r="${SIZE * 0.05}" fill="${c[0]}"/>`;
  return s;
}

const BUILDERS: Record<GlyphShape, (seed: string, c: [string, string, string]) => string> = {
  compass: gCompass,
  botanical: gBotanical,
  astro: gAstro,
  emblem: gEmblem,
};

export const GLYPH_SIZE = SIZE;

/** 生成 svg 内部 <g> 的内容（不含 <svg>/<filter> 外壳，那些在组件里拼）。 */
export function buildGlyphInner(seed: string, style: GlyphStyle): string {
  return BUILDERS[style.shape](seed, palette(style.hueBase));
}

/** displacement 滤镜的 seed（控制手抖差异），与图案 seed 同源。 */
export function glyphFilterSeed(seed: string): number {
  return hash32(seed) % 1000;
}
