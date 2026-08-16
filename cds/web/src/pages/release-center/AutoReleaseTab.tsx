/**
 * 定时发布规则：到点由 CDS 自己发，不需要人在场。
 *
 * 与「自动发布规则」（AutoRulesSection，事件驱动，分支被推时发）是两种触发面，
 * 同屏上下并列。标题必须叫「定时发布规则」——两块都叫「自动发布规则」时，
 * 屏幕上会出现两个同名标题和两个「新建规则」按钮，用户分不清点哪个。
 *
 * 底座复用 scheduled-job（interval / daily / manual 调度、超时、运行记录都是现成的），
 * 这里只负责「发布到某环境」这一种动作的配置面：不另起调度器，不另起一张任务表。
 *
 * 两处刻意的保守：
 * - **需人工确认**的规则永不自动发布，到点只跑预检 + 发一条待确认通知；
 * - 立即试跑走 check-target，对 release 只跑发布前检查，**不发布**。
 */

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Loader2, Play, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import { describeDryRunResult } from '@/lib/releaseDiagnosis';
import { mergeReleaseAction } from '@/lib/scheduledJobActions';
import { Chip, formatDateTime } from './shared';
import type {
  BranchOption,
  CenterRow,
  ScheduledJobActionSummary,
  ScheduledJobRunSummary,
  ScheduledJobSummary,
} from './types';

export interface AutoReleaseTabProps {
  row: CenterRow;
  /** 同项目的其它环境，用作 promote 来源候选。 */
  otherRows: CenterRow[];
  branches: BranchOption[];
  onToast: (message: string) => void;
}

interface RuleDraft {
  id?: string;
  name: string;
  scheduleType: 'daily' | 'interval' | 'manual';
  timeOfDay: string;
  intervalMinutes: string;
  timezone: string;
  sourceKind: 'branch' | 'promote';
  branchId: string;
  fromTargetId: string;
  requireApproval: boolean;
  rollbackOnFailure: boolean;
  skipWhenUnchanged: boolean;
  dryRun: boolean;
  enabled: boolean;
}

function emptyDraft(defaults: { branchId: string; fromTargetId: string }): RuleDraft {
  return {
    name: '',
    scheduleType: 'daily',
    timeOfDay: '03:00',
    intervalMinutes: '60',
    timezone: 'Asia/Shanghai',
    sourceKind: defaults.fromTargetId ? 'promote' : 'branch',
    branchId: defaults.branchId,
    fromTargetId: defaults.fromTargetId,
    // 生产类动作默认最保守：要人点头、失败自动回滚、版本没变就别白跑一趟。
    requireApproval: true,
    rollbackOnFailure: true,
    skipWhenUnchanged: true,
    dryRun: false,
    enabled: true,
  };
}

