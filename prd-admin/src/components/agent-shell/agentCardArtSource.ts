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
const GROUND = `<line x1="10" y1="158" x2="310" y2="158" stroke="currentColor" stroke-width="2" opacity="0.55"/>`;

/**
 * 「动作发生的那一处」永远是赭红，**不随类别变色**。
 *
 * 曾经把类别色（INK_HUES 八色）接到这一笔上，真机效果是灾难：一张只有黑白墨线的
 * 画上，那唯一一块色就是全卡最响的东西；35 张排在一起各响各的，整片就散了——
 * 正是「去紫、统一」要治的毛病，只是从满图彩色降级成了一点彩色。
 * 区分靠画本身（虫子 / 胶片 / 擂台 / 地图 一眼分得开），不靠颜色再区分一遍；
 * 类别色留在 hover 描边和标签上，不进画。
 */
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

/** 一组等距横线，很多张图的「文字」都是它。 */
const ruled = (x: number, y: number, w: number, rows: number, gap = 16, opacity = 0.55) =>
  `<g stroke="currentColor" stroke-width="1.8" opacity="${opacity}">${
    Array.from({ length: rows }, (_, i) => `<path d="M${x} ${y + i * gap} L${x + (i === rows - 1 ? w * 0.62 : w)} ${y + i * gap}"/>`).join('')
  }</g>`;

/** 视频分镜：三格连拍，中间那格是刚定下来的。 */
const visualStoryboard = `
<g stroke="currentColor" fill="none" stroke-width="2.4">
  <rect x="30" y="52" width="76" height="56" fill="url(#ink-hatch)"/>
  <rect x="122" y="52" width="76" height="56"/>
  <rect x="214" y="52" width="76" height="56" fill="url(#ink-hatch)"/>
  <path d="M42 96 L60 74 L74 88 L86 72 L96 96" stroke-width="2"/>
  <path d="M226 96 L246 78 L262 92 L278 76" stroke-width="2"/>
</g>
<g stroke="${ACCENT}" fill="none">
  <rect x="122" y="52" width="76" height="56" stroke-width="3.4"/>
  <rect x="122" y="122" width="76" height="9" fill="${ACCENT}" stroke="none"/>
</g>
<g stroke="currentColor" stroke-width="1.8" opacity="0.5">
  <path d="M30 122 L106 122 M214 122 L290 122"/>
</g>
${GROUND}`;

/** 成片视频：一条胶片，播放键落在中间。 */
const videoAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="42" y="52" width="236" height="96" rx="3" fill="url(#ink-hatch)"/>
  <path d="M42 74 L278 74 M42 126 L278 126" stroke-width="1.6" opacity="0.6"/>
</g>
<g fill="currentColor" opacity="0.55">
  ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<rect x="${54 + i * 32}" y="58" width="14" height="10" rx="1"/><rect x="${54 + i * 32}" y="132" width="14" height="10" rx="1"/>`).join('')}
</g>
<circle cx="160" cy="100" r="26" fill="none" stroke="${ACCENT}" stroke-width="3.2"/>
<path d="M152 88 L176 100 L152 112 Z" fill="${ACCENT}"/>
${GROUND}`;

/** MD 转 PPT：左边一页文稿，右边摞出的幻灯片，顶页标题条是新生成的。 */
const mdToPptAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.4">
  <rect x="26" y="44" width="86" height="112" fill="url(#ink-hatch)"/>
</g>
${ruled(38, 68, 62, 5, 18, 0.5)}
<path d="M124 100 L156 100 M146 92 L156 100 L146 108" stroke="currentColor" stroke-width="2.4" fill="none" opacity="0.7"/>
<g stroke="currentColor" fill="none" stroke-width="2.4">
  <rect x="188" y="38" width="104" height="66" fill="url(#ink-hatch)"/>
  <rect x="176" y="58" width="104" height="66" fill="url(#ink-hatch)"/>
  <rect x="164" y="78" width="104" height="66"/>
