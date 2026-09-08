import { compactServerEventValue, createServerEventId, enrichServerEventRecord } from './server-event-log-store.js';
import type { ServerEventLogSink, ServerEventRecord } from './server-event-log-store.js';
import { r2BackupConfigFromEnv, uploadAndVerifyR2Object } from './infra-backup-r2.js';
import type { R2BackupConfig } from './infra-backup-r2.js';

type EventInput = Omit<ServerEventRecord, '_id' | 'ts'> & { ts?: Date | string };

export interface OffHostAuditLogOptions {
  primary?: ServerEventLogSink | null;
  config: R2BackupConfig;
  prefix: string;
  fetchImpl?: typeof fetch;
  /** 测试注入时钟 */
  now?: () => number;
  /** 连续失败多少次后打开熔断（默认 5） */
  breakerOpenAfter?: number;
  /** 熔断打开后隔多久再试一条（默认 5 分钟） */
  breakerRetryMs?: number;
  /** 失败事件最短间隔（默认 60 秒）：每次失败都写一条错误事件会把事件表刷爆 */
  failureEventMinIntervalMs?: number;
}

export interface OffHostAuditBreakerState {
  consecutiveFailures: number;
  open: boolean;
  openedAt: string | null;
  nextRetryAt: string | null;
  /** 熔断期间没有尝试上传、直接跳过的事件数（本地主存储照常写入） */
  skippedWhileOpen: number;
  lastError: string | null;
}

const DEFAULT_BREAKER_OPEN_AFTER = 5;
const DEFAULT_BREAKER_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_FAILURE_EVENT_MIN_INTERVAL_MS = 60 * 1000;

export function offHostAuditConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): { config: R2BackupConfig; prefix: string } | null {
  const config = r2BackupConfigFromEnv(env);
  if (!config) return null;
  const prefix = String(env.R2_AUDIT_PREFIX || `${config.prefix}/audit-log`)
    .trim().replace(/^\/+|\/+$/g, '');
  return prefix ? { config, prefix } : null;
}

export class OffHostAuditLogSink implements ServerEventLogSink {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private failures = 0;
  private lastError = '';
  /**
   * 熔断（2026-09-08 宿主过载复盘）：线上曾连续失败 54256 次——每条服务器事件都
   * 触发一次注定失败的上传 + 校验，再各写一条错误事件（每秒约 2 条），把事件表
   * 刷到只剩它自己。打开后只让 primary 落本地，每 breakerRetryMs 放一条探路；
   * 探路成功即关闭并补一条恢复事件（带跳过数），失败事件按最短间隔限频。
   */
  private breakerOpenedAt: number | null = null;
  private nextRetryAt = 0;
  private skippedWhileOpen = 0;
  private lastFailureEventAt = 0;
  /** 半开探路只放一条：到点后排在队里的其余事件仍然跳过，探路成功才整体放行。 */
  private halfOpenProbeInFlight = false;

