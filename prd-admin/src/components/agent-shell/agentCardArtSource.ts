/**
 * 智能体卡片版画插图（米多墨系）。
 *
 * 语法沿用 `.claude/rules/report-design-system.md` 的「版画插图」条款，与刊徽同一支笔：
 * 内联 SVG、油墨 + 身份色双色、hatch 刻线、描边为主。这里只多两条卡片专属约束：
 *
 * 1. **一张图一个动作**。画的是「这个智能体替你做完的那件事」，不是它的图标。
 *    两块灰盒子代表「闭环产品缺陷」这种事不许再发生——看不懂就是没画对。
 * 2. **赭红只落在动作发生的那一处**。墨线画物件，身份色画「刚刚被做掉的那一下」
 *    （合上的缺口、写下的那道线、这一周的那根柱子）。满图彩色等于没有重点。
 *
 * 颜色全走 `currentColor`（油墨，随卡片文字色）与 `var(--accent-primary)`（赭红），
 * 所以**一张图同时成立于暗浅两个主题**——不再需要 `-light` 副本。
 * 这也是换掉 webp 的主要动机之一：原先 35 个智能体存了 70 个二进制文件（2.0 MB），
 * 每次换皮肤都要重出一整套，而且 3D 白模在 200px 缩略图下糊成一团。
 */

/** 所有插图共用的画布。16:10，与卡片封面比例一致。 */
export const ART_VIEWBOX = '0 0 320 200';

/**
 * 共用 defs：刻线纹理。
 *
 * 版画的「灰」不是降透明度，是刻线密度——所以底纹走 pattern 而不是 fill-opacity，
 * 缩到 200px 时仍然是可辨的线，不会糊成一片脏色。
 */
const DEFS = `
<defs>
  <pattern id="ink-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="7" stroke="currentColor" stroke-width="1.1" opacity="0.34"/>
  </pattern>
  <pattern id="ink-hatch-dense" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="4" stroke="currentColor" stroke-width="1" opacity="0.42"/>
  </pattern>
</defs>`;

/** 地平线：每张图都有，替代 3D 渲染的地面投影，也是刊系那条墨线的延续。 */
const GROUND = `<line x1="18" y1="170" x2="302" y2="170" stroke="currentColor" stroke-width="2" opacity="0.55"/>`;

const ACCENT = 'var(--accent-primary)';

/**
 * 视觉创作：画框立在架上，框里刻出山与日，右下角是刚落下的裁切角标。
 * 赭红 = 裁切角标（「构图定下来了」这一下）。
 */
const visualAgent = `
<g stroke="currentColor" fill="none">
  <rect x="74" y="30" width="172" height="124" rx="2" stroke-width="2.8"/>
  <rect x="88" y="44" width="144" height="96" rx="1" stroke-width="1.4" opacity="0.55"/>
  <circle cx="120" cy="72" r="11" stroke-width="2.2"/>
  <path d="M90 138 L134 92 L158 118 L188 80 L230 138 Z" stroke-width="2.6" fill="url(#ink-hatch)"/>
</g>
<g stroke="${ACCENT}" fill="none" stroke-width="3.4" stroke-linecap="square">
  <path d="M62 46 L62 22 L86 22"/>
  <path d="M258 138 L258 162 L234 162"/>
</g>
${GROUND}`;

/**
 * 文学创作：稿纸微微转开，钢笔尖压在最后一行上。
 * 赭红 = 刚写下的那道线（笔尖后面拖出来的那一段）。
 */
const literaryAgent = `
<g transform="rotate(-5 140 96)">
  <rect x="52" y="26" width="150" height="132" rx="2" stroke="currentColor" stroke-width="2.8" fill="none"/>
  <g stroke="currentColor" stroke-width="1.8" opacity="0.55">
    <path d="M70 56 L184 56 M70 76 L184 76 M70 96 L184 96 M70 116 L184 116"/>
  </g>
  <path d="M70 136 L132 136" stroke="${ACCENT}" stroke-width="4" stroke-linecap="square"/>
</g>
<g stroke="currentColor" fill="none" stroke-width="2.6" stroke-linejoin="round">
  <path d="M268 22 L286 40 L212 118 L188 132 L200 108 Z" fill="url(#ink-hatch)"/>
  <path d="M200 108 L212 118"/>
  <path d="M256 34 L274 52"/>
</g>
${GROUND}`;

/**
 * 缺陷管理：一个断了口的环，赭红那一段把它接上——「闭环」就是这一下。
 * 环内是被摁住的那只虫。
 */