</g>
<rect x="176" y="90" width="62" height="8" fill="${ACCENT}"/>
${ruled(176, 112, 80, 2, 14, 0.5)}
${GROUND}`;

/** 今日任务：一棵倒着长的任务树，第一枝已经打上勾。 */
const taskTreeAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <path d="M78 38 L78 152"/>
  <path d="M78 62 L118 62 M78 100 L118 100 M78 138 L118 138"/>
  <rect x="118" y="46" width="96" height="32"/>
  <rect x="118" y="84" width="96" height="32" fill="url(#ink-hatch)"/>
  <rect x="118" y="122" width="96" height="32" fill="url(#ink-hatch)"/>
  <circle cx="78" cy="30" r="8" fill="url(#ink-hatch-dense)"/>
</g>
<path d="M232 62 L244 74 L268 46" stroke="${ACCENT}" stroke-width="4.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
${ruled(132, 62, 62, 1, 0, 0.5)}
${GROUND}`;

/** 上台表达：讲台加话筒，声浪推出去。 */
const speechAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <path d="M84 170 L104 92 L172 92 L192 170 Z" fill="url(#ink-hatch)"/>
  <path d="M100 118 L176 118" stroke-width="1.8" opacity="0.6"/>
  <path d="M138 92 L138 66"/>
  <rect x="122" y="24" width="32" height="44" rx="16"/>
  <g stroke-width="1.8" opacity="0.7">
    <path d="M126 36 L150 36 M126 46 L150 46 M126 56 L150 56"/>
  </g>
</g>
<g stroke="${ACCENT}" fill="none" stroke-width="2.8" stroke-linecap="round">
  <path d="M214 62 A44 44 0 0 1 214 122"/>
  <path d="M236 46 A66 66 0 0 1 236 138"/>
</g>
${GROUND}`;

/** 项目交付：甘特条一级级推过去，终点插旗。 */
const pmAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.4">
  <rect x="34" y="46" width="104" height="20" fill="url(#ink-hatch)"/>
  <rect x="70" y="78" width="104" height="20" fill="url(#ink-hatch)"/>
  <rect x="106" y="110" width="104" height="20" fill="url(#ink-hatch)"/>
</g>
<rect x="142" y="142" width="76" height="20" fill="${ACCENT}"/>
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <path d="M252 34 L252 170"/>
  <path d="M252 40 L292 52 L252 64 Z" fill="url(#ink-hatch-dense)"/>
</g>
<circle cx="252" cy="152" r="6" fill="${ACCENT}"/>
${GROUND}`;

/** 产品全链：四个环节首尾相接，最后一环刚闭上。 */
const productAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="52" y="40" width="66" height="44" fill="url(#ink-hatch)"/>
  <rect x="202" y="40" width="66" height="44" fill="url(#ink-hatch)"/>
  <rect x="202" y="118" width="66" height="44" fill="url(#ink-hatch)"/>
  <rect x="52" y="118" width="66" height="44"/>
  <path d="M118 62 L196 62 M188 55 L196 62 L188 69"/>
  <path d="M235 84 L235 112 M228 104 L235 112 L242 104"/>
  <path d="M202 140 L124 140 M132 133 L124 140 L132 147"/>
</g>
<g stroke="${ACCENT}" fill="none" stroke-width="3.4">
  <path d="M85 118 L85 90 M78 98 L85 90 L92 98"/>
</g>
${GROUND}`;

/** 拆解想法：左边一团模糊，右边被切成三块能开工的。 */
const paAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.4">
  <path d="M64 96 A24 24 0 0 1 88 62 A28 28 0 0 1 138 58 A22 22 0 0 1 152 100 A24 24 0 0 1 118 122 L92 122 A24 24 0 0 1 64 96 Z" fill="url(#ink-hatch)"/>
</g>
<path d="M168 100 L204 100 M194 92 L204 100 L194 108" stroke="${ACCENT}" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="220" y="42" width="72" height="30"/>
  <rect x="220" y="84" width="72" height="30"/>
  <rect x="220" y="126" width="72" height="30"/>
</g>
${ruled(232, 57, 48, 1, 0, 0.5)}
${ruled(232, 99, 48, 1, 0, 0.5)}
${ruled(232, 141, 48, 1, 0, 0.5)}
${GROUND}`;

