import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Layers, Plus, RefreshCw, RotateCcw, ScrollText, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { MotionLink } from '@/components/layout/RouteMotion';
import { useNowTick } from '@/hooks/useNowTick';
import { apiRequest } from '@/lib/api';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { Chip, formatDateTime, type Tone } from './shared';
import type { ReleaseRun, ReleaseTarget } from './types';

export interface AcceptedReleaseVersion {
  versionId: string;
  commitSha: string;
  branchId: string;
  branchName: string;
  reportId: string;
  reportTitle: string;
  createdAt: string;
}

interface BatchCheck { id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string; blocking: boolean }
export interface BatchTarget {
  targetId: string;
  targetName: string;
  status: string;
  checks?: BatchCheck[];
  preflightId?: string;
  previousReleaseId?: string;
  runId?: string;
  rollbackRunId?: string;
  error?: string;
  observedCommitSha?: string;
  observedAt?: string;
  observationError?: string;
  attempts: Array<{ id: string; kind: 'deploy' | 'rollback'; runId?: string; createdAt: string; error?: string }>;
}
export interface ReleaseBatch {
  id: string;
  projectId: string;
  versionId: string;
  commitSha: string;
  branchId: string;
  branchName: string;
  reportId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  operator?: string;
  targets: BatchTarget[];
}

const BATCH_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: '待预检', tone: 'muted' },
  checking: { label: '发布前检查中', tone: 'live' },
  ready: { label: '预检通过，待确认', tone: 'warn' },
  blocked: { label: '预检未通过', tone: 'bad' },
  running: { label: '按顺序发布中', tone: 'live' },
  success: { label: '全部目标发布成功', tone: 'ok' },
  partial_success: { label: '部分成功', tone: 'warn' },
  failed: { label: '发布失败', tone: 'bad' },
  cancelled: { label: '已取消', tone: 'warn' },
  interrupted: { label: '执行中断，需核对现场', tone: 'bad' },
  rolled_back: { label: '已恢复原版本', tone: 'warn' },
  rollback_failed: { label: '回滚失败', tone: 'bad' },
  inconsistent: { label: '版本不一致或尚未核实', tone: 'bad' },
};
const TARGET_STATUS: Record<string, { label: string; tone: Tone }> = {
  ...BATCH_STATUS,
  pending: { label: '等待执行', tone: 'muted' },
  ready: { label: '预检通过', tone: 'ok' },
  running: { label: '发布中', tone: 'live' },
  success: { label: '发布成功', tone: 'ok' },
  rollback_running: { label: '回滚中', tone: 'live' },
  rolled_back: { label: '已恢复原版本', tone: 'warn' },
};
const ACTIVE_TARGETS = new Set(['checking', 'running', 'rollback_running']);
const RETRYABLE_TARGETS = new Set(['failed', 'cancelled', 'interrupted']);
const selectClass = 'h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm';

