import type { ReactNode } from 'react';
import { DeploymentTimingSummary } from './DeploymentTimingSummary';

export type DeploymentRunStatus = 'pending' | 'queued' | 'preparing' | 'building' | 'starting' | 'verifying' | 'running' | 'failed' | 'cancelled';

export interface DeploymentRunSummary {
  timingSummary?: unknown;
  id: string;
  projectId: string;
  branchId: string;
  trigger: 'webhook' | 'manual' | 'retry' | 'scheduler' | 'system';
  status: DeploymentRunStatus;
  phase: string;
  seq: number;
  eventCount: number;
  commitSha?: string;
  operationId?: string;
  executorId?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  latestEvent?: {
    seq: number;
    at: string;
    phase: string;
    level: 'info' | 'warn' | 'error';
    status: string;
    message: string;
  };
  failure?: {
    code: string;
    owner: 'code' | 'config' | 'cds' | 'external' | 'unknown';
    retryable: boolean;
    summary: string;
    suggestedAction?: string;
    evidenceRefs?: string[];
  };
}

export function DeploymentRunLedger({
  runs,
  activeRunId,
  expectedRepository,
  expectedBranch,
  renderDiagnosis,
}: {
  runs: DeploymentRunSummary[];
  activeRunId?: string;
  expectedRepository?: string;
  expectedBranch?: string;
  renderDiagnosis?: (runId: string) => ReactNode;
}): JSX.Element | null {
  if (runs.length === 0) return null;
  const visible = runs.slice(0, 5);

  return (
    <section className="overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]">
      <header className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3">
        <div>
          <h4 className="text-sm font-semibold">部署事实账本</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">页面刷新或连接中断后，仍从同一个 runId 继续读取阶段和根因。</p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">最近 {visible.length} 次</span>
      </header>
      <div className="divide-y divide-[hsl(var(--hairline))]">
        {visible.map((run) => {
          const meta = deploymentRunStatusMeta(run.status);
          const message = run.failure?.summary || run.latestEvent?.message || '等待部署事件';
          return (
            <div key={run.id} className="px-4 py-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className={`rounded border px-2 py-0.5 text-xs ${meta.className}`}>{meta.label}</span>
                <span className="font-mono text-xs text-muted-foreground" title={run.id}>{run.id.slice(0, 15)}</span>
                {run.id === activeRunId ? <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[0.6875rem] text-primary">分支当前运行</span> : null}
                <span className="text-xs text-muted-foreground">{deploymentRunTriggerLabel(run.trigger)}</span>
                {run.commitSha ? <span className="font-mono text-xs text-muted-foreground">{run.commitSha.slice(0, 7)}</span> : null}
              </div>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-medium text-foreground">阶段: {run.phase}</span>
                <span className="text-muted-foreground">事件 {run.eventCount}</span>
                <span className="text-muted-foreground">{new Date(run.updatedAt).toLocaleString()}</span>
                {run.executorId ? <span className="text-muted-foreground">执行器 {run.executorId}</span> : null}
              </div>
              <p className={`mt-2 break-words text-xs leading-5 ${run.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>
                {message}
              </p>
              {run.failure?.suggestedAction ? (
                <p className="mt-1 break-words text-xs leading-5 text-warn">
                  建议: {run.failure.suggestedAction}
                </p>
              ) : null}
              <DeploymentTimingSummary summary={run.timingSummary} commitSha={run.commitSha}
                expectedRepository={expectedRepository} expectedBranch={expectedBranch} />
              {run.status === 'failed' ? renderDiagnosis?.(run.id) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function deploymentRunStatusMeta(status: DeploymentRunStatus): { label: string; className: string } {
  if (status === 'running') return { label: '部署成功', className: 'border-ok/30 bg-ok-soft text-ok' };
  if (status === 'failed') return { label: '部署失败', className: 'border-destructive/30 bg-destructive/10 text-destructive' };
  if (status === 'cancelled') return { label: '已取消', className: 'border-border bg-muted text-muted-foreground' };
  const labels: Record<Exclude<DeploymentRunStatus, 'running' | 'failed' | 'cancelled'>, string> = {
    pending: '已受理',
    queued: '排队中',
    preparing: '准备中',
    building: '构建中',
    starting: '启动中',
    verifying: '验证中',
  };
  return { label: labels[status], className: 'border-info/30 bg-info-soft text-info' };
}

function deploymentRunTriggerLabel(trigger: DeploymentRunSummary['trigger']): string {
  const labels: Record<DeploymentRunSummary['trigger'], string> = {
    webhook: 'Webhook',
    manual: '手动',
    retry: '自动重试',
    scheduler: '调度器',
    system: '系统',
  };
  return labels[trigger];
}

