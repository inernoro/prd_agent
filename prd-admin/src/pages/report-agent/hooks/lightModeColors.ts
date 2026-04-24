/**
 * 浅色模式 (#FAF9F5 Anthropic 暖白底) 语义色统一规范。
 *
 * 设计原则:
 * 1. 主文字 / 图标使用 alpha 1.0 + Tailwind 600/700 色阶,确保 WCAG AA 4.5:1 对比度达标
 * 2. 半透明背景 alpha 在 0.10-0.15,在浅底上既有色彩感又不喧宾夺主
 * 3. border alpha 0.20-0.25,描边清晰但不干扰
 *
 * 所有 buildXxxConfig(isLight) 函数必须从这里取值,禁止再 inline 写浅色 rgba 字面量。
 */
export const LIGHT_SEMANTIC = {
  // ── 文字 / 图标主色 (alpha 1.0,Tailwind 700/800 色阶,米底上对比度 ≥ 7:1)
  slate:       'rgba(51, 65, 85, 1)',        // 中性灰 (未开始 / 草稿 / 辅助文字) — slate-700
  slateStrong: 'rgba(30, 41, 59, 1)',        // 标题级灰 — slate-800
  blue:        'rgba(29, 78, 216, 1)',       // 已提交
  green:       'rgba(21, 128, 61, 1)',       // 已审阅 / 已查看
  red:         'rgba(185, 28, 28, 1)',       // 已退回 / 逾期
  purple:      'rgba(126, 34, 206, 1)',      // AI / 会议
  orange:      'rgba(194, 65, 12, 1)',       // 沟通 / 待提交
  pink:        'rgba(190, 24, 93, 1)',       // 测试
  teal:        'rgba(15, 118, 110, 1)',      // todo
  sky:         'rgba(2, 132, 199, 1)',       // source(MAP/平台)
  emerald:     'rgba(4, 120, 87, 1)',        // "常来" 标签
  claude:      'rgba(204, 120, 92, 1)',      // Anthropic Claude 橙,主 accent (#CC785C)
  moss:        'rgba(90, 143, 94, 1)',       // 柔和墨绿,完成态 (#5A8F5E)
  amber:       'rgba(184, 120, 76, 1)',      // 琥珀暖橙,进行中态 (#B8784C)

  // ── 半透明背景 (alpha 0.10-0.15)
  bgSlate:     'rgba(51, 65, 85, 0.10)',
  bgBlue:      'rgba(29, 78, 216, 0.10)',
  bgGreen:     'rgba(21, 128, 61, 0.10)',
  bgRed:       'rgba(185, 28, 28, 0.10)',
  bgPurple:    'rgba(126, 34, 206, 0.10)',
  bgOrange:    'rgba(194, 65, 12, 0.10)',
  bgPink:      'rgba(190, 24, 93, 0.10)',
  bgTeal:      'rgba(15, 118, 110, 0.10)',
  bgSky:       'rgba(2, 132, 199, 0.10)',
  bgEmerald:   'rgba(4, 120, 87, 0.12)',
  bgClaude:    'rgba(204, 120, 92, 0.10)',
  bgMoss:      'rgba(90, 143, 94, 0.12)',
  bgAmber:     'rgba(184, 120, 76, 0.10)',

  // ── 边框 (alpha 0.20-0.28)
  borderSlate:   'rgba(51, 65, 85, 0.22)',
  borderBlue:    'rgba(29, 78, 216, 0.22)',
  borderGreen:   'rgba(21, 128, 61, 0.22)',
  borderRed:     'rgba(185, 28, 28, 0.22)',
  borderPurple:  'rgba(126, 34, 206, 0.22)',
  borderOrange:  'rgba(194, 65, 12, 0.22)',
  borderPink:    'rgba(190, 24, 93, 0.22)',
  borderTeal:    'rgba(15, 118, 110, 0.22)',
  borderSky:     'rgba(2, 132, 199, 0.22)',
  borderClaude:  'rgba(204, 120, 92, 0.28)',
  borderMoss:    'rgba(90, 143, 94, 0.32)',
  borderAmber:   'rgba(184, 120, 76, 0.28)',
} as const;

/** 一站式三元组:文字色 + 背景色 + 边框色,常用于 status chip / category chip */
export interface SemanticTriplet {
  color: string;
  bg: string;
  border: string;
}

export type SemanticHue = 'slate' | 'blue' | 'green' | 'red' | 'purple' | 'orange' | 'pink' | 'teal' | 'sky' | 'emerald' | 'claude' | 'moss' | 'amber';

const HUE_TO_RGB: Record<SemanticHue, string> = {
  slate:   '156, 163, 175',
  blue:    '59, 130, 246',
  green:   '34, 197, 94',
  red:     '239, 68, 68',
  purple:  '168, 85, 247',
  orange:  '249, 115, 22',
  pink:    '236, 72, 153',
  teal:    '20, 184, 166',
  sky:     '56, 189, 248',
  emerald: '16, 185, 129',
  claude:  '204, 120, 92',
  moss:    '90, 143, 94',
  amber:   '184, 120, 76',
};

/**
 * 按 hue + 主题取一组 (color, bg, border)。
 * - 浅色:返回 LIGHT_SEMANTIC 里规范的深色阶 + 0.10/0.22 alpha
 * - 暗色:返回原暗色色阶 (alpha 0.9 / 0.08 / 0.15) 保持原视觉
 */
export function getSemantic(isLight: boolean, hue: SemanticHue): SemanticTriplet {
  if (isLight) {
    const colorKey = hue as keyof typeof LIGHT_SEMANTIC;
    return {
      color:  LIGHT_SEMANTIC[colorKey] ?? LIGHT_SEMANTIC.slate,
      bg:     LIGHT_SEMANTIC[`bg${capitalize(hue)}` as keyof typeof LIGHT_SEMANTIC] ?? LIGHT_SEMANTIC.bgSlate,
      border: LIGHT_SEMANTIC[`border${capitalize(hue)}` as keyof typeof LIGHT_SEMANTIC] ?? LIGHT_SEMANTIC.borderSlate,
    };
  }
  const rgb = HUE_TO_RGB[hue];
  return {
    color:  `rgba(${rgb}, 0.9)`,
    bg:     `rgba(${rgb}, 0.08)`,
    border: `rgba(${rgb}, 0.15)`,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
