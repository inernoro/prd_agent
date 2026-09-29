/**
 * 片花的调色板：影片里出现的每一个字面色都只在本文件写一次。
 *
 * 片花是「放映内容」，和一段 MP4 一样不随浅 / 深主题翻转——它本来就是一块
 * 暗场银幕，翻成浅底反而是错的。所以它不走 tokens.css，而是把字面色收在这一处：
 * 双皮肤棘轮只需要为这一个文件记一条基线（与 `scenes/sceneTokens.ts` 同一做法），
 * 首页禁紫守卫照常扫描这里（受管范围是整个 `pages/home`）。
 *
 * 色系沿用首页：暖石墨底 + 陶土身份色 + 钢青 / 松绿两支墨色。
 * 品牌渐变的三档色标与其上的前景色直接从 HeroSection（SSOT）取，不抄色值。
 */
import { HERO_GRADIENT, HERO_GRADIENT_FG, HERO_GRADIENT_STOPS } from '../sections/HeroSection';

const [BRAND_DEEP, BRAND, BRAND_LIGHT] = HERO_GRADIENT_STOPS;
const STEEL = '#6AB6D2';
const PINE = '#6AD2A2';

/**
 * 视觉锚点：Apple 发布片（2026-09-28 用户指定）。以下度量按它的发布片取值，改之前先对照：
 *   · 底：纯黑 #000，没有暗角、噪点、角标 HUD——画面上只有内容
 *   · 字：正文白 #F5F5F7，副标题灰 #86868B；主标题 110–170px、字重 700、字距 -0.04em
 *   · 面板：#1C1C1E / #2C2C2E 两档，描边 8% 白，圆角 28px
 *   · 强调色只落在关键词与关键数字上，不铺满画面
 */
export const FILM = {
  bg: '#000000',
  panel: '#1C1C1E',
  panelRaised: '#2C2C2E',
  panelInset: '#141416',
  line: 'rgba(255, 255, 255, 0.08)',
  lineStrong: 'rgba(255, 255, 255, 0.14)',

  text: '#F5F5F7',
  gray: '#86868B',
  textDim: '#A1A1A6',
  textFaint: '#6E6E73',

  clay: BRAND,
  clayDeep: BRAND_DEEP,
  sand: BRAND_LIGHT,
  steel: STEEL,
  pine: PINE,
  danger: '#E5625A',
  paper: '#EFE6D8',
  ink: '#2A2622',

  brandGradient: HERO_GRADIENT,
  /** 铺在品牌渐变上的深墨字（两主题同为深墨，对比度见 HeroSection 的说明） */
  onBrand: HERO_GRADIENT_FG,
  titleGradient: 'linear-gradient(180deg, #FFFFFF 0%, #FBF0E7 55%, #E7C3A8 100%)',

  vignette: 'radial-gradient(ellipse at center, transparent 52%, rgba(0, 0, 0, 0.62) 100%)',
  ambient:
    'radial-gradient(ellipse at 30% 20%, rgba(217, 119, 87, 0.10), transparent 55%), radial-gradient(ellipse at 80% 90%, rgba(106, 182, 210, 0.08), transparent 55%)',
  flash: '#FFF4E8',
  shadow: '0 30px 80px rgba(0, 0, 0, 0.55)',
  scrim: 'linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.72))',
  dots: 'radial-gradient(circle, rgba(255, 255, 255, 0.10) 1.4px, transparent 1.4px)',
  hatch: 'repeating-linear-gradient(45deg, rgba(255, 255, 255, 0.03) 0 16px, transparent 16px 32px)',
  shimmer: 'linear-gradient(100deg, transparent 20%, rgba(255, 255, 255, 0.10) 50%, transparent 80%)',
  glass: 'rgba(14, 12, 10, 0.72)',
  /** 快切底色上的斜纹（onBrand 是 CSS 变量，不能再拼透明度后缀，所以单列） */
  stripe: 'rgba(26, 18, 13, 0.09)',
  /** 标志亮相时扫过的那道高光 */
  sheen: 'linear-gradient(105deg, transparent 35%, rgba(255, 255, 255, 0.55) 50%, transparent 65%)',
} as const;

/** 四张生成海报的画法（纯 CSS，无图片资源）。 */
export const POSTER_ART = [
  {
    // 胶片日落：天空渐变 + 太阳 + 远山剪影
    sky: `linear-gradient(180deg, #2B1A14 0%, #7A3A26 38%, ${BRAND} 66%, #F2C48D 100%)`,
    sun: 'radial-gradient(circle, #FFE3B8 0%, #F6B878 45%, rgba(246, 184, 120, 0) 70%)',
    hills: '#1E1310',
    accent: '#FFE3B8',
  },
  {
    // 几何构成：深底 + 同心圆 + 斜切色块
    sky: 'linear-gradient(160deg, #13171A 0%, #1C2A31 100%)',
    sun: `radial-gradient(circle, transparent 38%, ${STEEL} 39%, ${STEEL} 41%, transparent 42%, transparent 55%, ${BRAND} 56%, ${BRAND} 58%, transparent 59%)`,
    hills: BRAND,
    accent: '#EAF6FA',
  },
  {
    // 水墨山水：宣纸底 + 层叠墨山 + 朱印
    sky: 'linear-gradient(180deg, #F3ECE0 0%, #E6DCCB 100%)',
    sun: 'radial-gradient(circle, rgba(206, 107, 65, 0.9) 0%, rgba(206, 107, 65, 0.9) 60%, transparent 62%)',
    hills: '#3B4A52',
    accent: '#B8452C',
  },
  {
    // 夜城：深蓝夜幕 + 窗格灯带 + 月亮
    sky: 'linear-gradient(180deg, #0B1318 0%, #15242C 60%, #2A2A26 100%)',
    sun: 'radial-gradient(circle, #F4EDE6 0%, #E7D8C4 55%, rgba(231, 216, 196, 0) 72%)',
    hills: '#0A0F12',
    accent: BRAND_LIGHT,
  },
] as const;

/** 快切每拍的底色（循环取）。 */
export const MONTAGE_COLORS = [BRAND, STEEL, PINE, BRAND_LIGHT, BRAND_DEEP, '#5A9CB5', '#4FB888', '#D9905E'] as const;

/** 知识星系、百宝箱等处按序号取的点缀色。 */
export const ACCENT_CYCLE = [BRAND, STEEL, PINE, BRAND_LIGHT] as const;

/** 大字的渐变填充（快切每拍一支、关键数字与收口标语用）。每支都从品牌色走向近白，保证黑底上够亮。 */
export const WORD_GRADIENTS = [
  HERO_GRADIENT,
  `linear-gradient(135deg, ${STEEL} 0%, #EAF6FA 100%)`,
  `linear-gradient(135deg, ${PINE} 0%, #E8FBF2 100%)`,
  `linear-gradient(135deg, ${BRAND_LIGHT} 0%, #FFF1E2 100%)`,
] as const;