function statusView(status: string, target = false): { label: string; tone: Tone } {
  return (target ? TARGET_STATUS : BATCH_STATUS)[status] || { label: `未知状态：${status}`, tone: 'warn' };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function versionKey(version: AcceptedReleaseVersion): string { return `${version.versionId}:${version.reportId}`; }
function isActive(batch: ReleaseBatch): boolean {
  return batch.status === 'running' || batch.status === 'checking' || batch.targets.some((target) => ACTIVE_TARGETS.has(target.status));
}

/** 仅展示服务端批次事实；刷新和页面离开都不会重新发起部署。 */
export function BatchReleasePanel({ projectId, targets, onOpenLogs }: {
  projectId: string;
  targets: ReleaseTarget[];
  onOpenLogs: (run: ReleaseRun) => void;
}): JSX.Element {
  const [versions, setVersions] = useState<AcceptedReleaseVersion[]>([]);
  const [batches, setBatches] = useState<ReleaseBatch[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [creating, setCreating] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [rollbackTargetId, setRollbackTargetId] = useState('');
  const [liveRuns, setLiveRuns] = useState<Record<string, ReleaseRun>>({});
  const alive = useRef(true);
  const mutationKeys = useRef(new Map<string, string>());
  const selected = batches.find((batch) => batch.id === selectedId);
  const selectedActive = Boolean(selected && isActive(selected));
  const eligibleTargets = targets.filter((target) => target.projectId === projectId && target.isEnabled && target.lifecycle !== 'archived');
  const selectedRelease = versions.find((version) => versionKey(version) === selectedVersion);
  const busy = Boolean(pending) || selectedActive;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const receive = useCallback((batch: ReleaseBatch): void => {
    if (!alive.current || batch.projectId !== projectId) return;
    setBatches((current) => [batch, ...current.filter((item) => item.id !== batch.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, [projectId]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    const query = `projectId=${encodeURIComponent(projectId)}`;
    const results = await Promise.allSettled([
      apiRequest<{ versions: AcceptedReleaseVersion[] }>(`/api/releases/batches/accepted-versions?${query}`),
      apiRequest<{ batches: ReleaseBatch[] }>(`/api/releases/batches?${query}`),
    ]);
    if (!alive.current) return;
    if (results[0].status === 'fulfilled') setVersions(results[0].value.versions);
    if (results[1].status === 'fulfilled') {
      const next = results[1].value.batches;
      setBatches(next);
      setSelectedId((current) => next.some((batch) => batch.id === current) ? current : next[0]?.id || '');
    }
    const rejected = results.find((result) => result.status === 'rejected');
    setError(rejected?.status === 'rejected' ? `读取批次失败：${errorMessage(rejected.reason)}。请刷新重试。` : '');
    setLoading(false);
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  // 轮询只读取已有批次与运行记录；没有任何启动、重试或恢复动作。
  useEffect(() => {
    if (!selectedId) return undefined;
    let disposed = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const { batch } = await apiRequest<{ batch: ReleaseBatch }>(`/api/releases/batches/${encodeURIComponent(selectedId)}`);
        if (disposed) return;
        receive(batch);
        setError((current) => current.startsWith('更新批次状态失败：') ? '' : current);
        const runIds = [...new Set(batch.targets.flatMap((target) => [target.rollbackRunId, target.runId, target.previousReleaseId]).filter((id): id is string => Boolean(id)))];
        const runs = await Promise.allSettled(runIds.map((id) => apiRequest<{ run: ReleaseRun }>(`/api/releases/runs/${encodeURIComponent(id)}`)));
        if (disposed) return;
        const found: Record<string, ReleaseRun> = {};
        for (const result of runs) if (result.status === 'fulfilled') found[result.value.run.releaseId] = result.value.run;
        setLiveRuns(found);
        if (isActive(batch)) timer = window.setTimeout(() => void poll(), 2_000);
      } catch (failure) {
        if (!disposed) {
          setError(`更新批次状态失败：${errorMessage(failure)}。保留上次结果，请刷新核对。`);
          timer = window.setTimeout(() => void poll(), 5_000);
        }
      }
    };
    void poll();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [selectedId, selectedActive, receive]);

  async function mutate(action: string, path: string, body: Record<string, unknown>, keyScope = action): Promise<void> {
    if (pending) return;
    setPending(action);
    setError('');
    let idempotencyKey = mutationKeys.current.get(keyScope);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      mutationKeys.current.set(keyScope, idempotencyKey);
    }
    try {
      const { batch } = await apiRequest<{ batch: ReleaseBatch }>(path, { method: 'POST', body: { ...body, idempotencyKey } });
      if (!alive.current) return;
      mutationKeys.current.delete(keyScope);
      receive(batch);
      setSelectedId(batch.id);
      setCreating(false);
      setRollbackTargetId('');
    } catch (failure) {
      if (alive.current) setError(`${errorMessage(failure)}。结果可能尚未返回，请先刷新核对；再次点击同一操作会使用原请求编号。`);
    } finally { if (alive.current) setPending(''); }
  }

  const batchAction = (action: string, suffix: string): void => {
    if (!selected) return;
    void mutate(action, `/api/releases/batches/${encodeURIComponent(selected.id)}${suffix}`, {}, `${selected.id}${suffix}`);
  };
  const targetAction = (targetId: string, action: 'retry' | 'rollback'): void => {
    batchAction(action === 'retry' ? '正在重试失败目标' : '正在恢复原版本', `/targets/${encodeURIComponent(targetId)}/${action}`);
  };
  const showLogs = async (runId: string): Promise<void> => {
    try {
      const response = await apiRequest<{ run: ReleaseRun }>(`/api/releases/runs/${encodeURIComponent(runId)}`);
      if (alive.current) onOpenLogs(response.run);
    } catch (failure) { if (alive.current) setError(`读取发布日志失败：${errorMessage(failure)}`); }
  };
  const moveTarget = (index: number, delta: number): void => {
    setTargetIds((current) => {
      const next = [...current];
      const destination = index + delta;
      if (destination < 0 || destination >= next.length) return current;
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  };

  return <section id="release-batches" aria-label="批次发布" className="cds-surface-raised cds-hairline min-w-0 rounded-[0.875rem] border">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[hsl(var(--hairline))] p-4">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-bold"><Layers className="size-5" />批次发布</h2>
        <p className="mt-1 text-xs text-muted-foreground">选择一个已验收版本，按指定顺序发布到多个目标。分支后续更新不会改变本批次版本。</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={Boolean(pending) || loading} onClick={() => void load()}><RefreshCw className={loading ? 'animate-spin' : ''} />刷新批次</Button>
        <Button variant="outline" size="sm" disabled={Boolean(pending)} onClick={() => setCreating((value) => !value)} aria-expanded={creating}><Plus />新建批次</Button>
      </div>
    </header>
    <div className="space-y-4 p-4">
      {error ? <div role="alert" className="rounded-md border border-destructive/30 bg-bad-soft p-3 text-sm text-bad">{error}</div> : null}
      {pending ? <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><ContentLoading variant="inline" label={pending} />{pending}，请稍候</div> : null}
      {loading && !batches.length ? <ContentLoading label="读取批次与已验收版本" variant="rows" /> : null}
      {creating ? <div className="space-y-4 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-4">
        <label className="flex min-w-0 flex-col gap-2 text-sm font-medium">已验收版本
          <select aria-label="已验收版本" className={`${selectClass} w-full`} value={selectedVersion} onChange={(event) => setSelectedVersion(event.target.value)} disabled={Boolean(pending)}>
            <option value="">请选择已验收版本</option>
            {versions.map((version) => <option key={versionKey(version)} value={versionKey(version)}>{version.branchName} · {version.commitSha.slice(0, 12)} · {version.reportTitle}</option>)}
          </select>
        </label>
        {!versions.length && !loading ? <p className="text-sm text-muted-foreground">这个项目还没有可发布的已验收版本。请先完成分支部署并归档同提交的通过验收报告。</p> : null}
        {selectedRelease ? <div className="min-w-0 space-y-1 text-xs text-muted-foreground"><p className="break-all font-mono">固定提交：{selectedRelease.commitSha}</p><MotionLink className="text-primary hover:underline" to={`/reports?project=${encodeURIComponent(projectId)}&report=${encodeURIComponent(selectedRelease.reportId)}`}>查看验收依据：{selectedRelease.reportTitle}</MotionLink></div> : null}
        <fieldset disabled={Boolean(pending)} className="space-y-2"><legend className="mb-2 text-sm font-medium">发布目标（至少两个）</legend>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{eligibleTargets.map((target) => <label key={target.id} className="flex min-w-0 cursor-pointer items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-background p-3 text-sm"><input type="checkbox" checked={targetIds.includes(target.id)} onChange={(event) => setTargetIds((current) => event.target.checked ? [...current, target.id] : current.filter((id) => id !== target.id))} /><span className="min-w-0 break-words">{target.name}</span></label>)}</div>
          {eligibleTargets.length < 2 ? <p className="text-xs text-muted-foreground">需要至少两个已启用的发布目标，可先通过「新建环境」补齐。</p> : null}
        </fieldset>
        {targetIds.length ? <ol aria-label="发布顺序" className="space-y-2">{targetIds.map((id, index) => <li key={id} className="flex min-w-0 items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-background px-3 py-2 text-sm"><span className="font-mono text-muted-foreground">{index + 1}.</span><span className="min-w-0 flex-1 break-words">{eligibleTargets.find((target) => target.id === id)?.name || id}</span><Button size="sm" variant="ghost" aria-label={`上移目标 ${index + 1}`} disabled={index === 0 || Boolean(pending)} onClick={() => moveTarget(index, -1)}><ArrowUp /></Button><Button size="sm" variant="ghost" aria-label={`下移目标 ${index + 1}`} disabled={index === targetIds.length - 1 || Boolean(pending)} onClick={() => moveTarget(index, 1)}><ArrowDown /></Button></li>)}</ol> : null}
        <div className="flex flex-wrap items-center gap-3"><Button disabled={!selectedRelease || targetIds.length < 2 || Boolean(pending)} onClick={() => {
          if (!selectedRelease) return;
          const body = { projectId, versionId: selectedRelease.versionId, reportId: selectedRelease.reportId, targetIds };
          void mutate('正在创建批次', '/api/releases/batches', body, JSON.stringify(body));
        }}>固定版本并创建批次</Button><p className="text-xs text-muted-foreground">创建后先统一预检，确认后才开始发布。</p></div>
      </div> : null}

      {batches.length ? <label className="flex flex-col gap-2 text-xs text-muted-foreground">批次记录（刷新页面后仍可查看）<select aria-label="批次记录" value={selectedId} className={`${selectClass} w-full`} onChange={(event) => { setSelectedId(event.target.value); setRollbackTargetId(''); }}>{batches.map((batch) => <option value={batch.id} key={batch.id}>{formatDateTime(batch.createdAt)} · {batch.commitSha.slice(0, 12)} · {batch.targets.length} 个目标 · {statusView(batch.status).label}</option>)}</select></label> : !loading ? <p className="text-sm text-muted-foreground">尚无批次发布。点击「新建批次」，选择已验收版本和多个目标。</p> : null}
      {selected ? <>
        <BatchReleaseResult batch={selected} runs={liveRuns} busy={busy} rollbackTargetId={rollbackTargetId} onRetry={(id) => targetAction(id, 'retry')} onPrepareRollback={setRollbackTargetId} onRollback={(id) => targetAction(id, 'rollback')} onLogs={(id) => void showLogs(id)} />
        <MotionLink className="inline-block text-xs text-primary hover:underline" to={`/reports?project=${encodeURIComponent(projectId)}&report=${encodeURIComponent(selected.reportId)}`}>查看本批次验收依据</MotionLink>
        <div className="flex flex-wrap items-center gap-2 border-t border-[hsl(var(--hairline))] pt-4">
          {['draft', 'blocked', 'ready'].includes(selected.status) ? <Button variant="outline" disabled={busy} onClick={() => batchAction('正在统一检查所有目标', '/preflight')}>{selected.status === 'draft' ? '统一发布前检查' : '重新检查所有目标'}</Button> : null}
          {selected.status === 'ready' ? <Button disabled={busy} onClick={() => batchAction('正在开始批次发布', '/start')}>确认发布到 {selected.targets.length} 个目标</Button> : null}
          {isActive(selected) ? <Button variant="outline" disabled={Boolean(pending)} onClick={() => batchAction('正在取消批次', '/cancel')}><Square />取消批次</Button> : null}
          <Button variant="outline" disabled={Boolean(pending)} onClick={() => batchAction('正在核对各目标实际运行版本', '/refresh')}><RefreshCw />核对实际运行版本</Button>
          <span className="text-xs text-muted-foreground">更新于 {formatDateTime(selected.updatedAt)}</span>
        </div>
      </> : null}
    </div>
  </section>;
}

export function BatchReleaseResult({ batch, runs, busy, rollbackTargetId, onRetry, onPrepareRollback, onRollback, onLogs }: {
  batch: ReleaseBatch;
  runs: Record<string, ReleaseRun>;
  busy: boolean;
  rollbackTargetId: string;
  onRetry: (targetId: string) => void;
  onPrepareRollback: (targetId: string) => void;
  onRollback: (targetId: string) => void;
  onLogs: (runId: string) => void;
}): JSX.Element {
  const active = isActive(batch);
  const now = useNowTick(active);
  const status = statusView(batch.status);
  const done = batch.targets.filter((target) => target.status === 'success').length;
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1"><h3 className="text-sm font-semibold">{status.label} · {done}/{batch.targets.length} 个目标发布成功</h3><p className="break-all font-mono text-xs text-muted-foreground">本批次固定提交：{batch.commitSha}</p><p className="break-all text-xs text-muted-foreground">{batch.branchName} · 批次 {batch.id}</p></div><Chip tone={status.tone}>{status.label}</Chip>
    </div>
    {active ? <p role="status" className="text-xs text-muted-foreground">正在执行，批次创建至今 {Math.max(0, Math.floor((now - Date.parse(batch.createdAt)) / 1000))} 秒；可离开页面，执行与证据保留在服务端。</p> : null}
    <ol aria-label="各目标发布结果" className="space-y-3">{batch.targets.map((target, index) => {
      const targetStatus = target.status === 'success' && target.observedCommitSha !== batch.commitSha
        ? { label: target.observedCommitSha ? '执行成功，版本不一致' : '执行成功，版本待核实', tone: target.observedCommitSha ? 'bad' as const : 'warn' as const }
        : statusView(target.status, true);
      const runId = target.rollbackRunId || target.runId;
      const run = runId ? runs[runId] : undefined;
      const previousRun = target.previousReleaseId ? runs[target.previousReleaseId] : undefined;
      const progress = run ? resolveReleaseSteps(run) : undefined;
      const mismatched = Boolean(target.observedCommitSha && target.observedCommitSha !== batch.commitSha && target.status === 'success');
      return <li key={target.targetId} className="min-w-0 rounded-lg border border-[hsl(var(--hairline))] p-3">
        <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs text-muted-foreground">{index + 1}.</span><h4 className="min-w-0 flex-1 break-words text-sm font-semibold">{target.targetName}</h4><Chip tone={targetStatus.tone}>{targetStatus.label}</Chip></div>
        <div className="mt-3 grid min-w-0 gap-2 text-xs md:grid-cols-2">
          <p className="min-w-0 break-all"><span className="text-muted-foreground">实际运行提交：</span><code>{target.observedCommitSha || '未知，尚未核实'}</code>{mismatched ? <strong className="ml-2 text-bad">版本不一致</strong> : null}</p>
          <p className="min-w-0 break-all text-muted-foreground" title={target.previousReleaseId}>批次前版本：{previousRun?.commitSha || target.previousReleaseId || '无可恢复的历史版本'}</p>
          {target.observedAt ? <p className="text-muted-foreground">现场核对时间：{formatDateTime(target.observedAt)}</p> : null}
          {progress ? <p className="text-muted-foreground">执行进度：{progress.currentIndex}/{progress.total} · {progress.currentLabel}</p> : null}
        </div>
        {target.error ? <p role="alert" className="mt-2 whitespace-pre-wrap break-words text-xs text-bad">{target.error}</p> : null}
        {target.observationError ? <p className="mt-2 break-words text-xs text-warn">现场版本未核实：{target.observationError}</p> : null}
        {target.checks?.length ? <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">发布前检查 · {target.checks.filter((check) => check.status === 'pass').length}/{target.checks.length} 项通过</summary><ul className="mt-2 space-y-2">{target.checks.map((check) => <li key={check.id} className="min-w-0 rounded-md bg-[hsl(var(--surface-sunken))] p-2"><span className={check.status === 'fail' ? 'font-medium text-bad' : check.status === 'warn' ? 'font-medium text-warn' : 'font-medium'}>{check.status === 'fail' ? (check.blocking ? '阻断' : '未通过') : check.status === 'warn' ? '提醒' : '通过'} · {check.label}</span><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{check.message}</p></li>)}</ul></details> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {runId ? <Button size="sm" variant="outline" onClick={() => onLogs(runId)}><ScrollText />发布日志</Button> : null}
          {RETRYABLE_TARGETS.has(target.status) ? <Button size="sm" variant="outline" disabled={busy} onClick={() => onRetry(target.targetId)}><RefreshCw />仅重试此目标</Button> : null}
          {target.previousReleaseId && target.runId && !['pending', 'checking', 'ready', 'rolled_back'].includes(target.status) ? <Button size="sm" variant="outline" disabled={busy} onClick={() => onPrepareRollback(target.targetId)}><RotateCcw />恢复原版本</Button> : null}
        </div>
        {rollbackTargetId === target.targetId ? <div className="mt-3 space-y-2 rounded-md border border-warn/30 bg-warn-soft p-3 text-xs"><p className="break-all">确认将「{target.targetName}」恢复到本批次开始前的版本记录 {target.previousReleaseId}？</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => onRollback(target.targetId)}>确认恢复此目标</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => onPrepareRollback('')}>返回</Button></div></div> : null}
        {target.attempts.length > 1 ? <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">全部尝试与恢复记录（{target.attempts.length}）</summary><ul className="mt-2 space-y-2">{target.attempts.map((attempt) => <li key={attempt.id} className="flex flex-wrap items-center gap-2"><span>{attempt.kind === 'rollback' ? '恢复原版本' : '发布'} · {formatDateTime(attempt.createdAt)}</span>{attempt.runId ? <button type="button" className="text-primary hover:underline" onClick={() => onLogs(attempt.runId!)}>查看日志</button> : null}{attempt.error ? <span className="break-words text-bad">{attempt.error}</span> : null}</li>)}</ul></details> : null}
      </li>;
    })}</ol>
  </div>;
}
