import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlarmClock, ArrowDown, ArrowUp, CalendarClock, Globe2, Pencil, Play, Plus, RefreshCw, Rocket, Save, SlidersHorizontal, Terminal, Trash2, type LucideIcon } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '@/lib/api';
import { parseCurlCommand } from '@/lib/curl-import';
import { resolveTaskScheduleProjectId, taskScheduleProjectReference } from '@/lib/task-schedule-project';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import type {
  HttpMethod, RunStatus, ScheduleType, ScheduledJob, ScheduledJobAction,
  ScheduledJobRun, ScheduledJobTarget, TargetType,
} from '@/types/task-schedule';
import {
  buildOverview, buildTimeline, computeHealth, countdownTo, formatClock, formatDuration,
  groupJobs, runStatusLabel, scheduleLabel, statusTone,
  type JobHealth, type TimelineHourTick, type TimelineLane,
} from '@/lib/task-schedule-view';


interface ProjectLite {
  id: string;
  name: string;
  slug?: string;
  aliasName?: string;
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
  /** release 动作的原始载荷。本页不编辑它，只负责原样带回后端（防静默丢配置）。 */
  release?: ScheduledJobTarget;
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
type ActionLike = Pick<ActionForm, 'targetType' | 'method' | 'url' | 'command' | 'name' | 'release'>;

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

type RunFilterKey = 'all' | 'failed' | 'manual';

const RUN_FILTERS: { key: RunFilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'failed', label: '失败' },
  { key: 'manual', label: '手动' },
];


