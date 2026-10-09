import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClipboardList, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import {
  ACCEPTANCE_STATUS_LABELS, acceptanceReportLink, acceptanceTaskLink, archiveAcceptanceReport, bindAcceptanceReport,
  claimAcceptanceTask, completeAcceptanceTask, createAcceptanceTask, generateAcceptanceReport, getAcceptanceMatrix,
  getAcceptanceTask, heartbeatAcceptanceTask, latestAcceptanceTemplates, listAcceptanceTasks, listAcceptanceTemplates, publishAcceptanceTemplate,
  releaseAcceptanceTask, submitAcceptanceResult,
} from '@/lib/acceptance-api';
import type { AcceptanceEnvironment, AcceptanceMatrix, AcceptanceReportDraft, AcceptanceSubmission, AcceptanceTask, AcceptanceTemplate, AcceptanceView } from '@/lib/acceptance-api';
import { ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { AcceptanceField, AcceptanceTemplateEditor, acceptanceInputClass, normalizeAcceptanceCases } from './AcceptanceTemplateEditor';
import { AcceptanceResultEditor } from './AcceptanceResultEditor';
import { AcceptanceChecklist, AcceptanceStatus } from './AcceptanceChecklist';

export const ACCEPTANCE_TABS: Array<{ id: AcceptanceView; label: string }> = [
  { id: 'templates', label: '测试清单' }, { id: 'tasks', label: '执行任务' }, { id: 'matrix', label: '历史矩阵' }, { id: 'reports', label: '验收报告' },
];

export function AcceptanceNavigation({ view, onChange }: { view: AcceptanceView; onChange: (view: AcceptanceView) => void }): JSX.Element {
  return <nav className="flex shrink-0 flex-wrap gap-1 border-b border-border pb-2" aria-label="验收中心导航">{ACCEPTANCE_TABS.map((tab) => <Button key={tab.id} size="sm" variant={view === tab.id ? 'secondary' : 'ghost'} aria-current={view === tab.id ? 'page' : undefined} onClick={() => onChange(tab.id)}>{tab.label}</Button>)}</nav>;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const messages: Record<number, string> = {
      401: '登录已失效，请重新登录后继续。', 403: '当前身份无此项目的验收权限，请联系项目负责人确认授权。',
      404: '所选验收记录不存在，请刷新清单后重新选择。',
      409: '版本或领取状态已变化，请刷新后重新领取；已有结果会保留。',
      400: '提交未通过校验，请检查必填项、通过断言、线上证据和清理结果后重试。',
      422: '提交未通过验收准入，请补齐真实业务结果、线上证据和清理回读后重试。',
    };
    if (messages[error.status]) return messages[error.status];
  }
  return '操作未完成，请刷新后重试；若仍失败请联系 CDS 管理员检查验收服务。';
}
const TASK_STATUS_LABELS: Record<AcceptanceTask['status'], string> = { pending: '待领取', running: '执行中', completed: '执行结束', cancelled: '已取消' };
export { AcceptanceStatus } from './AcceptanceChecklist';

export function AcceptanceSummaryCard({ task }: { task: AcceptanceTask }): JSX.Element {
  const summary = task.summary;
  return <div className="rounded-lg border border-border bg-card p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{task.title}</h2><p className="mt-1 text-sm text-muted-foreground">{task.environment === 'production' ? '正式环境' : 'CDS'} · 模板 v{task.templateVersion} · {TASK_STATUS_LABELS[task.status]}</p></div><span className={`rounded-md border px-3 py-2 text-sm font-semibold ${summary.gate === 'pass' ? 'border-primary/30 text-primary' : 'border-destructive/30 text-destructive'}`}>业务门禁：{summary.gate === 'pass' ? '通过' : '未通过'}</span></div><p className="mt-3 text-sm">计划 {summary.planned} · 已执行 {summary.executed} · 通过 {summary.pass} · 失败 {summary.fail} · 阻塞 {summary.blocked} · 未执行 {summary.notRun} · 不稳定 {summary.flaky}</p><p className="mt-2 text-xs text-muted-foreground">执行结束不等于验收通过；业务门禁不替代线上报告归档与 verify-open。</p><p className="mt-1 text-xs text-muted-foreground">报告：{task.report ? '已归档，线上打开待验证' : '尚未归档，报告未完成'}</p>{task.report ? <Link className="mt-2 inline-block text-sm text-primary underline" to={acceptanceReportLink(task.projectId, task.report.id)}>打开已归档报告</Link> : null}</div>;
}