/** 前端交付：一扇浏览器窗，刚放进去的那块组件是实心的。 */
const frontEndAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="40" y="34" width="240" height="128" rx="3"/>
  <path d="M40 62 L280 62"/>
  <circle cx="58" cy="48" r="5"/><circle cx="76" cy="48" r="5"/><circle cx="94" cy="48" r="5"/>
  <rect x="54" y="78" width="66" height="68" fill="url(#ink-hatch)"/>
  <rect x="200" y="78" width="66" height="30" fill="url(#ink-hatch)"/>
  <rect x="200" y="118" width="66" height="28" fill="url(#ink-hatch)"/>
</g>
<rect x="134" y="78" width="52" height="68" fill="${ACCENT}"/>
${GROUND}`;

/** 模型竞技：两根台柱扛着横梁，赢的那根压下去。 */
const arena = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <path d="M74 52 L246 44" stroke-width="3.2"/>
  <path d="M160 48 L160 30"/>
  <path d="M144 30 L176 30"/>
  <path d="M74 52 L74 96 M246 44 L246 74"/>
  <rect x="44" y="96" width="80" height="74" fill="url(#ink-hatch)"/>
  <rect x="196" y="74" width="80" height="96" fill="url(#ink-hatch)"/>
  <path d="M64 122 L104 122 M64 142 L94 142" stroke-width="1.8" opacity="0.55"/>
</g>
<rect x="196" y="74" width="80" height="16" fill="${ACCENT}"/>
<circle cx="246" cy="44" r="7" fill="${ACCENT}"/>
${GROUND}`;

/** 方案评审：方案摊开，印章刚盖下去。 */
const reviewAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="34" y="30" width="150" height="132" fill="url(#ink-hatch)"/>
</g>
${ruled(50, 56, 118, 5, 20, 0.55)}
<g transform="rotate(-12 232 96)">
  <rect x="184" y="60" width="96" height="72" fill="none" stroke="${ACCENT}" stroke-width="4"/>
  <rect x="196" y="72" width="72" height="48" fill="none" stroke="${ACCENT}" stroke-width="2"/>
  <path d="M208 96 L224 112 L256 80" stroke="${ACCENT}" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</g>
${GROUND}`;

/** 项目路径：一张折起来的图，虚线走到落点。 */
const projectRouteAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <path d="M30 48 L112 30 L200 52 L286 32 L286 146 L200 166 L112 144 L30 162 Z" fill="url(#ink-hatch)"/>
  <path d="M112 30 L112 144 M200 52 L200 166" stroke-width="1.6" opacity="0.6"/>
</g>
<path d="M56 138 C96 128 88 84 130 82 C176 80 168 118 214 108" stroke="${ACCENT}" stroke-width="3.2" fill="none" stroke-dasharray="9 7" stroke-linecap="round"/>
<g fill="${ACCENT}">
  <path d="M214 66 A16 16 0 0 1 230 82 C230 96 214 112 214 112 C214 112 198 96 198 82 A16 16 0 0 1 214 66 Z"/>
</g>
<circle cx="214" cy="82" r="5.5" fill="currentColor"/>
<circle cx="56" cy="138" r="6" fill="none" stroke="currentColor" stroke-width="2.6"/>
${GROUND}`;

/** 赋码方案：箱子贴上刚生成的码。 */
const ccasAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <path d="M52 62 L148 38 L244 62 L244 148 L148 172 L52 148 Z" fill="url(#ink-hatch)"/>
  <path d="M52 62 L148 86 L244 62 M148 86 L148 172" stroke-width="2"/>
</g>
<g transform="translate(170 44)">
  <rect x="0" y="0" width="76" height="76" fill="${ACCENT}"/>
  <g fill="currentColor" opacity="0.9">
    <rect x="10" y="10" width="20" height="20"/><rect x="46" y="10" width="20" height="20"/>
    <rect x="10" y="46" width="20" height="20"/><rect x="46" y="46" width="10" height="10"/>
    <rect x="58" y="58" width="8" height="8"/>
  </g>
