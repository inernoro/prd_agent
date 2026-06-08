import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Trash2, Link2, AlertTriangle, MessageSquare, ListTree, ClipboardList } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import {
  getPmProject, updatePmTask, deletePmTask, createPmTask, getPmTaskActivities, addPmTaskComment, getPmMembers,
  listPmMilestones, listPmGoals,
} from '@/services';
import type {
  PmMember, PmMilestone, PmGoal, PmTask, PmTaskStatus, PmTaskPriority, PmTaskActivity, PmProject,
} from '@/services/contracts/pmAgent';
import { TASK_STATUS_REGISTRY, PRIORITY_REGISTRY, progressColor } from './pmConstants';
import { TaskWorkLogPanel } from './TaskWorkLogPanel';

const FIELD_LABEL: Record<string, string> = { status: '状态', priority: '优先级', assignee: '负责人', title: '标题', progress: '进度' };
const codeLabel = (field: string, v?: string | null) => {
  if (v == null || v === '') return '空';
  if (field === 'status') return TASK_STATUS_REGISTRY[v as PmTaskStatus]?.label ?? v;
  if (field === 'priority') return PRIORITY_REGISTRY[v as PmTaskPriority]?.label ?? v;
  if (field === 'progress') return `${v}%`;
  return v;
};
const fmtTime = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const STATUSES: PmTaskStatus[] = ['backlog', 'todo', 'in_progress', 'done', 'cancelled'];
const PRIORITIES: PmTaskPriority[] = ['urgent', 'high', 'medium', 'low', 'none'];
const toDateInput = (iso?: string | null) => (iso ? iso.slice(0, 10) : '');
const fromDateInput = (v: string) => (v ? new Date(v + 'T00:00:00').toISOString() : undefined);

/**
 * 任务独立详情页（全屏路由 /pm-agent/p/:projectId/task/:taskId）。
 * 双轨之一：抽屉做看板快速编辑，本页做深度编辑（工作日志 / 子任务 / 进度 / 动态）。
 * 布局遵守 full-height-layout.md：根 h-screen min-h-0 flex flex-col，滚动落到内容层。
 */
