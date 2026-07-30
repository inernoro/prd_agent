/**
 * 发布中心的三个次级弹窗：回滚、归档、单次发布的实时日志。
 *
 * 三者都从主页面搬出来，逻辑一字未改——本次改版的目标是首屏信息架构，
 * 不是顺手重写已经跑通的东西。
 */

import { useEffect, useState } from 'react';
import { Archive, CheckCircle2, Circle, Loader2, RefreshCw, RotateCcw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiUrl } from '@/lib/api';
import { releaseEtaText } from '@/lib/releaseEta';
import type { ReleaseEtaEstimate } from '@/lib/releaseEta';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { useNowTick } from '@/hooks/useNowTick';
import { CodeText, InfoBlock, ReleaseLogPane, StatusPill, formatClock, formatDateTime } from './shared';
import type { CenterRow, ReleaseLogEntry, ReleaseRun } from './types';
import { isReleaseTerminal } from './types';

export interface RollbackState {
  row: CenterRow;
  sourceRun: ReleaseRun;
}

export interface ArchiveState {
  row: CenterRow;
  reason: string;
}

export function RollbackDialog({
  state,
  onClose,
  onConfirm,
}: {
  state: RollbackState | null;
  onClose: () => void;
  onConfirm: (sourceRun: ReleaseRun, targetReleaseId: string) => void;
}): JSX.Element {
  const defaultVersionId = state ? defaultRollbackVersionId(state.row, state.sourceRun) : '';
  const [selectedVersionId, setSelectedVersionId] = useState(defaultVersionId);
  useEffect(() => setSelectedVersionId(defaultVersionId), [defaultVersionId]);
  const versions = state?.row.successfulRuns || [];
  const selected = versions.find((run) => run.releaseId === selectedVersionId);
  const rollbackCommand = state?.row.target.ssh?.rollbackCommand?.trim();
  return (
    <Dialog open={!!state} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(720px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>回滚站点版本</DialogTitle>
        </DialogHeader>
        {state ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <InfoBlock label="环境">{state.row.target.name}</InfoBlock>
              <InfoBlock label="当前记录"><CodeText>{state.sourceRun.releaseId}</CodeText></InfoBlock>
              <InfoBlock label="当前 commit"><CodeText>{state.sourceRun.commitSha.slice(0, 12)}</CodeText></InfoBlock>
              <InfoBlock label="回滚策略">
                {rollbackCommand ? `执行 ${rollbackCommand}` : '重新发布历史成功版本'}
              </InfoBlock>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">选择目标版本</span>
              <select
                value={selectedVersionId}
                onChange={(event) => setSelectedVersionId(event.target.value)}
                className="h-10 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
              >
                {versions.map((run) => (
                  <option key={run.releaseId} value={run.releaseId}>
                    {run.releaseId} · {run.commitSha.slice(0, 12)} · {formatDateTime(run.finishedAt || run.startedAt)}
                  </option>
                ))}
              </select>
            </label>
            <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
              <div className="text-muted-foreground">确认后将执行</div>
              <div className="mt-1">
                回滚到 <CodeText>{selected?.releaseId || '-'}</CodeText>，执行脚本后会立即做健康检查，并生成新的回滚记录。
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-[hsl(var(--hairline))] pt-4">
              <Button variant="outline" onClick={onClose}>取消</Button>
              <Button onClick={() => selectedVersionId && onConfirm(state.sourceRun, selectedVersionId)} disabled={!selectedVersionId}>
                <RotateCcw />
                确认回滚
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveTargetDialog({
  state,
  saving,
  onChange,
  onClose,
  onConfirm,
}: {
  state: ArchiveState | null;
  saving: boolean;
  onChange: (reason: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const valid = Boolean(state && state.reason.trim().length >= 8);
  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(620px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>归档发布目标</DialogTitle>
        </DialogHeader>
        {state ? (
          <div className="space-y-4">
            <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3 text-sm">
              <div className="font-medium">{state.row.target.name}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {state.row.target.projectIdentity?.projectSlug || state.row.target.projectId}
                {state.row.target.ssh ? ` · ${state.row.target.ssh.user}@${state.row.target.ssh.host}` : ''}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">归档会立即停用该目标并取消主目标标记，但会保留配置快照和全部发布记录。</div>
            </div>
            <label className="grid gap-1 text-sm">
              <span className="text-muted-foreground">归档原因</span>
              <textarea
                value={state.reason}
                onChange={(event) => onChange(event.target.value)}
                rows={3}
                placeholder="例如：该目标属于其他项目，错误挂载到当前项目"
                className="resize-none rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 outline-none focus:border-primary/60"
              />
              <span className="text-xs text-muted-foreground">至少 8 个字符，原因会进入审计记录。</span>
            </label>
            <div className="flex justify-end gap-2 border-t border-[hsl(var(--hairline))] pt-4">
              <Button variant="outline" onClick={onClose} disabled={saving}>取消</Button>
              <Button onClick={onConfirm} disabled={!valid || saving}>
                {saving ? <Loader2 className="animate-spin" /> : <Archive />}
                确认归档
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function ReleaseLogDialog({
  run,
  estimate,
  retryingRunId,
  canRollback,
  onClose,
  onRetry,
  onRollback,
}: {
  run: ReleaseRun | null;
  estimate?: ReleaseEtaEstimate;
  retryingRunId: string;
  canRollback: boolean;
  onClose: () => void;
  onRetry: (run: ReleaseRun) => void;
  onRollback: (run: ReleaseRun) => void;
}): JSX.Element {
  const [current, setCurrent] = useState<ReleaseRun | null>(run);
  useEffect(() => setCurrent(run), [run]);
  useEffect(() => {
    if (!run || isReleaseTerminal(run.status)) return undefined;
    const source = new EventSource(apiUrl(`/api/releases/runs/${encodeURIComponent(run.releaseId)}/stream?afterSeq=${run.logs.at(-1)?.seq || 0}`));
    source.addEventListener('snapshot', (event) => {
      const data = parseSseJson<{ run: ReleaseRun; logs: ReleaseLogEntry[] }>(event);
      if (data?.run) setCurrent(data.run);
    });
    source.addEventListener('release.log', (event) => {
      const data = parseSseJson<{ log: ReleaseLogEntry }>(event);
      if (!data?.log) return;
      setCurrent((prev) => prev ? { ...prev, logs: dedupeLogs([...prev.logs, data.log]) } : prev);
    });
    source.addEventListener('release.status', (event) => {
      const data = parseSseJson<{ run: ReleaseRun }>(event);
      if (data?.run) setCurrent(data.run);
    });
    return () => source.close();
  }, [run]);
  const progress = resolveReleaseSteps(current);
  const inFlight = Boolean(current && !isReleaseTerminal(current.status));
  const nowMs = useNowTick(inFlight);
  const etaText = inFlight ? releaseEtaText(current?.startedAt, estimate, nowMs) : '';
  const canActOnFailure = Boolean(current && (current.status === 'failed' || current.status === 'rollback_failed'));
  return (
    <Dialog open={!!run} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-none" style={{ width: 'min(768px, calc(100vw - 32px))' }}>
        <DialogHeader>
          <DialogTitle>
            发布记录 {current?.releaseId ? <span className="font-mono text-sm text-muted-foreground">{current.releaseId}</span> : null}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <StatusPill status={current?.status || 'unknown'} />
          {etaText ? <span className="min-w-0 text-xs text-primary">{etaText}</span> : null}
          <span className="text-muted-foreground">{formatDateTime(current?.startedAt)}</span>
        </div>
        {progress.total > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">第 {progress.currentIndex}/{progress.total} 步</span>
            {progress.currentLabel ? <span className="text-muted-foreground">· {progress.currentLabel}</span> : null}
            {progress.degraded ? <span className="text-xs text-muted-foreground">（历史记录，仅按日志还原大致阶段）</span> : null}
          </div>
        ) : null}
        <div className="grid gap-2">
          {progress.steps.map((step, index) => (
            <div key={step.id} className="flex items-center gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-sm">
              {step.state === 'done' ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                : step.state === 'failed' ? <XCircle className="h-4 w-4 text-red-500" />
                  : step.state === 'running' ? <Loader2 className="h-4 w-4 animate-spin text-sky-500" />
                    : <Circle className="h-4 w-4 text-muted-foreground" />}
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{index + 1}/{progress.total}</span>
              <span className="min-w-0 truncate font-medium">{step.label}</span>
            </div>
          ))}
        </div>
        {/* 与发布中弹窗共用同一块日志窗格：自动跟最新 + 长行折行（不许横向撑破弹窗）。 */}
        <ReleaseLogPane
          // 布局关键高度走 inline style（frontend-modal.md：arbitrary value 在 v4 下不可靠）。
          style={{ height: '42vh' }}
          text={(current?.logs || [])
            .map((log) => `[${formatClock(log.at)}] ${log.level.toUpperCase()} ${log.phase ? `${log.phase}: ` : ''}${log.message}`)
            .join('\n')}
        />
        {current && canActOnFailure ? (
          <div className="flex flex-wrap justify-end gap-2 border-t border-[hsl(var(--hairline))] pt-3">
            <Button variant="outline" onClick={() => onRollback(current)} disabled={!canRollback}>
              <RotateCcw />
              回滚到历史版本
            </Button>
            <Button onClick={() => onRetry(current)} disabled={retryingRunId === current.releaseId}>
              {retryingRunId === current.releaseId ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              重试发布
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function defaultRollbackVersionId(row: CenterRow, sourceRun: ReleaseRun): string {
  const versions = row.successfulRuns || [];
  if (versions.length === 0) return '';
  if (row.rollbackDefaultReleaseId && versions.some((run) => run.releaseId === row.rollbackDefaultReleaseId)) {
    return row.rollbackDefaultReleaseId;
  }
  const sourceTs = new Date(sourceRun.startedAt).getTime();
  const previous = versions.find((run) => run.releaseId !== sourceRun.releaseId && new Date(run.startedAt).getTime() < sourceTs);
  return previous?.releaseId || versions.find((run) => run.releaseId !== sourceRun.releaseId)?.releaseId || versions[0].releaseId;
}

export function dedupeLogs(items: ReleaseLogEntry[]): ReleaseLogEntry[] {
  const bySeq = new Map<number, ReleaseLogEntry>();
  for (const item of items) bySeq.set(item.seq, item);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function parseSseJson<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent).data) as T;
  } catch {
    return null;
  }
}
