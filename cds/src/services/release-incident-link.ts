/**
 * release-incident-link — 故障事件 ↔ 发布的归因判定（唯一判定源，纯函数）。
 *
 * 要回答的问题：状态页上这条「生产站点宕了」的故障，是哪次发布引入的？
 *
 * 归因发生在 **incident 创建那一刻**，不做读时反推，三条理由：
 *   1. incident 是存活监控的账本（独立文件），run 是 state 的账本；反挂到 run 上
 *      要让监控去写 state，而监控刻意不持有 StateService（见 uptime-monitor.ts
 *      顶部纪律 1：它连 BranchEntry 都不写）；
 *   2. 创建时刻的归因是确定事实，读时再算会随 run 被回收（pruneReleaseRuns）而漂移，
 *      同一条故障今天显示「由 rel_x 引入」明天变成「无归因」；
 *   3. 已存在的老 incident 无法追溯，就老老实实显示无归因，不伪造。
 *
 * 将来发布中心若也要展示同款关联，必须复用本函数，不许再写第二份时间窗判定。
 */

export interface ReleaseIncidentLinkRunLike {
  releaseId: string;
  targetId: string;
  status: string;
  finishedAt?: string;
}

export interface ReleaseIncidentLink {
  releaseId: string;
  /** incident 起始时刻 − 该次发布完成时刻，用于「发布后 8 分钟出故障」这种人话文案 */
  ageMs: number;
}

/**
 * 归因时间窗。默认 30 分钟。
 *
 * 窗口存在的意义是**宁可无归因，也不冤枉三天前那次发布**：一条挂了很久才被
 * 发现的故障，如果无条件归给「最近一次发布」，就会把一个与发布无关的机房问题
 * 写成某人的锅，而这个锅一旦进了审计流水就再也洗不掉。
 */
export const DEFAULT_RELEASE_INCIDENT_LINK_WINDOW_MS = 30 * 60_000;

export function releaseIncidentLinkWindowMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.CDS_UPTIME_RELEASE_LINK_WINDOW_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RELEASE_INCIDENT_LINK_WINDOW_MS;
  return Math.floor(raw);
}

/** 终态集合。在途 run 还没落地到生产，不可能是这次故障的成因。 */
const TERMINAL_STATUSES = new Set(['success', 'failed', 'rollback_success', 'rollback_failed']);

/**
 * 把一条 incident 归因到最近一次发布。
 *
 * @param atMs   incident 判定 down 的时刻
 * @param runs   **同一个 targetId** 的 run 列表（调用方负责过滤；这里不再按 target
 *               二次过滤是为了让「传错集合」在测试里立刻暴露，而不是被静默吃掉）
 */
export function linkIncidentToRelease(
  atMs: number,
  runs: ReadonlyArray<ReleaseIncidentLinkRunLike>,
  options: { windowMs?: number } = {},
): ReleaseIncidentLink | null {
  if (!Number.isFinite(atMs)) return null;
  const windowMs = options.windowMs ?? DEFAULT_RELEASE_INCIDENT_LINK_WINDOW_MS;
  let best: { releaseId: string; at: number } | null = null;
  for (const run of runs) {
    if (!run || !TERMINAL_STATUSES.has(run.status)) continue;
    const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
    if (!Number.isFinite(finishedAt)) continue;
    // 发布必须发生在故障之前。同一毫秒算「之前」，探测粒度本来就是秒级。
    if (finishedAt > atMs) continue;
    if (!best || finishedAt > best.at) best = { releaseId: run.releaseId, at: finishedAt };
  }
  if (!best) return null;
  const ageMs = atMs - best.at;
  if (ageMs > windowMs) return null;
  return { releaseId: best.releaseId, ageMs };
}
