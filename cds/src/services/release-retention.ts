import type { ReleasePreflightRecord, ReleaseRun, ReleaseRunStatus } from '../types.js';

/**
 * 发布记账的保留策略 —— run 与预检记录的淘汰判据只在这一份。
 *
 * 病根：`state.releaseRuns` 一条保留策略都没有（对比分支侧 addDeploymentRun 会调
 * pruneDeploymentRuns），内存里永远全量，只有持久化层在 global 文档超字节上限时
 * 才应急丢弃。发布记录里塞着整轮 SSH 日志，最终一定把 global 文档撑到写不进去。
 *
 * 但发布 run 不能照抄分支侧 pruneDeploymentRuns 的裸淘汰：那会把**可回滚版本**删掉。
 * 回滚链路有三个真实消费方，删错一个就等于静默砍掉回滚能力：
 *   - 发布中心的版本下拉 = 该目标最近 20 条成功 run（routes/releases.ts 的 slice(0, 20)）；
 *   - `getLatestSuccessfulReleaseRun` 的默认回滚目标；
 *   - `startRollback` 顺着 `previousReleaseId` / `rollbackTargetReleaseId` 找上一版本，
 *     指向的 run 一旦消失就直接抛「没有可回滚的上一版本」。
 * 所以这里照抄的是 pruneDeploymentVersions 的 protectedIds 模式，而不是前者。
 */

/**
 * 全量状态 → 是否终态。写成穷尽式 Record：以后新增 ReleaseRunStatus 时这里少一个键
 * TS 直接报错，不会再有「新状态被静默当成终态、于是在途守卫放行两个并发发布」这种漏项。
 *
 * 放在保留策略模块而不是 release-service：淘汰判定必须知道「哪些 run 还在途」，
 * 而 state 层不能反向依赖 release-service（会成环）。两边共用这一份，不许各写一张表。
 */
const RELEASE_STATUS_TERMINAL: Record<ReleaseRunStatus, boolean> = {
  queued: false,
  running: false,
  healthchecking: false,
  rollback_running: false,
  success: true,
  failed: true,
  rollback_success: true,
  rollback_failed: true,
};

export function isReleaseRunTerminal(status: ReleaseRunStatus): boolean {
  return RELEASE_STATUS_TERMINAL[status] === true;
}

/** 在途 = 非终态。在途守卫、排空判定、保留策略都从终态表取反推导，不再手写字面量数组。 */
export function isReleaseRunInFlight(run: Pick<ReleaseRun, 'status'>): boolean {
  return !isReleaseRunTerminal(run.status);
}

export function isSuccessfulReleaseRun(run: Pick<ReleaseRun, 'status'>): boolean {
  return run.status === 'success' || run.status === 'rollback_success';
}

/** 单个发布目标保留的 run 条数上限。 */
export const MAX_RELEASE_RUNS_PER_TARGET = 100;

/**
 * run 的时间窗。超窗且不在保护集里的才淘汰 —— 时间窗只是条数闸之外的补充，
 * 绝不能反过来把「还在下拉框里的可回滚版本」清掉。
 */
export const RELEASE_RUN_RETENTION_MS = 90 * 24 * 3600 * 1000;

/**
 * 每个目标至少留住的成功 run 条数。必须 ≥ 发布中心版本下拉的 slice(0, 20)，
 * 否则用户在 UI 上看得到的版本点下去会报「回滚目标不存在」。
 */
export const KEEP_SUCCESSFUL_RELEASE_RUNS = 20;

export interface ReleaseRunPruneInput {
  /** 同一个发布目标下的全部 run。 */
  runs: ReleaseRun[];
  nowMs: number;
  maxPerTarget?: number;
  retentionMs?: number;
  keepSuccessful?: number;
}

/**
 * 选出可以淘汰的 run id。纯函数，便于把「谁绝不能删」写成回归断言。
 *
 * 保护集刻意只做**一级展开**（保护 run 直接指向的回滚目标），不做传递闭包：
 * `previousReleaseId` 把历次发布串成一条长链，做闭包等于谁都删不掉，保留策略形同虚设。
 * 一级足够覆盖真实回滚路径 —— 从某个 run 回滚时，新建的回滚 run 自己会带上
 * `previousReleaseId = 当前 run`，而它本身是最新的，天然在保护集里。
 */
