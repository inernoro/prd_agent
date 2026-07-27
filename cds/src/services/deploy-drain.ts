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

import type { DeploymentRunStatus } from '../types.js';

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
 * 全量状态 → 是否终态。CDS 的部署 run 以 `running` 表示**成功终态**（历史语义，
 * 见 deployment-runs 路由与 deployment-run.ts 的 TERMINAL_STATUSES）。
 *
 * 写成 `Record<DeploymentRunStatus, boolean>` 而不是「在途状态字面量数组」是
 * 刻意的（Codex 第三十六轮 P1）：初版枚举在途状态时漏掉了 `preparing` 与
 * `verifying`——两个货真价实的非终态，于是恰好停在这两步的部署照样会被重启
 * 杀掉，排空等于半开的门。Record 少一个键 TS 直接报错，以后新增状态**必须**
 * 在这里表态，不会再有静默漏项。
 */
const RUN_STATUS_TERMINAL: Record<DeploymentRunStatus, boolean> = {
  pending: false,
  queued: false,
  preparing: false,
  building: false,
  starting: false,
  verifying: false,
  running: true,
  failed: true,
  cancelled: true,
};

export function isRunInFlight(run: DrainableRun): boolean {
  const status = String(run.status || '').toLowerCase() as DeploymentRunStatus;
  if (!status) return false; // 连状态都没有的记录没什么可等的
  const terminal = RUN_STATUS_TERMINAL[status];
  // 不认识的状态按在途处理：本轮的漏洞就是「没登记 = 当成终态 = 不等」，
  // 保守一侧代价只是最多多等一个超时窗口，激进一侧代价是杀掉在途部署。
  return terminal !== true;
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

/* ------------------------------------------------------------------ *
 * 排空窗口闸门（Codex 第三十六轮 P1）
 *
 * 只「等在途部署落地」是半个修复：排空最后一次轮询之后、进程真正退出之前仍有
 * 一段真空，这期间到达的 webhook / 手动部署会新建 run 并立刻被重启杀掉——正是
 * 排空要消灭的那个现象，只是把窗口从几分钟压到几秒。所以排空一开始就把部署入口
 * 关上：新请求当场收到 503 + Retry-After，是**明说的拒绝**，不是建到一半被腰斩
 * 的容器和一条要人工重触发的红灯。
 *
 * 闸门自带过期时间（fail-open）：重启若因任何原因没发生（spawn 失败、上层提前
 * 返回），闸门到点自动打开，绝不把部署永久锁死——同 disk-guard 的纪律。
 * ------------------------------------------------------------------ */

let drainGateUntilMs: number | null = null;

/** 默认最长持闸时长：排空超时之外再留一段给 flush + 重启交接。 */
export const DRAIN_GATE_MAX_HOLD_MS = 10 * 60_000;

export function beginSelfUpdateDrain(nowMs: number, maxHoldMs = DRAIN_GATE_MAX_HOLD_MS): void {
  drainGateUntilMs = nowMs + Math.max(0, maxHoldMs);
}

/** 重启被放弃时显式开闸（正常路径不需要——进程直接没了）。 */
export function endSelfUpdateDrain(): void {
  drainGateUntilMs = null;
}

export function isSelfUpdateDraining(nowMs: number): boolean {
  if (drainGateUntilMs === null) return false;
  if (nowMs >= drainGateUntilMs) {
    drainGateUntilMs = null; // 到点自动开闸
    return false;
  }
  return true;
}

/** 部署入口的拒绝理由；null = 放行。 */
export function selfUpdateDrainBlockReason(nowMs: number): string | null {
  if (!isSelfUpdateDraining(nowMs)) return null;
  return 'CDS 正在自更新重启，已暂停接受新的构建/部署请求（避免刚起的部署被重启腰斩）。重启通常在一分钟内完成，稍后重试即可；GitHub 侧可 push 新 commit 或在 PR 评论 /cds redeploy 重新触发。';
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
