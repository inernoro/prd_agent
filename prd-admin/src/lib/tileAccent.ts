import type { CSSProperties } from 'react';

/**
 * 桌面端智能体/工具卡片的统一配色与表面材质（SSOT）。
 *
 * 色阶尺（tonal ladder）：品类色统一取同一饱和度/明度档位，只允许换色相 H。
 * 颜色只出现在图标芯片上；卡片底、描边、辉光一律中性——彩而不乱的关键
 * 是"档位一致 + 颜色不乱涂在装饰上"，不是砍成单色。
 *
 * 消费方：首页启动器（AgentLauncherPage）+ 百宝箱（ToolCard），
 * 两处的卡片视觉语言必须一致（frontend-architecture：组件复用 / SSOT）。
 * 移动端另有一套 iOS 色系（lib/agentAccent.ts），互不混用。
 */
export const ICON_HUE: Record<string, number> = {
  AudioLines: 190,
  Blocks: 239,
  BookOpen: 142,
  Clapperboard: 330,
  Factory: 25,
  FileText: 217,
  Palette: 271,
  PenTool: 160,
  Bug: 25,
  Video: 347,
  Swords: 38,
  Code2: 160,
  Languages: 190,
  FileSearch: 45,
  BarChart3: 258,
  Bot: 239,
  FileBarChart: 239,
  Workflow: 173,
  Zap: 38,
  Globe: 199,
  ClipboardCheck: 239,
  ScanSearch: 258,
  Wand2: 258,
  FlaskConical: 199,
  ScrollText: 215,
  Sparkle: 271,
  ListTree: 142,
  Sparkles: 43,
  Library: 217,
  Store: 38,
  FolderHeart: 330,
  Cpu: 239,
  Users: 187,
  Hammer: 215,
  FolderKanban: 217,
  GitPullRequest: 258,
  GraduationCap: 217,
  Link2: 173,
  Mail: 347,
  Mic: 190,
  Plug: 160,
  Route: 258,
  Share2: 187,
  Terminal: 215,
  // 百宝箱自定义工具常用图标（对齐原 ACCENT_PALETTE 的色相）
  Lightbulb: 38,
  Target: 0,
  Wrench: 30,
  Rocket: 217,
  MessageSquare: 173,
  Brain: 292,
  Database: 199,
  Image: 330,
  Music: 292,
  Briefcase: 30,
  Heart: 347,
  Star: 43,
  Shield: 217,
  Lock: 215,
  Search: 173,
  Layers: 258,
  Globe2: 199,
  // 毒舌秘书：科幻深蓝，与 PaSecretaryHeroArt 内联插画呼应
  PaSecretary: 224,
};

export type Accent = { color: string; soft: string; border: string; faint: string; glow: string };

export function hueAccent(h: number): Accent {
  return {
    color: `hsl(${h} 68% 64%)`,
    soft: `hsla(${h}, 68%, 60%, 0.14)`,
    // faint: 静息态渗色（远看近乎不可见）；glow: 悬停投影。
    // 纪律不变：静时安静、碰时呼吸——色彩只在交互瞬间参与。
    border: `hsla(${h}, 68%, 60%, 0.26)`,
    faint: `hsla(${h}, 68%, 60%, 0.07)`,
    glow: `hsla(${h}, 68%, 60%, 0.3)`,
  };
}

export function getAccent(icon: string): Accent {
  return hueAccent(ICON_HUE[icon] ?? 239);
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