export function selectReleaseRunsToPrune(input: ReleaseRunPruneInput): string[] {
  const maxPerTarget = Math.max(1, input.maxPerTarget ?? MAX_RELEASE_RUNS_PER_TARGET);
  const retentionMs = input.retentionMs ?? RELEASE_RUN_RETENTION_MS;
  const keepSuccessful = Math.max(0, input.keepSuccessful ?? KEEP_SUCCESSFUL_RELEASE_RUNS);
  const runs = input.runs.slice();
  if (runs.length === 0) return [];

  const byId = new Map(runs.map((run) => [run.releaseId, run]));
  const newestFirst = runs.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const protectedIds = new Set<string>();

  for (const run of runs) {
    if (isReleaseRunInFlight(run)) protectedIds.add(run.releaseId);
  }
  // 发布中心首屏读的是「最新一条 run」，不论成败，删了整行就空了。
  if (newestFirst[0]) protectedIds.add(newestFirst[0].releaseId);
  for (const run of newestFirst.filter(isSuccessfulReleaseRun).slice(0, keepSuccessful)) {
    protectedIds.add(run.releaseId);
  }
  for (const id of [...protectedIds]) {
    const run = byId.get(id);
    if (!run) continue;
    for (const linked of [run.previousReleaseId, run.rollbackTargetReleaseId, run.rollbackOf]) {
      if (linked && byId.has(linked)) protectedIds.add(linked);
    }
  }

  const oldestFirst = runs.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  let overflow = runs.length - maxPerTarget;
  const doomed: string[] = [];
  for (const run of oldestFirst) {
    if (protectedIds.has(run.releaseId)) continue;
    if (overflow > 0) {
      doomed.push(run.releaseId);
      overflow -= 1;
      continue;
    }
    if (retentionMs <= 0) continue;
    const startedAtMs = Date.parse(run.startedAt);
    if (!Number.isFinite(startedAtMs)) continue;
    if (input.nowMs - startedAtMs > retentionMs) doomed.push(run.releaseId);
  }
  return doomed;
}

/** 单个发布目标保留的预检记录条数。预检本身也是记账，同样不许无界。 */
export const MAX_RELEASE_PREFLIGHTS_PER_TARGET = 20;

/** 预检记录的时间窗。远大于复用 TTL，留出「这次发布依据的是哪份结论」的审计余量。 */
export const RELEASE_PREFLIGHT_RETENTION_MS = 24 * 3600 * 1000;

export function selectReleasePreflightsToPrune(input: {
  /** 同一个发布目标下的全部预检记录。 */
  records: ReleasePreflightRecord[];
  nowMs: number;
  maxPerTarget?: number;
  retentionMs?: number;
  /**
   * 仍被保留 run 引用的 preflightId。这些记录**一条都不许删**。
   *
   * 事故值（Codex P2）：裁剪只按条数与时间窗，不看 `ReleaseRun.preflightId`。
   * 同一个目标再做 20 次预检，就能把某条在途 / 保留 run 依据的那份结论删掉，
   * 留下一个指向空气的审计链接 —— 而「这次发布依据的是哪份结论」正是预检落库
   * 的全部意义。缺了它，落库只是换个地方浪费磁盘。
   *
   * 保护是无上限的：引用数天然被 run 保留策略封顶（每目标 100 条），
   * 不会因为这条保护把预检记录撑爆。
   */
  referencedIds?: Iterable<string>;
}): string[] {
  const maxPerTarget = Math.max(1, input.maxPerTarget ?? MAX_RELEASE_PREFLIGHTS_PER_TARGET);
  const retentionMs = input.retentionMs ?? RELEASE_PREFLIGHT_RETENTION_MS;
  const referenced = new Set(input.referencedIds ?? []);
  const oldestFirst = input.records.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // 条数闸只对「没人引用的」记账：被引用的那些不占淘汰名额，否则它们会把
  // overflow 顶着不动，反而连累后面可删的记录活下来（上限形同虚设）。
  let overflow = oldestFirst.filter((record) => !referenced.has(record.id)).length - maxPerTarget;
  const doomed: string[] = [];
  for (const record of oldestFirst) {
    if (referenced.has(record.id)) continue;
    if (overflow > 0) {
      doomed.push(record.id);
      overflow -= 1;
      continue;
    }
    if (retentionMs <= 0) continue;
    const createdAtMs = Date.parse(record.createdAt);
    if (!Number.isFinite(createdAtMs)) continue;
    if (input.nowMs - createdAtMs > retentionMs) doomed.push(record.id);
  }
  return doomed;
}

