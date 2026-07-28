/**
 * 分支归属判定（本地内嵌 master vs 远端 executor）的唯一判定源。
 *
 * 约定：`BranchEntry.executorId` 为空、或以 `master-` 开头 = 内嵌 master 自己持有
 * （容器就在本机）；其余非空值 = 远端 executor 持有（容器在那台机器上）。
 *
 * 为什么单独抽一个文件：这条判定原本以内联字面量的形式散在
 * `routes/branches.ts`（redeploy 的 ghost 守卫）与 `server.ts`（心跳容量统计）里，
 * 各写一遍。存活监控新增第四个消费方时只照着「!== 'embedded'」写，把
 * `master-xxx` 的本地分支误判成远端、从此永久排除出监控——正是判定分散导致的
 * 漂移（Codex PR #1273 P2）。此后所有消费方一律走这里。
 */

/** 归属远端 executor（容器不在本机，宿主端口也不是本机的端口）。 */
export function isRemoteExecutorOwned(executorId: string | null | undefined): boolean {
  if (!executorId) return false;
  // 历史上也出现过字面量 'embedded'，一并当本地处理。
  if (executorId === 'embedded') return false;
  return !executorId.startsWith('master-');
}

/** 归属本机（内嵌 master）。isRemoteExecutorOwned 的反面，给可读性用。 */
export function isLocallyOwned(executorId: string | null | undefined): boolean {
  return !isRemoteExecutorOwned(executorId);
}
