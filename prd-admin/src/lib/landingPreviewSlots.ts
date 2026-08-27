/**
 * 对外首页（`/home`）**产物图**槽位注册表 —— 管理端「首页预览图」那一屏的数据源。
 *
 * ## 这些图是什么
 *
 * 首页十幕画的是真实界面的缩微版。其中两幕演的是「生成图片」：视觉创作的无限画布、
 * 文学创作的逐段配图。这两幕里那些「已经生成好的图」原本是手绘的 SVG 山脊渐变 ——
 * 一个演生图的产品，界面里摆的却是假图。这份注册表就是把那几个位置换成**真实照片**，
 * 由管理员用系统自己的生图能力生成。
 *
 * 所以这里的提示词与「示意图/信息图」是两回事：**要的是照片，不是矢量插画**。
 * 它们要冒充的是用户自己会生成出来的作品，画成扁平图形就又变回假图了。
 *
 * ## 提示词怎么写的
 *
 * 每条 = 一段共用的**风格前缀** + 这一张自己的**画面描述**。分开写的理由：
 *
 * 1. 同一幕里几张图必须像同一次创作出来的。风格散在各条里必然各自漂移。
 * 2. 管理员改的通常是画面（换个季节、换个天气），不是风格。前缀稳定，只动后半段。
 *
 * 风格前缀里三条是硬约束，删掉就不成套：
 *   · **是照片**，不是插画/渲染/绘画——这几张的全部意义就是「看起来像真的作品」；
 *   · 低饱和、压暗，要能安静地待在深色页面上，不能是明晃晃的风光大片；
 *   · **画面里不许有字**——图像模型写出来的字几乎必糊，而这些图是当作产物展示的。
 *
 * ## 成对约束
 *
 * `visual-draft` 与 `visual-fog` 是一对：那一幕演的是「把主视觉改成雾天，山脊线保留」，
 * 所以雾天那张必须是**同一条山脊线**加雾，不是另换一座山。两条提示词里都写死了这件事，
 * 改其中一条时另一条要跟着改，否则那一幕就自相矛盾了。
 */

/**
 * 风格预设 —— 同一个画面，换一种拍法。
 *
 * 只有一种风格时，出来的必然是「低饱和风景照」那一挂：晴天蓝调、雾天灰调，
 * 看多了就是一股 AI 图库味（用户原话「有点像假假的」）。所以把**看法**和
 * **画的是什么**拆开：`subject` 说画面里有什么，风格预设说这张照片是怎么拍的。
 * 换风格不换主题，一套图仍然自洽。
 *
 * 每条预设都必须自带那三条硬约束（是照片 / 压得住深色底 / 画面里不许有字），
 * 因为它整段替换掉前缀，不是叠加。
 */
export type LandingArtStyleKey = 'muted' | 'mono' | 'film' | 'night' | 'infrared';

export interface LandingArtStyle {
  key: LandingArtStyleKey;
  label: string;
  /** 一句话说清这一档长什么样，管理端下拉里直接显示 */
  hint: string;
  prefix: string;
}

const NO_TEXT = 'No people, no animals, no text of any kind, no watermark, no logo, no border, no user interface. '
  + 'It must read as an actual photograph — not an illustration, not a 3D render, not a painting, not a flat vector graphic.';

