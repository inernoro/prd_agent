/**
 * Graceful Shutdown — 蓝绿 admin daemon 优雅关停 service(B'.3)
 *
 * 对应 doc/report.cds.forwarder-success.md
 * doc/design.cds.control-data-split.md 4.2 节"退役蓝"步骤。
 *
 * 旧 daemon 收到 SIGTERM(supervisor 切流后发出)→ 进 draining 态:
 *   1. healthz 后续应返 503(由 index.ts 读 isDraining() 决策,本服务不挂 route)
 *   2. server.close() 触发 graceful close,新连接拒,已建立的保留
 *   3. 给所有现存 SSE response 写一条 close event 让客户端主动断开
 *   4. 等 worker run 完成(最长 runDrainMs,默认 25s),超时未完者 abort + 标 interrupted
 *   5. flush mongo write-behind buffer;失败时关键 state 落盘 pending-writes.json
 *   6. 总超时 totalTimeoutMs(默认 30s)兜底,到点不论 drain 完没完都 resolve
 *
 * 设计要点(详见 .claude 上下文 "compute-then-send" + "server-authority"):
 *   - 本服务不调 process.exit / process.kill;signal 只是 metadata
 *   - 新连接拒由 server.close(cb) 触发,本服务调用方传入 httpServer
 *   - SSE 连接通过 registerSseConnection 显式跟踪;runShutdown 阶段写 close event
 *   - run 通过 registerRun(runId, abort) 显式跟踪;awaitRunsDrain 周期检查
 *   - mongoFlush 由调用方注入(不依赖 mongo 客户端,便于单测 mock)
 *   - pendingWritesPath 必须验证不含 ".." 防路径穿越
 *   - onForceKill 回调收到 snapshot,运维 post-mortem 用;本服务不真 SIGKILL
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

export type ShutdownSignal = 'SIGTERM' | 'SIGINT' | 'manual';

export interface ShutdownSnapshot {
  /** 是否 run / sse 都成功 drain(false 表示有残留) */
  drained: boolean;
  /** 关闭的 SSE 连接数 */
  sseClosed: number;
  /** drain 期间自然完成的 run 数 */
  runsCompleted: number;
  /** 超时被 abort 的 run id 列表 */
  runsInterrupted: string[];
  /** mongoFlush 是否成功 */
  mongoFlushOk: boolean;
  /** runShutdown 总耗时 ms */
  durationMs: number;
  /** true 表示触发了总超时兜底(forcedKill 不真 SIGKILL,由 caller / systemd 兜底) */
  forcedKill: boolean;
  /** 触发原因(SIGTERM / SIGINT / manual) */
  signal: string;
  /** 调用方传入的 enterDraining reason(如 "supervisor-promote-green") */
  reason?: string;
  /** flush 失败时落盘 fallback 路径(便于 post-mortem) */
  fallbackPath?: string;
}

export interface RegisterSseOpts {
  /** 标识连接类型(如 'self-update-stream' / 'branch-events'),日志可读 */
  kind?: string;
}

export interface FlushOpts {
  mongoFlush?: () => Promise<void>;
  /** 待写 state 序列化后落盘的路径(JSON) */
  pendingWritesPath: string;
  /** 调用方提供的"待写 state"(任意可序列化对象);未提供则落盘空 placeholder */
  pendingState?: unknown;
}

export interface FlushResult {
  ok: boolean;
  fallbackPath?: string;
  error?: string;
}

export interface RunShutdownOpts {
  signal: ShutdownSignal;
  /** SSE close event 写完后等待的"客户端自行断开"时间,超时 force end。默认 2000 */
  sseDrainMs?: number;
  /** run drain 的最长等待。默认 25000 */
  runDrainMs?: number;
  /** 整体超时兜底。默认 30000 */
  totalTimeoutMs?: number;
  mongoFlush?: () => Promise<void>;
  /** 待写 state(由调用方提供,本服务不知道形态) */
  pendingState?: unknown;
  /** 待写 state fallback 落盘路径 */
  pendingWritesPath: string;
  /** 兜底超时触发时的回调,收到 snapshot 让运维 post-mortem */
  onForceKill?: (snapshot: ShutdownSnapshot) => void;
  /** 可选 http server,有则触发 graceful close(新连接拒) */
  httpServer?: { close(cb: (err?: Error) => void): void };
  /** 是否调用 enterDraining(如已由信号 handler 提前调用,可设 false 避免重复) */
  skipEnterDraining?: boolean;
}