/** 预检结论的复用 TTL。够覆盖「向导点完确认立刻发布」，又短到目标配置来不及漂移。 */
export const RELEASE_PREFLIGHT_REUSE_TTL_MS = 2 * 60_000;

export interface ReleasePreflightReuseKey {
  branchId: string;
  targetId: string;
  previewUrl?: string;
  operator?: string;
  /** 发起发布这一刻分支的真实 commit。对不上说明产物已经换了，旧结论一律作废。 */
  commitSha?: string;
  /**
   * 发起发布这一刻目标配置的指纹。对不上说明发的已经不是同一台机器 / 同一套脚本，
   * 旧结论证明不了新目标（Codex P1）。
   */
  targetConfigFingerprint?: string;
  /**
   * 发起发布这一刻**项目**身份的指纹。目标没动但项目换了仓库时，只比目标指纹会漏
   * （Codex P1）——而复用路径不会重跑 project-identity / remote-repository 两项检查。
   */
  projectIdentityFingerprint?: string;
}

function normalize(value: string | undefined): string {
  return (value || '').trim();
}

/**
 * 落库的预检结论能否直接拿来发布。
 *
 * 复用的目的是消掉「向导跑一次、startRelease 内部再跑一次」的重复 SSH + HTTP 探测
 * ——用户在向导里看到的结论必须**就是**真正把关的那份，而不是另一次独立探测的结果。
 * 但复用不能变成盲信：三道闸缺一不可。
 *   - ok=false 一律不复用（失败结论没有复用价值，重跑才能给出最新原因）；
 *   - key 任一不等就不复用（换了分支/目标/预览地址/操作人 = 换了一件事）；
 *   - commit 对不上或结论过期就不复用（产物已经变了，旧结论证明不了新产物）。
 */
export function canReuseReleasePreflight(
  record: ReleasePreflightRecord,
  key: ReleasePreflightReuseKey,
  nowMs: number,
  ttlMs: number = RELEASE_PREFLIGHT_REUSE_TTL_MS,
): boolean {
  if (!record.ok) return false;
  if (record.branchId !== key.branchId) return false;
  if (record.targetId !== key.targetId) return false;
  if (normalize(record.previewUrl) !== normalize(key.previewUrl)) return false;
  if (normalize(record.operator) !== normalize(key.operator)) return false;
  // 目标配置指纹缺一边或对不上，都证明不了「结论验的目标 = 现在要发的目标」。
  // 存量记录没有这个字段，一律走重跑：多花几秒预检，换掉「发到没验过的机器上」的风险。
  const fingerprint = normalize(key.targetConfigFingerprint);
  if (!fingerprint || normalize(record.targetConfigFingerprint) !== fingerprint) return false;
  const projectFingerprint = normalize(key.projectIdentityFingerprint);
  if (!projectFingerprint || normalize(record.projectIdentityFingerprint) !== projectFingerprint) return false;
  // commit 缺一边就证明不了「结论依据的产物 = 现在要发的产物」，宁可重跑。
  const commit = normalize(key.commitSha);
  if (!commit || normalize(record.artifactCommitSha) !== commit) return false;
  const createdAtMs = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAtMs)) return false;
  const age = nowMs - createdAtMs;
  // age < 0 = 记录来自未来（时钟回拨 / 伪造），按不可信处理。
  return age >= 0 && age <= Math.max(0, ttlMs);
}