</g>
${GROUND}`;

/** 流程邮件：信封掀开，正文刚写下第一行。 */
const emailAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="44" y="56" width="180" height="114" fill="url(#ink-hatch)"/>
  <path d="M44 56 L134 126 L224 56"/>
</g>
${ruled(66, 136, 100, 2, 16, 0.5)}
<path d="M66 136 L136 136" stroke="${ACCENT}" stroke-width="4" stroke-linecap="square"/>
<g stroke="currentColor" fill="none" stroke-width="2.4" stroke-linejoin="round">
  <path d="M282 26 L296 40 L232 104 L212 116 L222 96 Z" fill="url(#ink-hatch-dense)"/>
</g>
${GROUND}`;

/** 制度问答：翻开的册子，问号落在右页，答案已经画了线。 */
const shituAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <path d="M42 54 C74 40 110 40 148 54 L148 158 C110 144 74 144 42 158 Z" fill="url(#ink-hatch)"/>
  <path d="M148 54 C186 40 222 40 254 54 L254 158 C222 144 186 144 148 158 Z"/>
  <path d="M148 54 L148 158" stroke-width="2"/>
</g>
${ruled(64, 78, 68, 3, 20, 0.5)}
<g stroke="currentColor" fill="none" stroke-width="3.4" stroke-linecap="round">
  <path d="M186 76 A16 16 0 1 1 202 92 L202 100"/>
</g>
<circle cx="202" cy="114" r="4" fill="currentColor"/>
<path d="M172 134 L232 134" stroke="${ACCENT}" stroke-width="4.4" stroke-linecap="square"/>
${GROUND}`;

/** 技术文档校验：文档贴着标尺量过一遍，通过。 */
const techDocFormatAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="76" y="26" width="150" height="136" fill="url(#ink-hatch)"/>
  <rect x="44" y="26" width="24" height="136"/>
  <g stroke-width="1.8" opacity="0.7">
    <path d="M44 52 L60 52 M44 78 L56 78 M44 104 L60 104 M44 130 L56 130"/>
  </g>
</g>
${ruled(94, 54, 114, 4, 22, 0.55)}
<g stroke="${ACCENT}" fill="none" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M238 118 L254 134 L288 92"/>
</g>
${GROUND}`;

/** 涌现探索：两条链路交叉，交点上刚炸出一个新节点。 */
const emergenceAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.4" opacity="0.8">
  <path d="M40 46 L160 100 L280 46 M40 154 L160 100 L280 154"/>
  <circle cx="40" cy="46" r="9" fill="url(#ink-hatch-dense)"/>
  <circle cx="280" cy="46" r="9" fill="url(#ink-hatch-dense)"/>
  <circle cx="40" cy="154" r="9" fill="url(#ink-hatch-dense)"/>
  <circle cx="280" cy="154" r="9" fill="url(#ink-hatch-dense)"/>
</g>
<g stroke="${ACCENT}" stroke-width="3" stroke-linecap="round">
  <path d="M160 58 L160 40 M160 142 L160 160 M124 100 L104 100 M196 100 L216 100"/>
  <path d="M136 76 L122 62 M184 76 L198 62 M136 124 L122 138 M184 124 L198 138"/>
</g>
<circle cx="160" cy="100" r="15" fill="${ACCENT}"/>
${GROUND}`;

/** 规范提缺陷：四要素表单填齐，必填项刚补上。 */
const tapdBugAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="56" y="26" width="184" height="136" fill="url(#ink-hatch)"/>
  <path d="M56 58 L240 58"/>
</g>
<g stroke="currentColor" fill="none" stroke-width="2.2" opacity="0.75">
  <rect x="74" y="74" width="30" height="18"/>
  <rect x="74" y="104" width="30" height="18"/>
  <rect x="74" y="134" width="30" height="18"/>
</g>
${ruled(118, 83, 104, 1, 0, 0.5)}
${ruled(118, 113, 104, 1, 0, 0.5)}
<rect x="118" y="138" width="76" height="8" fill="${ACCENT}"/>
<g stroke="${ACCENT}" fill="none" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M79 82 L86 89 L100 74"/>
  <path d="M79 112 L86 119 L100 104"/>
</g>
${GROUND}`;

