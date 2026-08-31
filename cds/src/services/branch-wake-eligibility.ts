import type { BranchEntry } from '../types.js';

/**
 * 「这次停机之后，用户再访问预览域名时该不该自动把它拉起来」——唯一判定源。
 *
 * 为什么单独成文件：这条判断此前有**两份拷贝**（proxy.ts 的 shouldAutoWakeCooled
 * 与 index.ts 的 setOnReviveCooled 复检），两处各写一遍 `lastStopSource !== 'scheduler'`。
 * 判据分裂就会漂移（predicate-and-wiring-discipline 形状 3），而这一条漂了的后果是
 * 预览域名永久 503——不报错、不告警，只是打不开。
 *
 * ## 判据为什么曾经太窄（2026-08-30 修）
 *
 * 原判据只认 `lastStopSource === 'scheduler'`。实测线上 49 个分支里，有 5 个
 * **容器都还在、一个 docker restart 就能起来**，只因为停止来源被记成 `system` / `webhook`
 * 而被挡在门外，永久 503。其中最刺眼的一条：auto-lifecycle 降级停机时写的原话就是
 * 「已切发布版并停止，**下次访问重建**」——那个承诺从落地起就没兑现过。
 *
 * ## 现在按「这次停机是谁的意图」分档
 *
 * 放行（CDS 自己的调度/生命周期决策，没有任何人表达过「让它停着」）：
 *   - `scheduler` 调度器空闲降温 / 超热容量驱逐
 *   - `cds`       CDS 生命周期策略（state.ts 把 system:auto-lifecycle 归到这一档）
 *   - `system`    运行时**只有** auto-lifecycle 两处在写（已 grep 核过）；其中一处
 *                 就是上面那条「下次访问重建」。存量迁移数据里还可能夹着 Janitor
 *                 过期清理的旧行，把那种拉起来最坏也只是白重启一次容器，而这次重启
 *                 服务的正是此刻真的在访问这个地址的人——比现在这样永久 503 强。
 *
 * 不放行（有人表达过意图，或拉起来会更糟）：
 *   - `user`      用户手动停的。他说停就是停。
 *   - `ai`        AI Agent 调用停止，同上，是一次有主体的决定。
 *   - `webhook`   GitHub webhook 触发的停止，可能意味着上游分支已经没了；
 *                 把源码不存在的分支拉起来只会得到另一种坏状态。
 *   - `external`  有人绕过 CDS 直接 docker stop，同样是人的动作。
 *   - `executor`  远端执行器停的，本机 docker restart 够不着（下面还有 executorId 兜底）。
 *   - `crash`/`oom` 它是自己死的。重启只会再死一次，且会盖掉诊断页。
 *
 * 另外**一律不放行**「删除分支流程」留下的停机——那条链路正在拆这个分支，
 * 半路把它拉起来会和清理互相打架。
 */

/** 删除分支流程在 lastStopReason 里留下的标记。唯一定义处。 */
export const BRANCH_DELETE_CLEANUP_MARKER = '删除分支流程已开始';

/** 停机来源里，代表「CDS 自己决定的」那一档。 */
const CDS_INITIATED_STOP_SOURCES: ReadonlySet<NonNullable<BranchEntry['lastStopSource']>> = new Set([
  'scheduler',
  'cds',
  'system',
]);

export function isCdsInitiatedStop(source: BranchEntry['lastStopSource']): boolean {
  return source != null && CDS_INITIATED_STOP_SOURCES.has(source);
}

/**
 * 这次停机是不是「删除分支」流程留下的。
 * 不看 status —— 删除链路推进到哪一步都算，唤醒判据不能在其中任何一步插一脚。
 * startup-reconcile 的 hasBranchDeleteCleanupIntent 在此之上再加 status==='stopping'。
 */
export function hasBranchDeleteIntentReason(branch: BranchEntry): boolean {
  if (!(branch.lastStopReason || '').includes(BRANCH_DELETE_CLEANUP_MARKER)) return false;
  return branch.lastStopSource === 'system'
    || branch.lastStopSource === 'webhook'
    || branch.lastStopSource === 'cds';
}

/**
 * 被动访问预览域名时，这个分支能不能靠一次轻量 docker restart 复活。
 *
 * 注意它**不**判断「有没有接唤醒回调」和「是不是导航请求」——那两件是调用方的事
 * （proxy 侧判请求形态，index 侧判回调在不在），这里只回答分支本身够不够格。
 */
export function isAutoWakeEligible(branch: BranchEntry): boolean {
  if (branch.status !== 'idle') return false;
  if (!isCdsInitiatedStop(branch.lastStopSource)) return false;
  if (hasBranchDeleteIntentReason(branch)) return false;
  // 远端执行器持有的分支，本机 docker restart 是注定失败的空操作，
  // 失败还会把分支翻成 error、断掉后续重试。已解析的本机部署会把 executorId 清空，
  // 所以真值一律当远端看（含协调器重启导致的暂时失联）。
  if (branch.executorId) return false;
  // 没有任何已建服务 = 从没成功部署过，restart 无物可重启，只能走完整部署。
  return Object.keys(branch.services || {}).length > 0;
}