export function TaskSchedulePage(): JSX.Element {
  const location = useLocation();
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [runs, setRuns] = useState<ScheduledJobRun[]>([]);
  /*
   * 选中任务的完整运行史，单独按 jobId 取。
   *
   * 页面那份 runs 是**全局最近 400 条**：高频任务把名额占满之后，低频任务在里面
   * 只剩零星几条甚至一条都不剩——健康条、P50、单泳道细带、运行流全都被抽空，
   * 而服务端明明为它保留了 120 条（Codex #1471 P2）。服务端的每任务保留修好了，
   * 前端读的还是全局切片，等于那个修复到不了用户面前。
   *
   * 只用于「这个任务自己」的视图；今日统计仍然只看全局那份，否则同一屏的数字
   * 会随着选中谁而变。
   */
  // 带上它属于哪个任务：只按数组存，切到 B 时 A 的记录还在，而下面的合并会先把 B 的
  // 全局记录滤掉再贴上 A 的——B 在请求回来之前健康条 / P50 / 细带 / 运行流全是空的，
  // 慢一点的请求就是在报假状态（Codex #1471 P2）。
  const [selectedRuns, setSelectedRuns] = useState<{ jobId: string; runs: ScheduledJobRun[]; failed: boolean }>({ jobId: '', runs: [], failed: false });
  /** 完整史拉失败后的重试计数：进 effect 的依赖，加一次就重拉一次。 */
  const [historyRetry, setHistoryRetry] = useState(0);
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
  const [runFilter, setRunFilter] = useState<RunFilterKey>('all');
  const [expandedRunId, setExpandedRunId] = useState('');
  // 创建/编辑改为全屏浮层：此前它渲染在 2xl 才存在的第三栏里，1512px 下点「新建任务」
  // 表单一个字都不出现——最显眼的按钮指向一个可能不存在的容器。浮层不依赖任何断点。
  const [editorOpen, setEditorOpen] = useState(false);
  // 倒计时要一直走。静止的「下次 12:28」读不出紧迫感，也不满足「变化可感知」。
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [projectRes, jobRes, runRes] = await Promise.all([
        apiRequest<{ projects?: ProjectLite[] }>('/api/projects'),
        apiRequest<{ jobs: ScheduledJob[] }>('/api/scheduled-jobs?nextRuns=24'),
        apiRequest<{ runs: ScheduledJobRun[] }>('/api/scheduled-jobs/runs?limit=400'),
      ]);
      const nextProjects = projectRes.projects || [];
      const initialProjectId = resolveTaskScheduleProjectId(location.search, nextProjects);
      setProjects(nextProjects);
      setJobs(jobRes.jobs || []);
      setRuns(runRes.runs || []);
      setForm((prev) => prev.projectId ? prev : emptyForm(initialProjectId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [location.search]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!taskScheduleProjectReference(location.search) || projects.length === 0 || selectedId) return;
    const requestedProjectId = resolveTaskScheduleProjectId(location.search, projects);
    setForm((prev) => prev.id || prev.projectId === requestedProjectId
      ? prev
      : { ...prev, projectId: requestedProjectId });
  }, [location.search, projects, selectedId]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(t);
  }, [toast]);

  const projectName = useCallback((projectId: string) => {
    const project = projects.find((item) => item.id === projectId);
    return project ? (project.aliasName || project.name || project.slug || project.id) : projectId;
  }, [projects]);

  useEffect(() => {
    if (!selectedId) { setSelectedRuns({ jobId: '', runs: [], failed: false }); return; }
    let alive = true;
    void apiRequest<{ runs: ScheduledJobRun[] }>(
      `/api/scheduled-jobs/runs?jobId=${encodeURIComponent(selectedId)}&limit=200`,
    )
      .then((res) => { if (alive) setSelectedRuns({ jobId: selectedId, runs: res.runs || [], failed: false }); })
      // 拉不到就退回全局切片：细带和健康条会少几条，但不能因此把整页打红。
      // 只是这个降级**必须说出来**——高频任务把这条任务挤出全局切片时，
      // 用户看到的是「没有历史」，而真相是「没拉到」，两者的下一步完全不同
      // （Codex #1471 P2；expectation-management：失败要给原因和下一步）。
      .catch(() => { if (alive) setSelectedRuns({ jobId: selectedId, runs: [], failed: true }); });
    return () => { alive = false; };
  }, [selectedId, runs, historyRetry]);

  /**
   * 全局切片 + 选中任务的完整史；选中那个任务的记录以完整史为准。
   * 只有在完整史确实属于当前选中项时才替换——否则宁可用全局切片（少几条），
   * 也不能拿上一个任务的记录顶替这一个。
   */
  const mergedRuns = useMemo(() => {
    if (!selectedId || selectedRuns.jobId !== selectedId || selectedRuns.runs.length === 0) return runs;
    return [...runs.filter((run) => run.jobId !== selectedId), ...selectedRuns.runs];
  }, [runs, selectedRuns, selectedId]);

  const runsByJob = useMemo(() => {
    const map = new Map<string, ScheduledJobRun[]>();
    for (const run of mergedRuns) {
      const list = map.get(run.jobId);
      if (list) list.push(run); else map.set(run.jobId, [run]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt));
    }
    return map;
  }, [mergedRuns]);

  const healthOf = useCallback((jobId: string): JobHealth => computeHealth(runsByJob.get(jobId) || []), [runsByJob]);

  const jobNameOf = useCallback((jobId: string) => jobs.find((job) => job.id === jobId)?.name || jobId, [jobs]);

  const selectedJob = useMemo(() => jobs.find((job) => job.id === selectedId) || null, [jobs, selectedId]);

  const groupedJobs = useMemo(() => {
    // 判据在 lib/task-schedule-view 里（可断言）；这里只负责渲染顺序与文案。
    const { attention, soon, normal } = groupJobs(jobs, now);
    return [
      { key: 'attention', label: '需要注意', tone: 'text-bad', jobs: attention },
      { key: 'soon', label: '即将触发', tone: 'text-primary-ink', jobs: soon },
      { key: 'normal', label: '正常运行', tone: 'text-muted-foreground', jobs: normal },
    ].filter((group) => group.jobs.length > 0);
  }, [jobs, now]);

  // 第一屏不该是一张空表单 —— 那正是这次重构要治的病。有任务就默认打开最该看的
  // 那一个（分组已按「需要注意 → 即将触发 → 正常运行」排好），新建始终是显式动作。
  // 只在首次落位一次：用户点了「新建任务」把 selectedId 清空后，不许再被抢回去。
  // 选中某个任务时运行流默认只看它 —— 归因要的就是这个。但低频任务只有一两条记录，
  // 中栏会空掉大半（content-fills-canvas）。所以给一个显式的作用域开关，
  // 而不是让用户靠「清空选中」来换回全部（那会把右栏打回空表单）。
  const [runScopeAll, setRunScopeAll] = useState(false);
  // <2xl 时中栏在「运行流 / 概览」之间切；≥2xl 两者并列，这个值不参与渲染。
  const runScopeJobId = runScopeAll ? '' : selectedId;

  const visibleRuns = useMemo(() => {
    // 按任务筛选时用那个任务的完整史；「全部任务」仍看全局切片。
    const base = runScopeJobId ? mergedRuns.filter((run) => run.jobId === runScopeJobId) : runs;
    const filtered = runFilter === 'failed'
      ? base.filter((run) => run.status === 'failed' || run.status === 'skipped')
      : runFilter === 'manual'
        ? base.filter((run) => run.trigger === 'manual')
        : base;
    return [...filtered].sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt)).slice(0, 200);
  }, [runs, mergedRuns, runFilter, runScopeJobId]);

  const runFilterCaption = useMemo(() => {
    const scope = runScopeJobId ? jobNameOf(runScopeJobId) : '全部任务';
    if (runFilter === 'failed') return `${scope} · 只看失败与跳过`;
    if (runFilter === 'manual') return `${scope} · 只看手动触发`;
    return `${scope} · 最近 ${visibleRuns.length} 条`;
  }, [runFilter, runScopeJobId, jobNameOf, visibleRuns.length]);

  const overview = useMemo(() => buildOverview(jobs, runs, now), [jobs, runs, now]);
  const timeline = useMemo(() => buildTimeline(jobs, runsByJob, now, selectedId), [jobs, runsByJob, now, selectedId]);
  // 选中态顶部那条 44px 细带：只画这一个任务。onlyJobId 让它在任务排名靠后时也不会落空。
  const laneStrip = useMemo(
    () => (selectedId ? buildTimeline(jobs, runsByJob, now, selectedId, { onlyJobId: selectedId }) : null),
    [jobs, runsByJob, now, selectedId],
  );

  const selectJob = (job: ScheduledJob): void => {
    setSelectedId(job.id);
    setForm(jobToForm(job));
    // 从清单换一个任务，回到观察态。编辑始终是显式动作，不会因为切换而「粘」在表单上。
    setEditorOpen(false);
    // 作用域也跟着回到「只看这个任务」——换任务就是为了看它。
    setRunScopeAll(false);
  };

  const openEditor = (): void => {
    // 上一次操作留下的错误不该跟进这次编辑——否则一打开弹窗就顶着一条陈年报错。
    setError('');
    setEditorOpen(true);
  };

  const newJob = (): void => {
    // 只重置表单，不动 selectedId —— 表单是不是「新建」由 form.id 决定。
    // 清掉选中的话，关掉浮层后右栏会塌成空状态，用户回不到刚才在看的那个任务。
    setForm(emptyForm(resolveTaskScheduleProjectId(location.search, projects)));
    openEditor();
  };

  const openActionDialog = (index: number | null = null, preset?: 'http' | 'command'): void => {
    setEditingActionIndex(index);
    // 空态直接给「+ HTTP 调用 / + 命令脚本」两个入口，省掉「先点添加、再在里面选类型」
    // 那一步——类型是这张表里用户唯一真正要做的选择，没必要藏在下一屏。
    setActionDraft(
      index === null
        ? (preset === 'command' ? { ...emptyAction(), type: 'command' as const, targetType: 'command' as const } : emptyAction())
        : { ...form.actions[index] },
    );
    setCurlInput('');
    setActionError('');
    setCheckResult(null);
    setActionDialogOpen(true);
  };

  // 保存的三个前置条件此前只体现为一个灰按钮，用户看不出差哪个。
  const editorBlocker = !form.projectId ? '还要选一个所属项目' : !form.name.trim() ? '还要给任务起个名字' : form.actions.length === 0 ? '还差 1 个动作才能保存' : '';

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
      setEditorOpen(false);
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
    setError('');
    try {
      await apiRequest(`/api/scheduled-jobs/${encodeURIComponent(form.id)}`, { method: 'DELETE' });
      setToast('任务已删除');
      setSelectedId('');
      setForm(emptyForm(resolveTaskScheduleProjectId(location.search, projects)));
      setEditorOpen(false);
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
                <RefreshCw />
                刷新
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace fluid className="cds-workspace--fill min-h-0">
        {error ? <ErrorBlock message={error} /> : null}
        {toast ? (
          <div className="mb-3 rounded-md border border-ok/30 bg-ok-soft px-3 py-2 text-sm text-ok">
            {toast}
          </div>
        ) : null}

        {loading ? <LoadingBlock label="加载任务调度配置" /> : (
          <div className="flex flex-col gap-3 xl:min-h-0 xl:flex-1">

            {/* 值班条：常驻，跨左右两栏。它回答的是页面级的「有没有出事」，
                与选中了哪个任务无关，所以不进右栏。 */}
            <div className="flex flex-wrap items-stretch gap-3">
              {/* 一块，不是三块。原来是「卡片 + 橙色实心块」两种容器并排，
                  卡片内部又用左分割线切了一段统计——同一行里三种分组语言。
                  现在统一成「结论句 + 等分统计段」，与详情里的指标条同一套节奏。 */}
              <div className="flex min-w-0 flex-1 items-stretch overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]">
                <div className="flex min-w-0 flex-1 flex-col justify-center px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${overview.tone === 'bad' ? 'bg-bad' : overview.tone === 'warn' ? 'bg-warn' : 'bg-ok'}`} />
                    <span className="truncate text-base font-semibold">{overview.headline}</span>
                  </div>
                  <div className="mt-1 truncate text-xs leading-5 text-muted-foreground">{overview.detail}</div>
                </div>
                {/*
                  * 从 lg 起才露，不是 md：这一条统计段是固定宽的（5 个 86px 格 + 188px
                  * 的下一次触发 = 618px）。768px 那一档扣掉 72px 左栏与主区左右内边距，
                  * 剩下的宽度几乎全被它吃掉，结论条被压到接近零并被父级 overflow-hidden
                  * 裁掉——而结论条正是这一页存在的理由（Codex #1471 P2）。
                  * 1024px 起才有余量：888 − 618 ≈ 270px 留给结论条。
                  * 露不出来的那一档不是信息丢失：统计值在下面的调度轴与运行流里都还在。
                  */}
                <div className="hidden shrink-0 items-stretch lg:flex">
                  {overview.stats.map((stat) => (
                    <div key={stat.label} className="flex w-[86px] flex-col justify-center border-l border-[hsl(var(--hairline))] px-3 py-2">
                      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{stat.label}</div>
                      <div className={`mt-0.5 font-mono text-[17px] font-semibold leading-tight ${stat.tone}`}>{stat.value}</div>
                    </div>
                  ))}
                  <div className="flex w-[188px] flex-col justify-center border-l border-[hsl(var(--hairline))] bg-primary-soft/50 px-3 py-2">
                    <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">下一次触发</div>
                    <div className="mt-0.5 flex items-baseline gap-2">
                      <span className="font-mono text-[17px] font-semibold leading-tight text-primary-ink">{overview.nextCountdown}</span>
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground">{overview.nextName}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* 高度契约：Workspace 是 height:100% 的 flex 列，外面那层 div 必须 xl:flex-1
                才把确定高度传下来——少了它，这条 grid 写多少 flex-1 都只有内容高
                （实测索引 381px 而不是 660px，四档冒烟里「脊柱被压扁」那条会红）。

                主从：左栏索引是这一屏的脊柱，满高常驻；右栏按「选没选中任务」分两态。
                此前索引被时间轴压到 y=445（52% 屏高）、只有 280×367，而它是使用频率
                最高的元件；同时 2xl 才存在的第三栏让「新建」在 1536px 以下不可见。
                两栏之后没有断点分歧，那个洞从结构上被填掉。 */}
            <div className="grid flex-1 gap-3 xl:min-h-0 xl:grid-rows-[minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)]">

              {/* 左：任务索引。窄屏（<xl）退回自然流并限高，桌面才满高填充。 */}
              <section className="flex min-h-0 max-h-[52vh] flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] xl:max-h-none">
                <div className="flex shrink-0 items-center gap-2 border-b border-[hsl(var(--hairline))] px-3 py-2.5">
                  <div className="text-sm font-semibold">任务</div>
                  <span className="font-mono text-xs text-muted-foreground">{jobs.length}</span>
                  <div className="flex-1" />
                  <Button size="sm" onClick={newJob}>
                    <Plus />
                    新建
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-2">
                  {jobs.length === 0 ? (
                    <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
                      <AlarmClock className="h-9 w-9 opacity-60" />
                      <div>还没有定时任务。新建一个任务后，可以每天定时调用接口或执行命令。</div>
                    </div>
                  ) : groupedJobs.map((group) => (
                    <div key={group.key}>
                      <div className="flex items-center gap-2 px-1 pb-1 pt-2">
                        <span className={`text-[10px] font-semibold uppercase tracking-wide ${group.tone}`}>{group.label}</span>
                        <span className="h-px flex-1 bg-[hsl(var(--hairline))]" />
                        <span className="font-mono text-[10px] text-muted-foreground">{group.jobs.length}</span>
                      </div>
                      {group.jobs.map((job) => (
                        <JobRow
                          key={job.id}
                          job={job}
                          selected={selectedId === job.id}
                          projectLabel={projectName(job.projectId)}
                          scheduleText={scheduleLabel(job)}
                          countdown={countdownTo(job.nextRunAt, now)}
                          bars={healthOf(job.id).bars}
                          onSelect={() => selectJob(job)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </section>

              {/* 右：两态。未选中 = 值班概览（时间轴在这里满高展开）；
                  选中 = 这一个任务（时间轴收成 44px 细带，高度让给动作链与运行流）。 */}
              <section className="flex min-h-0 flex-col overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]">
                {selectedJob ? (
                  <>
                    {/* 三层表头（页面 / 上下文 / 详情）连排是噪音：细带自己就写着任务名，
                        原来那行「今天 · X」与它、与详情头三处重复。合并成一层。 */}
                    <JobDetailHeader
                      job={selectedJob}
                      projectLabel={projectName(selectedJob.projectId)}
                      scheduleText={scheduleLabel(selectedJob)}
                      running={runningId === selectedJob.id}
                      onRun={() => void runNow(selectedJob.id)}
                      onEdit={() => { selectJob(selectedJob); openEditor(); }}
                      onBack={() => setSelectedId('')}
                    />
                    {selectedRuns.jobId === selectedId && selectedRuns.failed ? (
                      <div
                        role="status"
                        data-history-degraded
                        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-warn/40 bg-warn-soft px-4 py-2 text-xs text-warn"
                      >
                        <span>这条任务的完整运行史没拉到，下面是全局切片，可能不全。</span>
                        <button type="button" className="underline underline-offset-2" onClick={() => setHistoryRetry((n) => n + 1)}>
                          重试
                        </button>
                      </div>
                    ) : null}
                    {laneStrip ? (
                      <TimelineBand
                        compact
                        lanes={laneStrip.lanes}
                        hourTicks={laneStrip.hourTicks}
                        nowRatio={laneStrip.nowRatio}
                        nowLabel={laneStrip.nowLabel}
                        hiddenCount={0}
                      />
                    ) : null}
                    <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_440px]">
                      <div className="flex min-h-0 max-h-[70vh] flex-col overflow-hidden border-b border-[hsl(var(--hairline))] xl:max-h-none xl:border-b-0 xl:border-r">
                        <JobOverview
                          job={selectedJob}
                          scheduleText={scheduleLabel(selectedJob)}
                          countdown={countdownTo(selectedJob.nextRunAt, now)}
                          health={healthOf(selectedJob.id)}
                          onEdit={() => { selectJob(selectedJob); openEditor(); }}
                        />
                      </div>
                      <div className="flex min-h-0 max-h-[60vh] flex-col overflow-hidden xl:max-h-none">
                        <RunStream
                          caption={runFilterCaption}
                          scopeLabel={runScopeAll ? `只看 ${jobNameOf(selectedId)}` : '看全部任务'}
                          onToggleScope={() => setRunScopeAll((prev) => !prev)}
                          filter={runFilter}
                          onFilter={setRunFilter}
                          runs={visibleRuns}
                          jobNameOf={jobNameOf}
                          showJobName={runScopeAll}
                          expandedRunId={expandedRunId}
                          onToggleRun={(id) => setExpandedRunId(expandedRunId === id ? '' : id)}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col overflow-auto">
                    <TimelineBand
                      lanes={timeline.lanes}
                      hourTicks={timeline.hourTicks}
                      nowRatio={timeline.nowRatio}
                      nowLabel={timeline.nowLabel}
                      hiddenCount={timeline.hiddenCount}
                    />
                    <div className="min-h-0 flex-1 border-t border-[hsl(var(--hairline))]">
                      <RunStream
                        caption={runFilterCaption}
                        scopeLabel=""
                        onToggleScope={null}
                        filter={runFilter}
                        onFilter={setRunFilter}
                        runs={visibleRuns}
                        jobNameOf={jobNameOf}
                        showJobName
                        expandedRunId={expandedRunId}
                        onToggleRun={(id) => setExpandedRunId(expandedRunId === id ? '' : id)}
                      />
                    </div>
                  </div>
                )}
              </section>
            </div>
          </div>
        )}
        {/* 创建/编辑走 shadcn Dialog：遮罩与层级由组件统一负责，不自己造
            （自己写死中性色遮罩会被 palette-contrast-guard 的棘轮拦下，那条拦得对）。
            浮层限高而非定高：表单只有三段时浮层就该只有三段高。写死 820px 会在动作链
            为空时留出一大块空白，违反「内容填满画布」——那条规则反过来同样成立：
            画布不该大于内容。 */}
        <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
          <DialogContent
            frame
            className="max-w-none"
            style={{ width: 'min(960px, calc(100vw - 40px))', maxHeight: 'calc(100vh - 40px)' }}
          >
            {/*
              * 双栏：左边定「什么时候跑」，右边整块给「跑什么」。动作是任务的本体
              * ——没有动作的任务什么都不做——所以它拿主区域并撑满高度，而不是排在
              * 第三块、空态一个灰虚线盒（content-fills-canvas）。
              * 右内边距仍给 DialogContent 自带的关闭 X 让位（absolute right-4 top-4）。
              * 窄屏（< lg）整体降回单栏自然流，由外层滚动（cds/.claude/rules/mobile-layout-fallback）。
              */}
            <DialogHeader className="shrink-0 border-b border-[hsl(var(--hairline))] py-3 pl-5 pr-12">
              <div className="text-left">
                <DialogTitle className="text-[15px]">{form.id ? '编辑任务' : '新建任务'}</DialogTitle>
                <div className="mt-0.5 text-xs text-muted-foreground">触发器启动任务，动作按顺序执行。</div>
              </div>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto lg:overflow-hidden">
              <div className="flex min-h-0 flex-col lg:grid lg:h-full lg:grid-cols-[300px_minmax(0,1fr)]">
                <div className="min-h-0 border-b border-[hsl(var(--hairline))] p-4 lg:overflow-y-auto lg:border-b-0 lg:border-r">
                  <Field label="任务名称">
                    <input className={compactInputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="生码统计同步" />
                  </Field>
                  <Field label="所属项目" className="mt-3.5">
                    <select className={compactInputClass} value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} disabled={Boolean(form.id)}>
                      <option value="">选择项目</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>{projectName(project.id)}</option>
                      ))}
                    </select>
                  </Field>

                  <div className="mt-4 border-t border-[hsl(var(--hairline))] pt-4">
                    <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-[12.5px] font-semibold">触发器</span>
                      <span className="text-xs text-muted-foreground">{scheduleLabelFromForm(form)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <SegmentButton icon={CalendarClock} label="每天" active={form.scheduleType === 'daily'} onClick={() => setForm({ ...form, scheduleType: 'daily' })} />
                      <SegmentButton icon={RefreshCw} label="间隔" active={form.scheduleType === 'interval'} onClick={() => setForm({ ...form, scheduleType: 'interval' })} />
                      <SegmentButton icon={Play} label="手动" active={form.scheduleType === 'manual'} onClick={() => setForm({ ...form, scheduleType: 'manual' })} />
                    </div>
                    {/* 时刻只有 5 个字符，输入框就该只有 5 个字符宽——此前给了 max-w-sm(384px)。 */}
                    <div className="mt-3">
                      {form.scheduleType === 'daily' ? (
                        <Field label="执行时间" className="w-32">
                          <input className={compactInputClass} type="time" value={form.timeOfDay} onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })} />
                        </Field>
                      ) : null}
                      {form.scheduleType === 'interval' ? (
                        <Field label="间隔分钟" className="w-32">
                          <input className={compactInputClass} value={form.intervalMinutes} onChange={(e) => setForm({ ...form, intervalMinutes: e.target.value })} inputMode="numeric" />
                        </Field>
                      ) : null}
                      {form.scheduleType === 'manual' ? (
                        <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs text-muted-foreground">
                          保存后通过“立即执行”触发。
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <details className="mt-4 border-t border-[hsl(var(--hairline))] pt-1">
                    <summary className="flex cursor-pointer list-none items-center gap-2 py-2 text-xs font-medium text-muted-foreground">
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                      更多设置
                      <span className="ml-auto text-[11px] opacity-70">{form.enabled ? '已启用' : '已停用'} · {form.timeoutSeconds}s · 重试 {form.retryCount}</span>
                    </summary>
                    <div className="grid gap-3 pb-1 pt-2">
                      <Field label="启用状态">
                        <label className="flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm">
                          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
                          {form.enabled ? '已启用' : '已停用'}
                        </label>
                      </Field>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="超时秒数">
                          <input className={compactInputClass} value={form.timeoutSeconds} onChange={(e) => setForm({ ...form, timeoutSeconds: e.target.value })} inputMode="numeric" />
                        </Field>
                        <Field label="重试次数">
                          <input className={compactInputClass} value={form.retryCount} onChange={(e) => setForm({ ...form, retryCount: e.target.value })} inputMode="numeric" />
                        </Field>
                      </div>
                      <Field label="时区">
                        <input className={compactInputClass} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
                      </Field>
                      <Field label="说明">
                        <textarea className={`${textareaClass} min-h-16`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="说明这个任务拉取什么数据、写入哪里。" />
                      </Field>
                    </div>
                  </details>

                  {form.id ? (
                    <div className="mt-4 border-t border-[hsl(var(--hairline))] pt-3">
                      <Button variant="outline" size="sm" onClick={() => void deleteJob()} disabled={saving} className="text-destructive hover:text-destructive">
                        <Trash2 />
                        删除任务
                      </Button>
                    </div>
                  ) : null}
                </div>

                <div className="flex min-h-0 flex-col p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-[12.5px] font-semibold">动作步骤</span>
                      <span className="text-xs text-muted-foreground">{form.actions.length} 个动作，按列表顺序执行</span>
                    </div>
                    {form.actions.length > 0 ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => openActionDialog()}>
                        <Plus />
                        添加
                      </Button>
                    ) : null}
                  </div>
                  {form.actions.length === 0 ? (
                    <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-md border border-dashed lg:flex-1 border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))]/45 px-6 py-8 text-center">
                      <div className="text-sm">这个任务触发后要做什么</div>
                      <div className="max-w-[340px] text-xs text-muted-foreground">按顺序执行；任一步失败后面的步骤不再继续。</div>
                      <div className="mt-1 flex flex-wrap justify-center gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={() => openActionDialog(null, 'http')}>
                          <Globe2 />
                          HTTP 调用
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => openActionDialog(null, 'command')}>
                          <Terminal />
                          命令脚本
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
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
                </div>
              </div>
            </div>

            {/*
              * 保存挪到底栏：右上角那个位置本来就得给原语自带的关闭 X 让位，而且灰着的
              * 保存按钮从不说自己在等什么。左边这句话把「还差什么」讲出来
              * （expectation-management：任何时刻都知道现在什么情况）。
              */}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[hsl(var(--hairline))] px-5 py-3">
              <div className="text-xs text-muted-foreground">{editorBlocker || (form.id ? '保存后按新的触发器排期' : '保存后按触发器排期，随时可停用')}</div>
              <div className="flex shrink-0 items-center gap-2">
                {form.id ? (
                  <Button variant="outline" size="sm" onClick={() => void runNow(form.id!)} disabled={runningId === form.id}>
                    <Play />
                    {runningId === form.id ? '执行中' : '立即执行'}
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => setEditorOpen(false)}>取消</Button>
                <Button size="sm" onClick={() => void saveJob()} disabled={saving || Boolean(editorBlocker)}>
                  <Save />
                  {saving ? '保存中' : '保存'}
                </Button>
              </div>
            </div>
            {/*
              * 失败必须在弹窗里说话。页面级 ErrorBlock 渲染在弹窗**之后**、被遮罩盖住，
              * 而失败时弹窗不会关（只有成功才 setEditorOpen(false)）——于是后端校验错、
              * 网络失败、目标已被删除，用户看到的只是忙碌态停下，没有原因也没有下一步
              * （Codex #1471 P2；违反 expectation-management：任何时刻都要知道现在什么情况）。
              * 同一份 error 在这里再渲染一次：弹窗开着时看这条，关着时看页面那条。
              */}
            {error ? (
              <div
                role="alert"
                data-editor-error
                className="shrink-0 border-t border-destructive/40 bg-destructive/10 px-5 py-3 text-[12.5px] text-destructive"
              >
                {error}
              </div>
            ) : toast ? (
              /*
               * 成功也要在弹窗里说话。保存和删除成功后弹窗会关掉，页面级 toast 看得见；
               * 只有「立即执行」是留在弹窗里的——它的成功提示同样被遮罩盖住，用户看到的
               * 只是忙碌态停下（Codex #1471 P2）。上一轮我把失败复制进来了却漏了成功，
               * 两边不对称本身就是缺陷。
               */
              <div
                role="status"
                data-editor-toast
                className="shrink-0 border-t border-ok/40 bg-ok/10 px-5 py-3 text-[12.5px] text-ok"
              >
                {toast}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog open={actionDialogOpen} onOpenChange={setActionDialogOpen}>
          <DialogContent className="max-w-none" style={{ width: 'min(760px, calc(100vw - 32px))' }}>
            <DialogHeader>
              <DialogTitle>{editingActionIndex === null ? '添加动作' : '编辑动作'}</DialogTitle>
              <DialogDescription>HTTP 会调用 CDS 能访问的接口，命令脚本会在独立 sandbox 工作区内执行。多个动作按列表顺序执行。</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {actionDraft.targetType === 'release' ? null : (
                <div className="flex flex-wrap gap-2">
                  <SegmentButton icon={Globe2} label="HTTP 接口" active={actionDraft.targetType === 'http'} onClick={() => setActionDraft({ ...actionDraft, type: 'http', targetType: 'http' })} />
                  <SegmentButton icon={Terminal} label="命令脚本" active={actionDraft.targetType === 'command'} onClick={() => setActionDraft({ ...actionDraft, type: 'command', targetType: 'command' })} />
                </div>
              )}

              <Field label="动作名称">
                <input className={compactInputClass} value={actionDraft.name} onChange={(e) => setActionDraft({ ...actionDraft, name: e.target.value })} placeholder={actionDraft.targetType === 'http' ? '调用旧总后台接口' : '清洗同步数据'} />
              </Field>

              {actionDraft.targetType === 'release' ? (
                <div className="space-y-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2.5 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <Rocket className="h-4 w-4" />
                    发布动作
                  </div>
                  <div className="font-mono text-[11px] leading-5">{releaseActionSummary(actionDraft.release)}</div>
                  <div>本页只展示与启停发布规则；来源、目标与闸门请到发布中心的「自动发布」页签编辑，避免在两处各改一半。</div>
                </div>
              ) : actionDraft.targetType === 'http' ? (
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
                <div className={`rounded-md border px-3 py-2 text-sm ${checkResult.ok ? 'border-ok/30 bg-ok-soft text-ok' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}>
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
      /*
       * 选中态不再整块染橙：一屏只留一处强调，那一处是保存。这里改成「抬升底 + 满墨
       * 字 + 左侧一道 2px 主色标记」，与左侧栏当前页同一套语言（主色面积从整块降到一道）。
       */
      className={`${segmentClass} ${active ? "relative border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))] font-semibold text-foreground before:absolute before:left-0 before:top-1/2 before:h-3.5 before:w-0.5 before:-translate-y-1/2 before:rounded-r-sm before:bg-primary before:content-['']" : 'border-[hsl(var(--hairline))] bg-background text-muted-foreground hover:text-foreground'}`}
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
  if (action.targetType === 'release') return Boolean(action.release?.targetId);
  return action.targetType === 'http' ? Boolean(action.url.trim()) : Boolean(action.command.trim());
}

/** 把服务端的 target/action 形状映射成表单侧的 ActionLike，标题与描述复用同一套判定。 */
function actionFromTarget(action: ScheduledJobAction): ActionLike {
  return {
    name: action.name || '',
    targetType: action.type,
    method: action.method || 'POST',
    url: action.url || '',
    command: action.command || '',
    release: action,
  };
}

function actionTitle(action: ActionLike): string {
  if (action.name.trim()) return action.name.trim();
  if (action.targetType === 'release') return '发布到环境';
  return action.targetType === 'http' ? '调用 HTTP 接口' : '执行命令脚本';
}

function actionDescription(action: ActionLike): string {
  if (action.targetType === 'release') return releaseActionSummary(action.release);
  if (action.targetType === 'http') return `${action.method} ${action.url}`;
  return action.command.split('\n')[0] || '命令脚本';
}

/** 一行说清「发到哪、发哪一版、有没有闸」。用户扫一眼就知道这条规则会做什么。 */
function releaseActionSummary(release?: ScheduledJobTarget): string {
  if (!release?.targetId) return '发布动作';
  const source = release.source?.kind === 'promote'
    ? `提升 ${release.source.fromTargetId} 正在跑的版本`
    : release.source?.kind === 'branch'
      ? `分支 ${release.source.branchId}`
      : '来源未配置';
  const flags = [
    release.requireApproval ? '需人工确认' : '',
    release.dryRun ? '仅预检' : '',
    release.rollbackOnFailure ? '失败自动回滚' : '',
    release.skipWhenUnchanged ? '版本未变则跳过' : '',
  ].filter(Boolean);
  return `发布到 ${release.targetId} · ${source}${flags.length ? ` · ${flags.join(' / ')}` : ''}`;
}

function targetPayloadFromAction(action: ActionDraft): ScheduledJobTarget {
  if (action.targetType === 'release') {
    // 本页不编辑发布动作，原样回传。丢一个字段就等于把发布配置改成另一条规则。
    if (!action.release?.targetId) throw new Error('发布动作缺少发布目标，请到发布中心的自动发布页签配置');
    return action.release;
  }
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




function scheduleLabelFromForm(form: FormState): string {
  if (form.scheduleType === 'manual') return '仅手动触发';
  if (form.scheduleType === 'interval') return `每 ${form.intervalMinutes || 60} 分钟触发`;
  return `每天 ${form.timeOfDay || '02:00'} 触发`;
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
    ...(action.type === 'release' ? { release: action } : {}),
  }));
}

/** 今日调度轴。左侧已发生，右侧待触发，橙线是现在。 */
function TimelineBand({
  lanes, hourTicks, nowRatio, nowLabel, hiddenCount, compact = false,
}: {
  lanes: TimelineLane[];
  hourTicks: TimelineHourTick[];
  nowRatio: number;
  nowLabel: string;
  hiddenCount: number;
  /** 选中态的细带：只画一条泳道，表头、图例、未展开计数在那一档都是噪音。 */
  compact?: boolean;
}): JSX.Element | null {
  if (lanes.length === 0) return null;
  return (
    <section className={compact
      ? 'shrink-0 overflow-hidden border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))]'
      : 'shrink-0 overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]'}>
      <div className={`items-center justify-between border-b border-[hsl(var(--hairline))] px-4 py-2 ${compact ? 'hidden' : 'flex'}`}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">今日调度轴</span>
          <span className="text-xs text-muted-foreground">左侧已发生，右侧待触发</span>
        </div>
        <div className="hidden items-center gap-4 text-[11px] text-muted-foreground sm:flex">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-ok" />成功</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-0.5 rounded bg-bad" />失败</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border border-dashed border-[hsl(var(--hairline-strong))]" />待触发</span>
        </div>
      </div>

      {/*
       * 名字列 176 + 两条沟槽 24×2 + 调度列 128 = 固定 352px。390px 视口扣掉
       * 32px 内边距只剩 358px，时间轨道会被压到几乎没有，而外层是 overflow-hidden，
       * 用户连横滚都滚不到（Codex #1471 P2；cds/.claude/rules/mobile-layout-fallback.md
       * 要求 desktop-fill 必须配 mobile-flow 兜底）。
       * 兜底取该规则点名的第 6 条：包一层横滚容器 + 内容自身 min-w，宽屏零变化。
       */}
      <div className={`overflow-x-auto ${compact ? 'px-4 pb-1 pt-1' : 'px-4 pb-3 pt-2'}`}>
        <div className="min-w-[560px]">
        {/* 刻度行的三段必须与泳道逐段对齐，否则刻度和点位是两套坐标。 */}
        <div className={compact ? 'hidden' : 'flex'}>
          <div className="w-44 shrink-0" />
          <div className="w-6 shrink-0" />
          <div className="relative h-4 flex-1">
            {hourTicks.map(({ hour, leftPct }) => (
              <span
                key={hour}
                className="absolute top-0 font-mono text-[10px] text-muted-foreground"
                style={{ left: `${leftPct}%`, transform: hour === 0 ? 'none' : hour === 24 ? 'translateX(-100%)' : 'translateX(-50%)' }}
              >
                {String(hour).padStart(2, '0')}
              </span>
            ))}
          </div>
          <div className="w-6 shrink-0" />
          <div className="w-32 shrink-0" />
        </div>

        <div className="relative">
          {lanes.map((lane) => (
            <div key={lane.id} className="flex h-7 items-center">
              {/* 选中态此前把底色铺满整行，未选中行只在轨道区有底纹——两种行看着不是一套结构。
                  现在底纹统一只铺轨道区，选中靠名字列左侧一根竖条 + 主色墨。 */}
              <div className={`flex h-full w-44 shrink-0 items-center gap-1.5 pl-2 pr-3 ${lane.selected ? 'shadow-[inset_2px_0_0_hsl(var(--primary))]' : ''}`}>
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${lane.disabled ? 'bg-muted-foreground' : 'bg-ok'}`} />
                <span className={`truncate text-[11px] ${lane.disabled ? 'text-muted-foreground line-through' : lane.selected ? 'font-semibold text-primary-ink' : 'text-foreground-muted'}`}>{lane.name}</span>
              </div>
              {/* 沟槽：轨道右端此前直接贴着调度列（实测 0px），虚线带压在「每 10 分钟」上。 */}
              <div className="box-border h-full w-6 shrink-0 border-l border-[hsl(var(--hairline))]" />
              <div className={`relative h-6 flex-1 rounded ${lane.selected ? 'bg-primary/[0.07]' : ''}`}>
                {hourTicks.filter(({ hour }) => hour > 0 && hour < 24).map(({ hour, leftPct }) => (
                  <span key={hour} className="absolute inset-y-0 w-px bg-[hsl(var(--hairline))]/80" style={{ left: `${leftPct}%` }} />
                ))}
                <span className="absolute inset-y-0 right-0 bg-[hsl(var(--surface-sunken))]/55" style={{ left: `${nowRatio}%` }} />
                {lane.dense && !lane.disabled ? (
                  <>
                    <span className="absolute top-1/2 h-1 -translate-y-1/2 rounded bg-gradient-to-r from-ok/35 to-ok/85" style={{ left: 0, width: `${nowRatio}%` }} />
                    <span className="absolute top-1/2 right-0 h-1 -translate-y-1/2 rounded border border-dashed border-[hsl(var(--hairline-strong))]" style={{ left: `${nowRatio}%` }} />
                  </>
                ) : null}
                {lane.events.map((event, index) => (
                  <span
                    key={`${event.leftPct}-${index}`}
                    title={event.title}
                    className={
                      event.status === 'pending'
                        ? 'absolute top-1/2 h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[hsl(var(--hairline-strong))]'
                        : event.status === 'failed'
                          ? 'absolute top-1/2 h-3.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-bad'
                          : `absolute top-1/2 h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full ${statusTone(event.status)}`
                    }
                    style={{ left: `${event.leftPct}%` }}
                  />
                ))}
              </div>
              <div className="box-border h-full w-6 shrink-0 border-r border-[hsl(var(--hairline))]" />
              {/* 8rem 才放得下「每天 09:00 Asia/Shanghai」；4rem 时六行里有三行吃省略号。 */}
              <div className="flex w-32 shrink-0 justify-end">
                <span className={`truncate text-[10px] ${lane.disabled ? 'text-bad' : 'text-muted-foreground'}`}>{lane.tag}</span>
              </div>
            </div>
          ))}

          <div
            className="pointer-events-none absolute top-0 w-px bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.6)]"
            style={{ left: `calc(12.5rem + (100% - 22rem) * ${nowRatio / 100})`, height: `${lanes.length * 28}px` }}
          />
          {compact ? null : (
            <span
              className="pointer-events-none absolute -translate-x-1/2 rounded bg-primary px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[hsl(var(--status-ink))]"
              style={{ left: `calc(12.5rem + (100% - 22rem) * ${nowRatio / 100})`, top: `${lanes.length * 28 + 4}px` }}
            >
              现在 {nowLabel}
            </span>
          )}
        </div>

        {compact ? null : hiddenCount > 0 ? (
          <div className="pl-[12.5rem] pt-7 text-[11px] text-muted-foreground">另有 {hiddenCount} 个任务未展开</div>
        ) : <div className="pt-6" />}
        </div>
      </div>
    </section>
  );
}