/** 开放接口：一把钥匙插进接口板，通道打开。 */
const marketplaceOpenapi = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="150" y="40" width="132" height="120" rx="4" fill="url(#ink-hatch)"/>
  <rect x="170" y="66" width="42" height="20"/>
  <rect x="170" y="102" width="42" height="20"/>
  <rect x="228" y="66" width="34" height="20"/>
  <rect x="228" y="102" width="34" height="20"/>
</g>
<g stroke="${ACCENT}" fill="none" stroke-width="3.6" stroke-linecap="round">
  <circle cx="60" cy="100" r="24"/>
  <path d="M84 100 L166 100"/>
  <path d="M126 100 L126 122 M148 100 L148 118"/>
</g>
<circle cx="60" cy="100" r="8" fill="currentColor"/>
${GROUND}`;

/** 快捷操作：一枚键帽被按下，闪电从里面出来。 */
const shortcutsAgent = `
<g stroke="currentColor" fill="none" stroke-width="2.8">
  <rect x="66" y="44" width="188" height="112" rx="10" fill="url(#ink-hatch)"/>
  <rect x="80" y="56" width="160" height="88" rx="6" stroke-width="1.8" opacity="0.6"/>
</g>
<path d="M176 56 L120 110 L156 110 L140 154 L200 96 L162 96 Z" fill="${ACCENT}"/>
${GROUND}`;

/** 我的分享：一串环扣在一处，最新那一环是实的。 */
const myShares = `
<g stroke="currentColor" fill="none" stroke-width="3.2">
  <rect x="40" y="76" width="76" height="48" rx="24"/>
  <rect x="96" y="76" width="76" height="48" rx="24"/>
  <rect x="152" y="76" width="76" height="48" rx="24"/>
</g>
<rect x="208" y="76" width="76" height="48" rx="24" fill="none" stroke="${ACCENT}" stroke-width="4.4"/>
<circle cx="284" cy="100" r="7" fill="${ACCENT}"/>
<g stroke="currentColor" stroke-width="1.8" opacity="0.45">
  <path d="M60 146 L260 146"/>
</g>
${GROUND}`;

/** 学习中心：书摞起来，进度环走掉一大半。 */
const learningCenter = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="46" y="126" width="132" height="30" fill="url(#ink-hatch)"/>
  <rect x="56" y="96" width="132" height="30" fill="url(#ink-hatch)"/>
  <rect x="40" y="66" width="132" height="30"/>
  <path d="M62 66 L62 96 M78 96 L78 126 M62 126 L62 156" stroke-width="1.6" opacity="0.6"/>
</g>
<g fill="none" stroke="currentColor" stroke-width="3" opacity="0.32">
  <circle cx="240" cy="90" r="42"/>
</g>
<path d="M240 48 A42 42 0 1 1 203 112" stroke="${ACCENT}" stroke-width="5" fill="none" stroke-linecap="round"/>
<g stroke="currentColor" fill="none" stroke-width="2.6" stroke-linejoin="round">
  <path d="M208 82 L240 68 L272 82 L240 96 Z" fill="url(#ink-hatch)"/>
  <path d="M220 88 L220 104 C220 112 260 112 260 104 L260 88"/>
  <path d="M272 82 L272 106"/>
</g>
<circle cx="272" cy="110" r="4.5" fill="currentColor"/>
${GROUND}`;

/** 分享链路自检：链子拉直，末端探针给出通过。 */
const shareLinkTester = `
<g stroke="currentColor" fill="none" stroke-width="3.2">
  <rect x="34" y="74" width="72" height="44" rx="22"/>
  <rect x="88" y="74" width="72" height="44" rx="22"/>
  <path d="M160 96 L206 96" stroke-dasharray="8 8" stroke-width="2.6" opacity="0.7"/>
</g>
<g stroke="${ACCENT}" fill="none" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="252" cy="96" r="38" stroke-width="3.2"/>
  <path d="M234 96 L248 110 L272 82"/>
</g>
${GROUND}`;

