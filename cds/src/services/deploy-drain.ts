/**
 * 自更新重启前排空在途部署（2026-07-27 会话实证，debt.cds.selfupdate-prebuilt #1）。
 *
 * 问题：同一次 push 会同时触发两件事——GitHub webhook 让 CDS 部署分支预览，
 * 以及生产 CDS 自更新到该 commit。自更新重启把在途的部署执行器一并杀掉，
 * 那次部署的心跳随即过期，看门狗把它收敛成 failed（`cds.run.interrupted`），
 * PR 的 CDS Deploy check 变红；更糟的情况是重启窗口内到达的 webhook 派发**整个丢失**
 * （连 run 记录都没有）。本 PR 期间复现 6 次以上，每次都要人工重新触发部署。
 *
 * 为什么不是「打开自动补发」：`CDS_DEPLOY_DISPATCH_RETRY_ENABLED` 那道闸是
 * 2026-06-24 为治「重试风暴」而默认关掉的——多个部署来源互相叠加把 CPU 打满、
 * 整个 CDS 进不去。补发是**事后补偿**，会把那个旧事故一起放回来。
 *
 * 所以走**事前避免**：重启前先等在途部署跑到终态。部署通常几分钟内结束，等它
 * 落地再重启，既不丢 run 也不需要任何重试。等待有上限（超时就照常重启并如实
 * 记录，绝不让一个卡住的部署把自更新永久堵死——自更新往往正是去修那个卡住的
 * bug 的），可经 `CDS_SELFUPDATE_DRAIN_TIMEOUT_MS` 调整，设 0 关闭。
 *
 * 判定做成纯函数，便于把「什么算在途」「什么时候该放弃等待」写成回归测试。
 */

/** 部署 run 里本模块关心的最小形状。 */
export interface DrainableRun {
  id: string;
  status: string;
  branchId?: string;
  /** 心跳时间（ISO）；用于识别「早已死掉但状态还挂在 running」的僵尸 run。 */
  heartbeatAt?: string;
  startedAt?: string;
}

/**
 * 非终态状态集合。CDS 的部署 run 以 `running` 表示**成功终态**（历史语义，
 * 见 deployment-runs 路由），故它不在此列；真正「还在跑」的是下面这些。
 */
const IN_FLIGHT_STATUSES = new Set(['queued', 'building', 'deploying', 'pending', 'starting']);

export function isRunInFlight(run: DrainableRun): boolean {
  return IN_FLIGHT_STATUSES.has(String(run.status || '').toLowerCase());
}

/**
 * 心跳超过此时长的 run 视为已死，不再等它（否则一个僵尸 run 能把自更新拖满整个
 * 超时窗口）。与看门狗的心跳过期口径同量级。
 */
export const DRAIN_STALE_HEARTBEAT_MS = 3 * 60_000;

export function isRunAlive(run: DrainableRun, nowMs: number): boolean {
  if (!isRunInFlight(run)) return false;
  const beat = Date.parse(run.heartbeatAt || run.startedAt || '');
  if (!Number.isFinite(beat)) return true; // 没有时间信息时保守当作活着
  return nowMs - beat <= DRAIN_STALE_HEARTBEAT_MS;
}

/** 当前仍值得等待的 run（在途且心跳新鲜）。 */
export function pendingRunsToDrain(runs: readonly DrainableRun[], nowMs: number): DrainableRun[] {
  return runs.filter((r) => isRunAlive(r, nowMs));
}

export interface DrainOutcome {
  /** 是否等到了全部落地（false = 超时后放弃，照常重启）。 */
  drained: boolean;
  /** 等待耗时（毫秒）。 */
  waitedMs: number;
  /** 放弃时仍在途的 run id（如实记录，绝不静默）。 */
  remaining: string[];
  /** 一开始就没有在途 run 时为 true（未真正等待）。 */
  skipped: boolean;
}

export interface DrainDeps {
  listRuns: () => readonly DrainableRun[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  pollIntervalMs?: number;
  onWait?: (pending: DrainableRun[], waitedMs: number) => void;
}

/**
 * 等在途部署落地，或等到超时。
 *
 * 超时不是失败——是「等够了就走」。自更新的优先级高于任何一次分支部署：
 * 卡住的部署不该把「修 bug 的那次自更新」永久堵在门外。放弃时把仍在途的
 * run id 如实带出去，由调用方记进事件日志。
 */
export async function drainInFlightDeploys(deps: DrainDeps): Promise<DrainOutcome> {
  const started = deps.now();
  if (deps.timeoutMs <= 0) {
    return { drained: true, waitedMs: 0, remaining: [], skipped: true };
  }
  const poll = Math.max(200, deps.pollIntervalMs ?? 2_000);
  let pending = pendingRunsToDrain(deps.listRuns(), deps.now());
  if (pending.length === 0) {
    return { drained: true, waitedMs: 0, remaining: [], skipped: true };
  }
  for (;;) {
    const waited = deps.now() - started;
    if (pending.length === 0) {
      return { drained: true, waitedMs: waited, remaining: [], skipped: false };
    }
    if (waited >= deps.timeoutMs) {
      return { drained: false, waitedMs: waited, remaining: pending.map((r) => r.id), skipped: false };
    }
    deps.onWait?.(pending, waited);
    await deps.sleep(Math.min(poll, deps.timeoutMs - waited));
    pending = pendingRunsToDrain(deps.listRuns(), deps.now());
  }
}
