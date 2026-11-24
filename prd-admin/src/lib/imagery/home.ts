import type { ImageryModule } from './types';

/**
 * 对外首页（`/home`）的产物图。
 *
 * ## 这些图是什么
 *
 * 首页十幕画的是真实界面的缩微版。其中两幕演的是「生成图片」：视觉创作的无限画布、
 * 文学创作的逐段配图。这两幕里那些「已经生成好的图」原本是手绘的 SVG 山脊渐变 ——
 * 一个演生图的产品，界面里摆的却是假图。这一组就是把那几个位置换成**真实照片**，
 * 由管理员用系统自己的生图能力生成。
 *
 * ## 成对约束
 *
 * `visual-draft` 与 `visual-fog` 是一对：那一幕演的是「把主视觉改成雾天，山脊线保留」，
 * 所以雾天那张必须是**同一条山脊线**加雾，不是另换一座山。两条提示词里都写死了这件事，
 * 改其中一条时另一条要跟着改，否则那一幕就自相矛盾了。
 *
 * ## slot 字符串为什么全是 `landing.` 前缀
 *
 * 这一组是 `reach: 'public'`：未登录的 `/home` 要能看到，走匿名端点，而后端那个端点
 * 只放行 `landing.` 前缀（公网无鉴权面不吐整张表）。换前缀等于这一组图在首页上集体消失。
 */
export const HOME_IMAGERY: ImageryModule = {
  id: 'home',
  label: '对外首页（未登录）',
  route: '/home',
  reach: 'public',
  defaultStyle: 'muted',
  hint: '十幕里演「生成结果」的那几张。它们要冒充用户自己生成出来的作品，所以必须是照片。',
  slots: [
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
  ],
};
