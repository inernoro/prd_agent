/**
 * 对外首页（`/home`）配图槽位注册表 —— 管理端「首页预览图」那一屏的数据源。
 *
 * 首页十幕本身画的是**真实界面的缩微版**（见 `pages/home/LandingPage.tsx` 的幕表），
 * 这里的配图不替代那些界面，是给每一幕配一张说明性的示意图：对外分享、写文档、
 * 做社交卡片时要的是一张能单独拿出去的图，而不是一段会动的 DOM。
 *
 * slot 命名走既有的 `HomepageAsset` 体系（`landing.{幕}`），因此存储、CDN URL、
 * 缓存击穿、删除全部复用现成的那套，不另起一张表。
 *
 * ## 提示词怎么写的
 *
 * 每条 = 一段共用的**风格前缀** + 这一幕自己的**画面描述**。分开写有两个原因：
 *
 * 1. 十张图必须像一套。风格散在十条里必然各自漂移，改一次要改十处。
 * 2. 管理员改的通常是画面（多一个框、少一根线），不是风格。前缀稳定，
 *    他每次只动后半段。
 *
 * 风格前缀里有三条是硬约束，删掉就不成套了：
 *   · 底色锁在暖石墨（#141418），与首页真实底色同源；
 *   · 只许赭红 + 钢青两支重音，确认态才用一点松绿——紫/品红/霓虹一律禁止
 *     （对齐 `lib/tileAccent.ts` 的墨系色带，首页有守卫测试盯着不许发紫）；
 *   · 标注一律小写拉丁等宽字，不写中文——图像模型渲染中文几乎必糊，
 *     宁可不写字也不要糊字。
 *
 * 另外明确写了「no emoji」：整个系统禁 emoji（AGENTS.md 规则 0），
 * 图里冒出来一个同样是违规。
 */

/**
 * 十张图共用的风格前缀。改这里 = 改整套的观感，改之前先想清楚十幕都还成立。
 */
export const LANDING_PREVIEW_STYLE_PREFIX = [
  'Editorial technical illustration, flat vector diagram, drawn as a single calm composition.',
  'Background: warm graphite #141418, very slightly lighter toward the upper left, subtle vignette at the edges.',
  'Accent palette is strict: terracotta clay #D97757 as the primary accent, cool steel blue #6AB6D2 as the secondary,',
  'and a muted pine green #6AD2A2 used only for confirmed or finished states. No purple, no magenta, no neon, no rainbow.',
  'Surfaces are near-black rounded rectangles with 1px hairline borders at about 10 percent white; strokes are thin and even.',
  'Generous negative space, nothing crowded, no more than a dozen elements in frame.',
  'Any label is short lowercase latin text in a small monospace face. Never any Chinese characters, never any paragraph of text.',
  'No people, no hands, no photographic texture, no glossy 3D, no drop shadows, no emoji, no brand logos, no watermark.',
].join(' ');

export type LandingPreviewSlot = {
  /** 稳定 id，同时是 slot 后缀 */
  id: string;
  /** 后端 slot 字符串 */
  slot: string;
  /** 管理端展示名 */
  label: string;
  /** 这张图配的是首页哪一幕 */
  where: string;
  /** 生图尺寸（宽x高）。横幅用 3:2，正方形留给密集网格类画面 */
  size: string;
  /** 画面描述（风格前缀之后的那半段） */
  subject: string;
};

