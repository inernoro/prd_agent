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
  const timeoutMs = options.timeoutMs ?? Number(process.env.CDS_RESTART_DRAIN_TIMEOUT_MS || 180_000);
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
