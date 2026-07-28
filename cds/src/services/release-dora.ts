/**
 * release-dora — 生产发布的 DORA 四项指标（纯函数 SSOT）。
 *
 * 只做「算」：不读 state、不落盘、不发 IO。输入是一份 ReleaseRun 列表，
 * 输出是发布频率 / 变更失败率 / 恢复时长 / 变更前置时间。放在 service 层而不是
 * 路由里，是为了让「窗口切片、回滚归因、恢复配对」这些容易算错的判定能被单测
 * 直接钉住——塞进路由后只能靠起 HTTP 服务才测得到，边界用例基本不会有人写。
 *
 * 贯穿全文件的一条纪律：**样本不足一律返回 null，绝不返回 0**。
 * 事故值：变更失败率在零次发布时返回 0，前端会渲染出「变更失败率 0%」这种
 * 看似精确的假数字，用户据此以为发布很健康，实际是压根没发过。
 * 同款教训见 duration-samples.ts::computeDurationEstimate 的 medianMs=null。
 */

import type { ReleaseRunStatus } from '../types.js';
import { isReleaseRunTerminal, isSuccessfulReleaseRun } from './release-retention.js';

/**
 * 计算所需的 run 视图。刻意不直接吃 ReleaseRun：DORA 只关心这几个字段，
 * 窄接口让单测能造极小的假数据，也让将来 run 结构变化不会连累本文件。
 */
export interface ReleaseDoraRunLike {
  releaseId: string;
  targetId: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  /** 非空 = 这是一次回滚运行，它指向被回滚的那次发布 */
  rollbackOf?: string;
  /** 非空 = 探测失败后自动恢复上一版本成功完成的时刻，即这条失败的真实恢复时刻 */
  autoRestoredAt?: string;
  /** 非空 = 探测失败、开始自动恢复的时刻，即故障窗口起点（恒早于 finishedAt） */
  autoRestoreStartedAt?: string;
}

export interface ReleaseDoraFrequency {
  /** 窗口内成功发布次数（不含回滚运行） */
  successCount: number;
  /** 天均发布次数。0 次也是事实，如实给 0，不置 null */
  perDay: number;
  /** 相邻两次成功发布的间隔中位；不足 2 次为 null */
  medianIntervalMs: number | null;
}

export interface ReleaseDoraChangeFailure {
  /** 分母：窗口内终态的正向发布次数（success + failed） */
  total: number;
  /** 分子：失败的，或事后被回滚的 */
  failed: number;
  /** 失败率 0-1；无发布为 null（不是 0） */
  ratio: number | null;
}

export interface ReleaseDoraRecovery {
  /** 已恢复的失败事件数（p50/p90 的样本量） */
  sampleCount: number;
  p50Ms: number | null;
  p90Ms: number | null;
  /** 至今仍未恢复的失败事件数，单列不混进中位样本 */
  ongoingCount: number;
  /**
   * 已确认恢复、但算不出恢复时长的失败事件数（只有 autoRestoredAt、没有起点的存量 run）。
   *
   * 单列而不是夹成 0 塞进样本：把「未知时长」当成「瞬时恢复」会把 p50/p90 系统性压低，
   * 而且违背本模块「样本不足一律 null、绝不编造 0」的口径。它也不算进行中 ——
   * 生产确实恢复了，只是不知道花了多久。三者之和恒等于失败数。
   */
  recoveredUnknownDurationCount: number;
}

export interface ReleaseDoraLeadTime {
  /** 真正算出前置时间的次数 */
  sampleCount: number;
  /** 本该算前置时间的成功发布次数（分母）。两者之差 = 缺 commit 时间的覆盖缺口 */
  eligibleCount: number;
  p50Ms: number | null;
  p90Ms: number | null;
}

export interface ReleaseDoraMetrics {
  windowDays: number;
  /** 统计窗口（ISO），前端直接展示，不让它自己再算一遍 */
  fromAt: string;
  toAt: string;
  frequency: ReleaseDoraFrequency;
  changeFailure: ReleaseDoraChangeFailure;
  recovery: ReleaseDoraRecovery;
  leadTime: ReleaseDoraLeadTime;
}