/**
 * 运行流。值班概览态与单任务态共用这一份——两处各写一遍就是
 * predicate-and-wiring 形状 3（判据分裂后各自漂移）。
 * onToggleScope 为 null 时不渲染范围切换（未选中任务时没有「只看某个」可切）。
 */
function RunStream({
  caption, scopeLabel, onToggleScope, filter, onFilter, runs, jobNameOf, showJobName, expandedRunId, onToggleRun,
}: {
  caption: string;
  scopeLabel: string;
  onToggleScope: (() => void) | null;
  filter: RunFilterKey;
  onFilter: (key: RunFilterKey) => void;
  runs: ScheduledJobRun[];
  jobNameOf: (jobId: string) => string;
  showJobName: boolean;
  expandedRunId: string;
  onToggleRun: (runId: string) => void;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* 380px 那一栏里，标题不写 shrink-0 会被 min-w-0 的兄弟挤成一列竖排的「运行流」。
          实测截图见 2026-09-01 本地 1512 档。 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-[hsl(var(--hairline))] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 whitespace-nowrap text-sm font-semibold">运行流</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{caption}</span>
          {onToggleScope ? (
            <button
              type="button"
              onClick={onToggleScope}
              className="shrink-0 rounded border border-[hsl(var(--hairline))] px-1.5 py-px text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {scopeLabel}
            </button>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {RUN_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onFilter(item.key)}
              className={`h-7 rounded-md px-2.5 text-xs transition-colors ${filter === item.key ? 'border border-primary/45 bg-primary-soft font-semibold text-primary-ink' : 'border border-[hsl(var(--hairline))] text-muted-foreground hover:text-foreground'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {runs.length === 0 ? (
          <div className="flex min-h-24 items-center justify-center px-4 py-10 text-center text-sm text-muted-foreground">
            还没有运行记录。
          </div>
        ) : runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            jobName={jobNameOf(run.jobId)}
            showJobName={showJobName}
            expanded={expandedRunId === run.id}
            onToggle={() => onToggleRun(run.id)}
          />
        ))}
      </div>
    </div>
  );
}


/** 任务清单里的一行：名字 + 倒计时 + 最近 10 次健康条。 */
function JobRow({
  job, selected, projectLabel, scheduleText, countdown, bars, onSelect,
}: {
  job: ScheduledJob;
  selected: boolean;
  projectLabel: string;
  scheduleText: string;
  countdown: string;
  bars: RunStatus[];
  onSelect: () => void;
}): JSX.Element {
  const disabled = Boolean(job.autoDisabledReason) || !job.enabled;
  return (
    <button
      type="button"
      onClick={onSelect}
      /* 冒烟脚本按这个属性点行，不靠文案猜——文案改了不该让守卫静默失效。 */
      data-job-row={job.id}
      className={`mb-1 block w-full rounded-md border px-2.5 py-2 text-left transition-colors ${selected ? 'border-primary/50 bg-primary-soft' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 hover:border-primary/40'} ${disabled ? 'opacity-75' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${disabled ? 'bg-muted-foreground' : job.lastRunStatus === 'failed' ? 'bg-bad' : job.lastRunStatus === 'skipped' ? 'bg-warn' : 'bg-ok'}`} />
        <span className={`min-w-0 flex-1 truncate text-[13px] font-semibold ${selected ? 'text-primary-ink' : ''}`}>{job.name}</span>
        <span className={`shrink-0 font-mono text-[11px] ${disabled ? 'text-bad' : selected ? 'text-primary-ink' : 'text-muted-foreground'}`}>
          {disabled ? '已停用' : countdown}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="min-w-0 max-w-[7rem] truncate text-[11px] text-muted-foreground">{projectLabel}</span>
        <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-[hsl(var(--hairline-strong))]" />
        <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">{scheduleText}</span>
        <span className="flex flex-1 justify-end gap-px">
          {bars.map((status, index) => (
            <span key={index} className={`h-2.5 w-1 rounded-sm ${statusTone(status)}`} />
          ))}
        </span>
      </div>
      {job.autoDisabledReason ? (
        <div className="mt-1.5 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[10px] leading-4 text-destructive">
          {job.autoDisabledReason}
        </div>
      ) : null}
    </button>
  );
}

/** 运行流的一行。动作链缩略来自 run.steps，点开展日志与逐步耗时。 */
function RunRow({
  run, jobName, showJobName, expanded, onToggle,
}: {
  run: ScheduledJobRun;
  jobName: string;
  /** 只看一个任务时每行都印同一个名字，12 行全是被截断的同一串字——那列该消失。 */
  showJobName: boolean;
  expanded: boolean;
  onToggle: () => void;
}): JSX.Element {
  const bad = run.status === 'failed';
  return (
    <div className={`border-b border-[hsl(var(--hairline))]/70 ${bad ? 'bg-destructive/[0.08]' : ''}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-2 text-left">
        <span className={`h-5 w-[3px] shrink-0 rounded-sm ${statusTone(run.status)}`} />
        <span className="w-11 shrink-0 font-mono text-[11px] text-muted-foreground">{formatClock(run.startedAt || run.queuedAt)}</span>
        {showJobName
          ? <span className={`min-w-0 max-w-[11rem] flex-1 truncate text-[12.5px] font-medium ${bad ? 'text-bad' : ''}`}>{jobName}</span>
          : null}
        <span className={`shrink-0 rounded px-1.5 py-px text-[10.5px] ${run.trigger === 'manual' ? 'border border-info/30 bg-info-soft text-info' : 'border border-[hsl(var(--hairline-strong))] text-muted-foreground'}`}>
          {run.trigger === 'manual' ? '手动' : run.trigger === 'push' ? 'push' : '定时'}
        </span>
        <span className="hidden shrink-0 items-center gap-0.5 sm:flex">
          {(run.steps || []).map((step) => (
            <span key={step.index} title={`${step.index}. ${step.name}`} className={`h-1.5 w-1.5 rounded-sm ${statusTone(step.status)}`} />
          ))}
        </span>
        {/* 名字列缺席时，弹性空档要留在这里而不是名字原来的位置，
            否则「定时」和耗时之间会裂开一条几百像素的空白。 */}
        {showJobName ? null : <span className="flex-1" />}
        <span className="w-14 shrink-0 text-right font-mono text-[11px] text-foreground-muted">{formatDuration(run.durationMs)}</span>
        <span className={`w-14 shrink-0 text-right font-mono text-[11px] ${bad ? 'text-bad' : run.status === 'skipped' ? 'text-warn' : 'text-ok'}`}>
          {run.httpStatus ? run.httpStatus : run.exitCode !== undefined ? `exit ${run.exitCode}` : runStatusLabel(run.status)}
        </span>
      </button>

      {expanded ? (
        <div className="px-4 pb-3 pl-[3.4rem]">
          {run.steps && run.steps.length > 0 ? (
            <div className="mb-2 space-y-1">
              {run.steps.map((step) => (
                <div key={step.index} className="flex items-center gap-2 rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/60 px-2 py-1">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-sm ${statusTone(step.status)}`} />
                  <span className="font-mono text-[10px] text-muted-foreground">{step.index}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px]">{step.name}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                    {step.status === 'not-run' ? '未执行' : formatDuration(step.durationMs)}
                    {step.httpStatus ? ` · ${step.httpStatus}` : step.exitCode !== undefined ? ` · exit ${step.exitCode}` : ''}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {run.error ? <div className="mb-2 text-[11.5px] text-destructive">{run.error}</div> : null}
          {run.log ? (
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-2 font-mono text-[11px] leading-5 text-muted-foreground">
              {run.log}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 选中任务的概览。观察态默认，编辑是显式动作。 */
/**
 * 详情头：名字 + 归属 + 主操作。
 * 操作从底部满宽橙条搬到这里——那条按钮在 420px 侧栏里是「填满宽度的主操作」，
 * 拉到 1080px 就成了整屏最响的东西，而这一页的主要行为是**读状态**不是执行。
 */
function JobDetailHeader({
  job, projectLabel, scheduleText, running, onRun, onEdit, onBack,
}: {
  job: ScheduledJob;
  projectLabel: string;
  scheduleText: string;
  running: boolean;
  onRun: () => void;
  onEdit: () => void;
  onBack: () => void;
}): JSX.Element {
  const disabled = Boolean(job.autoDisabledReason) || !job.enabled;
  return (
    /*
     * 窄屏（375-390px）下三个带文字的按钮 shrink-0 挤在标题同一行里，
     * 合起来就吃掉整条详情栏：标题被压没，最后一个按钮还会被外层
     * overflow-hidden 裁掉（Codex #1471 P2）。
     * 按 cds mobile-layout-fallback：默认竖向堆叠、按钮自成一行并允许换行，
     * sm 起再叠回单行。桌面观感零变化。
     */
    <div className="flex shrink-0 flex-col gap-2 border-b border-[hsl(var(--hairline))] px-4 py-2.5 sm:flex-row sm:items-center sm:gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold">{job.name}</span>
          {disabled ? (
            <span className="shrink-0 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-px text-[10.5px] font-semibold text-destructive">已停用</span>
          ) : null}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <span className="truncate">{projectLabel}</span>
          <span className="text-[hsl(var(--hairline-strong))]">·</span>
          <span className="truncate">{scheduleText}</span>
        </div>
      </div>
      <div className="hidden flex-1 sm:block" />
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
        <Button size="sm" onClick={onRun} disabled={running}>
          <Play />
          {running ? '执行中' : '立即执行'}
        </Button>
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil />
          编辑配置
        </Button>
        <Button variant="ghost" size="sm" onClick={onBack}>返回值班概览</Button>
      </div>
    </div>
  );
}


/**
 * 详情体：指标条 + 健康条 + 动作链。
 * 指标不再是 1 个异形大块 + 2x2 小卡：那套尺度是给 420px 侧栏画的，拉宽之后
 * 每张卡有 460px 却只装两行字。改成与顶部值班条同构的一行分栏——同一页里
 * 重复一种节奏，比再发明第三种容器好。
 */
function JobOverview({
  job, scheduleText, countdown, health, onEdit,
}: {
  job: ScheduledJob;
  scheduleText: string;
  countdown: string;
  health: JobHealth;
  onEdit: () => void;
}): JSX.Element {
  const disabled = Boolean(job.autoDisabledReason) || !job.enabled;
  const actions: ScheduledJobAction[] = job.actions && job.actions.length > 0
    ? job.actions
    : (job.target ? [{ ...job.target, id: 'legacy' }] : []);
  const stats = [
    {
      label: disabled ? '已停用' : '下次触发',
      value: disabled ? '——:——' : countdown,
      tone: disabled ? 'text-muted-foreground' : 'text-primary-ink',
    },
    {
      label: `近 ${health.total} 次`,
      value: health.successRate === null ? '—' : `${health.successRate}%`,
      tone: health.successRate !== null && health.successRate < 100 ? 'text-warn' : 'text-ok',
    },
    { label: 'P50 耗时', value: formatDuration(health.p50Ms), tone: 'text-foreground' },
    { label: '连续成功', value: String(health.streak), tone: 'text-ok' },
    {
      label: '连续失败',
      value: String(job.consecutiveFailureCount || 0),
      tone: (job.consecutiveFailureCount || 0) > 0 ? 'text-bad' : 'text-muted-foreground',
    },
  ];
  return (
    <>
      <div className="flex shrink-0 items-stretch border-b border-[hsl(var(--hairline))]">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0 flex-1 border-r border-[hsl(var(--hairline))] px-4 py-2 last:border-r-0">
            <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{stat.label}</div>
            <div className={`mt-0.5 truncate font-mono text-[15px] font-semibold leading-tight ${stat.tone}`}>{stat.value}</div>
          </div>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {health.bars.length > 0 ? (
          <div className="flex items-center gap-2.5">
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">最近 {health.bars.length} 次</span>
            {/* 原来是 h-6 flex-1 的大方块：拉宽后每格 105px，像被切碎的进度条而不是走势。 */}
            <div className="flex items-end gap-[2px]">
              {health.bars.map((status, index) => (
                <span
                  key={index}
                  className={`h-3.5 w-2 rounded-[1px] ${statusTone(status)}`}
                  style={{ opacity: 0.45 + (index / Math.max(1, health.bars.length - 1)) * 0.55 }}
                />
              ))}
            </div>
            <span className="shrink-0 text-[10.5px] text-muted-foreground">越靠右越新</span>
          </div>
        ) : null}

        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">动作链</span>
            <span className="font-mono text-[10px] text-muted-foreground">{actions.length}</span>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-primary/40 bg-primary-soft">
              <AlarmClock className="h-3.5 w-3.5 text-primary-ink" />
            </span>
            <span className="text-[12.5px] text-foreground-muted">{scheduleText}</span>
          </div>
          {actions.map((action, index) => (
            <div key={action.id || index}>
              <div className="ml-[0.85rem] h-3 w-px bg-[hsl(var(--hairline-strong))]" />
              <div className="flex items-center gap-2.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/55 px-2.5 py-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--hairline-strong))] font-mono text-[11.5px] font-semibold">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`shrink-0 rounded px-1.5 py-px text-[9.5px] ${action.type === 'http' ? 'bg-info-soft text-info' : action.type === 'release' ? 'bg-primary-soft text-primary-ink' : 'bg-[hsl(var(--hairline))] text-foreground-muted'}`}>
                      {action.type === 'http' ? 'HTTP' : action.type === 'release' ? '发布' : '命令'}
                    </span>
                    <span className="truncate text-[12.5px] font-medium">{actionTitle(actionFromTarget(action))}</span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-foreground">{actionDescription(actionFromTarget(action))}</div>
                </div>
              </div>
            </div>
          ))}
          {/* 链尾给一个真入口，而不是留一段死空白：它开的就是编辑浮层。 */}
          <div className="ml-[0.85rem] h-3 w-px bg-[hsl(var(--hairline-strong))]" />
          <button
            type="button"
            onClick={onEdit}
            className="flex w-full items-center gap-2.5 rounded-md border border-dashed border-[hsl(var(--hairline-strong))] px-2.5 py-2 text-left text-[12.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary-ink"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-dashed border-[hsl(var(--hairline-strong))]">
              <Plus className="h-3.5 w-3.5" />
            </span>
            在这一步之后添加动作
          </button>
        </div>

        {job.autoDisabledReason ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5">
            <div className="text-[12px] font-medium leading-5 text-destructive">已自动停用</div>
            <div className="mt-1 text-[11.5px] leading-5 text-muted-foreground">{job.autoDisabledReason}</div>
          </div>
        ) : null}
      </div>
    </>
  );
}
