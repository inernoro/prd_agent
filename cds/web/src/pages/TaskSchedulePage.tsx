import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, CalendarClock, Globe2, Pencil, Play, Plus, RefreshCw, Save, SlidersHorizontal, Terminal, Trash2, type LucideIcon } from 'lucide-react';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api';
import { parseCurlCommand } from '@/lib/curl-import';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';

type ScheduleType = 'manual' | 'interval' | 'daily';
type TargetType = 'http' | 'command';
type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'skipped';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface ProjectLite {
  id: string;
  name: string;
  slug?: string;
  aliasName?: string;
}

interface ScheduledJob {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: { type: ScheduleType; intervalMinutes?: number; timeOfDay?: string; timezone?: string };
  target?: ScheduledJobTarget;
  actions?: ScheduledJobAction[];
  timeoutSeconds: number;
  retryCount: number;
  lastRunAt?: string;
  lastRunStatus?: RunStatus;
  nextRunAt?: string | null;
}

interface ScheduledJobTarget {
  type: TargetType;
  method?: HttpMethod;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  command?: string;
  cwd?: string;
}

interface ScheduledJobAction extends ScheduledJobTarget {
  id: string;
  name?: string;
}

interface ActionForm {
  id: string;
  name: string;
  type: TargetType;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body: string;
  command: string;
  cwd: string;
  targetType: TargetType;
  headersJson: string;
}

interface ScheduledJobRun {
  id: string;
  jobId: string;
  projectId: string;
  trigger: 'schedule' | 'manual';
  status: RunStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  httpStatus?: number;
  log?: string;
  error?: string;
}

interface TargetCheckResult {
  ok: boolean;
  exitCode?: number;
  httpStatus?: number;
  log: string;
  error?: string;
}

type FormState = {
  id?: string;
  projectId: string;
  name: string;
  description: string;
  enabled: boolean;
  scheduleType: ScheduleType;
  intervalMinutes: string;
  timeOfDay: string;
  timezone: string;
  actions: ActionForm[];
  timeoutSeconds: string;
  retryCount: string;
};

type ActionDraft = ActionForm;
type ActionLike = Pick<ActionForm, 'targetType' | 'method' | 'url' | 'command' | 'name'>;

const emptyForm = (projectId = ''): FormState => ({
  projectId,
  name: '',
  description: '',
  enabled: true,
  scheduleType: 'daily',
  intervalMinutes: '60',
  timeOfDay: '02:00',
  timezone: 'Asia/Shanghai',
  actions: [],
  timeoutSeconds: '300',
  retryCount: '0',
});

