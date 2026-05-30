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
 * 2026-05-29 Cursor Bugbot(High + Medium):此前被改成 5_000ms,但典型 deploy
 * (docker build + 启动 + 状态写入)动辄数分钟,5s 几乎必然在 deploy 中途强制重启
 * cds-master,打断协调器的 lease 生命周期,留下半构建容器 / 不一致的分支状态。
 * "容器归 docker 管、SSE 会重连"只覆盖容器本身存活,覆盖不了进程内正在进行的状态
 * 写入。这与本仓库 server-authority 规则(不中断服务端任务)一致 —— 恢复到 deploy-safe
 * 的 180s。仍可用 CDS_RESTART_DRAIN_TIMEOUT_MS 覆盖(0 = 不等,立即重启)。
 */
export const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 180_000;

/** 解析 env 覆盖;非法/缺省回落到 DEFAULT_RESTART_DRAIN_TIMEOUT_MS(单一来源)。 */
export function resolveRestartDrainTimeoutMs(): number {
  const raw = process.env.CDS_RESTART_DRAIN_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
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
