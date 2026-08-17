import type { TutorialDifficulty } from '@/services/real/dailyTips';

/**
 * 教程难度(初/中/高)→ 标签 + 配色。注册表模式(frontend-architecture.md),
 * TipsDrawer 抽屉卡片与学习中心卡片共用,避免两处硬编码 switch 漂移。
 * 经验值权重在后端(初 10 / 中 20 / 高 40),前端只负责展示 difficulty + xpReward。
 */
/*
 * 底走 14~16% 同色调（两个主题都成立），字必须走双写的 --accent-fg-*。
 * 原来字也写死 300/400 档，浅色主题下就是「浅绿字压浅绿底」——
 * 初级 1.56:1，中/高级同型。学习中心与教程抽屉共用这一份，一处错、两处糊。
 */
export const DIFFICULTY_META: Record<TutorialDifficulty, { label: string; fg: string; bg: string }> = {
  beginner: { label: '初级', fg: 'var(--accent-fg-success)', bg: 'rgba(52,211,153,0.14)' },
  intermediate: { label: '中级', fg: 'var(--accent-fg-blue)', bg: 'rgba(56,189,248,0.14)' },
  advanced: { label: '高级', fg: 'var(--accent-fg-warning)', bg: 'rgba(251,146,60,0.16)' },
};

export function difficultyMeta(d?: TutorialDifficulty | null) {
  return DIFFICULTY_META[(d ?? 'beginner') as TutorialDifficulty] ?? DIFFICULTY_META.beginner;
}