export function AcceptanceMatrixTable({ matrix, projectId }: { matrix: AcceptanceMatrix; projectId: string }): JSX.Element {
  if (!matrix.tasks.length) return <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">尚无执行批次。先创建任务，逐项回填后即可比较历史结果。</p>;
  return <div className="max-w-full overflow-x-auto rounded-lg border border-border"><table className="w-full min-w-[40rem] border-collapse text-left text-sm"><thead className="bg-muted/50"><tr><th className="min-w-[15rem] border-b border-border p-3">重要功能／用例</th>{matrix.tasks.map((task) => <th className="min-w-[11rem] border-b border-border p-3 font-medium" key={task.id}><Link className="text-primary underline" to={acceptanceTaskLink(projectId, task.id)}>{task.title}</Link><p className="mt-1 text-xs font-normal text-muted-foreground">{task.environment === 'production' ? '正式环境' : 'CDS'} · {new Date(task.createdAt).toLocaleDateString()}</p><p className="mt-1 text-xs font-normal">业务门禁 {task.summary.gate === 'pass' ? '通过' : '未通过'}</p></th>)}</tr></thead><tbody>{matrix.rows.map((row) => <tr key={`${row.templateId}:${row.caseId}`}><th className="border-b border-border p-3 font-normal"><p className="font-medium">{row.title}</p><p className="mt-1 text-xs text-muted-foreground">{row.module} · {row.caseId} · {row.criticality === 'core' ? '核心必测' : '一般功能'}</p></th>{matrix.tasks.map((task) => { const cell = row.cells.find((value) => value.taskId === task.id); return <td className="border-b border-border p-3" key={`${row.templateId}:${row.caseId}:${task.id}`}>{cell?.applicable ? <Link to={acceptanceTaskLink(projectId, task.id, row.caseId)} aria-label={`${row.title} · ${task.title} · ${ACCEPTANCE_STATUS_LABELS[cell.status]}`}><AcceptanceStatus status={cell.status} flaky={cell.flaky} /></Link> : <span className="text-xs text-muted-foreground">不在本轮范围</span>}</td>; })}</tr>)}</tbody></table></div>;
}

interface Lease { taskId: string; token: string }

