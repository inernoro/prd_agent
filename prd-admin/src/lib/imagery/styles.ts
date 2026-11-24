/**
 * 拍法库 —— 系统配图的**第一层提示词**，整组共用。
 *
 * 为什么把「怎么拍」和「画的是什么」拆开：只有一种风格时，出来的必然是同一挂
 * 味道（用户原话「有点像假假的」）。拆开之后，换拍法不换主题，一套图仍然自洽；
 * 而管理员日常要改的通常是画面（换个季节、换个天气），前缀稳定不动。
 *
 * 每条预设都必须**自带那三条硬约束**（是照片 / 压得住深色底 / 画面里不许有字），
 * 因为它是整段替换掉前缀，不是叠加上去。
 *
 * 这些图冒充的是「用户自己会生成出来的作品」或「真实的实物」，所以一律要照片，
 * 不要插画——画成扁平矢量图就又变回假图了。
 */

export type ImageryStyleKey = 'muted' | 'mono' | 'film' | 'night' | 'infrared' | 'bookspine';

export interface ImageryStyle {
  key: ImageryStyleKey;
  label: string;
  /** 一句话说清这一档长什么样，管理端下拉里直接显示 */
  hint: string;
  prefix: string;
}

const NO_TEXT = 'No people, no animals, no text of any kind, no watermark, no logo, no border, no user interface. '
  + 'It must read as an actual photograph — not an illustration, not a 3D render, not a painting, not a flat vector graphic.';

export const IMAGERY_STYLES: ImageryStyle[] = [
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
  {
    /*
     * 藏书阁这一档单独加的：现有五档全是风景照，是为对外首页那两幕的「作品」调的。
     * 藏书阁的图要贴在卷名旁边当卷面，风景照会把「这是一卷书」这件事冲掉——
     * 所以换成台面静物：书、纸、工具、器物，近距离、侧光、有实物质感。
     */
    key: 'bookspine',
    label: '书脊静物',
    hint: '侧光台面静物：旧书、纸张、工具的实物质感，压得住深色底',
    prefix: [
      'A photograph. Close-range still life on a worn wooden workbench, shot on a full-frame camera with a 50mm lens.',
      'Raking side light from one window rakes across the surfaces and picks out texture: cloth book bindings, uncut paper edges, bare metal, dry wood grain.',
      'Muted palette that sits quietly on a dark page: warm clay, aged ivory, deep slate, tarnished brass. Most of the frame falls into shadow.',
      'Shallow depth of field, fine natural grain, no studio gloss, no clean seamless backdrop, no flat lay from directly above.',
      NO_TEXT,
    ].join(' '),
  },
];

export const DEFAULT_IMAGERY_STYLE: ImageryStyleKey = 'muted';

export function imageryStyle(key?: string | null): ImageryStyle {
  return IMAGERY_STYLES.find((s) => s.key === key) ?? IMAGERY_STYLES[0];
}