interface RunRecord {
  abort: () => void;
  registeredAt: number;
}

/**
 * 校验 pendingWritesPath 不含 ".." 路径穿越。
 * 允许相对/绝对路径,但每一段都不能是 ".." / "."(后者无意义,避免歧义)。
 */
export function validatePendingWritesPath(p: string): { ok: boolean; reason?: string } {
  if (!p || typeof p !== 'string') {
    return { ok: false, reason: 'pendingWritesPath must be a non-empty string' };
  }
  // 同时检查原始路径(防 "a/../b" 这种 path.normalize 后被消化掉的形态)
  // 与规范化后路径(防绝对路径里夹 "..")
  const checkSegments = (input: string, label: string): { ok: boolean; reason?: string } => {
    const segments = input.split(/[\\/]/).filter(Boolean);
    for (const seg of segments) {
      if (seg === '..') {
        return {
          ok: false,
          reason: `pendingWritesPath contains forbidden segment "${seg}" (${label})`,
        };
      }
    }
    return { ok: true };
  };
  const rawCheck = checkSegments(p, 'raw');
  if (!rawCheck.ok) return rawCheck;
  const normalized = path.normalize(p);
  const normCheck = checkSegments(normalized, 'normalized');
  if (!normCheck.ok) return normCheck;
  return { ok: true };
}

/**
 * 给单个 SSE response 写 close event(让客户端 EventSource 主动重连)。
 * 写失败(socket 已断)静默吞掉,本来就是要关的。
 */
