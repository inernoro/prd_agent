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
}

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

  constructor(private readonly opts: OffHostAuditLogOptions) {}

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
    this.pending += 1;
    this.chain = this.chain.then(async () => {
      try {
        await this.upload(record);
        this.failures = 0;
      } catch (err) {
        this.failures += 1;
        this.lastError = (err as Error).message;
        this.opts.primary?.record({
          category: 'system', severity: 'error', source: 'offhost-audit',
          action: 'offhost.audit.write.failed',
          message: `不可变审计日志外发失败（连续第 ${this.failures} 次）`,
          error: { message: this.lastError },
          details: { consecutiveFailures: this.failures },
        });
        // 不 rethrow：见上方注释。链条保持 fulfilled，不产生无人处理的拒绝。
      } finally {
        this.pending -= 1;
      }
    });
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
    await Promise.all([
      this.opts.primary?.recordImmediate?.(record),
      this.upload(record),
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