export const LANDING_ART_STYLES: LandingArtStyle[] = [
  {
    key: 'muted',
    label: '沉静风景',
    hint: '低饱和自然光，最安静的一档，适合不想让配图抢戏',
    prefix: [
      'A photograph. Real-world landscape photography shot on a full-frame camera with a 35mm lens.',
      'Muted, desaturated palette that sits quietly on a dark page: deep slate blue, cool grey, warm clay brown, moss green.',
      'Overcast or low-angle sun, soft directional light, gentle haze in the distance. Deep depth of field, fine natural film grain.',
      'No HDR, no heavy vignette, no oversaturated sky, no lens flare.',
      NO_TEXT,
    ].join(' '),
  },
  {
    key: 'mono',
    label: '黑白纪实',
    hint: '高反差黑白 + 粗颗粒，最有性格的一档，深色页面上最挺',
    prefix: [
      'A black and white photograph in the tradition of 1970s reportage, shot on pushed Tri-X at 28mm.',
      'High contrast with deep crushed blacks and a few clean bright highlights; coarse visible silver grain across the whole frame.',
      'Strong directional light carving clear shapes; texture and edge matter more than tonal smoothness.',
      'Strictly monochrome — no colour cast, no split toning, no sepia.',
      NO_TEXT,
    ].join(' '),
  },
  {
    key: 'film',
    label: '胶片颗粒',
    hint: '暖调负片，轻微光晕与偏色，有年代感但不脏',
    prefix: [
      'A photograph shot on expired colour negative film with a 50mm lens, scanned rather than digitally captured.',
      'Warm, slightly faded palette: dusty amber, muted olive, washed teal. Blacks lift a little instead of going pure black.',
      'Gentle halation glows around the brightest edges, a faint colour shift toward green in the shadows, visible film grain.',
      'Soft natural light, no flash. Restrained and quiet, never candy-coloured.',
      NO_TEXT,
    ].join(' '),
  },
  {
    key: 'night',
    label: '长曝夜航',
    hint: '夜景长曝，湿地面反光，暗部占多数，和深色页最贴',
    prefix: [
      'A long-exposure photograph taken at night on a tripod, 35mm, several seconds of exposure.',
      'The frame is mostly darkness with a few restrained pools of artificial light: cold blue-white and warm sodium amber.',
      'Wet surfaces reflect those lights in long smeared streaks; moving elements blur into soft trails while static ones stay sharp.',
      'Deep shadows dominate; no attempt to lift them. Quiet and still, not a neon cyberpunk scene.',
      NO_TEXT,
    ].join(' '),
  },
  {
    key: 'infrared',
    label: '红外植被',
    hint: '红外摄影：草木发白、天空压黑，最不像常规照片的一档',
    prefix: [
      'An infrared photograph shot on a converted camera with a 720nm filter, rendered in monochrome.',
      'Foliage and grass glow bright and almost white; the sky and any water go very dark; stone and soil sit in the middle greys.',
      'The tonal inversion is the whole point — it looks like a real place under an unfamiliar light.',
      'Fine grain, high micro-contrast, no colour.',
      NO_TEXT,
    ].join(' '),
  },
];

export const DEFAULT_LANDING_ART_STYLE: LandingArtStyleKey = 'muted';

export function landingArtStyle(key?: string | null): LandingArtStyle {
  return LANDING_ART_STYLES.find((s) => s.key === key) ?? LANDING_ART_STYLES[0];
}

export type LandingPreviewSlot = {
  /** 稳定 id，同时是 slot 后缀 */
  id: string;
  /** 后端 slot 字符串 */
  slot: string;
  /** 管理端展示名 */
  label: string;
  /** 这张图出现在首页哪一幕的什么位置 */
  where: string;
  /** 生图尺寸（宽x高） */
  size: string;
  /** 画面描述（风格前缀之后的那半段） */
  subject: string;
};