function writeCloseEvent(res: ServerResponse, reason = 'daemon-draining'): boolean {
  try {
    if (res.writableEnded || res.destroyed) {
      return false;
    }
    const payload = `event: close\ndata: ${JSON.stringify({ reason })}\n\n`;
    res.write(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * 强制结束 SSE response(在客户端不主动断开时调)。
 */
function forceEnd(res: ServerResponse): void {
  try {
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  } catch {
    // ignore
  }
}

/** 默认值集中管理,便于单测覆盖。 */
export const DEFAULT_SSE_DRAIN_MS = 2000;
export const DEFAULT_RUN_DRAIN_MS = 25_000;
export const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;

export class GracefulShutdownController {
  private _draining = false;
  private _drainReason?: string;
  private readonly _sseConnections: Map<ServerResponse, RegisterSseOpts> = new Map();
  private readonly _runs: Map<string, RunRecord> = new Map();
  /** runShutdown 阶段记录"shutdown 触发后才完成的 run 数",供 snapshot 用 */
  private _runsCompletedDuringShutdown = 0;

  /** 进入 draining 态。幂等,后续重复调只更新 reason(如先 SIGTERM 后 manual)。 */
  enterDraining(reason: string): void {
    this._draining = true;
    this._drainReason = reason;
  }

  isDraining(): boolean {
    return this._draining;
  }

  drainReason(): string | undefined {
    return this._drainReason;
  }

  /** 注册一个 SSE 连接。draining 时所有注册的连接会收到 close event。 */
  registerSseConnection(res: ServerResponse, opts: RegisterSseOpts = {}): void {
    if (this._draining) {
      // draining 态下还有新连接进来,直接关掉(不应发生,但兜底)
      writeCloseEvent(res, 'daemon-draining');
      forceEnd(res);
      return;
    }
    this._sseConnections.set(res, opts);
    // 监听底层 socket close 自动 unregister(避免泄漏)
    res.on('close', () => this.unregisterSseConnection(res));
  }

  unregisterSseConnection(res: ServerResponse): void {
    this._sseConnections.delete(res);
  }

  sseConnectionCount(): number {
    return this._sseConnections.size;
  }

  /**
   * 注册进行中的 run。draining 时不应再注册新 run(由 caller 检查 isDraining)。
   */
  registerRun(runId: string, abort: () => void): void {
    this._runs.set(runId, { abort, registeredAt: Date.now() });
  }

  unregisterRun(runId: string): void {
    if (this._runs.delete(runId) && this._draining) {
      this._runsCompletedDuringShutdown += 1;
    }
  }

  runCount(): number {
    return this._runs.size;
  }

  runIds(): string[] {
    return Array.from(this._runs.keys());
  }

  /**
   * 等所有 run 完成或超时。周期 50ms 检查,空了立即 resolve;超时返回残留。
   * 注意:超时时不调用 abort —— abort 由 runShutdown 整体编排时统一调,这里只观察。
   */
  async awaitRunsDrain(maxMs: number): Promise<{ drained: boolean; remaining: string[] }> {
    if (this._runs.size === 0) {
      return { drained: true, remaining: [] };
    }
    const start = Date.now();
    const pollInterval = 50;
    while (Date.now() - start < maxMs) {
      if (this._runs.size === 0) {
        return { drained: true, remaining: [] };
      }
      await sleep(pollInterval);
    }
    return { drained: false, remaining: Array.from(this._runs.keys()) };
  }

  /**
   * Flush write-behind buffer 到 mongo;失败时把 pendingState 序列化落盘 fallback 路径。
   *
   * - mongoFlush 不传 → 视为 ok(无 buffer 可 flush)
   * - mongoFlush 抛错 → 写 pendingWritesPath,返回 { ok: false, fallbackPath }
   * - pendingWritesPath 含 ".." → 返回 { ok: false, error: '...' } 不落盘
   */
  async flushPendingWrites(opts: FlushOpts): Promise<FlushResult> {
    const pathCheck = validatePendingWritesPath(opts.pendingWritesPath);
    if (!pathCheck.ok) {
      return { ok: false, error: pathCheck.reason };
    }

    if (!opts.mongoFlush) {
      return { ok: true };
    }

    try {
      await opts.mongoFlush();
      return { ok: true };
    } catch (err) {
      const errMsg = (err as Error).message || String(err);
      // mongo flush 失败 → 关键 state 落盘
      try {
        const dir = path.dirname(opts.pendingWritesPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const payload = {
          savedAt: new Date().toISOString(),
          mongoFlushError: errMsg,
          pendingState: opts.pendingState ?? null,
        };
        fs.writeFileSync(opts.pendingWritesPath, JSON.stringify(payload, null, 2), 'utf-8');
        return { ok: false, fallbackPath: opts.pendingWritesPath, error: errMsg };
      } catch (fallbackErr) {
        // fallback 也失败,只能记日志返回
        return {
          ok: false,
          error: `mongoFlush failed (${errMsg}); fallback write also failed: ${(fallbackErr as Error).message}`,
        };
      }
    }
  }

  /**
   * 编排:enterDraining → server.close → SSE close event + 等客户端断 → run drain → flush → snapshot。
   * 总超时由 totalTimeoutMs 兜底。任一阶段抛错都不会让 runShutdown reject —— 全部捕获后写进 snapshot。
   */
  async runShutdown(opts: RunShutdownOpts): Promise<ShutdownSnapshot> {
    const startedAt = Date.now();
    const sseDrainMs = opts.sseDrainMs ?? DEFAULT_SSE_DRAIN_MS;
    const runDrainMs = opts.runDrainMs ?? DEFAULT_RUN_DRAIN_MS;
    const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

    if (!opts.skipEnterDraining) {
      this.enterDraining(`shutdown:${opts.signal}`);
    }

    const sseAtStart = this._sseConnections.size;

    // 总超时 sentinel:跑得太久也要 resolve
    let forcedKillTriggered = false;
    const totalDeadlinePromise = sleep(totalTimeoutMs).then(() => {
      forcedKillTriggered = true;
    });

    // ── 阶段 1:停接新连接(httpServer.close) ─────────────────
    if (opts.httpServer) {
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            opts.httpServer!.close(() => resolve());
          }),
          // server.close 等所有连接关掉才 resolve;不等死,3 秒兜底继续
          sleep(3000),
        ]);
      } catch {
        // server.close 抛 callback err 不影响后续
      }
      if (forcedKillTriggered) return this._buildSnapshot(opts, sseAtStart, false, true, startedAt);
    }

    // ── 阶段 2:给所有 SSE 写 close event,等客户端自行断 sseDrainMs,超时 force end ──
    const initialSseList = Array.from(this._sseConnections.keys());
    for (const res of initialSseList) {
      writeCloseEvent(res, 'daemon-draining');
    }

    if (initialSseList.length > 0) {
      const drainStart = Date.now();
      while (this._sseConnections.size > 0 && Date.now() - drainStart < sseDrainMs) {
        await sleep(50);
        if (forcedKillTriggered) break;
      }
      // 还没断的 force end
      const remainingSse = Array.from(this._sseConnections.keys());
      for (const res of remainingSse) {
        forceEnd(res);
        this._sseConnections.delete(res);
      }
    }
    if (forcedKillTriggered) return this._buildSnapshot(opts, sseAtStart, false, true, startedAt);

    // ── 阶段 3:run drain ────────────────────────────────
    let runResult: { drained: boolean; remaining: string[] } = { drained: true, remaining: [] };
    if (this._runs.size > 0) {
      runResult = await Promise.race([
        this.awaitRunsDrain(runDrainMs),
        totalDeadlinePromise.then<{ drained: boolean; remaining: string[] }>(() => ({
          drained: false,
          remaining: Array.from(this._runs.keys()),
        })),
      ]);
    }
    // 超时残留 → abort
    const interruptedRunIds: string[] = [];
    if (!runResult.drained) {
      for (const runId of runResult.remaining) {
        const rec = this._runs.get(runId);
        if (rec) {
          interruptedRunIds.push(runId);
          try {
            rec.abort();
          } catch {
            // abort 抛错不影响后续
          }
          this._runs.delete(runId);
        }
      }
    }
    if (forcedKillTriggered) return this._buildSnapshot(opts, sseAtStart, false, true, startedAt, interruptedRunIds);

    // ── 阶段 4:mongo flush + fallback ─────────────────────
    let flushOk = true;
    let fallbackPath: string | undefined;
    if (opts.mongoFlush || opts.pendingState) {
      const flushResult = await this.flushPendingWrites({
        mongoFlush: opts.mongoFlush,
        pendingWritesPath: opts.pendingWritesPath,
        pendingState: opts.pendingState,
      });
      flushOk = flushResult.ok;
      fallbackPath = flushResult.fallbackPath;
    }

    // ── 阶段 5:总超时检测(刚好踩线) ─────────────────────
    // 当 forcedKillTriggered 已为 true(虽然不是上面的 break 路径触发),仍要标记
    // 注:Promise.race 已让 forcedKillTriggered 在超时时被设为 true,这里读取一次

    return this._buildSnapshot(
      opts,
      sseAtStart,
      flushOk,
      forcedKillTriggered,
      startedAt,
      interruptedRunIds,
      fallbackPath,
    );
  }

  private _buildSnapshot(
    opts: RunShutdownOpts,
    sseAtStart: number,
    mongoFlushOk: boolean,
    forcedKill: boolean,
    startedAt: number,
    interruptedRunIds: string[] = [],
    fallbackPath?: string,
  ): ShutdownSnapshot {
    const snapshot: ShutdownSnapshot = {
      drained: interruptedRunIds.length === 0 && !forcedKill,
      sseClosed: sseAtStart,
      runsCompleted: this._runsCompletedDuringShutdown,
      runsInterrupted: interruptedRunIds,
      mongoFlushOk,
      durationMs: Date.now() - startedAt,
      forcedKill,
      signal: opts.signal,
      reason: this._drainReason,
      fallbackPath,
    };
    if (forcedKill && opts.onForceKill) {
      try {
        opts.onForceKill(snapshot);
      } catch {
        // post-mortem 回调失败不影响 snapshot 返回
      }
    }
    return snapshot;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Factory 模式,便于注入测试 controller。
 */
export function createGracefulShutdownController(): GracefulShutdownController {
  return new GracefulShutdownController();
}