/**
 * 泛型挂在 run 类型上，是为了让 resolveCommitAt 能拿到调用方那份完整的 run
 * （projectId / commitSha 这些本文件用不上、但取 commit 时间必须要的字段），
 * 同时本文件自身仍然只依赖 ReleaseDoraRunLike 这几个窄字段。
 */
export interface ReleaseDoraOptions<T extends ReleaseDoraRunLike = ReleaseDoraRunLike> {
  windowDays?: number;
  nowMs?: number;
  /** 只算某个发布目标；缺省算传入的全部 run */
  targetId?: string;
  /**
   * 该次发布所用 commit 的提交时间（ISO）。取不到就别给——
   * 绝不允许拿 startedAt / lastPushAt 顶替：那算出来的不是前置时间，
   * 是「发布自己跑了多久」和「推送到发布的间隔」，两个都不是 DORA 要问的东西。
   */
  resolveCommitAt?: (run: T) => string | undefined;
}

export const DEFAULT_DORA_WINDOW_DAYS = 30;
export const MIN_DORA_WINDOW_DAYS = 7;
export const MAX_DORA_WINDOW_DAYS = 90;

const DAY_MS = 24 * 3600 * 1000;

/**
 * 终态 / 成功的判定一律借 release-retention 那份，不在这里另开一张状态表。
 * 新增 ReleaseRunStatus 时那边的穷尽 Record 会编译期报错，而这里若写成字面量
 * Set 只会静默漏算 —— 一个新状态被漏掉，DORA 四项会一起悄悄失真。
 *
 * 这里要一次 as 收窄：ReleaseDoraRunLike.status 刻意是 string（窄接口，好造假数据）。
 * 收窄是安全的 —— 认不出的状态在穷尽 Record 里查不到，两个判定都退化成 false，
 * 即「既不算终态也不算恢复」，样本被丢掉而不是被错算。
 */
const isTerminalRun = (run: Pick<ReleaseDoraRunLike, 'status'>): boolean =>
  isReleaseRunTerminal(run.status as ReleaseRunStatus);
/** 「服务恢复了」的证据：一次成功的正向发布，或一次成功的回滚。 */
const isRecoveryRun = (run: Pick<ReleaseDoraRunLike, 'status'>): boolean =>
  isSuccessfulReleaseRun({ status: run.status as ReleaseRunStatus });

export function clampDoraWindowDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DORA_WINDOW_DAYS;
  return Math.min(MAX_DORA_WINDOW_DAYS, Math.max(MIN_DORA_WINDOW_DAYS, Math.floor(n)));
}

/**
 * 时间戳解析。拿不到有效毫秒一律返回 null 让调用方丢样本 ——
 * 退回 0 会把这条样本钉在 1970 年，把任何窗口/间隔计算污染成天文数字。
 */
function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** 终态时刻。finishedAt 缺失（存量 run / 异常收尾）时退回 startedAt，仍无效则丢样本。 */
function terminalAtMs(run: ReleaseDoraRunLike): number | null {
  return parseMs(run.finishedAt) ?? parseMs(run.startedAt);
}

/**
 * 分位数（nearest-rank）。DORA 的恢复时长与前置时间共用这一个实现。
 *
 * 刻意不复用 duration-samples.ts::computeDurationEstimate：那份是 ETA 台账的口径
 * （ring buffer + 近 N 条窗口 + 偶数取两侧平均），语义与「窗口内全量样本的分位数」
 * 不同，混用会让两边的调参互相牵连。两处各自成立，但判定各只有一处。
 */
