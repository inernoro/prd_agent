/**
 * 个人公开页可选的背景主题。
 * 每个主题是一个 CSS background（可含多层 radial / linear gradient）。
 * 主题 key 持久化到 `User.ProfileBackground` 字段。
 */

export interface ProfileBackgroundTheme {
  key: string;
  label: string;
  /** 头部 banner 区的渐变光晕（叠在深色底色上，opacity 40%） */
  banner: string;
  /** 页面背景底色（hex） */
  base: string;
}

export const PROFILE_BACKGROUND_THEMES: ProfileBackgroundTheme[] = [
  {
    key: 'aurora',
    label: '极光',
    banner:
      'radial-gradient(ellipse 80% 60% at 30% 0%, rgba(56,189,248,0.25) 0%, transparent 55%), radial-gradient(ellipse 60% 50% at 90% 20%, rgba(139,92,246,0.2) 0%, transparent 60%)',
    base: '#0a0b0f',
  },
  {
    key: 'sunset',
    label: '日落',
    banner:
      'radial-gradient(ellipse 80% 60% at 20% 0%, rgba(251,146,60,0.28) 0%, transparent 55%), radial-gradient(ellipse 60% 55% at 85% 15%, rgba(236,72,153,0.22) 0%, transparent 60%)',
    base: '#110a0a',
  },
  {
    key: 'forest',
    label: '森林',
    banner:
      'radial-gradient(ellipse 80% 60% at 15% 10%, rgba(34,197,94,0.22) 0%, transparent 55%), radial-gradient(ellipse 60% 55% at 90% 25%, rgba(20,184,166,0.2) 0%, transparent 60%)',
    base: '#0a100d',
  },
  {
    key: 'ocean',
    label: '深海',
    banner:
      'radial-gradient(ellipse 80% 60% at 25% 0%, rgba(59,130,246,0.26) 0%, transparent 55%), radial-gradient(ellipse 60% 55% at 85% 20%, rgba(6,182,212,0.22) 0%, transparent 60%)',
    base: '#080d14',
  },
  {
    key: 'violet',
    label: '紫罗兰',
    banner:
      'radial-gradient(ellipse 80% 60% at 20% 10%, rgba(168,85,247,0.28) 0%, transparent 55%), radial-gradient(ellipse 60% 55% at 90% 20%, rgba(236,72,153,0.2) 0%, transparent 60%)',
    base: '#0e0912',
  },
  {
    key: 'sakura',
    label: '樱粉',
    banner:
      'radial-gradient(ellipse 80% 60% at 20% 0%, rgba(244,114,182,0.26) 0%, transparent 55%), radial-gradient(ellipse 60% 55% at 85% 20%, rgba(251,146,60,0.18) 0%, transparent 60%)',
    base: '#120a10',
  },
  {
    key: 'minimal',
    label: '极简',
    banner: 'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, transparent 100%)',
    base: '#0a0b0f',
  },
  {
    key: 'mono',
    label: '墨黑',
    banner: 'radial-gradient(ellipse 80% 60% at 50% 0%, rgba(120,120,120,0.16) 0%, transparent 55%)',
    base: '#080808',
  },
];

export const DEFAULT_BACKGROUND_KEY = 'aurora';

export function resolveBackgroundTheme(key: string | null | undefined): ProfileBackgroundTheme {
  const found = PROFILE_BACKGROUND_THEMES.find((t) => t.key === key);
  return found ?? PROFILE_BACKGROUND_THEMES[0];
}
