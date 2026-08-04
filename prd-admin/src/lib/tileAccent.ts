import type { CSSProperties } from 'react';

/**
 * 智能体/工具卡片的统一配色与表面材质（SSOT）。
 *
 * 色带（2026-08-02 收窄）：米多的底色是**纸与墨**——暖石墨 + 暖纸 + 赭红身份色。
 * 品类色因此只允许落在八个"墨系"色相上（陶土 / 焦糖 / 琥珀 / 橄榄 / 松绿 /
 * 黛青 / 钢青 / 钢蓝），**紫、靛、品红、粉一律不在色带内**——它们和纸墨底不是
 * 一家人，是过去"首页发紫"的根源。同一色带内只换色相，饱和度/明度档位固定，
 * 保证一屏几十张卡"彩而不乱"。
 *
 * 消费方：首页启动器（AgentLauncherPage）+ 百宝箱（ToolCard）+ 移动首页，
 * 三处共用同一份，改一处处处同步（frontend-architecture：SSOT）。
 */

/** 允许的八个色相（度）。新增图标只能从这里挑，不许自己发明色相。 */
export const INK_HUES = {
  clay: 16,      // 陶土：视觉/影像/情感类
  caramel: 32,   // 焦糖：缺陷/生产/工具类
  amber: 44,     // 琥珀：市场/亮点/AI 点金类
  olive: 92,     // 橄榄：阅读/文档/沉淀类
  pine: 152,     // 松绿：写作/代码/接入类
  celadon: 176,  // 黛青：流程/协作/连接类
  steel: 196,    // 钢青：音视频/网络/实验类
  slate: 214,    // 钢蓝：结构/管理/分析类
} as const;

export const ICON_HUE: Record<string, number> = {
  // 陶土：视觉、影像、人味
  Palette: INK_HUES.clay,
  Image: INK_HUES.clay,
  Clapperboard: INK_HUES.clay,
  Video: INK_HUES.clay,
  FolderHeart: INK_HUES.clay,
  Heart: INK_HUES.clay,
  Mail: INK_HUES.clay,
  Target: INK_HUES.clay,

  // 焦糖：缺陷、产线、动手的活
  Bug: INK_HUES.caramel,
  Factory: INK_HUES.caramel,
  Wrench: INK_HUES.caramel,
  Briefcase: INK_HUES.caramel,
  Hammer: INK_HUES.caramel,

  // 琥珀：市场、亮点、AI 点金
  Store: INK_HUES.amber,
  Sparkles: INK_HUES.amber,
  Sparkle: INK_HUES.amber,
  Star: INK_HUES.amber,
  Zap: INK_HUES.amber,
  Swords: INK_HUES.amber,
  Lightbulb: INK_HUES.amber,
  Wand2: INK_HUES.amber,
  Brain: INK_HUES.amber,
  Music: INK_HUES.amber,

  // 橄榄：阅读、文档、沉淀
  BookOpen: INK_HUES.olive,
  ListTree: INK_HUES.olive,
  ScrollText: INK_HUES.olive,
  FileSearch: INK_HUES.olive,

  // 松绿：写作、代码、接入
  PenTool: INK_HUES.pine,
  Code2: INK_HUES.pine,
  Plug: INK_HUES.pine,
  Search: INK_HUES.pine,
  MessageSquare: INK_HUES.pine,

  // 黛青：流程、协作、连接
  Workflow: INK_HUES.celadon,
  Link2: INK_HUES.celadon,
  Share2: INK_HUES.celadon,
  Users: INK_HUES.celadon,
  Route: INK_HUES.celadon,
  Layers: INK_HUES.celadon,

  // 钢青：音视频、网络、实验
  AudioLines: INK_HUES.steel,
  Languages: INK_HUES.steel,
  Mic: INK_HUES.steel,
  Globe: INK_HUES.steel,
  Globe2: INK_HUES.steel,
  Database: INK_HUES.steel,
  FlaskConical: INK_HUES.steel,
  Radar: INK_HUES.steel,

  // 钢蓝：结构、管理、分析
  FileText: INK_HUES.slate,
  FileBarChart: INK_HUES.slate,
  BarChart3: INK_HUES.slate,
  ScanSearch: INK_HUES.slate,
  Blocks: INK_HUES.slate,
  Bot: INK_HUES.slate,
  ClipboardCheck: INK_HUES.slate,
  Cpu: INK_HUES.slate,
  Library: INK_HUES.slate,
  FolderKanban: INK_HUES.slate,
  GitPullRequest: INK_HUES.slate,
  GraduationCap: INK_HUES.slate,
  Terminal: INK_HUES.slate,
  Rocket: INK_HUES.slate,
  Shield: INK_HUES.slate,
  Lock: INK_HUES.slate,
  // 毒舌秘书：与 PaSecretaryHeroArt 内联插画呼应
  PaSecretary: INK_HUES.slate,
};

export type Accent = { color: string; text: string; soft: string; border: string; faint: string; glow: string };

export function hueAccent(h: number): Accent {
  return {
    color: `hsl(${h} 54% 62%)`,
    // 同色相的「文字档」：`color` 是为暗底调的芯片色，直接拿去当浅色纸面上的
    // 文字会糊成一片。明度交给主题持有（暗 65% / 浅 36%），前缀 workflow- 是
    // 历史命名，它是全站唯一的 accent 文字明度 SSOT，不再另起一个同义 token。
    text: `hsl(${h} 48% var(--workflow-accent-text-lightness, 65%))`,
    soft: `hsla(${h}, 54%, 58%, 0.16)`,
    // faint: 静息态渗色（远看近乎不可见）；glow: 悬停投影。
    // 纪律不变：静时安静、碰时呼吸——色彩只在交互瞬间参与。
    border: `hsla(${h}, 54%, 58%, 0.28)`,
    faint: `hsla(${h}, 54%, 58%, 0.09)`,
    glow: `hsla(${h}, 54%, 58%, 0.32)`,
  };
}

export function getAccent(icon: string): Accent {
  return hueAccent(ICON_HUE[icon] ?? INK_HUES.slate);
}

/**
 * 瓦片表面（现代扁平版）：单层微透白 + 发丝描边，别无其他。
 *
 * 演化记录（都是用户实拍反馈驱动）：
 * v1 近黑平涂（白 3%）→ "很黑、很沉重"；
 * v2 纵向渐变 + 顶部 inset 高光 + blur → "剥离感太假，像 2000 年代的
 *    水晶按钮"——纵向渐变和顶部高光正是 aqua 按钮的两个特征，全部去掉。
 * v3（现行）：对齐 Linear / Raycast 的扁平纪律——底色只有一层平涂
 *    （白 5%，比 v1 亮一档治沉重），描边发丝级，无渐变、无高光、无
 *    静息投影、无 blur；色彩只出现在图标芯片与 hover 描边上，
 *    左上角保留一缕品类色渗光（远看近乎不可见，给卡片一点生气）。
 */
export function glassTileStyle(accent?: Accent): CSSProperties {
  const tint = accent ? `radial-gradient(150px 100px at 12% 0%, ${accent.faint} 0%, transparent 100%), ` : '';
  return {
    background: `${tint}var(--launcher-tile-bg)`,
    border: '1px solid var(--launcher-tile-border)',
  };
}
