/*
 * branchDeploymentSelection — 从一组分支部署/操作日志里挑出「当前活跃部署」的纯函数 SSOT。
 *
 * 从 BranchDetailDrawer 抽出来，使「活跃部署」判定可脱离 React 单测（tests/web 在 node 环境跑）。
 * 仅 import type（运行时擦除），不会拉起 BranchDetailDrawer 的 React/UI 依赖链。
 */
import type { BranchDeploymentItem } from './BranchDetailDrawer';

/** 部署收尾后仍把「最近结束的一条」当活跃的拖尾窗口（60s）。 */
export const ACTIVE_DEPLOYMENT_TAIL_MS = 60_000;

/**
 * 挑选当前活跃部署；无则返回 null。
 *
 * 僵尸 running 守卫：一条 webhook 派发/部署日志若进程在 finalize 前重启（或漏写终态），会永远停在
 * status='running'。旧逻辑「有 running 就选它当当前部署」会把这条 N 天前的孤儿当成进行中 →
 * finishedAt 为空、已用时算成几天 → 误报「疑似卡住 ≥1h」，盖在一个其实健康运行的分支上
 * （真实根因见 .claude/rules，2026-06-29 miduo-backend-master 案例）。
 *
 * 规则：用「已终结部署的最晚 finishedAt」当门槛 —— 分支部署是串行（操作租约互斥）的，只要有任意一条
 * 部署在某个 running 开始**之后**才完成，那条 running 就必是被这次更晚完成的部署取代的孤儿。必须比
 * **完成时间**而不是开始时间（Bugbot Medium,2026-06-29）：一条卡死的 running 可能在某次已完成部署的
 * startedAt 之后、finishedAt 之前开始，若只比 startedAt 会把它误当活跃 → 「疑似卡住」复发。
 */
export function pickActiveDeployment(
  items: BranchDeploymentItem[],
  now: number,
): BranchDeploymentItem | null {
  if (items.length === 0) return null;
  const sorted = items.slice().sort((left, right) => right.startedAt - left.startedAt);
  const newestFinishedDeployEnd = sorted.reduce((max, item) => {
    if (
      item.kind === 'deploy'
      && (item.status === 'success' || item.status === 'error')
      && typeof item.finishedAt === 'number'
    ) {
      return Math.max(max, item.finishedAt);
    }
    return max;
  }, -Infinity);
  // 被更晚完成的部署取代的僵尸 running（startedAt 早于已完成部署的最晚 finishedAt）。这类条目永远
  // 不该被当成「当前部署」，否则会渲染「疑似卡住」卡片。
  const isSupersededRunning = (item: BranchDeploymentItem): boolean =>
    item.status === 'running' && item.startedAt < newestFinishedDeployEnd;
  // running 优先（但排除被更晚完成的部署取代的孤儿：running 必须在所有已完成部署都收尾之后才开始）
  const running = sorted.find(
    (item) => item.status === 'running' && item.startedAt >= newestFinishedDeployEnd,
  );
  if (running) return running;
  // 最近 60s 内结束的最近一条也当作 active
  const recent = sorted.find((item) => {
    if (!item.finishedAt) return false;
    return now - item.finishedAt <= ACTIVE_DEPLOYMENT_TAIL_MS;
  });
  if (recent) return recent;
  // 兜底返回最新一条，但**跳过僵尸 running**（Codex P2）：tail 窗口过期后，若直接返回 sorted[0]，
  // 而最新一条恰是被取代的僵尸 running，会把「疑似卡住」卡片又选回来。改取最新的非僵尸条目；
  // 万一全是僵尸 running（极端），才退回 sorted[0]。
  return sorted.find((item) => !isSupersededRunning(item)) ?? sorted[0];
}
