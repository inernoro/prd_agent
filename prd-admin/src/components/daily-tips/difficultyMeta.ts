import type { TutorialDifficulty } from '@/services/real/dailyTips';

/**
 * 教程难度(初/中/高)→ 标签 + 配色。注册表模式(frontend-architecture.md),
 * TipsDrawer 抽屉卡片与学习中心卡片共用,避免两处硬编码 switch 漂移。
 * 经验值权重在后端(初 10 / 中 20 / 高 40),前端只负责展示 difficulty + xpReward。
 */
export const DIFFICULTY_META: Record<TutorialDifficulty, { label: string; fg: string; bg: string }> = {
  beginner: { label: '初级', fg: 'rgba(52,211,153,0.95)', bg: 'rgba(52,211,153,0.14)' },
  intermediate: { label: '中级', fg: 'rgba(125,211,252,0.97)', bg: 'rgba(56,189,248,0.14)' },
  advanced: { label: '高级', fg: 'rgba(251,146,60,0.98)', bg: 'rgba(251,146,60,0.16)' },
};

export function difficultyMeta(d?: TutorialDifficulty | null) {
  return DIFFICULTY_META[(d ?? 'beginner') as TutorialDifficulty] ?? DIFFICULTY_META.beginner;
}