/** 音频转录：波形在上，落成文字在下，选中那段是红的。 */
const transcriptAgent = `
<g stroke="currentColor" stroke-width="3" stroke-linecap="round" opacity="0.75">
  ${[18, 34, 46, 28, 52, 38, 22, 44, 30, 16].map((h, i) => `<path d="M${44 + i * 26} ${58 - h / 2} L${44 + i * 26} ${58 + h / 2}"/>`).join('')}
</g>
<g stroke="${ACCENT}" stroke-width="3.4" stroke-linecap="round">
  <path d="M148 36 L148 80 M174 42 L174 74 M200 36 L200 80"/>
</g>
<path d="M174 92 L174 108" stroke="${ACCENT}" stroke-width="2.4" stroke-dasharray="5 5"/>
<g stroke="currentColor" fill="none" stroke-width="2.4">
  <rect x="44" y="112" width="232" height="46" fill="url(#ink-hatch)"/>
</g>
${ruled(60, 128, 168, 2, 18, 0.55)}
${GROUND}`;

/** 短视频拆解：竖屏素材被拆成可用的几块。 */
const shortVideoParser = `
<g stroke="currentColor" fill="none" stroke-width="2.8">
  <rect x="46" y="26" width="88" height="144" rx="8" fill="url(#ink-hatch)"/>
  <path d="M46 62 L134 62 M46 116 L134 116" stroke-width="1.8" opacity="0.6"/>
</g>
<path d="M152 96 L188 96 M178 88 L188 96 L178 104" stroke="currentColor" stroke-width="2.4" fill="none" opacity="0.7"/>
<g stroke="currentColor" fill="none" stroke-width="2.4">
  <rect x="204" y="30" width="82" height="38"/>
  <rect x="204" y="124" width="82" height="38"/>
</g>
<rect x="204" y="77" width="82" height="38" fill="${ACCENT}"/>
${GROUND}`;

/** 代码审查：括号夹着代码，读完给了通过。 */
const codeReviewer = `
<g stroke="currentColor" fill="none" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M78 34 C56 34 62 88 40 96 C62 104 56 158 78 158"/>
  <path d="M212 34 C234 34 228 88 250 96 C228 104 234 158 212 158"/>
</g>
${ruled(96, 62, 100, 4, 24, 0.6)}
<g stroke="${ACCENT}" fill="none" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M258 128 L272 142 L298 112"/>
</g>
${GROUND}`;

/** 多语言翻译：左边方块字，右边拉丁行，中间那一箭是刚翻过去的。 */
const translator = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="30" y="42" width="104" height="104" fill="url(#ink-hatch)"/>
  <path d="M48 74 L116 74 M82 60 L82 128 M60 96 L104 96 M62 128 L102 128" stroke-width="2.8"/>
</g>
<path d="M152 94 L196 94 M186 85 L196 94 L186 103" stroke="${ACCENT}" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <rect x="212" y="42" width="78" height="104"/>
</g>
${ruled(226, 66, 50, 4, 20, 0.6)}
${GROUND}`;

/** 提炼要点：长文压成三条要点。 */
const summarizer = `
<g stroke="currentColor" fill="none" stroke-width="2.4">
  <rect x="26" y="30" width="112" height="132" fill="url(#ink-hatch)"/>
</g>
${ruled(40, 52, 84, 7, 17, 0.5)}
<path d="M156 96 L192 96 M182 88 L192 96 L182 104" stroke="currentColor" stroke-width="2.4" fill="none" opacity="0.7"/>
<g stroke="currentColor" fill="none" stroke-width="2.4">
  <rect x="208" y="52" width="84" height="88"/>
</g>
<g fill="${ACCENT}">
  <circle cx="224" cy="74" r="5"/><circle cx="224" cy="96" r="5"/><circle cx="224" cy="118" r="5"/>