export const LANDING_PREVIEW_SLOTS: LandingPreviewSlot[] = [
  {
    id: 'hero',
    slot: 'landing.hero',
    label: '开场 · 视觉创作工作台',
    where: '第 1 幕 Hero，首屏',
    size: '1536x1024',
    subject:
      'Subject: a dark creative canvas seen straight on. One large image tile sits slightly right of centre, ' +
      'still being generated — its lower third is a faint diagonal hatch instead of finished picture. ' +
      'Three small thumbnails are docked in a column to its left, one of them ringed in terracotta as the current selection. ' +
      'A slim floating action bar hovers just above the large tile carrying four tiny outline glyphs. ' +
      'A small zoom pill sits in the bottom-left corner reading 120%. Nothing else in frame.',
  },
  {
    id: 'literary',
    slot: 'landing.literary',
    label: '文学创作 · 左文右图',
    where: '第 3 幕 LiteraryScene',
    size: '1536x1024',
    subject:
      'Subject: a two-pane writing workspace. The left pane is a column of body text rendered as neat grey rules, ' +
      'with one paragraph block tinted terracotta to mark it as selected. The right pane holds a single generated ' +
      'illustration tile of the same height. A thin terracotta connector curves from the highlighted paragraph to the tile, ' +
      'showing that this picture belongs to that paragraph. Above the right pane sits a row of four small style swatches, ' +
      'the second one ringed as active.',
  },
  {
    id: 'knowledge',
    slot: 'landing.knowledge',
    label: '知识库 · 三栏阅读器',
    where: '第 4 幕 KnowledgeScene',
    size: '1536x1024',
    subject:
      'Subject: a three-column reading room. Far left, a narrow file tree of short indented rules. ' +
      'Centre, a document page where one sentence carries a steel-blue underline and a small rounded popover floats ' +
      'just above it holding three tiny glyphs. Far right, a constellation of about twenty dots joined by hairlines — ' +
      'a knowledge graph — with one node clearly brightest and slightly larger, and its immediate neighbours ringed in steel blue.',
  },
  {
    id: 'layers',
    slot: 'landing.layers',
    label: '三层一体 · MAP / LLMGW / CDS',
    where: '第 5 幕 LayersScene',
    size: '1536x1024',
    subject:
      'Subject: three horizontal bands stacked vertically, numbered 01, 02, 03 in small monospace down a thin rail on the left, ' +
      'the rail joining the three numbers into one vertical line. Every node below is a near-black rounded rectangle with a ' +
      'hairline border and a short lowercase label inside it — none of them are filled with colour. ' +
      'Band 01: four such nodes in an evenly spaced row, joined left to right by short terracotta arrows; only the last node ' +
      'has a pine-green border, marking the finished artefact. ' +
      'Band 02: four such nodes in a row that get progressively shorter in width from left to right, so the row visibly ' +
      'narrows as it goes right; two thin steel-blue guide lines run above and below the row and converge toward the right ' +
      'edge, forming a funnel that closes down onto the last and smallest node. ' +
      'Band 03: on the left a branch graph — a horizontal line with three small hollow commit dots, one of them curving away ' +
      'downward to a single detached dot — and on the right four small labelled service boxes in a row above one wide ' +
      'labelled card. A faint hexagonal grid sits behind band 03 only, fading out toward the right edge.',
  },
  {
    id: 'toolbox',
    slot: 'landing.toolbox',
    label: '百宝箱 · 搜一下就筛',
    where: '第 6 幕 ToolboxScene',
    size: '1024x1024',
    subject:
      'Subject: a tool shelf. A single wide search field runs across the top with a thin caret blinking in it. ' +
      'Below it one row of small pill-shaped filter chips, the second chip filled terracotta as the active filter. ' +
      'Beneath that a grid of sixteen small square tool cards, each carrying one simple outline glyph and a two-word ' +
      'lowercase label. Five of the cards are dimmed to roughly a third opacity, as if filtered out; the rest are crisp.',
  },
  {
    id: 'workflow',
    slot: 'landing.workflow',
    label: '工作流 · 自己跑的流水线',
    where: '第 7 幕 WorkflowScene',
    size: '1536x1024',
    subject:
      'Subject: a pipeline of five capsule-shaped stages laid left to right across the middle of the frame, ' +
      'joined by thin connectors, sitting on a very faint dot grid. The first two capsules carry a small pine-green check. ' +
      'The third is mid-run: a terracotta arc wraps three quarters of the way around it. The last two are outline only. ' +
      'Along the bottom edge, a shelf of four unused capsules waiting to be dragged in.',
  },
  {
    id: 'voc',
    slot: 'landing.voc',
    label: '体验地图 · 痛点自己跳出来',
    where: '第 8 幕 VocScene',
    size: '1536x1024',
    subject:
      'Subject: a squarified treemap that fills the whole frame edge to edge, about forty rectangles of widely varying size, ' +
      'packed with 2px gaps. Fill colours run through nine cold blue-green hues, all low saturation and all similar in value ' +
      'so no single tile shouts. Six scattered tiles carry a thin amber outline marking friction. ' +
      'Only the largest handful of tiles carry a short lowercase label; the rest are bare.',
  },
  {
    id: 'models',
    slot: 'landing.models',
    label: '模型池 · 坏了自动顶上',
    where: '第 9 幕 ModelLayerScene',
    size: '1536x1024',
    subject:
      'Subject: one pool card holding four stacked model rows. Row one carries a solid pine-green dot on the left and a short ' +
      'latency figure on the right. Row two is greyed out with a small cross where its dot would be, clearly out of service. ' +
      'A terracotta arrow runs from row three up the left edge into the position row two vacated, showing the promotion. ' +
      'A tiny flat sparkline sits at the right end of each row.',
  },
  {
    id: 'cds',
    slot: 'landing.cds',
    label: 'CDS · 分支即环境',
    where: '第 10 幕 CdsScene（高潮）',
    size: '1536x1024',
    subject:
      'Subject: a branch topology on a faint hexagonal grid that fades out toward the right. ' +
      'A horizontal main line runs across the upper left with three hollow commit dots on it; from the third dot a smooth ' +
      'pine-green curve peels away down and to the right, ending in one filled node. ' +
      'To the right of the graph, four small service boxes in a two by two block, each a glyph plus a short lowercase label ' +
      'and a port number. Below them one wide card carrying a link glyph and a single live dot. ' +
      'A single line of terminal output runs along the very bottom in monospace with a block caret at its end.',
  },
  {
    id: 'start',
    slot: 'landing.start',
    label: '从这里开始 · 三步与三端',
    where: '第 11 幕 StartScene',
    size: '1536x1024',
    subject:
      'Subject: three numbered steps laid out horizontally across the upper half, each a small circle holding 1, 2 or 3 ' +
      'in monospace, joined by thin connectors, with a short lowercase caption under each. ' +
      'Across the lower half, three device outlines side by side — a wide desktop, a laptop, a phone — drawn as outlines only, ' +
      'each showing the same simple abstract layout of two rules and a block inside.',
  },
];

/**
 * 组合出这一槽位的默认提示词（风格前缀 + 画面描述）。
 *
 * 管理端弹窗里给用户看的是**组合后的完整一段**，不是两个框——他要改画面时
 * 常常也想顺手压一下风格（「这次别要六边形底纹」），拆成两个框反而挡路。
 */
export function buildLandingPreviewPrompt(slot: LandingPreviewSlot): string {
  return `${LANDING_PREVIEW_STYLE_PREFIX}\n\n${slot.subject}`;
}

export function landingPreviewSlotById(id: string): LandingPreviewSlot | undefined {
  return LANDING_PREVIEW_SLOTS.find((s) => s.id === id);
}
