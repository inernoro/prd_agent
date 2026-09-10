/**
 * 订阅类条目在文件树 / 阅读器里的状态判据。
 *
 * 抽出来是因为这两条判据各自出过一次事故（2026-09-09 验收）：
 *   - 「谁算订阅」只认了 subscription，GitHub 目录父条目因此没有任何同步入口（P1）；
 *   - GitHub 目录图标恒为紫色，后台同步失败在树里完全看不出来（P2）。
 * 放在纯模块里，改回去会被单测直接打红。
 */

export type SubscriptionSyncTone = 'error' | 'paused' | 'syncing' | 'idle';

/** GitHub 目录订阅父条目的 sourceType */
export const GITHUB_DIRECTORY_SOURCE = 'github_directory';

/**
 * 该条目是否有「订阅面板」（立即同步 / 暂停 / 同步日志）。
 * GitHub 目录父条目必须算——它才是同步真正作用的对象，子文档反而不能单独同步。
 */
export function canOpenSubscriptionPanel(sourceType?: string): boolean {
  return sourceType === 'subscription' || sourceType === GITHUB_DIRECTORY_SOURCE;
}

/** 同步状态 → 色调档位。失败优先于暂停，暂停优先于同步中。 */
export function subscriptionSyncTone(
  entry: { syncStatus?: string; isPaused?: boolean },
): SubscriptionSyncTone {
  if (entry.syncStatus === 'error') return 'error';
  if (entry.isPaused) return 'paused';
  if (entry.syncStatus === 'syncing') return 'syncing';
  return 'idle';
}

/** GitHub 目录条目的悬浮说明，状态直接写在文案里，不靠用户猜颜色。 */
export function githubDirectoryStatusLabel(tone: SubscriptionSyncTone): string {
  switch (tone) {
    case 'error': return 'GitHub 目录 · 同步失败';
    case 'paused': return 'GitHub 目录 · 已暂停';
    case 'syncing': return 'GitHub 目录 · 同步中';
    default: return 'GitHub 目录订阅';
  }
}