</g>
${ruled(238, 74, 40, 1, 0, 0.6)}
${ruled(238, 96, 40, 1, 0, 0.6)}
${ruled(238, 118, 40, 1, 0, 0.6)}
${GROUND}`;

/** 数据洞察：折线走高，异常那点被圈出来。 */
const dataAnalyst = `
<g stroke="currentColor" fill="none" stroke-width="2.6">
  <path d="M46 26 L46 150 L286 150"/>
  <g stroke-width="1.4" opacity="0.35">
    <path d="M46 46 L286 46 M46 82 L286 82 M46 118 L286 118"/>
  </g>
  <path d="M64 132 L106 108 L146 118 L188 74 L228 90 L272 44" stroke-width="3.2"/>
  <g fill="currentColor" opacity="0.8">
    <circle cx="64" cy="132" r="4.5"/><circle cx="106" cy="108" r="4.5"/>
    <circle cx="146" cy="118" r="4.5"/><circle cx="228" cy="90" r="4.5"/>
  </g>
</g>
<circle cx="188" cy="74" r="15" fill="none" stroke="${ACCENT}" stroke-width="3.4"/>
<circle cx="188" cy="74" r="6" fill="${ACCENT}"/>
${GROUND}`;

/** key → 插图内容（不含 `<svg>` 外壳与 defs，由渲染层统一补）。 */
export const AGENT_CARD_ART: Readonly<Record<string, string>> = {
  'visual-agent': visualAgent,
  'visual-storyboard': visualStoryboard,
  'literary-agent': literaryAgent,
  'defect-agent': defectAgent,
  'video-agent': videoAgent,
  'report-agent': reportAgent,
  'md-to-ppt-agent': mdToPptAgent,
  'task-tree-agent': taskTreeAgent,
  'speech-agent': speechAgent,
  'pm-agent': pmAgent,
  'product-agent': productAgent,
  'pa-agent': paAgent,
  'front-end-agent': frontEndAgent,
  arena,
  'review-agent': reviewAgent,
  'project-route-agent': projectRouteAgent,
  'ccas-agent': ccasAgent,
  'email-agent': emailAgent,
  'shitu-agent': shituAgent,
  'pr-review': prReview,
  'cds-agent': cdsAgent,
  'tech-doc-format-agent': techDocFormatAgent,
  'emergence-agent': emergenceAgent,
  'tapd-bug-agent': tapdBugAgent,
  'marketplace-openapi': marketplaceOpenapi,
  'shortcuts-agent': shortcutsAgent,
  'my-shares': myShares,
  'learning-center': learningCenter,
  'share-link-tester': shareLinkTester,
  'transcript-agent': transcriptAgent,
  'short-video-parser': shortVideoParser,
  'code-reviewer': codeReviewer,
  translator,
  summarizer,
  'data-analyst': dataAnalyst,
};

/**
 * 拼出完整 SVG 源码。渲染层与打样表共用这一个出口，避免两处各画各的。
 *
 * **id 必须按 key 加后缀**：`url(#ink-hatch)` 是文档级查找，只认整篇里**第一个**
 * 同名 id。一页同时渲染十几张卡片时，所有 `fill="url(#ink-hatch)"` 都会指到第一张
 * 卡片的 pattern；而 pattern 里的 `currentColor` 解析的是**定义处**继承的颜色，
 * 不是使用处的——于是首页那种「不同卡片文字色不同」的场景会整片跟着第一张走，
 * 且不报任何错。加后缀让每张卡片自带一份，从结构上消掉这个坑。
 */
export function buildAgentCardArtSvg(agentKey: string): string | null {
  const art = AGENT_CARD_ART[agentKey];
  if (!art) return null;
  const scope = (svg: string) => svg.replace(/ink-hatch(-dense)?/g, (_m, dense = '') => `ink-hatch${dense}-${agentKey}`);
  return `<svg viewBox="${ART_VIEWBOX}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true">${scope(DEFS)}${scope(art)}</svg>`;
}
