/**
 * App Store（iOS 暗色模式）页面级复刻的设计 tokens。
 *
 * 目的：所有"苹果风"移动端页面共用同一套字号/间距/色彩，
 * 避免每次写 Tailwind 类名都要重新斟酌比例 —— 苹果设计之所以不显山不露水，
 * 核心就是**严格的纪律性**：字号只在几个固定档位跳、间距只在几个刻度上走。
 *
 * 参考：iOS 18 Human Interface Guidelines + App Store Today tab 实测尺寸。
 * 所有数值都是 px，Tailwind 用 arbitrary value 套用。
 */

/* ───────────── 色彩（iOS Dark Mode 系统色 + App Store 专用） ───────────── */

export const AS_COLOR = {
  /** 页面背景：App Store Today 暗色是纯黑，不是 #141418 那种微灰 */
  bg: '#000000',

  /** 一级文字（标题） */
  label: '#FFFFFF',
  /** 二级文字（副标题、日期） */
  labelSecondary: 'rgba(235, 235, 245, 0.60)',
  /** 三级文字（placeholder、极弱提示） */
  labelTertiary: 'rgba(235, 235, 245, 0.30)',

  /** iOS 分隔线（列表 hairline） */
  separator: 'rgba(84, 84, 88, 0.34)',
  /** 极细装饰边（卡片描边） */
  hairline: 'rgba(255, 255, 255, 0.08)',

  /** 卡片面（无图时兜底） */
  surface: 'rgba(255, 255, 255, 0.05)',
  surfaceHover: 'rgba(255, 255, 255, 0.08)',

  /** Pill 按钮底 —— App Store Get 按钮的灰色 */
  pillBg: 'rgba(120, 120, 128, 0.24)',

  /** iOS System Colors（暗色）—— 用于强调色、上眉色等 */
  blue: '#0A84FF',
  green: '#30D158',
  orange: '#FF9F0A',
  yellow: '#FFD60A',
  red: '#FF453A',
  pink: '#FF375F',
  purple: '#BF5AF2',
  teal: '#64D2FF',
  indigo: '#5E5CE6',
} as const;

/* ───────────── 字号阶梯（严格的 9 档，不允许出现中间值） ───────────── */

export const AS_TYPE = {
  /** 页面主标题（Today / 下午好）—— SF Pro Display Bold */
  heroTitle: { fontSize: 34, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.08 },
  /** Hero 副标题（日期、一行描述） */
  heroSubtitle: { fontSize: 15, fontWeight: 400, letterSpacing: '-0.01em', lineHeight: 1.3 },

  /** 区块标题（智能体 / 工具 / 最近活动）—— App Store "Must-Have Apps" 级 */
  sectionTitle: { fontSize: 26, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.1 },
  /** 区块"See All" 右侧字 */
  sectionAction: { fontSize: 17, fontWeight: 400, letterSpacing: '-0.01em' },

  /** 上眉 eyebrow（NOW AVAILABLE / EARTH DAY）—— 全大写 tracking-wide 粗体 */
  eyebrow: { fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' as const },

  /** Featured 卡片内的主标题（覆盖图片） */
  featuredTitle: { fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.1 },
  /** Featured 卡片副标题 */
  featuredSubtitle: { fontSize: 15, fontWeight: 400, lineHeight: 1.35 },

  /** 列表/卡片里的 app 名 */
  itemTitle: { fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em', lineHeight: 1.2 },
  /** 列表/卡片里的副标题 */
  itemSubtitle: { fontSize: 13, fontWeight: 400, lineHeight: 1.3 },

  /** Get / Open / Update Pill 按钮文字 */
  pill: { fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' },
  /** 极小附加说明（In-App Purchases） */
  caption: { fontSize: 11, fontWeight: 400, lineHeight: 1.2 },
} as const;

/* ───────────── 间距阶梯（基于 4 的倍数 + 常用值） ───────────── */

export const AS_SPACE = {
  /** 页面左右 gutter */
  gutter: 20,
  /** 区块之间垂直间距 */
  sectionGap: 36,
  /** 区块标题到内容 */
  titleGap: 16,
  /** 列表项垂直 padding */
  listItemPaddingY: 14,
  /** List 分隔线从 icon 右侧开始（icon 52 + 左 padding 20） */
  listDividerInset: 72,

  /** Featured 卡片圆角 */
  featuredRadius: 22,
  /** Shelf 卡片圆角 */
  shelfCardRadius: 18,
  /** App icon 圆角 */
  iconRadius: 12,
  /** Pill 按钮圆角（rounded-full 等价） */
  pillRadius: 999,
} as const;

/* ───────────── 尺寸 ───────────── */

export const AS_SIZE = {
  /** Featured 卡片的纵横比（参考 App Store "NOW AVAILABLE" 大卡） */
  featuredAspect: '16 / 11',
  /** Shelf 横滑卡片的宽度（近乎全宽，第二张探头） */
  shelfCardWidth: 308,
  /** Shelf 横滑卡片高度（水平卡片，icon 左 + 文字中 + 按钮右） */
  shelfCardHeight: 88,
  /** Shelf 卡片间距 */
  shelfGap: 12,
  /** App icon 尺寸（列表 + Featured 底部条） */
  appIconSize: 52,
  /** Pill 按钮高度 */
  pillHeight: 30,
} as const;

/* ───────────── 苹果级字体栈 ───────────── */

/** iOS/Mac 用户看到 SF Pro，其他系统 fallback 到 Inter 或系统 sans */
export const AS_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Inter", "Segoe UI", Roboto, sans-serif';