function percentile(sortedAsc: readonly number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil(q * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

export function computeReleaseDora<T extends ReleaseDoraRunLike>(
  runs: ReadonlyArray<T>,
  options: ReleaseDoraOptions<T> = {},
): ReleaseDoraMetrics {
  const windowDays = clampDoraWindowDays(options.windowDays ?? DEFAULT_DORA_WINDOW_DAYS);
  const nowMs = options.nowMs ?? Date.now();
  const fromMs = nowMs - windowDays * DAY_MS;

  const scoped = options.targetId
    ? runs.filter((run) => run.targetId === options.targetId)
    : runs.slice();

  /**
   * 「事后被回滚」的判定必须建在**全量** run 上，不能只在窗口切片里找。
   * 事故值：D-40 发布、D-1 才回滚 —— 只看窗口内的回滚运行会认不出这次回滚指向
   * 窗口外的发布，那次发布于是被算成成功，变更失败率被系统性低估。
   * 反过来同理：窗口内的失败发布可能在窗口结束后才被回滚。
   */
  const rolledBackIds = new Set<string>();
  /**
   * 被回滚的发布 → **最早那次回滚的发起时刻**。
   *
   * 事故值（Codex P2）：一次成功发布若在 9 天后才被回滚，它会被归为 failed，
   * 而恢复时钟的起点取的是它自己的完成时刻 —— 于是「恢复时长」把回滚发起之前
   * 那 9 天正常服务的时间全算了进去，MTTR 被系统性夸大；更糟的是那 9 天里
   * 任何一次成功发布都可能被选成它的「恢复者」，配对本身就是错的。
   * 故障是从**有人按下回滚**那一刻才开始被承认的，起点应该取回滚 run 的 startedAt。
   */
  const rollbackStartedAtByTarget = new Map<string, number>();
  for (const run of scoped) {
    // 回滚失败也算「这次发布被判定为坏的」——有人按下了回滚按钮，
    // 判据是「发布引入了问题」，不是「补救动作成没成功」。
    if (!run.rollbackOf) continue;
    rolledBackIds.add(run.rollbackOf);
    const at = parseMs(run.startedAt);
    if (at === null) continue;
    const known = rollbackStartedAtByTarget.get(run.rollbackOf);
    // 同一次发布可能被回滚多次（第一次没成功），取最早那次：故障是从第一次
    // 按下回滚开始的，取最晚会把中间的抢修时间漏掉。
    if (known === undefined || at < known) rollbackStartedAtByTarget.set(run.rollbackOf, at);
  }

  const terminalRuns: Array<{ run: T; at: number }> = [];
  for (const run of scoped) {
    if (!isTerminalRun(run)) continue;
    const at = terminalAtMs(run);
    // 时间戳解析不出来就丢样本：留着会被当成 1970 年，把窗口和间隔全部污染。
    if (at === null) continue;
    terminalRuns.push({ run, at });
  }
  terminalRuns.sort((a, b) => a.at - b.at);

  /** 窗口内的正向发布（回滚运行不是「一次变更」，是恢复动作）。 */
  const windowDeploys = terminalRuns.filter((item) => (
    !item.run.rollbackOf
    && (item.run.status === 'success' || item.run.status === 'failed')
    && item.at >= fromMs
    && item.at <= nowMs
  ));

  // ── 1. 发布频率 ──
  // rollback_success 刻意不计：它是恢复动作，计进来会得出「回滚越多，发布越频繁」
  // 这种明显反直觉的结论，把这个指标彻底废掉。
  const successDeploys = windowDeploys.filter((item) => item.run.status === 'success');
  const intervals: number[] = [];
  for (let i = 1; i < successDeploys.length; i++) {
    intervals.push(successDeploys[i].at - successDeploys[i - 1].at);
  }
  intervals.sort((a, b) => a - b);
  const frequency: ReleaseDoraFrequency = {
    successCount: successDeploys.length,
    perDay: successDeploys.length / windowDays,
    medianIntervalMs: percentile(intervals, 0.5),
  };

  // ── 2. 变更失败率 ──
  const failedDeploys = windowDeploys.filter((item) => (
    item.run.status === 'failed' || rolledBackIds.has(item.run.releaseId)
  ));
  const changeFailure: ReleaseDoraChangeFailure = {
    total: windowDeploys.length,
    failed: failedDeploys.length,
    ratio: windowDeploys.length === 0 ? null : failedDeploys.length / windowDeploys.length,
  };

  // ── 3. 恢复时长 ──
  // 恢复必须在**同一个 targetId** 上找：跨站点串链会把 A 站的恢复算到 B 站头上，
  // 得到一个既不属于任何真实故障、又普遍偏短的漂亮数字。
  const recoveryDurations: number[] = [];
  let ongoingCount = 0;
  let recoveredUnknownDurationCount = 0;
  for (const failure of failedDeploys) {
    // 自动恢复优先：探测失败后 restorePreviousAfterFailedProbe 把上一版本推回去，
    // 生产在那一刻就已经好了，但它**不产生任何 run**（那不是一次发布）。
    // 只按 run 找恢复者会把这种几秒自愈的失败算成「进行中故障」，一直挂到下一次
    // 成功发布为止 —— 恢复时长偏长、ongoingCount 虚高（Codex P2）。
    const autoRestoredAt = Date.parse(failure.run.autoRestoredAt || '');
    if (Number.isFinite(autoRestoredAt)) {
      // 起点必须是**探测失败时刻**，不是 run 的终态时刻：自动恢复跑在 failRun 之前，
      // finishedAt 恒晚于 autoRestoredAt。上一版拿 `autoRestoredAt >= failure.at` 当守卫，
      // 条件恒为 false，整条修复空转（Codex P2 第二轮）。
      const startedAt = Date.parse(failure.run.autoRestoreStartedAt || '');
      // autoRestoredAt 只在恢复真的成功后才落，所以「已恢复」是既成事实。
      // 但起点缺失（上一版只写了终点的存量 run）或时间戳倒挂时，时长是**未知**的：
      // 退回 failure.at 会得到负数、夹成 0 就等于宣称「瞬时恢复」，把 p50/p90 系统性
      // 压低，也违背本文件「绝不编造 0」的口径（Codex P2）。单列计数，不进样本。
      if (Number.isFinite(startedAt) && autoRestoredAt >= startedAt) {
        recoveryDurations.push(autoRestoredAt - startedAt);
      } else {
        recoveredUnknownDurationCount += 1;
      }
      continue;
    }
    // 「被事后回滚」的发布，故障时钟从**回滚发起**那一刻起算，不是它自己完成那一刻。
    // 否则一次跑了九天才被回滚的发布会报出九天恢复时长，中间那些正常发布还会被
    // 误选成它的恢复者（Codex P2）。自身就是 failed 的发布仍用它的终态时刻。
    const rollbackAt = rollbackStartedAtByTarget.get(failure.run.releaseId);
    const failedAt = failure.run.status === 'failed'
      ? failure.at
      : (rollbackAt ?? failure.at);
    const restored = terminalRuns.find((item) => (
      item.at > failedAt
      && item.run.targetId === failure.run.targetId
      && isRecoveryRun(item.run)
    ));
    if (!restored) {
      ongoingCount += 1;
      continue;
    }
    recoveryDurations.push(restored.at - failedAt);
  }
  recoveryDurations.sort((a, b) => a - b);
  const recovery: ReleaseDoraRecovery = {
    sampleCount: recoveryDurations.length,
    p50Ms: percentile(recoveryDurations, 0.5),
    p90Ms: percentile(recoveryDurations, 0.9),
    ongoingCount,
    recoveredUnknownDurationCount,
  };

  // ── 4. 变更前置时间 ──
  // 口径只覆盖「head commit 提交 → 生产可用」，不是每个 commit 的真实 lead time；
  // 覆盖率靠 sampleCount / eligibleCount 如实暴露，缺 commit 时间的那些不补也不猜。
  const leadDurations: number[] = [];
  for (const item of successDeploys) {
    const commitAt = parseMs(options.resolveCommitAt?.(item.run));
    if (commitAt === null) continue;
    const delta = item.at - commitAt;
    // 负数只可能来自机器时钟漂移或 commit 被 amend 过，留着会把中位拉成负值。
    if (delta < 0) continue;
    leadDurations.push(delta);
  }
  leadDurations.sort((a, b) => a - b);
  const leadTime: ReleaseDoraLeadTime = {
    sampleCount: leadDurations.length,
    eligibleCount: successDeploys.length,
    p50Ms: percentile(leadDurations, 0.5),
    p90Ms: percentile(leadDurations, 0.9),
  };

  return {
    windowDays,
    fromAt: new Date(fromMs).toISOString(),
    toAt: new Date(nowMs).toISOString(),
    frequency,
    changeFailure,
    recovery,
    leadTime,
  };
}
