import type { ActiveOperation, BranchOperationKind } from './branch-operation-coordinator.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

export interface RestartDrainActiveOperation {
  operationId: string;
  branchId: string;
  kind: BranchOperationKind;
  source?: string | null;
  requestId?: string | null;
}

export interface WaitForRestartSafeBranchOperationsOptions {
  source: string;
  getActiveOperations: () => ActiveOperation[];
  serverEventLogStore?: ServerEventLogSink | null;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RestartDrainResult {
  ok: boolean;
  active: RestartDrainActiveOperation[];
}

export function summarizeActiveBranchOperations(active: ActiveOperation[]): RestartDrainActiveOperation[] {
  return active.map((item) => ({
    operationId: item.operationId,
    branchId: item.branchId,
    kind: item.request.kind,
    source: item.request.source || null,
    requestId: item.request.requestId || null,
  }));
}

export async function waitForRestartSafeBranchOperations(
  options: WaitForRestartSafeBranchOperationsOptions,
): Promise<RestartDrainResult> {
  // 2026-05-28 用户反馈:"为什么一定要等?" — 答案是没必要。docker 容器归 docker
  // daemon 管,cds-master 重启后已存在的容器继续跑;in-flight deploy 的 SSE 连接
  // 断掉但 webhook 5s 内会重试,UI 也 auto-reconnect;重启后 reconcile 会用
  // `docker ps` 扫一遍核对状态。180s 默认是过度防御 → 砍到 5s 给即将完成的 op
  // 一点优雅窗口。配 CDS_RESTART_DRAIN_TIMEOUT_MS=0 可彻底不等。
  const timeoutMs = options.timeoutMs ?? Number(process.env.CDS_RESTART_DRAIN_TIMEOUT_MS || 5_000);
  const intervalMs = options.intervalMs ?? 1000;
  const sleep = options.sleep || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now || (() => Date.now());

  const firstActive = summarizeActiveBranchOperations(options.getActiveOperations());
  if (firstActive.length === 0) return { ok: true, active: [] };

  options.serverEventLogStore?.record({
    category: 'system',
    severity: 'info',
    source: options.source,
    action: 'self-update.restart.waiting',
    message: `restart waiting for ${firstActive.length} active branch operation(s) to drain`,
    details: { activeOperations: firstActive, timeoutMs },
  });

  const startedAt = now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  let active = firstActive;
  while (now() < deadline) {
    await sleep(intervalMs);
    active = summarizeActiveBranchOperations(options.getActiveOperations());
    if (active.length === 0) {
      options.serverEventLogStore?.record({
        category: 'system',
        severity: 'info',
        source: options.source,
        action: 'self-update.restart.wait-completed',
        message: 'restart branch-operation drain completed',
        details: { waitedMs: Math.max(0, now() - startedAt) },
      });
      return { ok: true, active: [] };
    }
  }

  options.serverEventLogStore?.record({
    category: 'system',
    severity: 'warn',
    source: options.source,
    action: 'self-update.restart.deferred',
    message: `restart deferred because ${active.length} branch operation(s) are still active`,
    details: { activeOperations: active, timeoutMs },
  });
  return { ok: false, active };
}