export function TaskDetailPage() {
  const navigate = useNavigate();
  const { projectId = '', taskId = '' } = useParams();

  const [project, setProject] = useState<PmProject | null>(null);
  const [allTasks, setAllTasks] = useState<PmTask[]>([]);
  const [milestones, setMilestones] = useState<PmMilestone[]>([]);
  const [goals, setGoals] = useState<PmGoal[]>([]);
  const [loading, setLoading] = useState(true);

  const task = useMemo(() => allTasks.find((t) => t.id === taskId) ?? null, [allTasks, taskId]);
  const children = useMemo(() => allTasks.filter((t) => t.parentTaskId === taskId), [allTasks, taskId]);
  const parentTask = useMemo(() => (task?.parentTaskId ? allTasks.find((t) => t.id === task.parentTaskId) ?? null : null), [allTasks, task]);
  const hasChildren = children.length > 0;

  // 编辑态
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<PmTaskStatus>('backlog');
  const [priority, setPriority] = useState<PmTaskPriority>('none');
  const [assigneeId, setAssigneeId] = useState('');
  const [milestoneId, setMilestoneId] = useState('');
  const [goalId, setGoalId] = useState('');
  const [estimateDays, setEstimateDays] = useState('');
  const [startAt, setStartAt] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [labels, setLabels] = useState('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [saving, setSaving] = useState(false);

  // 子任务 / 动态
  const [subTitle, setSubTitle] = useState('');
  const [attachId, setAttachId] = useState('');
  const [activities, setActivities] = useState<PmTaskActivity[]>([]);
  const [comment, setComment] = useState('');
  const [members, setMembers] = useState<PmMember[]>([]);
  const [mentioned, setMentioned] = useState<Record<string, string>>({});
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const commentRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [pres, mres, gres] = await Promise.all([getPmProject(projectId), listPmMilestones(projectId), listPmGoals(projectId)]);
    if (pres.success) { setProject(pres.data.project); setAllTasks(pres.data.tasks); }
    else toast.error('加载失败', pres.error?.message || '');
    if (mres.success) setMilestones(mres.data.items);
    if (gres.success) setGoals(gres.data.items);
    setLoading(false);
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  const loadActivities = useCallback(async () => {
    if (!taskId) return;
    const res = await getPmTaskActivities(taskId);
    if (res.success) setActivities(res.data.items);
  }, [taskId]);
  useEffect(() => { loadActivities(); }, [loadActivities]);
  useEffect(() => { getPmMembers(projectId).then((res) => { if (res.success) setMembers(res.data.members); }); }, [projectId]);

  // task 加载后回填编辑态
  useEffect(() => {
    if (!task) return;
    setTitle(task.title);
    setDescription(task.description ?? '');
    setStatus(task.status);
    setPriority(task.priority);
    setAssigneeId(task.assigneeId ?? '');
    setMilestoneId(task.milestoneId ?? '');
    setGoalId(task.goalId ?? '');
    setEstimateDays(task.estimateDays != null ? String(task.estimateDays) : '');
    setStartAt(toDateInput(task.startAt));
    setDueAt(toDateInput(task.dueAt));
    setLabels((task.labels ?? []).join(', '));
    setDependsOn(task.dependsOn ?? []);
    setProgress(task.progressPercent ?? 0);
  }, [task]);

  const taskById = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks]);
  const depCandidates = useMemo(() => allTasks.filter((t) => t.id !== taskId && t.parentTaskId !== taskId), [allTasks, taskId]);
  const blockedBy = useMemo(
    () => dependsOn.map((id) => taskById.get(id)).filter((d) => d && d.status !== 'done' && d.status !== 'cancelled'),
    [dependsOn, taskById],
  );

  const mentionMatches = mentionQuery === null ? [] : members.filter((m) => m.displayName.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6);
  const onCommentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value; setComment(val);
    const caret = e.target.selectionStart ?? val.length;
    const m = val.slice(0, caret).match(/@([^\s@]*)$/);
    setMentionQuery(m ? m[1] : null);
  };
  const pickMention = (mb: PmMember) => {
    const el = commentRef.current;
    const caret = el?.selectionStart ?? comment.length;
    const before = comment.slice(0, caret).replace(/@([^\s@]*)$/, `@${mb.displayName} `);
    setComment(before + comment.slice(caret));
    setMentioned((prev) => ({ ...prev, [mb.userId]: mb.displayName }));
    setMentionQuery(null);
    requestAnimationFrame(() => { el?.focus(); const pos = before.length; el?.setSelectionRange(pos, pos); });
  };
  const postComment = async () => {
    if (!comment.trim()) return;
    const ids = Object.entries(mentioned).filter(([, name]) => comment.includes(`@${name}`)).map(([uid]) => uid);
    const res = await addPmTaskComment(taskId, comment.trim(), ids);
    if (res.success) { setComment(''); setMentioned({}); setMentionQuery(null); loadActivities(); } else toast.error('评论失败', res.error?.message || '');
  };

  const parentIdSet = useMemo(() => new Set(allTasks.filter((t) => t.parentTaskId).map((t) => t.parentTaskId!)), [allTasks]);
  const attachCandidates = useMemo(
    () => allTasks.filter((t) => t.id !== taskId && t.parentTaskId == null && !parentIdSet.has(t.id)),
    [allTasks, taskId, parentIdSet],
  );

  const addSubtask = async () => {
    if (!subTitle.trim()) return;
    const res = await createPmTask(projectId, { title: subTitle.trim(), parentTaskId: taskId, status: 'todo' });
    if (res.success) { setSubTitle(''); load(); } else toast.error('创建子任务失败', res.error?.message || '');
  };
  const attachSubtask = async () => {
    if (!attachId) return;
    const res = await updatePmTask(attachId, { parentTaskId: taskId });
    if (res.success) { setAttachId(''); load(); } else toast.error('挂载子任务失败', res.error?.message || '');
  };
  const toggleSubDone = async (sub: PmTask) => {
    const next: PmTaskStatus = sub.status === 'done' ? 'todo' : 'done';
    const res = await updatePmTask(sub.id, { status: next });
    if (res.success) load(); else toast.error('更新失败', res.error?.message || '');
  };

  const save = async () => {
    if (!title.trim()) { toast.warning('请填写标题', ''); return; }
    if ((status === 'in_progress' || status === 'done') && blockedBy.length > 0) {
      const ok = window.confirm(`该任务有 ${blockedBy.length} 个前置任务尚未完成（${blockedBy.map((d) => d!.title).join('、')}），确定标记为「${TASK_STATUS_REGISTRY[status].label}」吗？`);
      if (!ok) return;
    }
    setSaving(true);
    const res = await updatePmTask(taskId, {
      title: title.trim(), description: description.trim(), status, priority, assigneeId,
      estimateDays: estimateDays === '' ? undefined : Number(estimateDays),
      startAt: fromDateInput(startAt), dueAt: fromDateInput(dueAt),
      labels: labels.split(',').map((l) => l.trim()).filter(Boolean),
      dependsOn, milestoneId, goalId,
      // 父任务进度自动汇总，不手动提交；仅叶子任务提交手填进度
      ...(hasChildren ? {} : { progressPercent: progress }),
    });
    setSaving(false);
    if (res.success) { toast.success('已保存', ''); load(); loadActivities(); }
    else toast.error('保存失败', res.error?.message || '');
  };

  const remove = async () => {
    if (!window.confirm('确定删除该任务（含子任务）？')) return;
    const res = await deletePmTask(taskId);
    if (res.success) { toast.success('已删除', ''); navigate(`/pm-agent`); }
    else toast.error('删除失败', res.error?.message || '');
  };

  const toggleDep = (id: string) => setDependsOn((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const labelCls = 'text-[11px] font-medium mb-1 block';
  const inputCls = 'w-full rounded-lg px-3 py-2 text-[13px] outline-none border';
  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' };
  const cardStyle = { background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' };
  const sectionTitle = 'text-[12px] font-semibold mb-2 flex items-center gap-1.5';

  if (loading) return <div className="h-screen flex items-center justify-center" style={{ background: 'var(--bg-primary)' }}><MapSectionLoader text="正在加载任务…" /></div>;
  if (!task) {
    return (
      <div className="h-screen flex flex-col items-center justify-center gap-3" style={{ background: 'var(--bg-primary)' }}>
        <div style={{ color: 'var(--text-secondary)' }}>任务不存在或已被删除</div>
        <Button variant="secondary" onClick={() => navigate('/pm-agent')}>返回项目管理</Button>
      </div>
    );
  }

  return (
    <div className="h-screen min-h-0 flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <button onClick={() => navigate(`/pm-agent?project=${projectId}`)} className="flex items-center justify-center w-8 h-8 rounded-lg border hover:opacity-70 shrink-0"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} title="返回项目">
          <ArrowLeft size={16} />
        </button>
        <div className="min-w-0">
          <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
            {project?.title ?? '项目'}{parentTask ? ` / ${parentTask.title}` : ''}
          </div>
          <div className="text-[15px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{task.title}</div>
        </div>
        {task.source === 'ai_decompose' && <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(168,85,247,0.15)', color: '#A855F7' }}>AI 拆解</span>}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button onClick={remove} className="p-1.5 rounded hover:opacity-70" style={{ color: '#EF4444' }} title="删除任务"><Trash2 size={16} /></button>
          <Button variant="primary" onClick={save} disabled={saving}>{saving ? <MapSpinner size={14} /> : null}保存</Button>
        </div>
      </div>

      {/* Body：左主栏 + 右属性栏 */}
      <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 360px' }}>
        {/* 左主栏 */}
        <div className="min-h-0 overflow-y-auto px-6 py-5 flex flex-col gap-5" style={{ overscrollBehavior: 'contain' }}>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>标题</label>
            <input className={inputCls} style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>描述</label>
            <textarea className={inputCls} style={{ ...inputStyle, resize: 'vertical', minHeight: 96 }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="任务说明 / 交付物" />
          </div>

          {/* 工作日志 */}
          <div className="rounded-xl border p-4" style={cardStyle}>
            <div className={sectionTitle} style={{ color: 'var(--text-primary)' }}><ClipboardList size={14} /> 工作日志</div>
            <TaskWorkLogPanel taskId={taskId} onProgressLogged={() => load()} />
          </div>

          {/* 动态 / 评论 */}
          <div className="rounded-xl border p-4" style={cardStyle}>
            <div className={sectionTitle} style={{ color: 'var(--text-primary)' }}><MessageSquare size={14} /> 动态与评论</div>
            <div className="flex items-center gap-1.5 mb-2">
              <div className="relative flex-1">
                <input ref={commentRef} className="w-full rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle}
                  value={comment} onChange={onCommentChange}
                  onKeyDown={(e) => {
                    if (mentionQuery !== null && mentionMatches.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) { e.preventDefault(); pickMention(mentionMatches[0]); return; }
                    if (e.key === 'Escape' && mentionQuery !== null) { e.preventDefault(); setMentionQuery(null); return; }
                    if (e.key === 'Enter') postComment();
                  }}
                  placeholder="写评论，输入 @ 提醒成员，回车发送" />
                {mentionQuery !== null && mentionMatches.length > 0 && (
                  <div className="absolute left-0 bottom-full mb-1 z-10 rounded-lg border py-1 shadow-lg" style={{ minWidth: 180, background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }}>
                    {mentionMatches.map((mb) => (
                      <button key={mb.userId} onClick={() => pickMention(mb)} className="w-full text-left px-3 py-1.5 text-[12px] hover:opacity-80" style={{ color: 'var(--text-primary)' }}>@{mb.displayName}</button>
                    ))}
                  </div>
                )}
              </div>
              <Button variant="secondary" size="sm" onClick={postComment} disabled={!comment.trim()}>发送</Button>
            </div>
            <div className="flex flex-col gap-2">
              {activities.length === 0 && <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无动态</div>}
              {activities.map((a) => (
                <div key={a.id} className="text-[11.5px]">
                  <div className="flex items-center gap-1.5">
                    <span style={{ color: 'var(--text-secondary)' }}>{a.userName || '用户'}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{fmtTime(a.createdAt)}</span>
                  </div>
                  {a.type === 'comment' ? (
                    <div className="mt-0.5 px-2 py-1 rounded" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>{a.content}</div>
                  ) : (
                    <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      将{FIELD_LABEL[a.field || ''] || a.field} 从「{codeLabel(a.field || '', a.fromValue)}」改为「{codeLabel(a.field || '', a.toValue)}」
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 右属性栏 */}
        <div className="min-h-0 overflow-y-auto px-5 py-5 flex flex-col gap-4 border-l" style={{ borderColor: 'var(--border-subtle)', overscrollBehavior: 'contain' }}>
          {/* 进度 */}
          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>进度 {hasChildren ? '（由子任务自动汇总）' : ''}</label>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-input)' }}>
                <div className="h-full rounded-full" style={{ width: `${status === 'done' ? 100 : progress}%`, background: progressColor(progress, status) }} />
              </div>
              <span className="text-[12px] font-medium w-9 text-right" style={{ color: 'var(--text-primary)' }}>{status === 'done' ? 100 : progress}%</span>
            </div>
            {!hasChildren && (
              <input type="range" min={0} max={100} step={5} value={progress} onChange={(e) => setProgress(Number(e.target.value))}
                className="w-full mt-2" style={{ accentColor: progressColor(progress, status) }} disabled={status === 'done'} />
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>状态</label>
              <select className={inputCls} style={inputStyle} value={status} onChange={(e) => setStatus(e.target.value as PmTaskStatus)}>
                {STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_REGISTRY[s].label}</option>)}
              </select>
            </div>
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>优先级</label>
              <select className={inputCls} style={inputStyle} value={priority} onChange={(e) => setPriority(e.target.value as PmTaskPriority)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_REGISTRY[p].label}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>负责人</label>
            <UserSearchSelect value={assigneeId} onChange={setAssigneeId} placeholder="搜索用户名或昵称…" />
          </div>

          {milestones.length > 0 && (
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>所属里程碑</label>
              <select className={inputCls} style={inputStyle} value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
                <option value="">未归属</option>
                {milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
            </div>
          )}
          {goals.length > 0 && (
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>所属目标</label>
              <select className={inputCls} style={inputStyle} value={goalId} onChange={(e) => setGoalId(e.target.value)}>
                <option value="">未归属</option>
                {goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>开始</label>
              <input type="date" className={inputCls} style={inputStyle} value={startAt} onChange={(e) => setStartAt(e.target.value)} />
            </div>
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>截止</label>
              <input type="date" className={inputCls} style={inputStyle} value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
            </div>
            <div>
              <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>工时(人天)</label>
              <input type="number" min={0} step={0.5} className={inputCls} style={inputStyle} value={estimateDays} onChange={(e) => setEstimateDays(e.target.value)} />
            </div>
          </div>

          <div>
            <label className={labelCls} style={{ color: 'var(--text-secondary)' }}>标签（逗号分隔）</label>
            <input className={inputCls} style={inputStyle} value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="如：前端, 设计" />
          </div>

          {/* 子任务 */}
          <div>
            <div className={sectionTitle} style={{ color: 'var(--text-secondary)' }}>
              <ListTree size={13} /> 子任务{hasChildren ? `（${children.filter((c) => c.status === 'done').length}/${children.length}）` : ''}
            </div>
            <div className="flex flex-col gap-1">
              {children.map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-[12px] px-2 py-1.5 rounded" style={{ background: 'var(--bg-base)' }}>
                  <input type="checkbox" checked={c.status === 'done'} onChange={() => toggleSubDone(c)} style={{ accentColor: '#10B981' }} />
                  <button onClick={() => navigate(`/pm-agent/p/${projectId}/task/${c.id}`)} className="truncate text-left hover:underline"
                    style={{ color: 'var(--text-primary)', textDecoration: c.status === 'done' ? 'line-through' : 'none', opacity: c.status === 'done' ? 0.6 : 1 }}>{c.title}</button>
                  <span className="ml-auto text-[10px]" style={{ color: progressColor(c.progressPercent ?? 0, c.status) }}>{c.status === 'done' ? 100 : (c.progressPercent ?? 0)}%</span>
                </div>
              ))}
              {parentTask ? (
                <div className="text-[11px] py-1" style={{ color: 'var(--text-muted)' }}>子任务不能再有下级（仅支持两级）</div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5">
                    <input className="flex-1 rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle}
                      value={subTitle} onChange={(e) => setSubTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addSubtask(); }} placeholder="新建子任务，回车确认" />
                    <Button variant="secondary" size="sm" onClick={addSubtask} disabled={!subTitle.trim()}>新建</Button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <select className="flex-1 rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle} value={attachId} onChange={(e) => setAttachId(e.target.value)}>
                      <option value="">选择已有任务挂为子任务…</option>
                      {attachCandidates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                    </select>
                    <Button variant="secondary" size="sm" onClick={attachSubtask} disabled={!attachId}>挂载</Button>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* 依赖 */}
          <div>
            <div className={sectionTitle} style={{ color: 'var(--text-secondary)' }}><Link2 size={13} /> 前置依赖</div>
            {blockedBy.length > 0 && (
              <div className="text-[11px] mb-1.5 flex items-center gap-1" style={{ color: '#F59E0B' }}><AlertTriangle size={12} /> 有 {blockedBy.length} 个前置未完成（被阻塞）</div>
            )}
            <div className="rounded-lg border max-h-40 overflow-y-auto" style={{ borderColor: 'var(--border-subtle)' }}>
              {depCandidates.length === 0 ? (
                <div className="text-[11px] text-center py-3" style={{ color: 'var(--text-muted)' }}>无其他任务可依赖</div>
              ) : depCandidates.map((t) => (
                <label key={t.id} className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer text-[12px]" style={{ color: 'var(--text-primary)' }}>
                  <input type="checkbox" checked={dependsOn.includes(t.id)} onChange={() => toggleDep(t.id)} style={{ accentColor: '#3B82F6' }} />
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: TASK_STATUS_REGISTRY[t.status].color }} />
                  <span className="truncate">{t.title}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