export function AutoReleaseTab({ row, otherRows, branches, onToast }: AutoReleaseTabProps): JSX.Element {
  const [jobs, setJobs] = useState<ScheduledJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyJobId, setBusyJobId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiRequest<{ jobs: ScheduledJobSummary[] }>(
        `/api/scheduled-jobs?project=${encodeURIComponent(row.target.projectId)}`,
      );
      setJobs(res.jobs || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [row.target.projectId]);

  useEffect(() => { void load(); }, [load]);

  // 事件驱动的 push 规则归 AutoRulesSection（设计稿 §4）。不排掉的话同一条规则
  // 会在两块里各出现一次，而且在这里被当成定时规则编辑。
  const releaseJobs = jobs.filter(
    (job) => job.schedule.type !== 'push' && releaseActionOf(job, row.target.id) !== undefined,
  );

  const submit = async (): Promise<void> => {
    if (!draft) return;
    const action = buildReleaseAction(draft, row.target.id);
    if (!action) {
      onToast('请先选择版本来源：要么指定一个分支，要么指定一个来源环境');
      return;
    }
    setSaving(true);
    try {
      const nextAction = { id: 'release', name: '发布到环境', ...action };
      // 编辑既有规则时必须把兄弟动作原样带回——判据见 mergeReleaseAction。
      const editing = draft.id ? jobs.find((job) => job.id === draft.id) : undefined;
      const body = {
        projectId: row.target.projectId,
        name: draft.name.trim() || defaultRuleName(draft, row),
        enabled: draft.enabled,
        schedule: buildSchedule(draft),
        actions: mergeReleaseAction(editing?.actions, row.target.id, nextAction),
      };
      if (draft.id) {
        await apiRequest(`/api/scheduled-jobs/${encodeURIComponent(draft.id)}`, { method: 'PATCH', body });
        onToast('定时发布规则已更新');
      } else {
        await apiRequest('/api/scheduled-jobs', { method: 'POST', body });
        onToast('定时发布规则已创建');
      }
      setDraft(null);
      await load();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (job: ScheduledJobSummary): Promise<void> => {
    setBusyJobId(job.id);
    try {
      await apiRequest(`/api/scheduled-jobs/${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        body: { enabled: !job.enabled },
      });
      await load();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyJobId('');
    }
  };

  const dryRun = async (job: ScheduledJobSummary): Promise<void> => {
    const action = releaseActionOf(job, row.target.id);
    if (!action) return;
    setBusyJobId(job.id);
    try {
      const res = await apiRequest<{ result: { ok?: boolean; error?: string; log?: string } }>(
        '/api/scheduled-jobs/check-target',
        { method: 'POST', body: { projectId: row.target.projectId, target: action } },
      );
      onToast(describeDryRunResult(res.result));
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyJobId('');
    }
  };

  const remove = async (job: ScheduledJobSummary): Promise<void> => {
    setBusyJobId(job.id);
    try {
      await apiRequest(`/api/scheduled-jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      onToast('定时发布规则已删除');
      await load();
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusyJobId('');
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">定时发布规则</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            按时间触发，与上面的事件规则各走各的。需人工确认的规则永不自动发布，只会到点跑一次预检并通知你。
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setDraft(emptyDraft({
            branchId: branches[0]?.id || '',
            fromTargetId: otherRows[0]?.target.id || '',
          }))}
        >
          <Plus />
          新建定时规则
        </Button>
      </div>

      {draft ? (
        <RuleForm
          draft={draft}
          row={row}
          otherRows={otherRows}
          branches={branches}
          saving={saving}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSubmit={() => void submit()}
        />
      ) : null}

      {loading ? (
        <div className="cds-surface-raised cds-hairline flex items-center gap-2 rounded-lg px-4 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在读取定时发布规则
        </div>
      ) : error ? (
        <div className="cds-surface-raised cds-hairline rounded-lg px-4 py-8 text-sm text-muted-foreground">
          规则列表暂时读不到：{error}
        </div>
      ) : releaseJobs.length === 0 ? (
        <div className="cds-surface-raised cds-hairline rounded-lg px-4 py-10 text-center">
          <p className="text-sm font-medium">这个环境还没有定时发布规则</p>
          <p className="mx-auto mt-1.5 max-w-lg text-xs text-muted-foreground">
            典型用法：生产环境「每天固定时间把预发这一版发上来，但需要人点头」。分支一有提交就发那种，用上面的事件规则。
          </p>
        </div>
      ) : (
        <section className="cds-surface-raised cds-hairline overflow-hidden rounded-lg">
          {releaseJobs.map((job) => (
            <RuleRow
              key={job.id}
              job={job}
              action={releaseActionOf(job, row.target.id)!}
              row={row}
              otherRows={otherRows}
              busy={busyJobId === job.id}
              onToggle={() => void toggle(job)}
              onDryRun={() => void dryRun(job)}
              onEdit={() => setDraft(draftFromJob(job, row.target.id, branches[0]?.id || '', otherRows[0]?.target.id || ''))}
              onDelete={() => void remove(job)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function RuleRow({
  job,
  action,
  row,
  otherRows,
  busy,
  onToggle,
  onDryRun,
  onEdit,
  onDelete,
}: {
  job: ScheduledJobSummary;
  action: ScheduledJobActionSummary;
  row: CenterRow;
  otherRows: CenterRow[];
  busy: boolean;
  onToggle: () => void;
  onDryRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3.5 last:border-b-0 md:grid-cols-[auto_minmax(0,1fr)_auto]">
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        aria-label={job.enabled ? '停用规则' : '启用规则'}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
          job.enabled ? 'bg-primary' : 'bg-[hsl(var(--hairline-strong))]'
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${job.enabled ? 'left-[18px]' : 'left-0.5'}`}
        />
      </button>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-semibold">{job.name}</span>
          <Chip>{scheduleText(job)}</Chip>
          {action.requireApproval ? <Chip tone="warn">需人工确认</Chip> : null}
          {action.dryRun ? <Chip>仅预检</Chip> : null}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          发到 {row.target.name} · {sourceText(action, otherRows)}
          {action.rollbackOnFailure ? ' · 失败自动回滚' : ''}
          {action.skipWhenUnchanged ? ' · 版本未变则跳过' : ''}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {job.lastRunAt ? `上次运行 ${formatDateTime(job.lastRunAt)} · ${job.lastRunStatus || '-'}` : '还没有运行过'}
          {job.enabled && job.nextRunAt ? ` · 下次 ${formatDateTime(job.nextRunAt)}` : ''}
          {typeof job.consecutiveFailureCount === 'number' && job.consecutiveFailureCount > 0
            ? ` · 已连续失败 ${job.consecutiveFailureCount} 次`
            : ''}
        </div>
        {job.autoDisabledReason ? (
          <div className="mt-1.5 rounded-md border border-warn/35 bg-warn-soft px-2.5 py-1.5 text-[11.5px] text-warn">
            已被系统自动停用：{job.autoDisabledReason}
          </div>
        ) : null}
        <JobRuns jobId={job.id} />
      </div>
      <div className="col-start-2 flex flex-wrap gap-2 md:col-start-3">
        <Button size="sm" variant="outline" onClick={onDryRun} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />}
          立即试跑
        </Button>
        <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>编辑</Button>
        <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>
          <Trash2 />
          删除
        </Button>
      </div>
    </div>
  );
}

function JobRuns({ jobId }: { jobId: string }): JSX.Element {
  const [runs, setRuns] = useState<ScheduledJobRunSummary[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || runs !== null) return;
    apiRequest<{ runs: ScheduledJobRunSummary[] }>(
      `/api/scheduled-jobs/runs?jobId=${encodeURIComponent(jobId)}&limit=10`,
    )
      .then((res) => setRuns(res.runs || []))
      .catch(() => setRuns([]));
  }, [open, runs, jobId]);

  return (
    <details className="mt-2" onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary className="inline-flex cursor-pointer items-center gap-1 text-[11.5px] text-muted-foreground">
        <ChevronDown className="h-3.5 w-3.5" />
        运行记录
      </summary>
      {runs === null ? (
        <div className="mt-1.5 text-[11.5px] text-muted-foreground">正在读取…</div>
      ) : runs.length === 0 ? (
        <div className="mt-1.5 text-[11.5px] text-muted-foreground">还没有运行记录。</div>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1">
          {runs.map((run) => (
            <li key={run.id} className="text-[11.5px] text-muted-foreground">
              {formatDateTime(run.startedAt || run.queuedAt)} · {run.status}
              {run.releaseStatus ? ` · 发布 ${run.releaseStatus}` : ''}
              {run.error ? ` · ${run.error}` : ''}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function RuleForm({
  draft,
  row,
  otherRows,
  branches,
  saving,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: RuleDraft;
  row: CenterRow;
  otherRows: CenterRow[];
  branches: BranchOption[];
  saving: boolean;
  onChange: (draft: RuleDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): JSX.Element {
  const set = (patch: Partial<RuleDraft>): void => onChange({ ...draft, ...patch });
  return (
    <section className="cds-surface-raised cds-hairline rounded-lg p-4">
      <h4 className="text-sm font-semibold">{draft.id ? '编辑定时发布规则' : '新建定时发布规则'}</h4>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">规则名称</span>
          <input
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
            placeholder={defaultRuleName(draft, row)}
            className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">调度</span>
          <select
            value={draft.scheduleType}
            onChange={(event) => set({ scheduleType: event.target.value as RuleDraft['scheduleType'] })}
            className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
          >
            <option value="daily">每天固定时间</option>
            <option value="interval">每隔一段时间</option>
            <option value="manual">只手动触发</option>
          </select>
        </label>
        {draft.scheduleType === 'daily' ? (
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">时间（{draft.timezone}）</span>
            <input
              value={draft.timeOfDay}
              onChange={(event) => set({ timeOfDay: event.target.value })}
              placeholder="03:00"
              className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 font-mono text-sm outline-none focus:border-primary/60"
            />
          </label>
        ) : null}
        {draft.scheduleType === 'interval' ? (
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">间隔（分钟）</span>
            <input
              value={draft.intervalMinutes}
              onChange={(event) => set({ intervalMinutes: event.target.value })}
              className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 font-mono text-sm outline-none focus:border-primary/60"
            />
          </label>
        ) : null}
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">版本来源</span>
          <select
            value={draft.sourceKind}
            onChange={(event) => set({ sourceKind: event.target.value as RuleDraft['sourceKind'] })}
            className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
          >
            <option value="promote">提升另一个环境正在跑的那一版</option>
            <option value="branch">发某个分支的最新版</option>
          </select>
        </label>
        {draft.sourceKind === 'promote' ? (
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">来源环境</span>
            <select
              value={draft.fromTargetId}
              onChange={(event) => set({ fromTargetId: event.target.value })}
              className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
            >
              <option value="">请选择</option>
              {otherRows.map((other) => (
                <option key={other.target.id} value={other.target.id}>{other.target.name}</option>
              ))}
            </select>
          </label>
        ) : (
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">分支</span>
            <select
              value={draft.branchId}
              onChange={(event) => set({ branchId: event.target.value })}
              className="h-9 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-sm outline-none focus:border-primary/60"
            >
              <option value="">请选择</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.branch}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <Toggle label="需人工确认后才发布" checked={draft.requireApproval} onChange={(v) => set({ requireApproval: v })} />
        <Toggle label="失败自动回滚" checked={draft.rollbackOnFailure} onChange={(v) => set({ rollbackOnFailure: v })} />
        <Toggle label="版本未变则跳过" checked={draft.skipWhenUnchanged} onChange={(v) => set({ skipWhenUnchanged: v })} />
        <Toggle label="只跑预检不发布" checked={draft.dryRun} onChange={(v) => set({ dryRun: v })} />
        <Toggle label="创建后立即启用" checked={draft.enabled} onChange={(v) => set({ enabled: v })} />
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-[hsl(var(--hairline))] pt-3">
        <Button variant="outline" onClick={onCancel} disabled={saving}>取消</Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          保存规则
        </Button>
      </div>
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }): JSX.Element {
  return (
    <label className="inline-flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** 一个 job 里发到本目标的那个 release 动作。找不到即「这条规则与本环境无关」。 */
export function releaseActionOf(job: ScheduledJobSummary, targetId: string): ScheduledJobActionSummary | undefined {
  const actions = job.actions && job.actions.length > 0 ? job.actions : job.target ? [job.target] : [];
  return actions.find((action) => action.type === 'release' && action.targetId === targetId);
}

export function scheduleText(job: ScheduledJobSummary): string {
  const tz = job.schedule.timezone || 'Asia/Shanghai';
  if (job.schedule.type === 'daily') return `每天 ${job.schedule.timeOfDay || '--:--'} ${tz}`;
  if (job.schedule.type === 'interval') return `每 ${job.schedule.intervalMinutes || '-'} 分钟`;
  return '仅手动触发';
}

function sourceText(action: ScheduledJobActionSummary, otherRows: CenterRow[]): string {
  const source = action.source;
  if (source?.kind === 'promote') {
    const from = otherRows.find((row) => row.target.id === source.fromTargetId);
    return `提升 ${from?.target.name || source.fromTargetId} 正在跑的版本`;
  }
  if (source?.kind === 'branch') return `分支 ${source.branchId} 的最新版`;
  return '版本来源未配置';
}

function defaultRuleName(draft: RuleDraft, row: CenterRow): string {
  if (draft.sourceKind === 'promote') return `定时提升到${row.target.name}`;
  return `定时发布到${row.target.name}`;
}

function buildSchedule(draft: RuleDraft): Record<string, unknown> {
  if (draft.scheduleType === 'daily') {
    return { type: 'daily', timeOfDay: draft.timeOfDay.trim() || '03:00', timezone: draft.timezone };
  }
  if (draft.scheduleType === 'interval') {
    return { type: 'interval', intervalMinutes: Number(draft.intervalMinutes) || 60, timezone: draft.timezone };
  }
  return { type: 'manual', timezone: draft.timezone };
}

/** 来源没选全就返回 undefined：宁可不让保存，也不能存一条来源不明的发布规则。 */
function buildReleaseAction(draft: RuleDraft, targetId: string): ScheduledJobActionSummary | undefined {
  if (draft.sourceKind === 'promote') {
    if (!draft.fromTargetId) return undefined;
    return {
      type: 'release',
      targetId,
      source: { kind: 'promote', fromTargetId: draft.fromTargetId },
      dryRun: draft.dryRun,
      requireApproval: draft.requireApproval,
      rollbackOnFailure: draft.rollbackOnFailure,
      skipWhenUnchanged: draft.skipWhenUnchanged,
    };
  }
  if (!draft.branchId) return undefined;
  return {
    type: 'release',
    targetId,
    source: { kind: 'branch', branchId: draft.branchId },
    dryRun: draft.dryRun,
    requireApproval: draft.requireApproval,
    rollbackOnFailure: draft.rollbackOnFailure,
    skipWhenUnchanged: draft.skipWhenUnchanged,
  };
}

function draftFromJob(
  job: ScheduledJobSummary,
  targetId: string,
  fallbackBranchId: string,
  fallbackFromTargetId: string,
): RuleDraft {
  const action = releaseActionOf(job, targetId);
  return {
    id: job.id,
    name: job.name,
    // 这个编辑器只管定时调度；push 规则归 AutoRulesSection，本页不列它们。
    // 真被喂进来（列表过滤漏了）时退回 manual，不把一条事件规则改写成定时规则。
    scheduleType: job.schedule.type === 'push' ? 'manual' : job.schedule.type,
    timeOfDay: job.schedule.timeOfDay || '03:00',
    intervalMinutes: String(job.schedule.intervalMinutes || 60),
    timezone: job.schedule.timezone || 'Asia/Shanghai',
    sourceKind: action?.source?.kind === 'branch' ? 'branch' : 'promote',
    branchId: action?.source?.kind === 'branch' ? action.source.branchId : fallbackBranchId,
    fromTargetId: action?.source?.kind === 'promote' ? action.source.fromTargetId : fallbackFromTargetId,
    requireApproval: action?.requireApproval === true,
    rollbackOnFailure: action?.rollbackOnFailure === true,
    skipWhenUnchanged: action?.skipWhenUnchanged === true,
    dryRun: action?.dryRun === true,
    enabled: job.enabled,
  };
}
