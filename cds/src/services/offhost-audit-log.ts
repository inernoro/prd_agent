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

  constructor(private readonly opts: OffHostAuditLogOptions) {}

  record(record: EventInput): void {
    this.opts.primary?.record(record);
    this.pending += 1;
    this.chain = this.chain.catch(() => undefined).then(async () => {
      try {
        await this.upload(record);
      } catch (err) {
        this.opts.primary?.record({
          category: 'system', severity: 'error', source: 'offhost-audit',
          action: 'offhost.audit.write.failed',
          message: '不可变审计日志外发失败',
          error: { message: (err as Error).message },
        });
        throw err;
      } finally {
        this.pending -= 1;
      }
    });
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