const defectAgent = `
<g stroke="currentColor" fill="none">
  <path d="M196 42 A72 72 0 1 0 224 128" stroke-width="3"/>
  <g stroke-width="2" opacity="0.8" stroke-linecap="round">
    <path d="M132 74 L114 62 M128 92 L106 92 M132 110 L114 122"/>
    <path d="M168 74 L186 62 M172 92 L194 92 M168 110 L186 122"/>
    <path d="M142 62 L136 46 M158 62 L164 46"/>
  </g>
  <ellipse cx="150" cy="92" rx="19" ry="25" stroke-width="2.6" fill="url(#ink-hatch)"/>
  <path d="M150 70 L150 114" stroke-width="1.5" opacity="0.6"/>
  <ellipse cx="150" cy="62" rx="9" ry="7" stroke-width="2.4"/>
</g>
<path d="M196 42 A72 72 0 0 1 224 128" stroke="${ACCENT}" stroke-width="5" fill="none" stroke-linecap="round"/>
<circle cx="224" cy="128" r="6" fill="${ACCENT}"/>
${GROUND}`;

/**
 * 周报：一叠柱子立在基线上，右边是折角的刊页。
 * 赭红 = 本周那根（也是唯一一根实心的）。
 */
const reportAgent = `
<g stroke="currentColor" fill="none">
  <rect x="52" y="118" width="22" height="52" stroke-width="2.2" fill="url(#ink-hatch)"/>
  <rect x="84" y="92" width="22" height="78" stroke-width="2.2" fill="url(#ink-hatch)"/>
  <rect x="116" y="104" width="22" height="66" stroke-width="2.2" fill="url(#ink-hatch)"/>
</g>
<rect x="148" y="62" width="22" height="108" fill="${ACCENT}"/>
<g stroke="currentColor" fill="none">
  <path d="M204 34 L286 34 L286 152 L204 152 Z" stroke-width="2.6" fill="url(#ink-hatch)"/>
  <path d="M264 34 L264 56 L286 56" stroke-width="2"/>
  <g stroke-width="1.6" opacity="0.62">
    <path d="M216 76 L274 76 M216 92 L274 92 M216 108 L258 108 M216 124 L274 124"/>
  </g>
</g>
${GROUND}`;

/**
 * CDS：三只箱子摞着，顶上一道信号弧——远端在跑。
 * 赭红 = 正在运行的那一只。
 */
const cdsAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.4">
  <rect x="72" y="126" width="104" height="44" fill="url(#ink-hatch)"/>
  <rect x="72" y="82" width="104" height="44" fill="url(#ink-hatch)"/>
  <path d="M96 82 L96 126 M124 82 L124 126 M152 82 L152 126" stroke-width="1.4" opacity="0.5"/>
  <path d="M96 126 L96 170 M124 126 L124 170 M152 126 L152 170" stroke-width="1.4" opacity="0.5"/>
</g>
<rect x="72" y="38" width="104" height="44" fill="${ACCENT}"/>
<g stroke="currentColor" fill="none" stroke-width="1.4" opacity="0.5">
  <path d="M96 38 L96 82 M124 38 L124 82 M152 38 L152 82"/>
</g>
<g stroke="${ACCENT}" fill="none" stroke-width="2.6" stroke-linecap="round">
  <path d="M204 74 A34 34 0 0 1 204 126"/>
  <path d="M222 62 A54 54 0 0 1 222 138"/>
</g>
<circle cx="192" cy="100" r="4.5" fill="${ACCENT}"/>
${GROUND}`;

/**
 * PR 审查：两条分支并到一处，放大镜压在合流点上。
 * 赭红 = 被看过的那一段差异。
 */
const prReview = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <path d="M40 60 L104 60 A28 28 0 0 1 132 88 L132 112 A28 28 0 0 0 160 140 L232 140"/>
  <path d="M40 140 L232 140" opacity="0.34"/>
  <circle cx="40" cy="60" r="8" fill="url(#ink-hatch-dense)"/>
  <circle cx="40" cy="140" r="8" fill="url(#ink-hatch-dense)"/>
</g>
<circle cx="232" cy="140" r="9" fill="${ACCENT}"/>
<g stroke="currentColor" fill="none" stroke-width="3">
  <circle cx="196" cy="76" r="40" fill="url(#ink-hatch)"/>
  <path d="M224 104 L262 142" stroke-linecap="round" stroke-width="5"/>
</g>
<g stroke="${ACCENT}" stroke-width="3" stroke-linecap="square">
  <path d="M176 66 L216 66 M176 86 L204 86"/>
</g>
${GROUND}`;

/** key → 插图内容（不含 `<svg>` 外壳与 defs，由渲染层统一补）。 */
export const AGENT_CARD_ART: Readonly<Record<string, string>> = {
  'visual-agent': visualAgent,
  'literary-agent': literaryAgent,
  'defect-agent': defectAgent,
  'report-agent': reportAgent,
  'cds-agent': cdsAgent,
  'pr-review': prReview,
};

/** 拼出完整 SVG 源码。渲染层与打样表共用这一个出口，避免两处各画各的。 */
export function buildAgentCardArtSvg(agentKey: string): string | null {
  const art = AGENT_CARD_ART[agentKey];
  if (!art) return null;
  return `<svg viewBox="${ART_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true">${DEFS}${art}</svg>`;
}
