/**
 * 首页「真实面板」场景的配色 SSOT。
 *
 * 为什么这些色值集中在这一个文件里，而不是散在四个场景组件里：
 *
 * 1. `/home` 是**固定暗色**的宣传页（LandingPage 根节点写死 `bg-[#0E0C0A]`，
 *    不参与 `<html data-theme>` 的明暗切换）。这些场景画的是「登录之后的产品长什么样」
 *    ——它复刻的就是应用内暗色工作台的表面材质，翻成浅色反而是失真。
 *    这属于 `admin-dual-theme.md`「合法例外 · 暗色形态专用皮肤对象」那一档。
 * 2. 例外不等于可以随手写。四个场景共用同一套表面/描边/文字阶梯，散着写必然各自漂移
 *    （HERO_GRADIENT 被手抄三份、三份各自漂色，就是前车之鉴）。集中一处后
 *    改一个阶梯四个场景同步，也让双皮肤棘轮只需要记一条基线而不是四条。
 *
 * 色相一律走墨系色带（`lib/tileAccent.ts` 的 INK_HUES），紫/靛/品红不在带内——
 * 这条由 `lib/__tests__/inkPalette.test.ts` 守着，`pages/home` 在它的 GUARDED 清单里。
 */

/** 暗色工作台表面阶梯（对齐 tokens.css 暗色档的 --bg-* / --launcher-tile-*）。 */
export const SCENE = {
  /** 画布底（应用内画布用的中性深灰，比页面底稍亮，好让浮层浮得起来） */
  canvas: '#1e1e1e',
  /** 卡片/占位底 —— 对齐 --bg-base 暗色档 */
  base: '#141418',
  /** 浮动面板（对话面板 / 三栏阅读器） */
  panel: 'rgba(30, 30, 36, 0.94)',
  /** 浮层（动作条 / 划词浮层）—— 比面板更实，压得住底下的内容 */
  overlay: 'rgba(30, 30, 36, 0.97)',
  /** 胶囊浮条（缩放条 / 工具条） */
  pill: 'rgba(30, 30, 36, 0.92)',

  /** 表面：极淡 → 淡 → 可点 */
  ghost: 'rgba(255, 255, 255, 0.03)',
  tile: 'rgba(255, 255, 255, 0.055)',
  tileHi: 'rgba(255, 255, 255, 0.07)',

  /** 描边：发丝 → 常规 → 强调 */
  hair: 'rgba(255, 255, 255, 0.08)',
  line: 'rgba(255, 255, 255, 0.12)',
  edge: 'rgba(255, 255, 255, 0.14)',
  edgeStrong: 'rgba(255, 255, 255, 0.18)',

  /** 文字阶梯（对齐 --text-primary / secondary / muted 暗色档） */
  ink: '#f7f7fb',
  inkSoft: 'rgba(247, 247, 251, 0.86)',
  inkMid: 'rgba(247, 247, 251, 0.68)',
  inkDim: 'rgba(247, 247, 251, 0.5)',
  inkFaint: 'rgba(247, 247, 251, 0.42)',
  inkGhost: 'rgba(247, 247, 251, 0.34)',

  /** 品牌赭红实心（主操作）—— 对齐 --accent-primary-solid */
  brand: '#B0523A',
  brandFg: '#ffffff',

  /** 投影：浮条 → 面板 → 浮层 */
  liftSm: '0 12px 32px rgba(0, 0, 0, 0.45)',
  liftMd: '0 16px 40px rgba(0, 0, 0, 0.45)',
  liftLg: '0 20px 56px rgba(0, 0, 0, 0.5)',
  liftBar: '0 14px 40px rgba(0, 0, 0, 0.6)',

  /** 图片上的角标：底部压一层黑渐变 + 近白字（彩图上的白字两个主题都成立） */
  captionFg: 'rgba(255, 255, 255, 0.86)',
  captionScrim: 'linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.72))',
  /** 画布的点阵底纹 */
  canvasDots: 'radial-gradient(circle, rgba(255, 255, 255, 0.12) 1px, transparent 1px)',
  /** 虚线占位元素的极淡填充 */
  faintFill: 'rgba(255, 255, 255, 0.02)',
  /** 生成中占位卡的 45 度斜纹（比 ghost 还淡一档，只提供"有东西在长"的质感） */
  hatch: 'repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.014) 0 14px, transparent 14px 28px)',
  /** 扫光条两端的过渡白（写成 hsla 是为了和中间那段品类色同族拼接） */
  sweepEdge: 'hsla(0, 0%, 100%, 0.015)',

  /** 编辑器面：比画布再抬一档（对齐 --bg-elevated 暗色档） */
  editorSurface: '#1e1e24',
  /** 卡片里再套一层内框时的压深底 */
  inset: 'rgba(0, 0, 0, 0.16)',
  /** 图片区的托底：图没出来时这块也不是纯透明 */
  mediaWell: 'rgba(0, 0, 0, 0.22)',
  /** 压在图片上下的遮罩，保证角标与 prompt 在任何图上都读得清 */
  scrimTop: 'linear-gradient(180deg, rgba(0, 0, 0, 0.5), transparent)',
  scrimBottom: 'linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.78))',
} as const;

/**
 * 知识星系的夜空底。收在这里而不是写在组件里：深色 hex 与深色 rgba 都是双皮肤棘轮
 * 盯的对象，四个场景的字面色**只在本文件出现一次**，棘轮只需要记一条基线。
 */
export function galaxyBackdrop(hue: number): string {
  return `radial-gradient(120% 150% at 50% 116%, hsl(${hue} 32% 12%) 0%, #0b0d12 46%, #06070a 100%)`;
}

/** 一个墨系色相的五档取值。参数是色相度数，只能取 INK_HUES 里的八个之一。 */
export function inkTone(h: number) {
  return {
    /** 图标/强调字 */
    solid: `hsl(${h} 54% 62%)`,
    /** 高亮字（比 solid 再亮一档，用于深底上的小字） */
    bright: `hsl(${h} 54% 68%)`,
    /** 选中/激活底 */
    soft: `hsla(${h}, 54%, 58%, 0.16)`,
    /** 选中/激活描边 */
    border: `hsla(${h}, 54%, 58%, 0.28)`,
    /** 场景角落的品类渗光 */
    faint: `hsla(${h}, 54%, 58%, 0.09)`,
  };
}

/**
 * 场景里用到的墨系色相（度）。与 `lib/tileAccent.ts` 的 INK_HUES 同源，
 * 这里只是把本页用到的那几支点名出来，方便阅读时对上「哪个场景是哪支色」。
 */
export const SCENE_HUE = {
  clay: 16, // 视觉创作
  amber: 44, // 超时/即将完成
  olive: 92, // 知识库
  pine: 152, // 完成态 / 文学创作·林间
  steel: 196, // 生成中 / 文学创作·沉静
  slate: 214, // 三层一体 · 结构
} as const;

/** 场景内所有 @keyframes 的唯一定义处（扫光 / 光标 / 星点呼吸）。 */
export const SCENE_KEYFRAMES = `
@keyframes mapSceneSweep { from { transform: translateX(-100%); } to { transform: translateX(120%); } }
@keyframes mapSceneCaret { 50% { opacity: 0; } }
@keyframes mapSceneTwinkle { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .map-scene-anim { animation: none !important; }
}
`;
