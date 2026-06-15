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

/**
 * 重启前等待 in-flight 分支操作排空的默认上限(SSOT,utility 与 route 包装共用)。
 *
 * 2026-06-14: self-update 默认不再等待分支操作排空。分支操作协调器已经会在
 * master 重启前 interruptAll,重启后也有 docker/state reconcile 兜底。把所有
 * self-update 默认卡到 180s 会把“正在部署/日志流还在”的普通场景放大成 3-4 分钟
 * 等待。需要强一致排空时,请求显式传 drain=true 或 drainTimeoutMs。
 */
export const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 0;

/** 显式传 drain=true 但没给 drainTimeoutMs 时使用的排空窗口。 */
export const DEFAULT_EXPLICIT_RESTART_DRAIN_TIMEOUT_MS = 180_000;

/** 解析 env 覆盖;非法/缺省回落到 DEFAULT_RESTART_DRAIN_TIMEOUT_MS(单一来源)。 */
export function resolveRestartDrainTimeoutMs(): number {
  const raw = process.env.CDS_RESTART_DRAIN_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
}

export function resolveExplicitRestartDrainTimeoutMs(): number {
  const raw = process.env.CDS_RESTART_DRAIN_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_EXPLICIT_RESTART_DRAIN_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EXPLICIT_RESTART_DRAIN_TIMEOUT_MS;
}

function isTruthyDrainFlag(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1 || value === 'yes';
}

function parseNonNegativeMs(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function resolveRestartDrainTimeoutFromRequest(body: unknown): number {
  const source = body && typeof body === 'object'
    ? body as Record<string, unknown>
    : {};
  const explicitTimeout =
    parseNonNegativeMs(source.drainTimeoutMs) ??
    parseNonNegativeMs(source.restartDrainTimeoutMs);
  if (explicitTimeout !== null) return explicitTimeout;
  if (isTruthyDrainFlag(source.drain) || isTruthyDrainFlag(source.waitForDrain)) {
    return resolveExplicitRestartDrainTimeoutMs();
  }
  return DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
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
  // 默认上限走 SSOT(见 DEFAULT_RESTART_DRAIN_TIMEOUT_MS 注释:deploy-safe 180s +
  // env 覆盖)。早返机制不变:active 一旦排空立即返回,不会傻等满 180s。
  const timeoutMs = options.timeoutMs ?? resolveRestartDrainTimeoutMs();
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