export function AcceptanceWorkspace({ projectId, projects, view, onProjectChange }: {
  projectId: string; projects: Array<{ id: string; name: string }>; view: Exclude<AcceptanceView, 'reports'>; onProjectChange: (id: string) => void;
}): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const taskId = searchParams.get('task') || '';
  const caseId = searchParams.get('case') || '';
  const [templates, setTemplates] = useState<AcceptanceTemplate[]>([]);
  const [tasks, setTasks] = useState<AcceptanceTask[]>([]);
  const [matrix, setMatrix] = useState<AcceptanceMatrix | null>(null);
  const [task, setTask] = useState<AcceptanceTask | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<AcceptanceTemplate | 'new' | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [environment, setEnvironment] = useState<AcceptanceEnvironment>('production');
  const [caseIds, setCaseIds] = useState<string[]>([]);
  const [taskTitle, setTaskTitle] = useState('');
  const [agentName, setAgentName] = useState('');
  const [lease, setLease] = useState<Lease | null>(null);
  const leaseRef = useRef<Lease | null>(null);
  const [reportDraft, setReportDraft] = useState<AcceptanceReportDraft | null>(null);
  const [pendingReportId, setPendingReportId] = useState('');
  const [bindReportId, setBindReportId] = useState('');
  const [matrixTemplate, setMatrixTemplate] = useState('');
  const [matrixEnvironment, setMatrixEnvironment] = useState<AcceptanceEnvironment | ''>('production');
  const requestGeneration = useRef(0);
  const activeTaskId = useRef(taskId);
  activeTaskId.current = taskId;
  const mounted = useRef(true);
  const pendingSubmissions = useRef(new Map<string, { signature: string; id: string }>());
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const updateTask = useCallback((next: AcceptanceTask) => { if (!mounted.current) return; if (activeTaskId.current === next.id) setTask(next); setTasks((current) => current.some((value) => value.id === next.id) ? current.map((value) => value.id === next.id ? next : value) : [next, ...current]); }, []);
  const clearLease = (): void => { leaseRef.current = null; setLease(null); };

  const load = useCallback(async (): Promise<void> => {
    if (!projectId) return;
    const generation = ++requestGeneration.current;
    setLoading(true); setError('');
    try {
      const [nextTemplates, nextTasks, nextMatrix] = await Promise.all([
        listAcceptanceTemplates(projectId), listAcceptanceTasks(projectId),
        view === 'matrix' ? getAcceptanceMatrix(projectId, matrixTemplate || undefined, matrixEnvironment || undefined) : Promise.resolve(null),
      ]);
      if (generation !== requestGeneration.current) return;
      const latestTemplates = latestAcceptanceTemplates(nextTemplates);
      setTemplates(latestTemplates); setTasks(nextTasks); if (nextMatrix) setMatrix(nextMatrix);
      setTemplateId((current) => latestTemplates.some((value) => value.id === current) ? current : latestTemplates[0]?.id ?? '');
    } catch (err) { if (generation === requestGeneration.current) setError(errorMessage(err)); }
    finally { if (generation === requestGeneration.current) setLoading(false); }
  }, [projectId, view, matrixTemplate, matrixEnvironment]);
  useEffect(() => { void load(); return () => { requestGeneration.current += 1; }; }, [load]);

  useEffect(() => {
    setTask(null); setReportDraft(null); setPendingReportId(''); setBindReportId('');
    if (!taskId || !projectId) return;
    let cancelled = false;
    getAcceptanceTask(taskId).then((next) => {
      if (cancelled) return;
      if (next.projectId !== projectId) { setError('该任务不属于当前项目，请选择任务所属项目。'); return; }
      updateTask(next);
    }).catch((err) => { if (!cancelled) setError(errorMessage(err)); });
    return () => { cancelled = true; };
  }, [taskId, projectId, updateTask]);

  useEffect(() => {
    if (caseId && task?.id === taskId) document.getElementById('acceptance-case-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [caseId, task?.id, taskId]);

  useEffect(() => {
    if (!lease) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      heartbeatAcceptanceTask(lease.taskId, lease.token).then((next) => { if (!cancelled) updateTask(next); }).catch((err) => {
        if (cancelled) return;
        leaseRef.current = null; setLease(null);
        setError(`领取心跳未完成，已停止回填。${errorMessage(err)} 请重新领取后从已保存结果继续。`);
      });
    }, 30_000);
    return () => {
      cancelled = true; window.clearInterval(timer);
      if (leaseRef.current?.token === lease.token) { leaseRef.current = null; void releaseAcceptanceTask(lease.taskId, lease.token).catch(() => undefined); }
    };
  }, [lease, updateTask]);

  useEffect(() => {
    if (lease && lease.taskId !== taskId) { const previous = lease; clearLease(); void releaseAcceptanceTask(previous.taskId, previous.token).catch(() => undefined); }
  }, [taskId, lease]);

  const selectedTemplate = templates.find((value) => value.id === templateId);
  useEffect(() => { setCaseIds(selectedTemplate?.cases.filter((value) => value.environments.includes(environment)).map((value) => value.caseId) ?? []); }, [selectedTemplate, environment]);
  const selectTask = (id: string): void => { const next = new URLSearchParams(searchParams); next.set('view', 'tasks'); next.set('task', id); next.delete('case'); next.delete('report'); setSearchParams(next); };
  const action = async (operation: () => Promise<void>): Promise<void> => { setBusy(true); setError(''); setNotice(''); try { await operation(); } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); } };

  const claimTask = async (): Promise<void> => {
    if (!task) return;
    const claimed = await claimAcceptanceTask(task.id, agentName.trim());
    if (!mounted.current || activeTaskId.current !== task.id) {
      await releaseAcceptanceTask(task.id, claimed.leaseToken);
      return;
    }
    const held = { taskId: task.id, token: claimed.leaseToken };
    leaseRef.current = held; setLease(held); updateTask(claimed.task);
  };

  const saveResult = async (id: string, draft: AcceptanceSubmission): Promise<void> => {
    if (!task || !lease || lease.taskId !== task.id) return;
    const key = `${task.id}:${id}`;
    const signature = JSON.stringify(draft);
    const previous = pendingSubmissions.current.get(key);
    const submissionId = previous?.signature === signature ? previous.id : crypto.randomUUID();
    pendingSubmissions.current.set(key, { signature, id: submissionId });
    const updated = await submitAcceptanceResult(task.id, id, { ...draft, leaseToken: lease.token, submissionId });
    pendingSubmissions.current.delete(key); updateTask(updated);
    if (activeTaskId.current === task.id) setNotice(`已保存 ${id}；业务汇总以服务端结果为准。`);
  };

  const archiveReport = async (): Promise<void> => {
    if (!task) return;
    let reportId = pendingReportId || task.report?.id;
    if (!reportId) {
      const generated = await generateAcceptanceReport(task.id); setReportDraft(generated.report);
      const report = await archiveAcceptanceReport(projectId, generated.report);
      reportId = report.id; setPendingReportId(reportId);
    }
    try {
      const bound = await bindAcceptanceReport(task.id, reportId); updateTask(bound); setPendingReportId('');
      setNotice('报告已线上归档；请打开实际深链执行 verify-open，未验证前交付仍未完成。');
    } catch (err) { setError(`报告绑定未完成；保留已创建的报告 ${reportId}，可直接重试绑定而不重复归档。${errorMessage(err)}`); }
  };

  if (!projectId) return <section className="flex min-h-[20rem] flex-col items-start justify-center gap-4 rounded-lg border border-dashed border-border bg-card p-6"><ClipboardList className="size-8 text-muted-foreground" /><h2 className="text-lg font-semibold">先选择项目，再建立核心功能验收表</h2><p className="max-w-2xl text-sm text-muted-foreground">测试清单、任务与历史结果按项目隔离。正式环境巡检不需要发布，也不要求指定分支或 commit。</p><AcceptanceField label="项目"><select className={`${acceptanceInputClass} min-w-[12rem]`} value="" onChange={(event) => onProjectChange(event.target.value)}><option value="">请选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></AcceptanceField></section>;

  return (
    <section className="flex min-h-0 flex-col gap-4 lg:flex-1" aria-label="结构化验收工作区">
      <div className="flex flex-wrap items-end justify-between gap-3"><div className="flex flex-wrap items-end gap-3"><AcceptanceField label="验收项目"><select className={acceptanceInputClass} value={projectId} onChange={(event) => onProjectChange(event.target.value)}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}{!projects.some((project) => project.id === projectId) ? <option value={projectId}>{projectId}</option> : null}</select></AcceptanceField><p className="max-w-2xl pb-2 text-xs text-muted-foreground">正式环境是巡检主体；CDS 只选少量核心项，不作为正式环境开测前置。</p></div><Button variant="outline" size="sm" disabled={loading || busy} onClick={() => void load()}><RefreshCw />刷新清单与结果</Button></div>
      {error ? <ErrorBlock message={error} /> : null}{notice ? <div role="status" className="rounded-md border border-border bg-muted/50 p-3 text-sm">{notice}</div> : null}
      {loading ? <LoadingBlock label="正在读取结构化验收记录" /> : null}
      {view === 'templates' ? editing ? <AcceptanceTemplateEditor key={editing === 'new' ? 'new' : `${editing.id}-${editing.version}`} template={editing === 'new' ? undefined : editing} busy={busy} onCancel={() => setEditing(null)} onPublish={(draft) => action(async () => { const template = await publishAcceptanceTemplate({ projectId, ...draft, cases: normalizeAcceptanceCases(draft.cases), ...(editing !== 'new' ? { templateId: editing.id, expectedVersion: editing.version } : {}) }); setEditing(null); setNotice(`已发布「${template.title}」v${template.version}；历史任务仍使用原快照。`); await load(); })} /> : <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">重要产品功能测试清单</h2><Button onClick={() => setEditing('new')}><Plus />新建测试清单</Button></div>{!loading && !templates.length ? <div className="rounded-lg border border-dashed border-border bg-card p-6"><h3 className="font-semibold">先建立一张可复用的验收评分表</h3><p className="my-3 text-sm text-muted-foreground">定义重要功能、真人操作步骤、通过断言、证据和清理要求；每轮创建新任务逐项填写，不覆盖历史。</p><Button onClick={() => setEditing('new')}><Plus />新建测试清单</Button></div> : null}{templates.map((template) => <article key={template.id} className="rounded-lg border border-border bg-card p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{template.title} <span className="text-xs text-muted-foreground">v{template.version}</span></h3><p className="mt-1 text-sm text-muted-foreground">{template.description}</p><p className="mt-2 text-xs text-muted-foreground">{template.cases.length} 项重要功能 · 发布于 {new Date(template.createdAt).toLocaleString()}</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => setEditing(template)}>编辑并发布新版本</Button><Button size="sm" onClick={() => { setTemplateId(template.id); setCreateOpen(true); const next = new URLSearchParams(searchParams); next.set('view', 'tasks'); next.delete('task'); next.delete('case'); setSearchParams(next); }}>创建验收任务</Button></div></div><div className="mt-3"><AcceptanceChecklist cases={template.cases} /></div></article>)}</div> : null}
      {view === 'tasks' ? <div className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">执行任务</h2><Button disabled={!templates.length || busy} onClick={() => setCreateOpen((current) => !current)}><Plus />创建验收任务</Button></div>
        {createOpen ? <section className="space-y-3 rounded-lg border border-border bg-card p-4" aria-label="创建验收任务"><div className="grid gap-3 md:grid-cols-3"><AcceptanceField label="测试清单版本"><select className={acceptanceInputClass} value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{templates.map((template) => <option key={template.id} value={template.id}>{template.title} v{template.version}</option>)}</select></AcceptanceField><AcceptanceField label="目标环境"><select className={acceptanceInputClass} value={environment} onChange={(event) => setEnvironment(event.target.value as AcceptanceEnvironment)}><option value="production">正式环境（默认）</option><option value="cds">CDS（少量核心项）</option></select></AcceptanceField><AcceptanceField label="本轮任务名称（可选）"><input className={acceptanceInputClass} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="系统自动命名" /></AcceptanceField></div><p className="text-xs text-muted-foreground">不要求分支、commit、发布或同轮 CDS 验证。任务使用此版本的不可变清单快照。</p><fieldset className="grid gap-2 md:grid-cols-2"><legend className="mb-2 text-sm font-medium">本轮执行范围</legend>{selectedTemplate?.cases.filter((value) => value.environments.includes(environment)).map((value) => <label key={value.caseId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={caseIds.includes(value.caseId)} onChange={(event) => setCaseIds((current) => event.target.checked ? [...current, value.caseId] : current.filter((id) => id !== value.caseId))} />{value.title} · {value.caseId}</label>)}</fieldset><div className="flex gap-2"><Button disabled={busy || !templateId || !caseIds.length} onClick={() => void action(async () => { const created = await createAcceptanceTask({ projectId, templateId, templateVersion: selectedTemplate?.version, environment, title: taskTitle.trim() || undefined, caseIds }); updateTask(created); setCreateOpen(false); selectTask(created.id); })}>创建本轮任务</Button><Button variant="ghost" onClick={() => setCreateOpen(false)}>取消</Button></div></section> : null}
        {!taskId ? <div className="space-y-3">{!loading && !tasks.length ? <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">暂无任务。{templates.length ? '选择测试清单，创建第一轮验收任务。' : '先在测试清单页建立验收标准。'}</p> : null}{tasks.map((value) => <article key={value.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4"><div><Link className="font-semibold text-primary underline" to={acceptanceTaskLink(projectId, value.id)}>{value.title}</Link><p className="mt-2 text-sm">{value.environment === 'production' ? '正式环境' : 'CDS'} · {TASK_STATUS_LABELS[value.status]} · 已执行 {value.summary.executed}/{value.summary.planned} · 领取人 {value.lease?.agentName || '无'}</p><p className="mt-1 text-xs text-muted-foreground">通过 {value.summary.pass} / 失败 {value.summary.fail} / 阻塞 {value.summary.blocked} / 未执行 {value.summary.notRun} / 不稳定 {value.summary.flaky}</p></div><Button variant="outline" size="sm" onClick={() => selectTask(value.id)}>查看与继续执行</Button></article>)}</div> : null}
        {taskId && !task && !error ? <LoadingBlock label="正在读取任务与已保存结果" /> : null}
        {task ? <><Button variant="ghost" size="sm" onClick={() => { const next = new URLSearchParams(searchParams); next.delete('task'); next.delete('case'); setSearchParams(next); }}>返回任务列表</Button><AcceptanceSummaryCard task={task} />
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">{task.status !== 'completed' && task.status !== 'cancelled' ? lease?.taskId === task.id ? <><p className="min-w-0 flex-1 text-sm">已领取：{task.lease?.agentName} · 自动心跳续租 · 到期 {task.lease ? new Date(task.lease.expiresAt).toLocaleTimeString() : '待更新'}</p><Button variant="outline" disabled={busy} onClick={() => void action(async () => { const held = lease; const released = await releaseAcceptanceTask(task.id, held.token); clearLease(); updateTask(released); })}>释放任务</Button><Button disabled={busy} onClick={() => void action(async () => { const completed = await completeAcceptanceTask(task.id, lease.token); clearLease(); updateTask(completed); setNotice('执行已结束。请检查业务门禁，并继续归档和验证线上报告。'); })}>结束执行</Button></> : <><div className="min-w-[12rem] flex-1"><AcceptanceField label="领取智能体／执行者名称"><input className={acceptanceInputClass} value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="例如：核心业务巡检 Agent" /></AcceptanceField></div><Button disabled={busy || !agentName.trim()} onClick={() => void action(claimTask)}>领取并开始执行</Button><p className="w-full text-xs text-muted-foreground">{task.lease ? `${task.lease.agentName} 当前持有租约；服务端只允许一个执行者领取。` : '领取后逐项回填；已保存记录可续跑。刷新页面需重新领取，租约票据不写入浏览器存储。'}</p></> : <p className="text-sm text-muted-foreground">任务已结束。记录只读保留，失败不因结束执行而变为通过。</p>}</div>
          <AcceptanceChecklist cases={task.cases} results={task.results} projectId={projectId} taskId={task.id} />
          {!caseId ? <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">上方就是本轮评分表。点击一项功能即可查看或填写该项，不必对照另一份执行清单。</p> : null}
          {task.cases.filter((value) => value.caseId === caseId).map((testCase) => <AcceptanceResultEditor key={`${task.id}-${testCase.caseId}-${task.results[testCase.caseId]?.submittedAt ?? 'new'}`} testCase={testCase} result={task.results[testCase.caseId]} writable={lease?.taskId === task.id && task.status === 'running'} busy={busy} onSave={(draft: AcceptanceSubmission) => action(() => saveResult(testCase.caseId, draft))} />)}
          {caseId && !task.cases.some((value) => value.caseId === caseId) ? <p role="alert" className="text-sm text-destructive">该用例不在此任务快照中，请选择上方的真实用例。</p> : null}
          <section className="space-y-3 rounded-lg border border-border bg-card p-4"><h3 className="font-semibold">执行报告与线上交付</h3><p className="text-sm text-muted-foreground">从已保存的结构化结果生成报告，按现有准入规则归档到验收报告；归档成功仍需 verify-open。</p><div className="flex flex-wrap gap-2"><Button disabled={busy || task.status !== 'completed'} onClick={() => void action(archiveReport)}>{pendingReportId ? '重试绑定已归档报告' : task.report ? '核对报告绑定' : '生成并归档报告'}</Button><Button variant="outline" disabled={busy} onClick={() => void action(async () => { const generated = await generateAcceptanceReport(task.id); setReportDraft(generated.report); })}>查看报告草稿</Button>{task.report ? <Button variant="outline" asChild><Link to={acceptanceReportLink(projectId, task.report.id)}>打开线上报告</Link></Button> : null}</div>{reportDraft ? <details className="rounded-md border border-border p-3"><summary className="cursor-pointer text-sm">报告草稿（不是交付结果）</summary><textarea aria-label="报告草稿" readOnly className={`${acceptanceInputClass} mt-3 min-h-[16rem] font-mono text-xs`} value={reportDraft.content} /><Button variant="outline" size="sm" className="mt-2" onClick={() => void action(async () => { await navigator.clipboard.writeText(reportDraft.content); setNotice('已复制草稿；草稿不代表线上归档或验证完成。'); })}>复制草稿供验收归档</Button></details> : null}<details className="text-sm"><summary className="cursor-pointer text-muted-foreground">恢复：绑定通过现有流程归档的报告</summary><div className="mt-3 flex flex-wrap items-end gap-2"><AcceptanceField label="已归档报告 ID"><input className={acceptanceInputClass} value={bindReportId} onChange={(event) => setBindReportId(event.target.value)} /></AcceptanceField><Button variant="outline" disabled={busy || !bindReportId.trim()} onClick={() => void action(async () => { updateTask(await bindAcceptanceReport(task.id, bindReportId.trim())); setNotice('已绑定线上报告，verify-open 仍待执行。'); })}>核验并绑定</Button></div><p className="mt-2 text-xs text-muted-foreground">服务端核对项目、任务来源、正文和线上存储；不能将本机草稿绑定为验收报告。</p></details></section>
        </> : null}
      </div> : null}
      {view === 'matrix' ? <div className="space-y-4"><div><h2 className="text-lg font-semibold">重要功能历史矩阵</h2><p className="mt-1 text-sm text-muted-foreground">每行一个重要功能，每列一个执行批次。核心失败不能被平均分抵消，未执行与业务失败分别显示。</p></div><div className="grid gap-3 md:grid-cols-2"><AcceptanceField label="测试清单筛选"><select className={acceptanceInputClass} value={matrixTemplate} onChange={(event) => setMatrixTemplate(event.target.value)}><option value="">全部清单</option>{templates.map((value) => <option key={value.id} value={value.id}>{value.title}</option>)}</select></AcceptanceField><AcceptanceField label="环境筛选"><select className={acceptanceInputClass} value={matrixEnvironment} onChange={(event) => setMatrixEnvironment(event.target.value as AcceptanceEnvironment | '')}><option value="production">正式环境（主体）</option><option value="cds">CDS</option><option value="">全部环境</option></select></AcceptanceField></div>{matrix && !loading ? <AcceptanceMatrixTable matrix={matrix} projectId={projectId} /> : null}</div> : null}
    </section>
  );
}