const emptyAction = (): ActionForm => ({
  id: `action_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
  name: '',
  type: 'http',
  targetType: 'http',
  method: 'POST',
  url: '',
  headersJson: '{}',
  body: '',
  command: '',
  cwd: '',
});

const textareaClass = 'w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring';
const compactInputClass = 'h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring';
const segmentClass = 'inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors';

export function TaskSchedulePage(): JSX.Element {
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [runs, setRuns] = useState<ScheduledJobRun[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [actionDialogOpen, setActionDialogOpen] = useState(false);
  const [editingActionIndex, setEditingActionIndex] = useState<number | null>(null);
  const [actionDraft, setActionDraft] = useState<ActionDraft>(() => emptyAction());
  const [curlInput, setCurlInput] = useState('');
  const [actionError, setActionError] = useState('');
  const [checkingAction, setCheckingAction] = useState(false);
  const [checkResult, setCheckResult] = useState<TargetCheckResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [projectRes, jobRes, runRes] = await Promise.all([
        apiRequest<{ projects?: ProjectLite[] }>('/api/projects'),
        apiRequest<{ jobs: ScheduledJob[] }>('/api/scheduled-jobs'),
        apiRequest<{ runs: ScheduledJobRun[] }>('/api/scheduled-jobs/runs?limit=100'),
      ]);
      const nextProjects = projectRes.projects || [];
      setProjects(nextProjects);
      setJobs(jobRes.jobs || []);
      setRuns(runRes.runs || []);
      setForm((prev) => prev.projectId ? prev : emptyForm(nextProjects[0]?.id || ''));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  const projectName = useCallback((projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    return project ? (project.aliasName || project.name || project.slug || project.id) : projectId;
  }, [projects]);

  const selectedRuns = useMemo(() => {
    if (!selectedId) return runs;
    return runs.filter((run) => run.jobId === selectedId);
  }, [runs, selectedId]);

  const selectJob = (job: ScheduledJob): void => {
    setSelectedId(job.id);
    setForm(jobToForm(job));
  };

  const newJob = (): void => {
    setSelectedId('');
    setForm(emptyForm(projects[0]?.id || ''));
  };

  const openActionDialog = (index: number | null = null): void => {
    setEditingActionIndex(index);
    setActionDraft(index === null ? emptyAction() : { ...form.actions[index] });
    setCurlInput('');
    setActionError('');
    setCheckResult(null);
    setActionDialogOpen(true);
  };

  const applyActionDraft = (): void => {
    try {
      targetPayloadFromAction(actionDraft);
    } catch (err) {
      setActionError((err as Error).message);
      return;
    }
    setForm((prev) => {
      const actions = [...prev.actions];
      if (editingActionIndex === null) actions.push(actionDraft);
      else actions[editingActionIndex] = actionDraft;
      return { ...prev, actions };
    });
    setActionDialogOpen(false);
  };

  const moveAction = (index: number, direction: -1 | 1): void => {
    setForm((prev) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.actions.length) return prev;
      const actions = [...prev.actions];
      const [item] = actions.splice(index, 1);
      actions.splice(nextIndex, 0, item);
      return { ...prev, actions };
    });
  };

  const deleteAction = (index: number): void => {
    setForm((prev) => ({ ...prev, actions: prev.actions.filter((_, i) => i !== index) }));
  };

  const importCurl = (): void => {
    try {
      const imported = parseCurlCommand(curlInput);
      setActionDraft({
        ...actionDraft,
        type: 'http',
        targetType: 'http',
        method: imported.method,
        url: imported.url,
        headersJson: JSON.stringify(imported.headers, null, 2),
        body: imported.body,
      });
      setActionError('');
      setCheckResult(null);
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const checkAction = async (): Promise<void> => {
    if (!form.projectId) {
      setActionError('请先选择所属项目');
      return;
    }
    setCheckingAction(true);
    setActionError('');
    setCheckResult(null);
    try {
      const target = targetPayloadFromAction(actionDraft);
      const res = await apiRequest<{ result: TargetCheckResult }>('/api/scheduled-jobs/check-target', {
        method: 'POST',
        body: {
          projectId: form.projectId,
          target,
          timeoutSeconds: Number(form.timeoutSeconds) || 30,
        },
      });
      setCheckResult(res.result);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setCheckingAction(false);
    }
  };

  const saveJob = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      const payload = formToPayload(form);
      const res = form.id
        ? await apiRequest<{ job: ScheduledJob }>(`/api/scheduled-jobs/${encodeURIComponent(form.id)}`, { method: 'PATCH', body: payload })
        : await apiRequest<{ job: ScheduledJob }>('/api/scheduled-jobs', { method: 'POST', body: payload });
      setToast(form.id ? '任务已更新' : '任务已创建');
      setSelectedId(res.job.id);
      setForm(jobToForm(res.job));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deleteJob = async (): Promise<void> => {
    if (!form.id) return;
    if (!window.confirm(`删除任务 "${form.name}"?`)) return;
    setSaving(true);
    try {
      await apiRequest(`/api/scheduled-jobs/${encodeURIComponent(form.id)}`, { method: 'DELETE' });
      setToast('任务已删除');
      newJob();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runNow = async (jobId: string): Promise<void> => {
    setRunningId(jobId);
    setError('');
    try {
      await apiRequest(`/api/scheduled-jobs/${encodeURIComponent(jobId)}/run`, { method: 'POST' });
      setToast('手动执行已完成');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunningId('');
    }
  };

  return (
    <AppShell
      active="task-schedule"
      wide
      topbar={(
        <TopBar
          left={(
            <>
              <Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '任务调度' }]} />
            </>
          )}
          right={(
            <>
              <PaletteHint />
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw className="h-4 w-4" />
                刷新
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace className="min-h-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-normal">任务调度</h1>
            <p className="mt-1 text-xs text-muted-foreground">项目级定时任务，调度交给 CDS，业务逻辑留在接口或脚本里。</p>
          </div>
          <Button size="sm" onClick={newJob}>
            <Plus className="h-4 w-4" />
            新建任务
          </Button>
        </div>

        {error ? <ErrorBlock message={error} /> : null}
        {toast ? (
          <div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            {toast}
          </div>
        ) : null}

        {loading ? <LoadingBlock label="加载任务调度配置" /> : (
          <div className="grid min-h-0 gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <section className="min-h-0 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]">
              <div className="flex items-center justify-between border-b border-[hsl(var(--hairline))] px-4 py-3">
                <div className="text-sm font-semibold">全部任务</div>
                <span className="text-xs text-muted-foreground">{jobs.length} 个</span>
              </div>
              <div className="max-h-[660px] overflow-auto p-2">
                {jobs.length === 0 ? (
                  <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
                    <CalendarClock className="h-9 w-9 opacity-60" />
                    <div>还没有定时任务。新建一个任务后，可以每天定时调用接口或执行命令。</div>
                  </div>
                ) : jobs.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => selectJob(job)}
                    className={`mb-2 w-full rounded-md border px-3 py-3 text-left transition-colors ${selectedId === job.id ? 'border-primary bg-primary/10' : 'border-[hsl(var(--hairline))] bg-background hover:border-primary/50'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-sm font-semibold">{job.name}</span>
                      <StatusBadge status={job.lastRunStatus} enabled={job.enabled} />
                    </div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{projectName(job.projectId)} · {scheduleLabel(job)}</div>
                    <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="truncate">下次 {formatTime(job.nextRunAt)}</span>
                      <span className="shrink-0">{targetLabel(job)}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <div className="min-h-0 space-y-3">
              <section className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] p-4">
                <div className="mb-4 flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] pb-3">
                  <div>
                    <div className="text-sm font-semibold">{form.id ? '编辑任务' : '新建任务'}</div>
                    <div className="text-xs text-muted-foreground">触发器启动任务，动作按顺序执行。</div>
                  </div>
                  <div className="flex gap-2">
                    {form.id ? (
                      <Button variant="outline" size="sm" onClick={() => void runNow(form.id!)} disabled={runningId === form.id}>
                        <Play className="h-4 w-4" />
                        {runningId === form.id ? '执行中' : '立即执行'}
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => void saveJob()} disabled={saving || !form.projectId || !form.name || form.actions.length === 0}>
                      <Save className="h-4 w-4" />
                      {saving ? '保存中' : '保存'}
                    </Button>
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  <Field label="所属项目">
                    <select className={compactInputClass} value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} disabled={Boolean(form.id)}>
                      <option value="">选择项目</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>{projectName(project.id)}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="任务名称">
                    <input className={compactInputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="生码统计同步" />
                  </Field>
                </div>

                <section className="mt-4 rounded-md border border-[hsl(var(--hairline))] bg-background p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">触发器</div>
                      <div className="text-xs text-muted-foreground">{scheduleLabelFromForm(form)}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <SegmentButton icon={CalendarClock} label="每天" active={form.scheduleType === 'daily'} onClick={() => setForm({ ...form, scheduleType: 'daily' })} />
                    <SegmentButton icon={RefreshCw} label="间隔" active={form.scheduleType === 'interval'} onClick={() => setForm({ ...form, scheduleType: 'interval' })} />
                    <SegmentButton icon={Play} label="手动" active={form.scheduleType === 'manual'} onClick={() => setForm({ ...form, scheduleType: 'manual' })} />
                  </div>
                  <div className="mt-3 max-w-sm">
                    {form.scheduleType === 'daily' ? (
                      <Field label="执行时间">
                        <input className={compactInputClass} type="time" value={form.timeOfDay} onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })} />
                      </Field>
                    ) : null}
                    {form.scheduleType === 'interval' ? (
                      <Field label="间隔分钟">
                        <input className={compactInputClass} value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })} inputMode="numeric" />
                      </Field>
                    ) : null}
                    {form.scheduleType === 'manual' ? (
                      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs text-muted-foreground">
                        保存后通过“立即执行”触发。
                      </div>
                    ) : null}
                  </div>
                </section>

                <section className="mt-3 rounded-md border border-[hsl(var(--hairline))] bg-background p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">动作步骤</div>
                      <div className="text-xs text-muted-foreground">{form.actions.length} 个动作，按列表顺序执行。</div>
                    </div>
                    <Button type="button" size="sm" onClick={() => openActionDialog()}>
                      <Plus className="h-4 w-4" />
                      添加动作
                    </Button>
                  </div>
                  {form.actions.length === 0 ? (
                    <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-4 py-8 text-center text-sm text-muted-foreground">
                      还没有动作。添加 HTTP 调用或命令脚本后，任务触发时会从第 1 步开始执行。
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {form.actions.map((action, index) => (
                        <div key={action.id} className="flex items-center gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/30 px-3 py-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-[hsl(var(--hairline))] bg-background text-xs font-semibold">
                            {index + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-sm font-medium">
                              {action.targetType === 'http' ? <Globe2 className="h-4 w-4 text-muted-foreground" /> : <Terminal className="h-4 w-4 text-muted-foreground" />}
                              <span className="truncate">{actionTitle(action)}</span>
                            </div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">{actionDescription(action)}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <IconButton label="上移" disabled={index === 0} onClick={() => moveAction(index, -1)} icon={ArrowUp} />
                            <IconButton label="下移" disabled={index === form.actions.length - 1} onClick={() => moveAction(index, 1)} icon={ArrowDown} />
                            <IconButton label="编辑" onClick={() => openActionDialog(index)} icon={Pencil} />
                            <IconButton label="删除" onClick={() => deleteAction(index)} icon={Trash2} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <details className="mt-4 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45">
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground">
                    <SlidersHorizontal className="h-3.5 w-3.5" />
                    更多设置
                  </summary>
                  <div className="grid gap-3 border-t border-[hsl(var(--hairline))] p-3 lg:grid-cols-2">
                    <Field label="启用状态">
                      <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                        {form.enabled ? '已启用' : '已停用'}
                      </label>
                    </Field>
                    <Field label="超时秒数">
                      <input className={compactInputClass} value={form.timeoutSeconds} onChange={(e) => setForm({ ...form, timeoutSeconds: e.target.value })} inputMode="numeric" />
                    </Field>
                    <Field label="重试次数">
                      <input className={compactInputClass} value={form.retryCount} onChange={(e) => setForm({ ...form, retryCount: e.target.value })} inputMode="numeric" />
                    </Field>
                    <Field label="时区">
                      <input className={compactInputClass} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
                    </Field>
                    <Field label="说明" className="lg:col-span-2">
                      <textarea className={`${textareaClass} min-h-16`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="说明这个任务拉取什么数据、写入哪里。" />
                    </Field>
                  </div>
                </details>

                {form.id ? (
                  <div className="mt-3 flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => void deleteJob()} disabled={saving} className="text-destructive hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                      删除任务
                    </Button>
                  </div>
                ) : null}
              </section>

              <details className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold">
                  <span>运行记录</span>
                  <span className="text-xs font-normal text-muted-foreground">{selectedRuns.length} 条</span>
                </summary>
                <div className="max-h-[720px] overflow-auto p-3">
                  {selectedRuns.length === 0 ? (
                    <div className="flex min-h-24 items-center justify-center text-center text-sm text-muted-foreground">
                      还没有运行记录。
                    </div>
                  ) : selectedRuns.map((run) => (
                    <div key={run.id} className="mb-3 rounded-md border border-[hsl(var(--hairline))] bg-background p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold">{runStatusLabel(run.status)}</span>
                        <span className="text-xs text-muted-foreground">{formatTime(run.startedAt || run.queuedAt)}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {run.trigger === 'manual' ? '手动触发' : '定时触发'}
                        {run.durationMs !== undefined ? ` · ${Math.round(run.durationMs / 1000)} 秒` : ''}
                        {run.httpStatus ? ` · HTTP ${run.httpStatus}` : ''}
                        {run.exitCode !== undefined ? ` · exit ${run.exitCode}` : ''}
                      </div>
                      {run.error ? <div className="mt-2 text-xs text-destructive">{run.error}</div> : null}
                      {run.log ? (
                        <details className="mt-2 rounded-md bg-[hsl(var(--surface-sunken))]">
                          <summary className="cursor-pointer px-2 py-1.5 text-xs text-muted-foreground">查看日志</summary>
                          <pre className="max-h-44 overflow-auto whitespace-pre-wrap border-t border-[hsl(var(--hairline))] p-2 font-mono text-[11px] leading-5 text-muted-foreground">
                            {run.log}
                          </pre>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          </div>
        )}
        <Dialog open={actionDialogOpen} onOpenChange={setActionDialogOpen}>
          <DialogContent className="max-w-none" style={{ width: 'min(760px, calc(100vw - 32px))' }}>
            <DialogHeader>
              <DialogTitle>{editingActionIndex === null ? '添加动作' : '编辑动作'}</DialogTitle>
              <DialogDescription>HTTP 会调用 CDS 能访问的接口，命令脚本会在独立 sandbox 工作区内执行。多个动作按列表顺序执行。</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <SegmentButton icon={Globe2} label="HTTP 接口" active={actionDraft.targetType === 'http'} onClick={() => setActionDraft({ ...actionDraft, type: 'http', targetType: 'http' })} />
                <SegmentButton icon={Terminal} label="命令脚本" active={actionDraft.targetType === 'command'} onClick={() => setActionDraft({ ...actionDraft, type: 'command', targetType: 'command' })} />
              </div>

              <Field label="动作名称">
                <input className={compactInputClass} value={actionDraft.name} onChange={(e) => setActionDraft({ ...actionDraft, name: e.target.value })} placeholder={actionDraft.targetType === 'http' ? '调用旧总后台接口' : '清洗同步数据'} />
              </Field>

              {actionDraft.targetType === 'http' ? (
                <div className="space-y-3">
                  <details className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45">
                    <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">从 curl 导入</summary>
                    <div className="space-y-2 border-t border-[hsl(var(--hairline))] p-3">
                      <textarea
                        className={`${textareaClass} min-h-24 font-mono`}
                        value={curlInput}
                        onChange={(e) => setCurlInput(e.target.value)}
                        placeholder="curl -X POST 'https://example.com/api/sync' -H 'Content-Type: application/json' --data-raw '{&quot;date&quot;:&quot;2026-06-29&quot;}'"
                      />
                      <div className="flex justify-end">
                        <Button type="button" variant="outline" size="sm" onClick={importCurl} disabled={!curlInput.trim()}>
                          导入 curl
                        </Button>
                      </div>
                    </div>
                  </details>
                  <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-3">
                    <Field label="方法">
                      <select className={compactInputClass} value={actionDraft.method} onChange={(e) => setActionDraft({ ...actionDraft, method: e.target.value as HttpMethod })}>
                        {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => <option key={method} value={method}>{method}</option>)}
                      </select>
                    </Field>
                    <Field label="URL">
                      <input className={`${compactInputClass} font-mono`} value={actionDraft.url} onChange={(e) => setActionDraft({ ...actionDraft, url: e.target.value })} placeholder="/api/internal/sync" />
                    </Field>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Headers JSON">
                      <textarea className={`${textareaClass} min-h-24 font-mono`} value={actionDraft.headersJson} onChange={(e) => setActionDraft({ ...actionDraft, headersJson: e.target.value })} />
                    </Field>
                    <Field label="Body">
                      <textarea className={`${textareaClass} min-h-24 font-mono`} value={actionDraft.body} onChange={(e) => setActionDraft({ ...actionDraft, body: e.target.value })} />
                    </Field>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <Field label="命令">
                    <textarea className={`${textareaClass} min-h-28 font-mono`} value={actionDraft.command} onChange={(e) => setActionDraft({ ...actionDraft, command: e.target.value })} placeholder="echo sync-start" />
                  </Field>
                  <Field label="工作目录">
                    <input className={`${compactInputClass} font-mono`} value={actionDraft.cwd} onChange={(e) => setActionDraft({ ...actionDraft, cwd: e.target.value })} placeholder="sandbox 内相对路径，留空为 work 根目录" />
                  </Field>
                  <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs text-muted-foreground">
                    命令不会在仓库根目录执行。每个任务会进入自己的 sandbox，工作目录只允许填写相对路径。
                  </div>
                </div>
              )}

              {actionError ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {actionError}
                </div>
              ) : null}

              {checkResult ? (
                <div className={`rounded-md border px-3 py-2 text-sm ${checkResult.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}>
                  <div className="font-medium">
                    {checkResult.ok ? '检测通过' : '检测失败'}
                    {checkResult.httpStatus ? ` · HTTP ${checkResult.httpStatus}` : ''}
                    {checkResult.exitCode !== undefined ? ` · exit ${checkResult.exitCode}` : ''}
                  </div>
                  {checkResult.error ? <div className="mt-1 text-xs">{checkResult.error}</div> : null}
                  {checkResult.log ? (
                    <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded bg-background/60 p-2 font-mono text-[11px] leading-5">
                      {checkResult.log}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setActionDialogOpen(false)}>取消</Button>
              <Button type="button" variant="outline" onClick={() => void checkAction()} disabled={!hasActionConfigured(actionDraft) || checkingAction}>
                {checkingAction ? '检测中' : '检测'}
              </Button>
              <Button type="button" onClick={applyActionDraft} disabled={!hasActionConfigured(actionDraft)}>
                保存动作
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Workspace>
    </AppShell>
  );
}

function SegmentButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`${segmentClass} ${active ? 'border-primary bg-primary/10 text-primary' : 'border-[hsl(var(--hairline))] bg-background text-muted-foreground hover:text-foreground'}`}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function IconButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[hsl(var(--hairline))] bg-background text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function hasActionConfigured(action: ActionLike): boolean {
  return action.targetType === 'http' ? Boolean(action.url.trim()) : Boolean(action.command.trim());
}

function actionTitle(action: ActionLike): string {
  return action.name.trim() || (action.targetType === 'http' ? '调用 HTTP 接口' : '执行命令脚本');
}

function actionDescription(action: ActionLike): string {
  if (action.targetType === 'http') return `${action.method} ${action.url}`;
  return action.command.split('\n')[0] || '命令脚本';
}

function targetPayloadFromAction(action: ActionDraft): ScheduledJobTarget {
  if (action.targetType === 'command') {
    if (!action.command.trim()) throw new Error('命令必填');
    if (action.cwd.trim() && !isSafeRelativeCwd(action.cwd)) throw new Error('工作目录必须是 sandbox 内的相对路径');
    return { type: 'command', command: action.command, cwd: action.cwd };
  }

  if (!action.url.trim()) throw new Error('HTTP URL 必填');
  let headers: Record<string, string> = {};
  if (action.headersJson.trim()) {
    headers = JSON.parse(action.headersJson) as Record<string, string>;
  }
  return {
    type: 'http',
    method: action.method,
    url: action.url,
    headers,
    body: action.body,
  };
}

function actionPayloadFromForm(action: ActionForm): ScheduledJobAction {
  const target = targetPayloadFromAction(action);
  return {
    ...target,
    id: action.id,
    name: action.name.trim() || actionTitle(action),
  };
}

function isSafeRelativeCwd(cwd: string): boolean {
  if (cwd.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cwd)) return false;
  return cwd.replace(/\\/g, '/').split('/').filter(Boolean).every((part) => part !== '..');
}

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function StatusBadge({ status, enabled }: { status?: RunStatus; enabled: boolean }): JSX.Element {
  if (!enabled) return <span className="rounded border border-muted px-2 py-0.5 text-xs text-muted-foreground">已停用</span>;
  const cls = status === 'success'
    ? 'border-emerald-500/35 text-emerald-700 dark:text-emerald-300'
    : status === 'failed'
      ? 'border-destructive/35 text-destructive'
      : 'border-[hsl(var(--hairline))] text-muted-foreground';
  return <span className={`rounded border px-2 py-0.5 text-xs ${cls}`}>{status ? runStatusLabel(status) : '待运行'}</span>;
}

function runStatusLabel(status: RunStatus): string {
  if (status === 'success') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'running') return '运行中';
  if (status === 'skipped') return '已跳过';
  return '排队中';
}

function scheduleLabel(job: ScheduledJob): string {
  if (job.schedule.type === 'manual') return '仅手动';
  if (job.schedule.type === 'interval') return `每 ${job.schedule.intervalMinutes || 60} 分钟`;
  return `每天 ${job.schedule.timeOfDay || '02:00'} ${job.schedule.timezone || 'Asia/Shanghai'}`;
}

function scheduleLabelFromForm(form: FormState): string {
  if (form.scheduleType === 'manual') return '仅手动触发';
  if (form.scheduleType === 'interval') return `每 ${form.intervalMinutes || 60} 分钟触发`;
  return `每天 ${form.timeOfDay || '02:00'} 触发`;
}

function targetLabel(job: ScheduledJob): string {
  const actions = normalizeJobActions(job);
  if (actions.length === 0) return '无动作';
  if (actions.length === 1) {
    const action = actions[0];
    return action.targetType === 'http' ? `${action.method || 'POST'} ${action.url || ''}` : '命令';
  }
  return `${actions.length} 个动作`;
}

function formatTime(iso?: string | null): string {
  if (!iso) return '无';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function jobToForm(job: ScheduledJob): FormState {
  return {
    id: job.id,
    projectId: job.projectId,
    name: job.name,
    description: job.description || '',
    enabled: job.enabled,
    scheduleType: job.schedule.type,
    intervalMinutes: String(job.schedule.intervalMinutes || 60),
    timeOfDay: job.schedule.timeOfDay || '02:00',
    timezone: job.schedule.timezone || 'Asia/Shanghai',
    actions: normalizeJobActions(job),
    timeoutSeconds: String(job.timeoutSeconds || 300),
    retryCount: String(job.retryCount || 0),
  };
}

function formToPayload(form: FormState): Omit<ScheduledJob, 'id' | 'createdAt' | 'updatedAt' | 'concurrencyPolicy'> {
  const actions = form.actions.map(actionPayloadFromForm);
  if (actions.length === 0) throw new Error('至少需要添加一个动作');
  return {
    projectId: form.projectId,
    name: form.name,
    description: form.description,
    enabled: form.enabled,
    schedule: form.scheduleType === 'manual'
      ? { type: 'manual', timezone: form.timezone }
      : form.scheduleType === 'interval'
        ? { type: 'interval', intervalMinutes: Number(form.intervalMinutes) || 60, timezone: form.timezone }
        : { type: 'daily', timeOfDay: form.timeOfDay, timezone: form.timezone },
    target: actions[0],
    actions,
    timeoutSeconds: Number(form.timeoutSeconds) || 300,
    retryCount: Number(form.retryCount) || 0,
  };
}

function normalizeJobActions(job: ScheduledJob): ActionForm[] {
  const rawActions = job.actions && job.actions.length > 0 ? job.actions : job.target ? [{ ...job.target, id: 'action_1' }] : [];
  return rawActions.map((action, index) => ({
    id: action.id || `action_${index + 1}`,
    name: action.name || '',
    type: action.type,
    targetType: action.type,
    method: action.method || 'POST',
    url: action.url || '',
    headers: action.headers,
    headersJson: JSON.stringify(action.headers || {}, null, 2),
    body: action.body || '',
    command: action.command || '',
    cwd: action.cwd || '',
  }));
}
