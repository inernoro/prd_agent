import type { StateService } from './state.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import type { BranchEntry } from '../types.js';
import { createHash } from 'node:crypto';

export interface DeployDispatchReconcileResult {
  branchId: string;
  projectId?: string;
  previousStatus: 'dispatching' | 'accepted';
  nextStatus: 'accepted' | 'interrupted';
  ageMin: number;
  commitSha?: string;
  dispatchAt: string;
  reason: string;
}

export interface ReconcileStaleDeployDispatchOptions {
  now?: Date;
  staleAfterMinutes?: number;
  source?: string;
  serverEventLogStore?: ServerEventLogSink | null;
}

const STALE_DEPLOY_DISPATCH_MINUTES = 15;

function parseTime(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createReconcileTraceId(branchId: string, dispatchAt: string, source: string): string {
  const digest = createHash('sha1')
    .update(`${branchId}\0${dispatchAt}\0${source}`)
    .digest('hex')
    .slice(0, 12);
  return `op_reconcile_${digest}`;
}

function hasAllServicesRunning(branch: BranchEntry): boolean {
  const services = Object.values(branch.services || {});
  return services.length > 0 && services.every((svc) => svc.status === 'running');
}

/**
 * 派发已被更新的成功部署取代时，finalize 仍卡在 running 的孤儿部署日志。
 * webhook 派发后进程若在 finalize 前重启 / 漏写终态，对应 build OperationLog 会永远停在
 * status='running'；前端「有 running 就当当前部署」会把它误报为「疑似卡住 ≥1h」，盖在一个
 * 其实健康运行的分支上（2026-06-29 miduo-backend-master：lastDeployAt 06-24 > 这条 06-23
 * 的 webhook-dispatch 日志，但它从未写终态）。既然存在 startedAt 更晚的成功部署戳，这条更早的
 * running 必已被取代，安全收敛为 completed。幂等：收敛后下次 status 不再是 running，不重复处理。
 * @returns 是否发生变更（决定是否需要 save）。
 */
function finalizeSupersededRunningDeployLogs(
  stateService: StateService,
  branchId: string,
  supersededByMs: number,
  now: Date,
): boolean {
  const logs = stateService.getLogs(branchId);
  let mutated = false;
  for (const log of logs) {
    if (log.type !== 'build' || log.status !== 'running') continue;
    const startedMs = parseTime(log.startedAt);
    if (!startedMs || startedMs >= supersededByMs) continue;
    log.status = 'completed';
    log.finishedAt = now.toISOString();
    (log.events ||= []).push({
      step: 'webhook-dispatch',
      status: 'done',
      title: '该部署日志已被更新的成功部署取代，CDS 收敛为已完成',
      log: '原部署日志未写入终态便被新部署覆盖；看门狗据更晚的成功部署戳收敛，避免前端把它误报为「疑似卡住」',
      timestamp: now.toISOString(),
    });
    mutated = true;
  }
  return mutated;
}

export function reconcileStaleDeployDispatches(
  stateService: StateService,
  options: ReconcileStaleDeployDispatchOptions = {},
): DeployDispatchReconcileResult[] {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const staleAfterMinutes = options.staleAfterMinutes ?? STALE_DEPLOY_DISPATCH_MINUTES;
  const source = options.source ?? 'deploy-dispatch-reconciler';
  const results: DeployDispatchReconcileResult[] = [];
  let mutatedLogs = false;

  for (const branch of stateService.getAllBranches()) {
    const status = branch.lastDeployDispatchStatus;
    if (status !== 'dispatching' && status !== 'accepted') continue;
    const dispatchAt = branch.lastDeployDispatchAt;
    if (!dispatchAt) continue;
    const dispatchAtMs = parseTime(dispatchAt);
    if (!dispatchAtMs) continue;
    const lastDeployAtMs = parseTime(branch.lastDeployAt);
    if (lastDeployAtMs >= dispatchAtMs) {
      // 派发已被更新的成功部署取代：本次派发作废，不再判 stale；但要顺手 finalize 仍卡在
      // running 的孤儿部署日志，否则前端会把它误报为「疑似卡住」（见函数注释的 06-29 案例）。
      if (finalizeSupersededRunningDeployLogs(stateService, branch.id, lastDeployAtMs, now)) {
        mutatedLogs = true;
      }
      continue;
    }
    const lastReadyAtMs = parseTime(branch.lastReadyAt);
    if (
      lastReadyAtMs >= dispatchAtMs
      && branch.status === 'running'
      && hasAllServicesRunning(branch)
    ) {
      const reason = `Webhook deploy dispatch already reached ready state after dispatch; recovered deploy stamp from lastReadyAt`;
      const operationId = createReconcileTraceId(branch.id, dispatchAt, `${source}:ready`);
      const requestId = `reconcile_${operationId.slice('op_reconcile_'.length)}`;
      branch.lastDeployAt = branch.lastReadyAt;
      branch.lastDeployDispatchStatus = 'accepted';
      branch.lastDeployDispatchError = undefined;
      const result: DeployDispatchReconcileResult = {
        branchId: branch.id,
        projectId: branch.projectId,
        previousStatus: status,
        nextStatus: 'accepted',
        ageMin: Math.floor((nowMs - dispatchAtMs) / 60_000),
        commitSha: branch.lastDeployDispatchCommitSha,
        dispatchAt,
        reason,
      };
      results.push(result);

      stateService.appendLog(branch.id, {
        type: 'build',
        startedAt: dispatchAt,
        finishedAt: now.toISOString(),
        status: 'completed',
        events: [{
          step: 'webhook-dispatch',
          status: 'done',
          title: 'Webhook 部署派发状态已由运行时就绪证据恢复',
          log: reason,
          detail: {
            commitSha: branch.lastDeployDispatchCommitSha || null,
            previousStatus: status,
            nextStatus: 'accepted',
            lastReadyAt: branch.lastReadyAt || null,
            source,
          },
          timestamp: now.toISOString(),
        }],
      });
      options.serverEventLogStore?.record({
        category: 'system',
        severity: 'info',
        source,
        action: 'branch.deploy-dispatch.recovered-ready',
        message: `stale webhook deploy dispatch recovered from ready state for ${branch.id}`,
        projectId: branch.projectId,
        branchId: branch.id,
        requestId,
        operationId,
        details: {
          operationId,
          requestId,
          actor: 'system:deploy-dispatch-reconciler',
          trigger: 'system',
          previousStatus: status,
          nextStatus: 'accepted',
          lastDeployDispatchAt: branch.lastDeployDispatchAt || null,
          lastDeployDispatchCommitSha: branch.lastDeployDispatchCommitSha || null,
          lastReadyAt: branch.lastReadyAt || null,
          lastDeployAt: branch.lastDeployAt || null,
          reason,
        },
      });
      continue;
    }
    const ageMin = Math.floor((nowMs - dispatchAtMs) / 60_000);
    if (ageMin < staleAfterMinutes) continue;

    const reason = `Webhook deploy dispatch stayed ${status} for ${ageMin} minutes without a newer successful deploy stamp`;
    const operationId = createReconcileTraceId(branch.id, dispatchAt, source);
    const requestId = `reconcile_${operationId.slice('op_reconcile_'.length)}`;
    branch.lastDeployDispatchStatus = 'interrupted';
    branch.lastDeployDispatchError = reason;
    const result: DeployDispatchReconcileResult = {
      branchId: branch.id,
      projectId: branch.projectId,
      previousStatus: status,
      nextStatus: 'interrupted',
      ageMin,
      commitSha: branch.lastDeployDispatchCommitSha,
      dispatchAt,
      reason,
    };
    results.push(result);

    stateService.appendLog(branch.id, {
      type: 'build',
      startedAt: dispatchAt,
      finishedAt: now.toISOString(),
      status: 'error',
      events: [{
        step: 'webhook-dispatch',
        status: 'warning',
        title: 'Webhook 部署派发被 CDS 收敛为中断',
        log: reason,
        detail: {
          commitSha: branch.lastDeployDispatchCommitSha || null,
          previousStatus: status,
          nextStatus: 'interrupted',
          ageMin,
          source,
        },
        timestamp: now.toISOString(),
      }],
    });
    options.serverEventLogStore?.record({
      category: 'system',
      severity: 'warn',
      source,
      action: 'branch.deploy-dispatch.interrupted',
      message: `stale webhook deploy dispatch interrupted for ${branch.id}`,
      projectId: branch.projectId,
      branchId: branch.id,
      requestId,
      operationId,
      details: {
        operationId,
        requestId,
        actor: 'system:deploy-dispatch-reconciler',
        trigger: 'system',
        previousStatus: status,
        nextStatus: 'interrupted',
        lastDeployDispatchAt: branch.lastDeployDispatchAt || null,
        lastDeployDispatchCommitSha: branch.lastDeployDispatchCommitSha || null,
        lastDeployAt: branch.lastDeployAt || null,
        ageMin,
        reason,
      },
    });
  }

  if (results.length > 0 || mutatedLogs) stateService.save();
  return results;
}
