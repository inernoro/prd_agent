import { randomUUID } from 'node:crypto';
import type { ServerEventLogSink, ServerEventRecord } from './server-event-log-store.js';
import { maskSecrets } from './secret-masker.js';

export const ALARM_HISTORY_SOURCE = 'alarm-delivery';

export interface AlarmDeliveryContext {
  channelId: string;
  channelName: string;
  channelKind: string;
  kind: 'alert' | 'drill';
  eventKind: string;
  projectId: string;
  targetId?: string;
  targetName: string;
  detectedAt: string;
  title: string;
  body: string;
}

/** Only allow notification facts into the ledger, never transport credentials or URLs. */
function safeText(value: string): string {
  return maskSecrets(value, { mask: true }).replace(/https?:\/\/[^\s<>"']+/gi, '[链接已省略]').slice(0, 4000);
}

/** One attempt has two durable events; interrupted attempts remain unknown, never successful. */
export async function withAlarmDeliveryHistory<T extends { ok: boolean; status?: number; reason?: string }>(
  store: ServerEventLogSink | null | undefined,
  context: AlarmDeliveryContext,
  send: () => Promise<T>,
): Promise<T> {
  const deliveryId = randomUUID();
  const startedAt = new Date().toISOString();
  const details = {
    deliveryId, startedAt,
    channelId: context.channelId, channelName: safeText(context.channelName), channelKind: context.channelKind,
    kind: context.kind, eventKind: context.eventKind, targetId: context.targetId,
    targetName: safeText(context.targetName), detectedAt: context.detectedAt,
    title: safeText(context.title), body: safeText(context.body),
  };
  const record = async (status: 'started' | 'sent' | 'failed', result?: { status?: number; reason?: string }): Promise<void> => {
    if (!store) return;
    const row = {
      category: 'system' as const, severity: status === 'failed' ? 'warn' as const : 'info' as const,
      source: ALARM_HISTORY_SOURCE, action: `alarm.delivery.${status}`, status,
      projectId: context.projectId, operationId: deliveryId,
      message: `${safeText(context.channelName)}：${safeText(context.title)} · ${status === 'started' ? '准备发送' : status === 'sent' ? '推送服务已接受' : '发送失败'}`,
      details: { ...details, ...(status === 'started' ? {} : { finishedAt: new Date().toISOString() }),
        ...(result?.status === undefined ? {} : { responseStatus: result.status }),
        ...(result?.reason ? { reason: safeText(result.reason) } : {}) },
    };
    try {
      if (store.recordImmediate) await store.recordImmediate(row);
      else store.record(row);
    } catch {
      // Logging failures must not silence a real alarm; do not print potentially secret errors.
      console.warn('[alarm-delivery] 通知记录写入失败，本次发送继续；请检查日志存储');
    }
  };
  await record('started');
  try {
    const result = await send();
    await record(result.ok ? 'sent' : 'failed', result);
    return result;
  } catch (error) {
    await record('failed', { reason: '发送过程中出现异常，结果未确认' });
    throw error;
  }
}

/** Results describe provider acceptance, not proof that a phone displayed the notification. */
export function summarizeAlarmDeliveries(events: ServerEventRecord[]) {
  const attempts = new Map<string, ServerEventRecord>();
  for (const event of events) {
    const id = event.operationId;
    if (event.source !== ALARM_HISTORY_SOURCE || !id) continue;
    const previous = attempts.get(id);
    if (!previous || previous.status === 'started' && event.status !== 'started') attempts.set(id, event);
  }
  const deliveries = [...attempts.values()].map((event) => ({
    deliveryId: event.operationId!,
    status: event.status === 'sent' || event.status === 'failed' || event.status === 'suppressed' ? event.status : 'unknown',
    at: event.ts,
    projectId: event.projectId,
    ...(event.details as Partial<AlarmDeliveryContext> & { startedAt?: string; finishedAt?: string; reason?: string; responseStatus?: number }),
  }));
  const count = (rows: typeof deliveries) => ({
    total: rows.length,
    sent: rows.filter((r) => r.status === 'sent').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    unknown: rows.filter((r) => r.status === 'unknown').length,
  });
  const alerts = deliveries.filter((r) => r.kind === 'alert');
  const group = (key: (row: typeof deliveries[number]) => string) => {
    const groups = new Map<string, typeof deliveries>();
    for (const row of alerts) {
      const k = key(row); const rows = groups.get(k) ?? []; rows.push(row); groups.set(k, rows);
    }
    return [...groups].map(([key, rows]) => ({ key, ...count(rows) }));
  };
  return {
    suppressed: deliveries.filter((r) => String(r.kind) === 'policy'),
    deliveries: deliveries.filter((r) => String(r.kind) !== 'policy'), summary: count(alerts), drills: count(deliveries.filter((r) => r.kind === 'drill')),
    byTarget: group((r) => String(r.targetName ?? '未知目标')),
    byChannel: group((r) => String(r.channelId ?? '未知通道')),
    byEventKind: group((r) => String(r.eventKind ?? '未知事件')),
    hourly: group((r) => new Date(String(r.startedAt ?? r.at)).toISOString().slice(0, 13) + ':00:00Z'),
  };
}
