import type { ReleaseLogEntry, ReleaseRun } from '../types.js';

/**
 * 发布日志的有界缓冲与落盘节流 —— 本文件是这两件事的唯一判定源。
 *
 * 事故一（写放大）：`appendReleaseRunLog` 曾经每追加一行就 `save()` 一次。SSH 输出
 * 是按 chunk 逐行拆开 emit 的，一次发布轻松上千行；而 releaseRuns 属于 global rest，
 * 两个后端每次 flush 都要把**全部 run 的全部日志**整份序列化 / structuredClone 一遍。
 * 于是单次发布的持久化开销是 O(chunk 数 × 已累积日志量)，平方级增长——发布越久越卡。
 *
 * 事故二（无界）：`ReleaseRun.logs` 从来没有上限，只有持久化层在 global 文档超字节
 * 上限时才逐档降级截断（最狠只留 20 条/run），且**不写任何截断标记**。客户端拿着
 * afterSeq 续传时会静默缺一段，自己还以为收全了。
 *
 * 因此这里同时钉死三件事：
 *   1. 追加即有界（上限与分支侧 DeploymentRunService.maxEvents 同为 500 条）；
 *   2. 截断标记 `firstEventSeq` 永远由 `logs[0].seq` 推导 —— 谁在别处 slice 掉头部日志
 *      （例如持久化层的应急压缩）都不会造出一个「声称有、其实已丢」的谎；
 *   3. 落盘节流的阈值只有这一份，别处不许再拍一个数字。
 */

/** 单个 run 的日志条数上限。与 deployment-run.ts 的 maxEvents 同口径，两条生命周期不要各留各的。 */
export const RELEASE_MAX_LOGS = 500;

/** 攒够多少行就落一次盘。50 行把 save 次数压到原来的 1/50，仍远小于一次发布的日志量。 */
export const RELEASE_LOG_FLUSH_LINES = 50;

/** 攒够多久就落一次盘。长静默阶段（构建）零星几行日志也不该在内存里压一整轮发布。 */
export const RELEASE_LOG_FLUSH_INTERVAL_MS = 1_000;

export interface ReleaseLogSnapshot {
  logs: ReleaseLogEntry[];
  /** 当前窗口里最早那条日志的 seq。客户端据此判断自己要的那段是否已经被丢掉。 */
  firstEventSeq: number;
  /** true = 客户端持有的 afterSeq 之后有日志已被截断，续传拿不全，UI 必须如实提示。 */
  truncated: boolean;
}

type ReleaseRunLogView = Pick<ReleaseRun, 'logs' | 'seq'> & { firstEventSeq?: number };

/**
 * 截断标记的唯一推导口径：**以 logs[0].seq 为准**，落库字段只做空日志时的兜底。
 *
 * 存量 run 根本没有 firstEventSeq 字段；被持久化层应急压缩过的历史 run 更是
 * logs[0].seq 远大于 1 却不带任何标记。两种情况都只能从实际留存的日志头部推导，
 * 假设 firstEventSeq === 1 会直接对客户端撒谎。
 */
export function resolveReleaseFirstEventSeq(run: ReleaseRunLogView): number {
  const head = run.logs?.[0]?.seq;
  if (typeof head === 'number' && Number.isFinite(head)) return head;
  if (typeof run.firstEventSeq === 'number' && Number.isFinite(run.firstEventSeq)) return run.firstEventSeq;
  return Math.max(1, (run.seq || 0) + 1);
}

/**
 * 追加一条日志并就地维持上限。照抄 deployment-run.ts::appendEvent 的顺序：
 * seq 自增 → push → 超限从尾部保留 → 重算 firstEventSeq。顺序错一步标记就不准。
 */
export function appendBoundedReleaseLog(
  run: ReleaseRunLogView,
  entry: Omit<ReleaseLogEntry, 'seq' | 'at'> & { at?: string },
  maxLogs: number = RELEASE_MAX_LOGS,
): ReleaseLogEntry {
  const seq = (run.seq || 0) + 1;
  const log: ReleaseLogEntry = {
    seq,
    at: entry.at || new Date().toISOString(),
    level: entry.level,
    message: entry.message,
    phase: entry.phase,
  };
  run.seq = seq;
  if (!Array.isArray(run.logs)) run.logs = [];
  run.logs.push(log);
  const limit = Math.max(1, Math.floor(maxLogs) || RELEASE_MAX_LOGS);
  if (run.logs.length > limit) run.logs = run.logs.slice(-limit);
  run.firstEventSeq = resolveReleaseFirstEventSeq(run);
  return log;
}

/**
 * 是否该把这一行连同之前攒下的一起落盘。
 *
 * error 级不参与攒批：失败证据是排障的第一现场，进程若在这一刻挂掉，丢掉的恰好是
 * 最需要的那几行。其余按「够 N 行」或「够 T 毫秒」放行。
 */
export function shouldPersistReleaseLog(input: {
  /** 含本行在内、自上次落盘以来累计的行数。 */
  pendingLines: number;
  lastSaveAtMs: number;
  nowMs: number;
  level: ReleaseLogEntry['level'];
  flushLines?: number;
  flushIntervalMs?: number;
}): boolean {
  if (input.level === 'error') return true;
  const lines = input.flushLines ?? RELEASE_LOG_FLUSH_LINES;
  if (input.pendingLines >= Math.max(1, lines)) return true;
  const elapsed = input.nowMs - input.lastSaveAtMs;
  if (!Number.isFinite(elapsed)) return true;
  return elapsed >= (input.flushIntervalMs ?? RELEASE_LOG_FLUSH_INTERVAL_MS);
}

/**
 * SSE 快照 / 断点续传的传输面。与 deployment-run.ts::getEventsAfter 同口径：
 * `truncated` 的判据是「客户端要接的位置比现存窗口的头还早」。
 */
export function buildReleaseLogSnapshot(run: ReleaseRunLogView, afterSeq: number): ReleaseLogSnapshot {
  const normalized = Number.isFinite(afterSeq) ? Math.max(0, Math.floor(afterSeq)) : 0;
  const firstEventSeq = resolveReleaseFirstEventSeq(run);
  return {
    logs: (run.logs || []).filter((log) => log.seq > normalized),
    firstEventSeq,
    truncated: normalized < firstEventSeq - 1,
  };
}