export const LANDING_PREVIEW_SLOTS: LandingPreviewSlot[] = [
  /* ── 视觉创作：无限画布上的四张 ── */
  {
    id: 'visual-draft',
    slot: 'landing.visual.draft',
    label: '画布 · 主视觉初稿',
    where: '第 1 幕 视觉创作画布 · 左上那张',
    size: '1536x1024',
    subject:
      'Subject: a long mountain ridge at blue hour, seen from a facing slope across a wide valley. ' +
      'Three overlapping ranges recede into the distance, each one paler than the last. ' +
      'The sky is clear and cool, graded from deep slate at the top to pale grey at the horizon. ' +
      'The air is clean — no fog — and the ridge line is crisp and fully readable from left to right. ' +
      'The foreground slope is dark and almost silhouetted.',
  },
  {
    id: 'visual-fog',
    slot: 'landing.visual.fog',
    label: '画布 · 雾天版本',
    where: '第 1 幕 视觉创作画布 · 左下那张',
    size: '1536x1024',
    subject:
      // 这段刻意把初稿那张的构图逐条描出来（圆钝双峰、左侧长脊、右下前景坡、右侧两道远山、
      // 右侧地平线偏暖）。本该用图生图锁住同一条山脊，但本环境没有配 vision 模型池，
      // 图生图一律 MODEL_POOL_EMPTY，只能靠文生图尽量复述构图 —— 详见 debt 里记的那条。
      'Subject: a broad rounded mountain massif with a gentle double summit just right of centre, seen from a ' +
      'facing slope across a wide valley. A long dark ridge descends from the left edge of the frame; a dark ' +
      'foreground slope rises from the bottom-right corner. Two paler ranges recede behind it toward the right. ' +
      'The weather is fog: a low bank fills the valley and drifts across the lower slopes, softening the far ' +
      'ranges into pale silhouettes, while the summit line along the top stays visible and unbroken. ' +
      'Cool, grey and quiet — the same place as the clear shot, on a foggy morning.',
  },
  {
    id: 'visual-warm',
    slot: 'landing.visual.warm',
    label: '画布 · 暖调另一版',
    where: '第 1 幕 视觉创作画布 · 中上那张',
    size: '1024x1024',
    subject:
      'Subject: the same valley late in the afternoon instead of at blue hour. Low warm sun rakes across the ' +
      'ridge from the right, picking out the near slope in muted clay and ochre while the far ranges stay cool grey. ' +
      'Long soft shadows run down the slope. Still restrained and desaturated — warm, not a golden-hour postcard.',
  },
  {
    id: 'visual-mixed',
    slot: 'landing.visual.mixed',
    label: '画布 · 混合结果',
    where: '第 1 幕 视觉创作画布 · 中下那张',
    size: '1024x1024',
    subject:
      'Subject: the same valley at dawn with the fog half burned off. The upper ridge is lit warm and clear ' +
      'while the valley floor still holds a cold blue bank of mist — the two weathers meeting in one frame, ' +
      'divided roughly along the tree line. Muted moss green shows on the sunlit slope.',
  },

  /* ── 文学创作：正文内联配图 + 右侧生成缩略图 ── */
  {
    id: 'literary-ridge',
    slot: 'landing.literary.ridge',
    label: '文稿 · 雾压山谷的清晨旧路',
    where: '第 3 幕 文学创作 · 正文配图 1 与右侧第 1 张',
    size: '1536x1024',
    subject:
      'Subject: an old gravel path climbing through a narrow valley in the first light of an October morning. ' +
      'A layer of fog still sits low between the slopes and has not lifted. The loose stones underfoot are ' +
      'darkened and glossy with dew. The path leads away from the camera and disappears into the mist. ' +
      'Cold, quiet, almost monochrome, with only faint moss green at the verges.',
  },
  {
    id: 'literary-bridge',
    slot: 'landing.literary.bridge',
    label: '文稿 · 谷底泡白的木桥',
    where: '第 3 幕 文学创作 · 正文配图 2',
    size: '1536x1024',
    subject:
      'Subject: a small plank footbridge across a shallow stream at the bottom of a valley. ' +
      'The timber has been soaked for years and has weathered to a pale bleached grey, its grain raised and splitting. ' +
      'Dark water runs underneath over rounded stones. Wet leaf litter on both banks. ' +
      'Flat overcast light, no sun, the whole frame close in value.',
  },
  {
    id: 'literary-larch',
    slot: 'landing.literary.larch',
    label: '文稿 · 坡顶那排落叶松',
    where: '第 3 幕 文学创作 · 右侧第 2 张',
    size: '1024x1024',
    subject:
      'Subject: a row of larches standing dead straight along the crest of a slope, seen from slightly below. ' +
      'Their needles have turned through to a dull yellow and are starting to drop; a few are caught mid-air. ' +
      'The fog has just thinned here, so the trees are sharp against a soft pale sky while the ground behind ' +
      'them is still washed out. Restrained ochre against cool grey.',
  },
];

/**
 * 组合出这一槽位的完整提示词（风格前缀 + 画面描述）。
 *
 * 管理端弹窗里给用户看的是**组合后的完整一段**，不是两个框——他要改画面时常常也想
 * 顺手压一下风格（「这次别要雾」），拆成两个框反而挡路。
 */
export function buildLandingPreviewPrompt(slot: LandingPreviewSlot, styleKey?: string | null): string {
  return `${landingArtStyle(styleKey).prefix}\n\n${slot.subject}`;
}

export function landingPreviewSlotById(id: string): LandingPreviewSlot | undefined {
  return LANDING_PREVIEW_SLOTS.find((s) => s.id === id);
}