  constructor(private readonly opts: OffHostAuditLogOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  breakerState(): OffHostAuditBreakerState {
    return {
      consecutiveFailures: this.failures,
      open: this.breakerOpenedAt !== null,
      openedAt: this.breakerOpenedAt === null ? null : new Date(this.breakerOpenedAt).toISOString(),
      nextRetryAt: this.breakerOpenedAt === null ? null : new Date(this.nextRetryAt).toISOString(),
      skippedWhileOpen: this.skippedWhileOpen,
      lastError: this.failures > 0 ? this.lastError : null,
    };
  }

  /** 熔断打开且还没到探路时刻 → 本条不上传。 */
  private shouldSkipUpload(): boolean {
    if (this.breakerOpenedAt === null) return false;
    return this.now() < this.nextRetryAt;
  }

  private onUploadSuccess(): void {
    const wasOpen = this.breakerOpenedAt !== null;
    const skipped = this.skippedWhileOpen;
    this.failures = 0;
    this.breakerOpenedAt = null;
    this.nextRetryAt = 0;
    this.skippedWhileOpen = 0;
    if (wasOpen) {
      this.opts.primary?.record({
        category: 'system', severity: 'info', source: 'offhost-audit',
        action: 'offhost.audit.write.recovered',
        message: `不可变审计日志外发已恢复（熔断期间跳过 ${skipped} 条，仅本地留存）`,
        details: { skippedWhileOpen: skipped },
      });
    }
  }

  private onUploadFailure(err: unknown): void {
    this.failures += 1;
    this.lastError = (err as Error).message;
    const now = this.now();
    const openAfter = this.opts.breakerOpenAfter ?? DEFAULT_BREAKER_OPEN_AFTER;
    const retryMs = this.opts.breakerRetryMs ?? DEFAULT_BREAKER_RETRY_MS;
    const justOpened = this.breakerOpenedAt === null && this.failures >= openAfter;
    if (justOpened) this.breakerOpenedAt = now;
    if (this.breakerOpenedAt !== null) this.nextRetryAt = now + retryMs;
    const minInterval = this.opts.failureEventMinIntervalMs ?? DEFAULT_FAILURE_EVENT_MIN_INTERVAL_MS;
    // 限频：熔断刚打开那条必发（运维要知道从此只剩本地），其余按最短间隔。
    if (!justOpened && now - this.lastFailureEventAt < minInterval) return;
    this.lastFailureEventAt = now;
    const open = this.breakerOpenedAt !== null;
    this.opts.primary?.record({
      category: 'system', severity: 'error', source: 'offhost-audit',
      action: 'offhost.audit.write.failed',
      message: open
        ? `不可变审计日志外发失败（连续第 ${this.failures} 次），熔断已打开：${Math.round(retryMs / 60000)} 分钟后再探路，期间事件只留本地（已跳过 ${this.skippedWhileOpen} 条）`
        : `不可变审计日志外发失败（连续第 ${this.failures} 次）`,
      error: { message: this.lastError },
      details: {
        consecutiveFailures: this.failures,
        breakerOpen: open,
        nextRetryAt: open ? new Date(this.nextRetryAt).toISOString() : null,
        skippedWhileOpen: this.skippedWhileOpen,
      },
    });
  }

  /**
   * `record` 是**发出去就不管**的（返回 void，调用方无从等待、无从捕获）。
   * 所以这里绝不能把失败重新抛出去：抛进这条没人接的链，就是一个「无人处理的
   * 拒绝」，而 Node 默认把它当致命错误终止进程。
   *
   * 2026-08-18 就是这么炸的：本机 R2 凭据回 401 → 每条事件上传都失败 → 启动后
   * 第一条事件就把 cds-master 打死 → systemd 反复重启超限 → 全站 18 分钟不可用。
   * 一条审计日志传不出去，代价不该是整台 CDS。
   *
   * 现在改成：记一条失败事件 + 累计连续失败次数，然后**咽下**。传不出去这件事
   * 由 {@link consecutiveFailures} 暴露出来，让健康探针去判断严重程度——
   * 咽下不等于藏起来。
   */
  record(record: EventInput): void {
    this.opts.primary?.record(record);
    if (this.shouldSkipUpload()) {
      this.skippedWhileOpen += 1;
      return;
    }
    this.pending += 1;
    this.chain = this.chain.then(async () => {
      try {
        // 队列里的事件是在熔断打开**之前**入队的，真正轮到它上传时熔断可能已经开了
        // （事件来得比失败快）：执行时再判一次，否则积压的几千条还是会逐条撞 R2
        // （Codex PR #1516 P1）。到探路时刻也只放一条半开探路，其余照常跳过。
        if (!this.claimUploadSlot()) {
          this.skippedWhileOpen += 1;
          return;
        }
        try {
          await this.upload(record);
          this.onUploadSuccess();
        } catch (err) {
          this.onUploadFailure(err);
        } finally {
          this.halfOpenProbeInFlight = false;
        }
      } finally {
        this.pending -= 1;
      }
    });
  }

  /** 熔断关着 → 可上传；开着且到点且没有别的探路在飞 → 认领这一条半开探路；否则跳过。 */
  private claimUploadSlot(): boolean {
    if (this.breakerOpenedAt === null) return true;
    if (this.now() < this.nextRetryAt) return false;
    if (this.halfOpenProbeInFlight) return false;
    this.halfOpenProbeInFlight = true;
    return true;
  }

  /** 连续失败次数（成功一次即归零）。健康探针据此判断「离机审计是不是已经哑了」。 */
  consecutiveFailures(): number {
    return this.failures;
  }

  /** 最近一次失败原因，没失败过就是 null。 */
  lastFailure(): string | null {
    return this.failures > 0 ? this.lastError : null;
  }

  async recordImmediate(record: EventInput): Promise<void> {
    // 熔断期间同样只落本地：recordImmediate 的调用方在等这个 promise，
    // 让它去撞一次注定失败的上传只会把请求拖慢。
    if (!this.claimUploadSlot()) {
      this.skippedWhileOpen += 1;
      await this.opts.primary?.recordImmediate?.(record);
      return;
    }
    await Promise.all([
      this.opts.primary?.recordImmediate?.(record),
      this.upload(record).then(
        () => { this.halfOpenProbeInFlight = false; this.onUploadSuccess(); },
        (err) => { this.halfOpenProbeInFlight = false; this.onUploadFailure(err); throw err; },
      ),
    ]);
  }

  async flush(): Promise<void> {
    await this.chain.catch(() => undefined);
    await this.opts.primary?.flush?.();
  }

  findRecent(filter?: Parameters<NonNullable<ServerEventLogSink['findRecent']>>[0]): ReturnType<NonNullable<ServerEventLogSink['findRecent']>> {
    return this.opts.primary?.findRecent?.(filter) ?? Promise.resolve([]);
  }

  get pendingCount(): number {
    return this.pending;
  }

  private async upload(record: EventInput): Promise<void> {
    const enriched = enrichServerEventRecord(record);
    const ts = record.ts ? new Date(record.ts) : new Date();
    const safeTs = Number.isFinite(ts.getTime()) ? ts : new Date();
    const id = createServerEventId();
    const doc = compactServerEventValue({
      ...enriched,
      _id: id,
      ts: safeTs.toISOString(),
    }) as Record<string, unknown>;
    const day = safeTs.toISOString().slice(0, 10).replaceAll('-', '/');
    const objectKey = `${this.opts.prefix}/${day}/${safeTs.getTime()}-${id}.json`;
    await uploadAndVerifyR2Object({
      config: this.opts.config,
      objectKey,
      body: Buffer.from(`${JSON.stringify(doc)}\n`, 'utf8'),
      contentType: 'application/json',
      now: safeTs,
      fetchImpl: this.opts.fetchImpl,
    });
  }
}
