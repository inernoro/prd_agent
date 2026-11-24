import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, CheckCircle2, ChevronRight, History, LockKeyhole, Plus, RefreshCw, RotateCcw, ScrollText, Square, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
import { MotionLink } from '@/components/layout/RouteMotion';
import { useNowTick } from '@/hooks/useNowTick';
import { apiRequest } from '@/lib/api';
import { resolveReleaseSteps } from '@/lib/releaseSteps';
import { diagnoseReleaseFailure } from '@/lib/releaseDiagnosis';
import { Chip, formatDateTime, type Tone } from './shared';
import type { CenterRow, ReleaseRun, ReleaseTarget } from './types';

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
  previousCommitSha?: string;
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
export function BatchReleasePanel({ projectId, targets, currentRows = [], onOpenLogs, isTargetUnconfirmed = () => false }: {
  projectId: string;
  targets: ReleaseTarget[];
  currentRows?: CenterRow[];
  onOpenLogs: (run: ReleaseRun) => void;
  isTargetUnconfirmed?: (targetId: string) => boolean;
}): JSX.Element {
  const [params, setParams] = useSearchParams();
  const [requestedBatchId] = useState(() => params.get('batch') || '');
  const [versions, setVersions] = useState<AcceptedReleaseVersion[]>([]);
  const [batches, setBatches] = useState<ReleaseBatch[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [creating, setCreating] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(() => params.get('batchView') === 'history');
  const initialized = useRef(false);
  const [selectedVersion, setSelectedVersion] = useState('');
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [rollbackTargetId, setRollbackTargetId] = useState('');
  const [liveRuns, setLiveRuns] = useState<Record<string, ReleaseRun>>({});
  const alive = useRef(true);
  const mutationKeys = useRef(new Map<string, string>());
  const cancellationRevision = useRef(0);
  const cancelInFlight = useRef(false);
  const selected = batches.find((batch) => batch.id === selectedId);
  const selectedActive = Boolean(selected && isActive(selected));
  const eligibleTargets = targets.filter((target) => target.projectId === projectId && target.isEnabled && target.lifecycle !== 'archived');
  const selectedRelease = versions.find((version) => versionKey(version) === selectedVersion);
  const pollingPending = Boolean(pending) || cancelling;
  const busy = pollingPending || selectedActive;
  const operationLabel = cancelling ? '正在取消批次'
    : selected?.status === 'cancelled' && pending === '正在统一检查所有目标' ? '取消已受理，等待当前检查结束' : pending;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const receive = useCallback((batch: ReleaseBatch): void => {
    if (!alive.current || batch.projectId !== projectId) return;
    setBatches((current) => {
      const previous = current.find((item) => item.id === batch.id);
      if (previous && previous.updatedAt > batch.updatedAt) return current;
      return [batch, ...current.filter((item) => item.id !== batch.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
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
      if (!initialized.current) {
        const resume = next.find((batch) => batch.id === requestedBatchId) || next.find(isActive);
        if (resume) { setSelectedId(resume.id); setCreating(false); }
        initialized.current = true;
      }
    }
    const rejected = results.find((result) => result.status === 'rejected');
    setError(rejected?.status === 'rejected' ? `读取批次失败：${errorMessage(rejected.reason)}。请刷新重试。` : '');
    setLoading(false);
  }, [projectId, requestedBatchId]);
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
        if (isActive(batch) || pollingPending) timer = window.setTimeout(() => void poll(), 2_000);
      } catch (failure) {
        if (!disposed) {
          setError(`更新批次状态失败：${errorMessage(failure)}。保留上次结果，请刷新核对。`);
          timer = window.setTimeout(() => void poll(), 5_000);
        }
      }
    };
    void poll();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [selectedId, selectedActive, pollingPending, receive]);

  async function mutate(action: string, path: string, body: Record<string, unknown>, keyScope = action): Promise<void> {
    if (pending || cancelling) return;
    const startingTargets = path === '/api/releases/batches' && Array.isArray(body.targetIds)
      ? body.targetIds as string[]
      : path.endsWith('/start') ? selected?.targets.map(target => target.targetId) || [] : [];
    if (startingTargets.some(isTargetUnconfirmed)) {
      setError('所选目标还有发布请求待核对，请先通过上方请求编号确认原任务结果。');
      return;
    }
    const cancellationAtStart = cancellationRevision.current;
    setPending(action);
    setError('');
    let idempotencyKey = mutationKeys.current.get(keyScope);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      mutationKeys.current.set(keyScope, idempotencyKey);
    }
    try {
      let { batch } = await apiRequest<{ batch: ReleaseBatch }>(path, { method: 'POST', body: { ...body, idempotencyKey } });
      if (!alive.current) return;
      if (path === '/api/releases/batches') {
        receive(batch);
        setSelectedId(batch.id);
        setCreating(false);
        setParams((current) => { const next = new URLSearchParams(current); next.set('batch', batch.id); return next; }, { replace: true });
        setPending('正在统一检查所有目标');
        ({ batch } = await apiRequest<{ batch: ReleaseBatch }>(`/api/releases/batches/${encodeURIComponent(batch.id)}/preflight`, { method: 'POST', body: { idempotencyKey: `${idempotencyKey}:preflight` } }));
        if (!alive.current) return;
      }
      // A cancellation may overtake this response while a synchronous preflight
      // probe is finishing. Read the authoritative state before showing it.
      if (cancellationAtStart !== cancellationRevision.current) {
        ({ batch } = await apiRequest<{ batch: ReleaseBatch }>(`/api/releases/batches/${encodeURIComponent(batch.id)}`));
        if (!alive.current) return;
      }
      mutationKeys.current.delete(keyScope);
      receive(batch);
      setSelectedId(batch.id);
      setParams((current) => { const next = new URLSearchParams(current); next.set('batch', batch.id); return next; }, { replace: true });
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
    if (isTargetUnconfirmed(targetId)) {
      setError('此目标还有发布请求待核对，请先通过上方请求编号确认原任务结果。');
      return;
    }
    const cancelled = selected?.status === 'cancelled' || selected?.targets.find(target => target.targetId === targetId)?.status === 'cancelled';
    batchAction(action === 'retry' ? (cancelled ? '正在重新发布已取消目标' : '正在重试目标') : '正在恢复原版本', `/targets/${encodeURIComponent(targetId)}/${action}`);
  };
  const cancelBatch = async (): Promise<void> => {
    if (!selected || cancelInFlight.current) return;
    cancelInFlight.current = true;
    cancellationRevision.current += 1;
    setCancelling(true);
    setError('');
    try {
      const { batch } = await apiRequest<{ batch: ReleaseBatch }>(`/api/releases/batches/${encodeURIComponent(selected.id)}/cancel`, { method: 'POST', body: {} });
      receive(batch);
    } catch (failure) {
      if (alive.current) setError(`取消结果未确认：${errorMessage(failure)}。请刷新核对，可再次取消同一批次。`);
    } finally {
      cancelInFlight.current = false;
      if (alive.current) setCancelling(false);
    }
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
  const showHistory = (id = selectedId): void => {
    setSelectedId(id); setHistoryOpen(true); setCreating(false); setRollbackTargetId('');
    setParams((current) => { const next = new URLSearchParams(current); if (id) next.set('batch', id); next.set('batchView', 'history'); return next; }, { replace: true });
  };
  const newRelease = (copySelected = false): void => {
    if (copySelected && selected) {
      const version = versions.find((item) => item.versionId === selected.versionId && item.reportId === selected.reportId);
      setSelectedVersion(version ? versionKey(version) : '');
      setTargetIds(selected.targets.map((target) => target.targetId).filter((id) => eligibleTargets.some((target) => target.id === id) && !isTargetUnconfirmed(id)));
    }
    setCreating(true); setHistoryOpen(false); setRollbackTargetId('');
    setParams((current) => { const next = new URLSearchParams(current); next.delete('batch'); next.delete('batchView'); return next; }, { replace: true });
  };

  const stage = creating ? 1 : selected && ['draft', 'checking', 'ready', 'blocked'].includes(selected.status) ? 2 : selected && isActive(selected) ? 3 : 4;
  const activeVersion = creating ? selectedRelease : versions.find((version) => version.versionId === selected?.versionId && version.reportId === selected?.reportId);
  const fixedCommit = creating ? selectedRelease?.commitSha : selected?.commitSha;
  const reportId = creating ? selectedRelease?.reportId : selected?.reportId;
  const count = creating ? targetIds.length : selected?.targets.length || 0;
  const prepared = selected?.targets.filter((target) => target.status === 'ready').length || 0;
  const heading = creating ? '选择版本与目标' : stage === 2 ? '发布前确认' : stage === 3 ? '执行发布' : '发布结果';

  const nextStep = creating ? loading ? '正在读取已验收版本与目标。' : !versions.length
      ? '先完成分支验收并归档通过报告，再来选择发布版本。'
      : eligibleTargets.length < 2 ? '当前不足两个可用目标。请到环境管理补齐，或改用逐目标发布。'
      : !selectedRelease ? '先选择一个已验收版本。' : targetIds.length < 2 ? '再选择至少两个发布目标。' : '版本与目标已选定，可以开始预检。'
    : selected?.status === 'blocked' ? '查看未通过的目标，处理后重新检查。'
      : selected?.status === 'ready' ? '所有目标已通过预检，核对顺序后确认发布。'
        : stage === 2 ? '先完成发布前检查。' : stage === 3 ? '发布正在执行，可以查看各目标进度。' : '查看各目标结果和执行记录。';
  return <section id="release-batches" aria-label="批次发布" className={RELEASE_BATCH_SECTION_CLASS}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h1 className="text-2xl font-bold">{historyOpen ? '历史批次 · ' : ''}{heading}</h1>
        <p className="mt-2 text-sm text-muted-foreground"><strong className="text-foreground">下一步：</strong>{nextStep}</p></div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={pollingPending || loading} onClick={() => void load()}><RefreshCw className={loading ? 'animate-spin' : ''} />刷新批次</Button>
        <Button variant="outline" size="sm" disabled={pollingPending} onClick={() => showHistory()}><History />历史批次</Button>
        {!creating ? <Button variant="outline" size="sm" disabled={busy} onClick={() => newRelease()}><Plus />新建发布</Button> : null}
      </div>
    </header>
    <ol aria-label="发布步骤" className={RELEASE_BATCH_STEPS_CLASS}>{['选择版本与目标', '发布前确认', '执行发布', '查看结果'].map((label, index) => <li key={label} aria-current={stage === index + 1 ? 'step' : undefined}
      className={`flex min-w-0 items-center gap-2 rounded-md border p-3 text-sm ${stage === index + 1 ? 'border-primary/40 bg-primary/10 font-semibold text-primary' : 'border-[hsl(var(--hairline))] text-muted-foreground'}`}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-current text-xs" aria-hidden="true">{index + 1}</span><span>{label}</span></li>)}</ol>
    {error ? <div role="alert" className="rounded-md border border-destructive/30 bg-bad-soft p-4 text-sm text-bad">{error}</div> : null}
    {operationLabel ? <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><ContentLoading variant="inline" label={operationLabel} />{operationLabel}，请稍候</div> : null}
    {loading && !batches.length ? <ContentLoading label="读取批次与已验收版本" variant="rows" /> : null}
    <footer className={RELEASE_BATCH_ACTIONS_CLASS}>
      <p className="text-sm text-muted-foreground">{creating ? '尚未开始发布' : selected ? `${historyOpen ? '历史记录 · ' : ''}${statusView(selected.status).label} · 更新于 ${formatDateTime(selected.updatedAt)}` : '尚无批次发布'}</p>
      <div className="flex flex-wrap items-center gap-3">
        {creating ? <Button disabled={!selectedRelease || targetIds.length < 2 || Boolean(pending) || targetIds.some(isTargetUnconfirmed)} onClick={() => {
          if (!selectedRelease) return;
          const body = { projectId, versionId: selectedRelease.versionId, reportId: selectedRelease.reportId, targetIds };
          void mutate('正在创建批次', '/api/releases/batches', body, JSON.stringify(body));
        }}>固定版本并检查目标</Button> : selected ? <>
          {['draft', 'blocked', 'ready'].includes(selected.status) ? <Button variant="outline" disabled={busy} onClick={() => newRelease(true)}>返回修改（创建新批次）</Button> : null}
          {['draft', 'blocked', 'ready'].includes(selected.status) ? <Button variant="outline" disabled={busy} onClick={() => batchAction('正在统一检查所有目标', '/preflight')}>{selected.status === 'draft' ? '统一发布前检查' : '重新检查所有目标'}</Button> : null}
          {selected.status === 'ready' ? <Button disabled={busy || selected.targets.some(target => isTargetUnconfirmed(target.targetId))} onClick={() => batchAction('正在开始批次发布', '/start')}>确认发布到 {selected.targets.length} 个目标</Button> : null}
          {['draft', 'blocked', 'ready'].includes(selected.status) || isActive(selected) || pending === '正在统一检查所有目标' ? <Button variant="outline" disabled={cancelling || selected.status === 'cancelled'} onClick={() => void cancelBatch()}><Square />{selected.status === 'cancelled' ? '正在取消' : '取消批次'}</Button> : null}
          <Button variant="outline" disabled={pollingPending} onClick={() => batchAction('正在核对各目标实际运行版本', '/refresh')}><RefreshCw />核对实际运行版本</Button>
        </> : null}
      </div>
    </footer>
    {historyOpen ? <div className="cds-surface-raised cds-hairline rounded-lg border p-4">
      <p className="mb-3 text-sm text-muted-foreground">这里展示历史执行记录，不会重新发起部署。实际版本以各记录的现场核对时间为准。</p>
      {batches.length ? <label className="flex flex-col gap-2 text-sm">批次记录<select aria-label="批次记录" disabled={pollingPending} value={selectedId} className={`${selectClass} w-full`} onChange={(event) => showHistory(event.target.value)}>{batches.map((batch) => <option value={batch.id} key={batch.id}>{formatDateTime(batch.createdAt)} · {batch.commitSha.slice(0, 12)} · {batch.targets.length} 个目标 · {statusView(batch.status).label}</option>)}</select></label> : <p className="text-sm text-muted-foreground">尚无历史批次，可点击「新建发布」开始。</p>}
    </div> : null}
    {creating || selected ? <div className={RELEASE_BATCH_DETAIL_CLASS}>
      <div className="min-w-0 space-y-4">
        {creating ? <div className="cds-surface-raised cds-hairline space-y-6 rounded-xl border p-5 md:p-6">
          <label className="flex min-w-0 flex-col gap-3 text-base font-semibold">已验收版本
            <select aria-label="已验收版本" className={`${selectClass} h-11 w-full font-normal`} value={selectedVersion} onChange={(event) => setSelectedVersion(event.target.value)} disabled={Boolean(pending)}>
              <option value="">请选择已验收版本</option>
              {versions.map((version) => <option key={versionKey(version)} value={versionKey(version)}>{version.reportTitle} · {version.commitSha.slice(0, 12)} · {version.branchName}</option>)}
            </select>
          </label>
          {!versions.length && !loading ? <p className="text-sm text-muted-foreground">这个项目还没有可发布的已验收版本。请先完成分支部署并归档同提交的通过验收报告。</p> : null}
          <fieldset disabled={Boolean(pending)} className="space-y-3"><legend className="mb-3 text-base font-semibold">发布目标（至少两个）</legend>
            <div className="grid gap-3 sm:grid-cols-2">{eligibleTargets.map((target) => <label key={target.id} className={`flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-4 text-sm ${targetIds.includes(target.id) ? 'border-primary/40 bg-primary/5' : 'border-[hsl(var(--hairline))]'}`}>
              <input className="mt-1 size-4 shrink-0 accent-primary" type="checkbox" disabled={isTargetUnconfirmed(target.id)} checked={targetIds.includes(target.id)} onChange={(event) => { if (isTargetUnconfirmed(target.id)) return; setTargetIds((current) => event.target.checked ? [...current, target.id] : current.filter((id) => id !== target.id)); }} />
              <span className="min-w-0"><span className="block break-words font-medium">{target.name}</span>{isTargetUnconfirmed(target.id) ? <span className="mt-2 block text-warn">此目标有发布请求待核对</span> : null}<span className="mt-2 block break-all text-xs text-muted-foreground">已记录版本 {currentRows.find((row) => row.target.id === target.id)?.currentCommit?.slice(0, 12) || '未知，预检时核对'}</span></span>
            </label>)}</div>
            {eligibleTargets.length < 2 ? <p className="text-sm text-muted-foreground">需要至少两个已启用的发布目标，可先通过「环境管理」补齐。</p> : null}
          </fieldset>
          {targetIds.length ? <div><h2 className="mb-3 text-base font-semibold">发布顺序</h2><ol aria-label="发布顺序" className="space-y-3">{targetIds.map((id, index) => <li key={id} className="flex min-w-0 items-center gap-3 rounded-lg border border-[hsl(var(--hairline))] px-4 py-3 text-sm"><span className="text-muted-foreground">{index + 1}.</span><span className="min-w-0 flex-1 break-words">{eligibleTargets.find((target) => target.id === id)?.name || id}</span><Button size="sm" variant="ghost" aria-label={`上移目标 ${index + 1}`} disabled={index === 0 || Boolean(pending)} onClick={() => moveTarget(index, -1)}><ArrowUp /></Button><Button size="sm" variant="ghost" aria-label={`下移目标 ${index + 1}`} disabled={index === targetIds.length - 1 || Boolean(pending)} onClick={() => moveTarget(index, 1)}><ArrowDown /></Button></li>)}</ol></div> : null}
          <p className="text-sm text-muted-foreground">下一步会固定版本并统一检查所有目标，通过后仍需你确认才开始发布。</p>
        </div> : selected ? <BatchReleaseResult batch={selected} runs={liveRuns} busy={busy} isTargetUnconfirmed={isTargetUnconfirmed} rollbackTargetId={rollbackTargetId} onRetry={(id) => targetAction(id, 'retry')} onPrepareRollback={setRollbackTargetId} onRollback={(id) => targetAction(id, 'rollback')} onLogs={(id) => void showLogs(id)} /> : null}
      </div>
      <aside aria-label="本次固定版本" className="cds-surface-raised cds-hairline min-w-0 space-y-5 rounded-xl border p-5 md:p-6">
        <h2 className="text-lg font-semibold">{creating ? '本次发布' : '本次固定版本'}</h2>
        {fixedCommit ? <><div><p className="break-words text-lg font-semibold">{activeVersion?.reportTitle || selected?.branchName || '已验收版本'}</p><p className="mt-2 font-mono text-base">{fixedCommit.slice(0, 12)}</p><span className="mt-3 inline-flex items-center gap-1.5 text-sm text-ok"><CheckCircle2 className="size-4" />已验收</span></div>
          <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm"><dt className="text-muted-foreground">目标</dt><dd>{count} 个</dd><dt className="text-muted-foreground">分支</dt><dd className="break-all">{creating ? selectedRelease?.branchName : selected?.branchName}</dd></dl>
          <div className="flex items-start gap-3 rounded-lg bg-[hsl(var(--surface-sunken))] p-4 text-sm"><LockKeyhole className="mt-0.5 size-4 shrink-0" /><p>版本已固定。分支后续更新不会改变本次发布内容，重试也继续使用同一版本。</p></div>
          {reportId ? <MotionLink className="inline-flex items-center gap-1 text-sm text-primary hover:underline" to={`/reports?project=${encodeURIComponent(projectId)}&report=${encodeURIComponent(reportId)}`}>查看验收依据<ChevronRight className="size-4" /></MotionLink> : null}
          <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">版本与批次标识</summary><p className="mt-3 break-all font-mono text-xs">固定提交：{fixedCommit}</p>{!creating && selected ? <p className="mt-2 break-all text-xs">批次 {selected.id}</p> : null}</details>
        </> : <p className="text-sm text-muted-foreground">先选择一个已验收版本，再选择本次发布的目标。</p>}
        {!creating && selected && stage === 2 ? <p className={`rounded-lg p-4 text-sm ${selected.status === 'ready' ? 'bg-ok-soft text-ok' : selected.status === 'blocked' ? 'bg-bad-soft text-bad' : 'bg-muted text-muted-foreground'}`}>{selected.status === 'ready' ? `${prepared} / ${count} 个目标预检通过` : selected.status === 'blocked' ? '预检存在阻断项，暂不能发布。展开目标检查查看处理建议。' : '尚未开始发布，请先完成所有目标的发布前检查。'}</p> : null}
        <p className="text-sm leading-relaxed text-muted-foreground">部分目标失败时，可仅重试失败目标；如需撤回，可按目标恢复原版本。</p>
      </aside>
    </div> : null}
  </section>;
}

export function BatchReleaseResult({ batch, runs, busy, rollbackTargetId, onRetry, onPrepareRollback, onRollback, onLogs, isTargetUnconfirmed = () => false }: {
  batch: ReleaseBatch;
  runs: Record<string, ReleaseRun>;
  busy: boolean;
  rollbackTargetId: string;
  onRetry: (targetId: string) => void;
  onPrepareRollback: (targetId: string) => void;
  onRollback: (targetId: string) => void;
  onLogs: (runId: string) => void;
  isTargetUnconfirmed?: (targetId: string) => boolean;
}): JSX.Element {
  const active = isActive(batch);
  const now = useNowTick(active);
  const preparing = ['draft', 'checking', 'ready', 'blocked'].includes(batch.status);
  const done = batch.targets.filter((target) => target.status === 'success' && target.observedCommitSha === batch.commitSha && !target.observationError).length;
  const stopping = batch.status === 'cancelled' && active;
  const status = stopping ? { label: '正在取消，等待目标停止', tone: 'live' as const }
    : statusView(batch.status === 'success' && done !== batch.targets.length ? 'inconsistent' : batch.status);
  const observedVersions = new Set(batch.targets.map((target) => target.observationError ? undefined : target.observedCommitSha).filter(Boolean));
  const unknown = batch.targets.filter((target) => !target.observedCommitSha || target.observationError).length;
  const hasRollback = batch.targets.some((target) => target.rollbackRunId || target.attempts.some((attempt) => attempt.kind === 'rollback'));
  const restored = batch.targets.filter((target) => {
    const previousCommit = target.previousCommitSha || (target.previousReleaseId ? runs[target.previousReleaseId]?.commitSha : undefined);
    return target.status === 'rolled_back' && previousCommit && target.observedCommitSha === previousCommit && !target.observationError;
  }).length;
  return <div className="min-w-0 space-y-3">
    <div role="status" className={`space-y-3 rounded-xl border p-5 ${status.tone === 'bad' ? 'border-bad/30 bg-bad-soft' : status.tone === 'ok' ? 'border-ok/30 bg-ok-soft' : 'border-warn/30 bg-warn-soft'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-lg font-semibold">{status.label} · {preparing ? `${batch.targets.filter((target) => target.status === 'ready').length}/${batch.targets.length} 个目标预检通过` : hasRollback ? `已恢复 ${restored}/${batch.targets.length} 个目标原版本` : `${done}/${batch.targets.length} 个目标发布成功`}</h3><Chip tone={status.tone}>{status.label}</Chip>
      </div>
      {!preparing && observedVersions.size > 1 ? <p className="flex items-start gap-2 text-sm font-medium text-warn"><TriangleAlert className="mt-0.5 size-4 shrink-0" />各目标版本不一致，请按下方实际运行版本判断。</p> : null}
      {!preparing && unknown > 0 ? <p className="text-sm text-warn">{unknown} 个目标的实际版本尚未核实，请核对现场。执行记录不能代替实际运行结果。</p> : null}
      {!preparing && batch.targets.some((target) => RETRYABLE_TARGETS.has(target.status)) ? <p className="text-sm text-muted-foreground">可单独重试失败或中断目标，已取消目标需确认后重新发布。已成功目标不会重复部署，操作继续使用本批次固定版本。</p> : null}
    </div>
    {active ? <p role="status" className="text-xs text-muted-foreground">{stopping ? '取消已受理，正在等待目标停止并核对实际版本。' : <>正在执行，批次创建至今 {Math.max(0, Math.floor((now - Date.parse(batch.createdAt)) / 1000))} 秒；可离开页面，执行与证据保留在服务端。</>}</p> : null}
    <ol aria-label="各目标发布结果" className="space-y-3">{batch.targets.map((target, index) => {
      const targetLocked = isTargetUnconfirmed(target.targetId);
      const targetStatus = stopping && ACTIVE_TARGETS.has(target.status)
        ? { label: '正在停止', tone: 'warn' as const }
        : preparing && target.status === 'failed'
        ? statusView('blocked', true)
        : target.status === 'success' && (target.observedCommitSha !== batch.commitSha || target.observationError)
        ? { label: target.observationError || !target.observedCommitSha ? '执行成功，版本待核实' : '执行成功，版本不一致', tone: target.observationError || !target.observedCommitSha ? 'warn' as const : 'bad' as const }
        : statusView(target.status, true);
      const runId = target.rollbackRunId || target.runId;
      const run = runId ? runs[runId] : undefined;
      const previousRun = target.previousReleaseId ? runs[target.previousReleaseId] : undefined;
      const progress = run ? resolveReleaseSteps(run) : undefined;
      const mismatched = Boolean(target.observedCommitSha && target.observedCommitSha !== batch.commitSha && target.status === 'success');
      const failureHint = target.error && run ? diagnoseReleaseFailure(run.logs || []).humanHint : undefined;
      const observedResult = target.observedCommitSha && target.observedCommitSha === target.previousCommitSha
        ? '实际运行版本已核实为批次前版本。'
        : target.observedCommitSha === batch.commitSha ? '实际运行版本已核实为本批次版本。'
        : target.observedCommitSha ? '实际运行版本与本批次版本不同，请先核对现场。' : '实际运行版本尚未核实，请先核对现场。';
      return <li key={target.targetId} className="cds-surface-raised min-w-0 rounded-xl border border-[hsl(var(--hairline))] p-5 md:p-6">
        <div className="flex flex-wrap items-center gap-3"><span className="text-sm text-muted-foreground">{index + 1}.</span><h4 className="min-w-0 flex-1 break-words text-lg font-semibold">{target.targetName}</h4><Chip tone={targetStatus.tone}>{targetStatus.label}</Chip></div>
        {preparing ? <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-[hsl(var(--surface-sunken))] p-4 text-sm"><span>发布前记录 <code>{(target.previousCommitSha || previousRun?.commitSha)?.slice(0, 12) || '无历史记录'}</code></span><ChevronRight className="size-4 text-muted-foreground" /><span className="font-medium">本次发布 <code>{batch.commitSha.slice(0, 12)}</code></span></div> : <div className="mt-4 space-y-2">
          <p className="text-sm text-muted-foreground">当前实际运行版本</p><p className="break-all font-mono text-xl font-semibold">{target.observationError ? '尚未核实' : target.observedCommitSha?.slice(0, 12) || '尚未核实'}</p>
          <p className="text-sm text-muted-foreground">{target.observationError ? '最近核对未成功，保留的旧记录不能作为当前现场结论。' : observedResult}</p>
        </div>}
        <div className="mt-4 grid min-w-0 gap-2 text-sm md:grid-cols-2">
          {target.observedAt ? <p className="text-muted-foreground">现场核对时间：{formatDateTime(target.observedAt)}</p> : null}
          {progress ? <p className="text-muted-foreground">执行进度：{progress.currentIndex}/{progress.total} · {progress.currentLabel}</p> : null}
          {target.attempts.length ? <p className="text-muted-foreground">本批次部署 {target.attempts.filter((attempt) => attempt.kind === 'deploy').length} 次 · 恢复 {target.attempts.filter((attempt) => attempt.kind === 'rollback').length} 次</p> : null}
        </div>
        {target.error ? <div role="alert" className="mt-2 space-y-1 text-xs"><p className="text-bad">{preparing ? '发布前检查未通过，请展开阻断项，处理后重新检查所有目标。' : failureHint || (target.status === 'rollback_failed' ? '原版本恢复未完成，请查看诊断详情，处理原因后重新恢复此目标。' : '本次操作未完成，请查看诊断详情，处理原因后重试此目标。')}</p>{!preparing ? <p className="text-muted-foreground">{observedResult}</p> : null}</div> : null}
        {target.observationError && !target.error ? <p className="mt-2 text-xs text-warn">现场版本尚未核实，请查看诊断详情后重新核对。</p> : null}
        {target.error || target.observationError ? <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">诊断详情</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[hsl(var(--surface-sunken))] p-3 text-xs text-muted-foreground">{[target.error, target.observationError].filter(Boolean).join('\n\n')}</pre></details> : null}
        {target.checks?.length ? <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">发布前检查 · {target.checks.filter((check) => check.status === 'pass').length}/{target.checks.length} 项通过</summary><ul className="mt-2 space-y-2">{target.checks.map((check) => <li key={check.id} className="min-w-0 rounded-md bg-[hsl(var(--surface-sunken))] p-2"><span className={check.status === 'fail' ? 'font-medium text-bad' : check.status === 'warn' ? 'font-medium text-warn' : 'font-medium'}>{check.status === 'fail' ? (check.blocking ? '阻断' : '未通过') : check.status === 'warn' ? '提醒' : '通过'} · {check.label}</span><p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{check.message}</p></li>)}</ul></details> : null}
        {targetLocked ? <p className="mt-3 text-sm text-warn">此目标有发布请求待核对，核对前不能再次发布或恢复原版本；日志与版本记录仍可查看。</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {runId ? <Button size="sm" variant="outline" onClick={() => onLogs(runId)}><ScrollText />发布日志</Button> : null}
          {!preparing && RETRYABLE_TARGETS.has(target.status) ? <ConfirmAction
            disabled={busy || targetLocked}
            trigger={<Button size="sm" disabled={busy || targetLocked}><RefreshCw />{batch.status === 'cancelled' || target.status === 'cancelled' ? '重新发布此目标' : '仅重试此目标'}</Button>}
            title={batch.status === 'cancelled' || target.status === 'cancelled' ? '确认重新发布已取消目标' : '确认重试此目标'}
            description={<div className="space-y-2 break-words"><p>目标：{target.targetName}</p><p>本批次固定提交：<code className="block break-all">{batch.commitSha}</code></p><p>此次只发布此目标，保留其他目标的结果。</p></div>}
            confirmLabel={batch.status === 'cancelled' || target.status === 'cancelled' ? '确认重新发布' : '确认重试'}
            cancelLabel="返回"
            onConfirm={() => onRetry(target.targetId)}
          /> : null}
          {target.previousReleaseId && target.runId && !['pending', 'checking', 'ready', 'rolled_back'].includes(target.status) ? <Button size="sm" variant="outline" disabled={busy || targetLocked} onClick={() => onPrepareRollback(target.targetId)}><RotateCcw />恢复原版本</Button> : null}
        </div>
        <details className="mt-4 text-sm text-muted-foreground"><summary className="cursor-pointer">版本记录详情</summary><div className="mt-3 space-y-2 text-xs"><p className="break-all"><span>实际运行提交：</span><code>{target.observedCommitSha || '未知，尚未核实'}</code>{mismatched ? <strong className="ml-2 text-bad">版本不一致</strong> : null}</p><p className="break-all" title={target.previousReleaseId}>批次前版本：{target.previousCommitSha || previousRun?.commitSha || target.previousReleaseId || '无可恢复的历史版本'}</p><p className="break-all">本批次固定提交：{batch.commitSha}</p></div></details>
        {rollbackTargetId === target.targetId ? <div className="mt-3 space-y-3 rounded-md border border-warn/30 bg-warn-soft p-4 text-sm"><p>将恢复至发布前版本 <code className="font-semibold">{(target.previousCommitSha || previousRun?.commitSha)?.slice(0, 12) || '历史版本（请先核对版本记录）'}</code>，只影响此目标。</p><p className="break-all text-xs text-muted-foreground">确认将「{target.targetName}」恢复到本批次开始前的版本记录 {target.previousReleaseId}？</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || targetLocked} onClick={() => onRollback(target.targetId)}>确认恢复此目标</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => onPrepareRollback('')}>返回</Button></div></div> : null}
        {target.attempts.length > 1 ? <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">全部尝试与恢复记录（{target.attempts.length}）</summary><ul className="mt-2 space-y-2">{target.attempts.map((attempt) => <li key={attempt.id} className="flex flex-wrap items-center gap-2"><span>{attempt.kind === 'rollback' ? '恢复原版本' : '发布'} · {formatDateTime(attempt.createdAt)}</span>{attempt.runId ? <button type="button" className="text-primary hover:underline" onClick={() => onLogs(attempt.runId!)}>查看日志</button> : null}{attempt.error ? <span className="break-words text-bad">{attempt.error}</span> : null}</li>)}</ul></details> : null}
      </li>;
    })}</ol>
  </div>;
}
import { RELEASE_BATCH_ACTIONS_CLASS, RELEASE_BATCH_DETAIL_CLASS, RELEASE_BATCH_SECTION_CLASS, RELEASE_BATCH_STEPS_CLASS } from '@/components/skeletons/ReleaseConsoleSkeleton';
