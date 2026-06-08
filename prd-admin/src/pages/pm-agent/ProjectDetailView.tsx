import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Sparkles, Plus, LayoutGrid, List, GanttChartSquare, Trash2, Users, UserCog, Award, Search, CalendarClock, BookOpen, Gavel, FileText, NotebookText, Target, Milestone, FolderOpen, ShieldAlert, Stethoscope, TrendingDown } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import {
  getPmProject, updatePmTask, deletePmTask, updatePmProject, bulkPmTasks, listPmMilestones, listPmGoals, updatePmMilestone,
} from '@/services';
import type { PmProject, PmTask, PmTaskStatus, PmTaskPriority, PmMilestone, PmGoal } from '@/services/contracts/pmAgent';
import { KanbanBoard } from './KanbanBoard';
import { GanttChart } from './GanttChart';
import { DecomposePanel } from './DecomposePanel';
import { StakeholderPanel } from './StakeholderPanel';
import { MembersPanel } from './MembersPanel';
import { KnowledgePanel } from './KnowledgePanel';
import { DecisionsPanel } from './DecisionsPanel';
import { WeeklyReportsPanel } from './WeeklyReportsPanel';
import { MeetingsPanel } from './MeetingsPanel';
import { GoalsPanel } from './GoalsPanel';
import { MilestonesBar } from './MilestonesBar';
import { MilestonesPanel } from './MilestonesPanel';
import { RiskPanel } from './RiskPanel';
import { BurndownPanel } from './BurndownPanel';
import { ClosureReportPanel } from './ClosureReportPanel';
import { HealthDiagnosisPanel } from './HealthDiagnosisPanel';
import { EvaluatePanel } from './EvaluatePanel';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { PROJECT_TYPE_REGISTRY, LIFECYCLE_REGISTRY, TASK_STATUS_REGISTRY, PRIORITY_REGISTRY, GRADE_REGISTRY, progressColor } from './pmConstants';

interface Props {
  projectId: string;
  onBack: () => void;
}

type ViewTab = 'goals' | 'milestones' | 'tasks' | 'decisions' | 'risks' | 'report' | 'library' | 'members' | 'stakeholders';
type LibraryTab = 'weekly' | 'meetings' | 'knowledge';
type TaskViewMode = 'board' | 'list' | 'gantt';
type GroupBy = 'none' | 'assignee' | 'priority';

const TABS: { key: ViewTab; label: string; icon: typeof LayoutGrid }[] = [
  { key: 'goals', label: '目标', icon: Target },
  { key: 'milestones', label: '里程碑', icon: Milestone },
  { key: 'tasks', label: '任务', icon: LayoutGrid },
  { key: 'decisions', label: '决策', icon: Gavel },
  { key: 'risks', label: '风险', icon: ShieldAlert },
  { key: 'report', label: '报表', icon: TrendingDown },
  { key: 'library', label: '资料', icon: FolderOpen },
  { key: 'members', label: '成员', icon: UserCog },
  { key: 'stakeholders', label: '干系人', icon: Users },
];

// 「资料」二级子 tab（周报 / 会议纪要 / 知识库）
const LIBRARY_TABS: { key: LibraryTab; label: string; icon: typeof LayoutGrid }[] = [
  { key: 'weekly', label: '周报', icon: FileText },
  { key: 'meetings', label: '会议纪要', icon: NotebookText },
  { key: 'knowledge', label: '知识库', icon: BookOpen },
];

// 任务 Tab 内部三视图（看板/列表/甘特）
const TASK_VIEWS: { key: TaskViewMode; label: string; icon: typeof LayoutGrid }[] = [
  { key: 'board', label: '看板', icon: LayoutGrid },
  { key: 'list', label: '列表', icon: List },
  { key: 'gantt', label: '甘特图', icon: GanttChartSquare },
];

const isOverdue = (t: PmTask) => !!t.dueAt && t.status !== 'done' && t.status !== 'cancelled' && new Date(t.dueAt) < new Date(new Date().toDateString());
const ORDER_STEP = 1024;

export function ProjectDetailView({ projectId, onBack }: Props) {
  const navigate = useNavigate();
  const myId = useAuthStore((s) => s.user?.userId ?? '');
  const [project, setProject] = useState<PmProject | null>(null);
  const [tasks, setTasks] = useState<PmTask[]>([]);
  const [milestones, setMilestones] = useState<PmMilestone[]>([]);
  const [goals, setGoals] = useState<PmGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ViewTab>('tasks');
  const [viewMode, setViewMode] = useState<TaskViewMode>('board');
  const [showDecompose, setShowDecompose] = useState(false);
  const [showEvaluate, setShowEvaluate] = useState(false);
  const [showClosure, setShowClosure] = useState(false);
  const [showDiagnosis, setShowDiagnosis] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [costEdit, setCostEdit] = useState<{ budget: string; actualCost: string } | null>(null);
  const [savingCost, setSavingCost] = useState(false);
  const [timeEdit, setTimeEdit] = useState<{ start: string; end: string } | null>(null);
  const [savingTime, setSavingTime] = useState(false);
  const [openTask, setOpenTask] = useState<PmTask | null>(null);
  // 「资料」二级子 tab
  const [libraryTab, setLibraryTab] = useState<LibraryTab>('weekly');
  // 目标画布反查跳转：到任务（切 tab + 开抽屉）/ 到周报（切资料-周报 + 定位）
  const [targetWeeklyId, setTargetWeeklyId] = useState<string | undefined>(undefined);
  const navigateToTask = useCallback((taskId: string) => {
    const t = tasks.find((x) => x.id === taskId);
    if (t) { setTab('tasks'); setViewMode('list'); setOpenTask(t); }
    else toast.error('任务不存在', '可能已被删除');
  }, [tasks]);
  const navigateToWeekly = useCallback((reportId: string) => { setTab('library'); setLibraryTab('weekly'); setTargetWeeklyId(reportId); }, []);
  // 立项后引导：成员只有项目经理一人、且无观察者时，引导去拉人协作（有人后自动消失，可手动收起）
  const [teamGuideDismissed, setTeamGuideDismissed] = useState(() => sessionStorage.getItem(`pm-team-guide-${projectId}`) === '1');
  const dismissTeamGuide = () => { sessionStorage.setItem(`pm-team-guide-${projectId}`, '1'); setTeamGuideDismissed(true); };
  // P1 筛选 / 分组
  const [search, setSearch] = useState('');
  const [fPriority, setFPriority] = useState('');
  const [fAssignee, setFAssignee] = useState('');
  const [myOnly, setMyOnly] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  // P2 批量选择 + WIP
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [wipEdit, setWipEdit] = useState(false);
  const [bulkAssignee, setBulkAssignee] = useState('');

  const loadMilestones = useCallback(async () => {
    const res = await listPmMilestones(projectId);
    if (res.success) setMilestones(res.data.items);
  }, [projectId]);

  const loadGoals = useCallback(async () => {
    const res = await listPmGoals(projectId);
    if (res.success) setGoals(res.data.items);
  }, [projectId]);

  const load = useCallback(async () => {
    const res = await getPmProject(projectId);
    if (res.success) { setProject(res.data.project); setTasks(res.data.tasks); }
    else toast.error('加载失败', res.error?.message || '');
    loadMilestones();
    loadGoals();
    setLoading(false);
  }, [projectId, loadMilestones, loadGoals]);

  useEffect(() => { load(); }, [load]);

  // 移动 / 排序：beforeId=null 放到目标列末尾
  const handleMove = useCallback(async (taskId: string, status: PmTaskStatus, beforeId: string | null) => {
    let newOrder = Date.now();
    setTasks((prev) => {
      const colTasks = prev.filter((t) => t.status === status && t.id !== taskId).sort((a, b) => a.orderKey - b.orderKey);
      if (beforeId === null) {
        newOrder = (colTasks.length ? colTasks[colTasks.length - 1].orderKey : 0) + ORDER_STEP;
      } else {
        const idx = colTasks.findIndex((t) => t.id === beforeId);
        const before = idx > 0 ? colTasks[idx - 1].orderKey : 0;
        const at = idx >= 0 ? colTasks[idx].orderKey : (colTasks.length ? colTasks[colTasks.length - 1].orderKey + ORDER_STEP : ORDER_STEP);
        newOrder = (before + at) / 2;
      }
      return prev.map((t) => (t.id === taskId ? { ...t, status, orderKey: newOrder } : t));
    });
    const res = await updatePmTask(taskId, { status, orderKey: newOrder });
    if (!res.success) { toast.error('移动失败', res.error?.message || ''); load(); }
  }, [load]);

  const handleDelete = useCallback(async (taskId: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
    const res = await deletePmTask(taskId);
    if (!res.success) { toast.error('删除失败', res.error?.message || ''); load(); }
  }, [load]);

  // 新建任务 → 进入新建详情页（带可选标题预填），在详情页填全字段后保存才落库
  const handleAddTask = () => {
    const t = newTitle.trim();
    navigate(`/pm-agent/p/${projectId}/task/new${t ? `?title=${encodeURIComponent(t)}` : ''}`);
  };

  const saveCost = async () => {
    if (!costEdit) return;
    setSavingCost(true);
    const payload: { budget?: number; actualCost?: number } = {};
    if (costEdit.budget !== '') payload.budget = Number(costEdit.budget);
    if (costEdit.actualCost !== '') payload.actualCost = Number(costEdit.actualCost);
    const res = await updatePmProject(projectId, payload);
    setSavingCost(false);
    if (res.success) {
      setProject((prev) => (prev ? { ...prev, budget: payload.budget ?? prev.budget, actualCost: payload.actualCost ?? prev.actualCost } : prev));
      setCostEdit(null);
      toast.success('已保存成本', '');
    } else toast.error('保存失败', res.error?.message || '');
  };

  const saveTime = async () => {
    if (!timeEdit) return;
    if (timeEdit.start && timeEdit.end && timeEdit.end < timeEdit.start) { toast.error('结束时间不能早于开始时间', ''); return; }
    setSavingTime(true);
    const payload: { plannedStartAt?: string; plannedEndAt?: string } = {};
    if (timeEdit.start) payload.plannedStartAt = new Date(timeEdit.start + 'T00:00:00').toISOString();
    if (timeEdit.end) payload.plannedEndAt = new Date(timeEdit.end + 'T00:00:00').toISOString();
    const res = await updatePmProject(projectId, payload);
    setSavingTime(false);
    if (res.success) {
      setProject((prev) => (prev ? { ...prev, plannedStartAt: payload.plannedStartAt ?? prev.plannedStartAt, plannedEndAt: payload.plannedEndAt ?? prev.plannedEndAt } : prev));
      setTimeEdit(null);
      toast.success('已保存项目时间', '');
    } else toast.error('保存失败', res.error?.message || '');
  };

  // P2 批量
  const toggleSel = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const bulkApply = async (patch: { status?: PmTaskStatus; priority?: PmTaskPriority; assigneeId?: string }) => {
    const res = await bulkPmTasks(projectId, { taskIds: [...selected], ...patch });
    if (res.success) { setSelected(new Set()); setBulkAssignee(''); load(); } else toast.error('批量操作失败', res.error?.message || '');
  };
  const bulkDelete = async () => {
    if (!window.confirm(`确定删除选中的 ${selected.size} 个任务？`)) return;
    const res = await bulkPmTasks(projectId, { taskIds: [...selected], delete: true });
    if (res.success) { setSelected(new Set()); load(); } else toast.error('批量删除失败', res.error?.message || '');
  };
  const saveWip = async (limits: Record<string, number>) => {
    const res = await updatePmProject(projectId, { wipLimits: limits });
    if (res.success) { setProject((prev) => (prev ? { ...prev, wipLimits: limits } : prev)); toast.success('已保存 WIP 限制', ''); }
    else toast.error('保存失败', res.error?.message || '');
  };

  // P1 筛选
  const filtered = useMemo(() => tasks.filter((t) =>
    (!search || t.title.toLowerCase().includes(search.toLowerCase())) &&
    (!fPriority || t.priority === fPriority) &&
    (!fAssignee || t.assigneeId === fAssignee) &&
    (!myOnly || t.assigneeId === myId),
  ), [tasks, search, fPriority, fAssignee, myOnly, myId]);

  const hasFilter = search || fPriority || fAssignee || myOnly;

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载项目…" /></div>;
  if (!project) return null;

  const typeMeta = PROJECT_TYPE_REGISTRY[project.projectType];
  const lifeMeta = LIFECYCLE_REGISTRY[project.lifecycle];

  // 列表分组
  const listGroups: { key: string; label: string; color?: string; items: PmTask[] }[] = (() => {
    const sorted = [...filtered].sort((a, b) => PRIORITY_REGISTRY[b.priority].weight - PRIORITY_REGISTRY[a.priority].weight);
    if (groupBy === 'none') return [{ key: 'all', label: '', items: sorted }];
    if (groupBy === 'priority') {
      return (['urgent', 'high', 'medium', 'low', 'none'] as PmTaskPriority[])
        .map((p) => ({ key: p, label: PRIORITY_REGISTRY[p].label, color: PRIORITY_REGISTRY[p].color, items: sorted.filter((t) => t.priority === p) }))
        .filter((g) => g.items.length > 0);
    }
    // assignee
    const groups = new Map<string, { label: string; items: PmTask[] }>();
    for (const t of sorted) {
      const k = t.assigneeId || '__none__';
      if (!groups.has(k)) groups.set(k, { label: t.assigneeName || '未分配', items: [] });
      groups.get(k)!.items.push(t);
    }
    return [...groups.entries()].map(([key, v]) => ({ key, label: v.label, items: v.items }));
  })();

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* 项目头部 */}
      <div className="shrink-0">
        <button onClick={onBack} className="flex items-center gap-1 text-[12px] mb-2 hover:opacity-70" style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft size={14} /> 返回项目列表
        </button>
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] px-1.5 py-0.5 rounded font-semibold" style={{ background: `${typeMeta.color}22`, color: typeMeta.color }}>{typeMeta.short}</span>
              <h2 className="text-[17px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{project.title}</h2>
              <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: `${lifeMeta.color}22`, color: lifeMeta.color }}>{lifeMeta.label}</span>
              {project.evaluation && (
                <span className="text-[11px] px-1.5 py-0.5 rounded font-semibold" style={{ background: `${GRADE_REGISTRY[project.evaluation.grade].color}22`, color: GRADE_REGISTRY[project.evaluation.grade].color }}>
                  {GRADE_REGISTRY[project.evaluation.grade].label} · {project.evaluation.satisfactionScore}
                </span>
              )}
            </div>
            <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>{project.projectNo}｜目标：{project.businessGoal}</div>
            {/* 项目时间 */}
            <div className="text-[12px] mt-1.5 flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-muted)' }}>
              <CalendarClock size={12} />
              {timeEdit ? (
                <>
                  <span>开始</span>
                  <input type="date" value={timeEdit.start} onChange={(e) => setTimeEdit({ ...timeEdit, start: e.target.value })}
                    className="rounded px-2 py-0.5 text-[12px] outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
                  <span>结束</span>
                  <input type="date" value={timeEdit.end} onChange={(e) => setTimeEdit({ ...timeEdit, end: e.target.value })}
                    className="rounded px-2 py-0.5 text-[12px] outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
                  <Button variant="primary" size="xs" onClick={saveTime} disabled={savingTime}>保存</Button>
                  <button onClick={() => setTimeEdit(null)} className="text-[12px] hover:opacity-70">取消</button>
                </>
              ) : (
                <>
                  <span>时间 {project.plannedStartAt ? new Date(project.plannedStartAt).toLocaleDateString('zh-CN') : '未设置'} ~ {project.plannedEndAt ? new Date(project.plannedEndAt).toLocaleDateString('zh-CN') : '未设置'}</span>
                  <button onClick={() => setTimeEdit({ start: project.plannedStartAt ? project.plannedStartAt.slice(0, 10) : '', end: project.plannedEndAt ? project.plannedEndAt.slice(0, 10) : '' })} className="hover:opacity-70" style={{ color: 'var(--text-secondary)' }}>编辑时间</button>
                </>
              )}
            </div>
            {/* 成本侧进度留痕 */}
            <div className="text-[12px] mt-1.5 flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-muted)' }}>
              {costEdit ? (
                <>
                  <span>预算</span>
                  <input type="number" min={0} value={costEdit.budget} onChange={(e) => setCostEdit({ ...costEdit, budget: e.target.value })}
                    className="rounded px-2 py-0.5 text-[12px] outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', width: 110 }} placeholder="预算(元)" />
                  <span>实际</span>
                  <input type="number" min={0} value={costEdit.actualCost} onChange={(e) => setCostEdit({ ...costEdit, actualCost: e.target.value })}
                    className="rounded px-2 py-0.5 text-[12px] outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', width: 110 }} placeholder="实际成本(元)" />
                  <Button variant="primary" size="xs" onClick={saveCost} disabled={savingCost}>保存</Button>
                  <button onClick={() => setCostEdit(null)} className="text-[12px] hover:opacity-70">取消</button>
                </>
              ) : (
                <>
                  <span>预算 {project.budget != null ? `¥${project.budget.toLocaleString('zh-CN')}` : '未设置'}</span>
                  <span>·</span>
                  <span>实际 {project.actualCost != null ? `¥${project.actualCost.toLocaleString('zh-CN')}` : '未填写'}</span>
                  {project.budget != null && project.actualCost != null && (
                    <span style={{ color: project.actualCost > project.budget ? '#EF4444' : '#10B981' }}>{project.actualCost > project.budget ? '超支' : '预算内'}</span>
                  )}
                  <button onClick={() => setCostEdit({ budget: project.budget != null ? String(project.budget) : '', actualCost: project.actualCost != null ? String(project.actualCost) : '' })} className="hover:opacity-70" style={{ color: 'var(--text-secondary)' }}>编辑成本</button>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(project.ownerId === myId || project.leaderId === myId) && (
              <>
                <Button variant="ghost" onClick={() => setShowDiagnosis(true)}><Stethoscope size={14} />AI 健康诊断</Button>
                <Button variant="ghost" onClick={() => setShowClosure(true)}><Sparkles size={14} />AI 结案报告</Button>
              </>
            )}
            <Button variant="secondary" onClick={() => setShowEvaluate(true)}><Award size={14} />结案评价</Button>
          </div>
        </div>
      </div>

      {/* 立项后团队协作引导（仅项目经理一人、无观察者时显示，可管理者可见） */}
      {(project.ownerId === myId || project.leaderId === myId)
        && !teamGuideDismissed
        && project.memberIds.filter((id) => id && id !== project.leaderId).length === 0
        && (project.observerIds ?? []).length === 0 && (
        <div className="shrink-0 rounded-xl border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          <div className="flex items-start gap-2.5">
            <Sparkles size={16} className="mt-0.5 shrink-0" style={{ color: '#3B82F6' }} />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>立项成功，接下来把团队拉起来</div>
              <div className="text-[12px] mt-1" style={{ color: 'var(--text-secondary)' }}>
                目前项目里只有你一人。去「成员」把一起干活的人拉进来分配任务；不直接参与、只需了解进展的同事可加为「观察者」（权限相同、主要是看）；需要参与结案评价的，到「干系人」里维护。
              </div>
              <div className="flex items-center gap-2 mt-3">
                <Button variant="primary" size="sm" onClick={() => setTab('members')}><UserCog size={14} />去拉成员 / 观察者</Button>
                <Button variant="ghost" size="sm" onClick={() => setTab('stakeholders')}><Users size={14} />维护干系人</Button>
                <button onClick={dismissTeamGuide} className="ml-auto text-[12px] px-2 py-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}>知道了</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab 切换 */}
      <div className="shrink-0">
        <div className="inline-flex flex-wrap gap-1 rounded-lg p-1" style={{ background: 'var(--bg-base)' }}>
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] transition-colors shrink-0"
                style={{ background: active ? 'var(--bg-card)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 任务工具栏：视图切换（看板/列表/甘特）+ 快速添加任务 + AI 拆解（仅「任务」Tab）*/}
      {tab === 'tasks' && (
        <div className="shrink-0 flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--bg-base)' }}>
            {TASK_VIEWS.map((v) => {
              const Icon = v.icon;
              const active = viewMode === v.key;
              return (
                <button key={v.key} onClick={() => setViewMode(v.key)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] transition-colors shrink-0"
                  style={{ background: active ? 'var(--bg-card)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  <Icon size={14} /> {v.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            <input className="rounded-lg px-3 py-1.5 text-[12px] outline-none border"
              style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', width: 200 }}
              value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddTask(); }} placeholder="新建任务（进入详情页填写）…" />
            <Button variant="secondary" size="sm" onClick={handleAddTask}><Plus size={14} />新建</Button>
            <Button variant="primary" size="sm" onClick={() => setShowDecompose(true)}><Sparkles size={14} />AI 拆解需求</Button>
          </div>
        </div>
      )}

      {/* P1 筛选栏（任务视图） */}
      {tab === 'tasks' && tasks.length > 0 && (
        <div className="shrink-0 flex items-center gap-2 flex-wrap text-[12px]">
          <div className="relative">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索任务"
              className="rounded-lg pl-7 pr-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', width: 160 }} />
          </div>
          <select value={fPriority} onChange={(e) => setFPriority(e.target.value)} className="rounded-lg px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
            <option value="">全部优先级</option>
            {(['urgent', 'high', 'medium', 'low', 'none'] as PmTaskPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_REGISTRY[p].label}</option>)}
          </select>
          <div style={{ width: 160 }}>
            <UserSearchSelect value={fAssignee} onChange={setFAssignee} placeholder="全部负责人" showAllOption uiSize="sm" />
          </div>
          <button onClick={() => setMyOnly((v) => !v)} className="rounded-lg px-2.5 py-1.5 border transition-colors"
            style={{ background: myOnly ? 'rgba(59,130,246,0.15)' : 'var(--bg-input)', borderColor: myOnly ? '#3B82F6' : 'var(--border-subtle)', color: myOnly ? '#3B82F6' : 'var(--text-secondary)' }}>
            仅看我的
          </button>
          {viewMode === 'list' && (
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)} className="rounded-lg px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
              <option value="none">不分组</option>
              <option value="assignee">按负责人</option>
              <option value="priority">按优先级</option>
            </select>
          )}
          {viewMode === 'board' && (
            <button onClick={() => setWipEdit((v) => !v)} className="rounded-lg px-2.5 py-1.5 border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>WIP 限制</button>
          )}
          {hasFilter && <span style={{ color: 'var(--text-muted)' }}>命中 {filtered.length} / {tasks.length}</span>}
        </div>
      )}

      {/* WIP 限制编辑（看板）*/}
      {tab === 'tasks' && viewMode === 'board' && wipEdit && (
        <div className="shrink-0 flex items-center gap-3 flex-wrap rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--bg-base)' }}>
          <span style={{ color: 'var(--text-secondary)' }}>各列在制上限（0=不限）：</span>
          {(['backlog', 'todo', 'in_progress', 'done'] as PmTaskStatus[]).map((col) => (
            <label key={col} className="flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
              {TASK_STATUS_REGISTRY[col].label}
              <input type="number" min={0} defaultValue={project.wipLimits?.[col] ?? 0}
                onChange={(e) => { const v = Number(e.target.value); const next = { ...(project.wipLimits ?? {}) } as Record<string, number>; if (v > 0) next[col] = v; else delete next[col]; setProject((prev) => (prev ? { ...prev, wipLimits: next } : prev)); }}
                className="rounded px-2 py-0.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', width: 56 }} />
            </label>
          ))}
          <Button variant="primary" size="xs" onClick={() => { saveWip((project.wipLimits ?? {}) as Record<string, number>); setWipEdit(false); }}>保存</Button>
        </div>
      )}

      {/* 批量操作条（列表多选）*/}
      {tab === 'tasks' && viewMode === 'list' && selected.size > 0 && (
        <div className="shrink-0 flex items-center gap-2 flex-wrap rounded-lg px-3 py-2 text-[12px]" style={{ background: 'rgba(59,130,246,0.1)' }}>
          <span style={{ color: '#3B82F6' }}>已选 {selected.size}</span>
          <select defaultValue="" onChange={(e) => { if (e.target.value) bulkApply({ status: e.target.value as PmTaskStatus }); e.currentTarget.value = ''; }} className="rounded px-2 py-1 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
            <option value="">改状态…</option>
            {(['backlog', 'todo', 'in_progress', 'done', 'cancelled'] as PmTaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_REGISTRY[s].label}</option>)}
          </select>
          <select defaultValue="" onChange={(e) => { if (e.target.value) bulkApply({ priority: e.target.value as PmTaskPriority }); e.currentTarget.value = ''; }} className="rounded px-2 py-1 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
            <option value="">改优先级…</option>
            {(['urgent', 'high', 'medium', 'low', 'none'] as PmTaskPriority[]).map((p) => <option key={p} value={p}>{PRIORITY_REGISTRY[p].label}</option>)}
          </select>
          <div style={{ width: 150 }}><UserSearchSelect value={bulkAssignee} onChange={(uid) => { setBulkAssignee(uid); if (uid) bulkApply({ assigneeId: uid }); }} placeholder="改负责人…" uiSize="sm" /></div>
          <button onClick={bulkDelete} className="rounded px-2 py-1 border" style={{ borderColor: '#EF4444', color: '#EF4444' }}>删除</button>
          <button onClick={() => setSelected(new Set())} className="ml-auto" style={{ color: 'var(--text-muted)' }}>取消选择</button>
        </div>
      )}

      {/* 空状态 */}
      {tasks.length === 0 && tab === 'tasks' && (
        <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-center">
          <div className="text-[14px] font-medium" style={{ color: 'var(--text-secondary)' }}>还没有任务</div>
          <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>点击右上角「AI 拆解需求」，让 AI 根据业务目标自动生成任务清单</div>
          <Button variant="primary" onClick={() => setShowDecompose(true)}><Sparkles size={14} />AI 拆解需求</Button>
        </div>
      )}

      {tasks.length > 0 && tab === 'tasks' && viewMode === 'board' && (
        <KanbanBoard tasks={filtered} onMove={handleMove} onDelete={handleDelete} onOpen={setOpenTask} wipLimits={project.wipLimits ?? undefined} />
      )}

      {tasks.length > 0 && tab === 'tasks' && viewMode === 'list' && (
        <div className="flex-1 min-h-0 overflow-y-auto border rounded-xl" style={{ borderColor: 'var(--border-subtle)', overscrollBehavior: 'contain' }}>
          {listGroups.map((g) => (
            <div key={g.key}>
              {g.label && (
                <div className="px-4 py-1.5 text-[11px] font-semibold sticky top-0" style={{ background: 'var(--bg-base)', color: g.color || 'var(--text-secondary)' }}>{g.label}（{g.items.length}）</div>
              )}
              {g.items.map((t) => {
                const p = PRIORITY_REGISTRY[t.priority];
                const s = TASK_STATUS_REGISTRY[t.status];
                const overdue = isOverdue(t);
                return (
                  <div key={t.id} onClick={() => setOpenTask(t)} className="group flex items-center gap-3 px-4 py-2.5 border-b cursor-pointer" style={{ borderColor: 'var(--border-subtle)' }}>
                    <input type="checkbox" checked={selected.has(t.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggleSel(t.id)} style={{ accentColor: '#3B82F6' }} />
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} title={s.label} />
                    <span className="text-[13px] flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>{t.title}</span>
                    {overdue && <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0 inline-flex items-center gap-0.5" style={{ background: 'rgba(239,68,68,0.15)', color: '#EF4444' }}><CalendarClock size={10} />逾期</span>}
                    {t.priority !== 'none' && <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${p.color}22`, color: p.color }}>{p.label}</span>}
                    {t.assigneeName && <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>{t.assigneeName}</span>}
                    {t.estimateDays != null && <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>{t.estimateDays}人天</span>}
                    {(() => { const pct = t.status === 'done' ? 100 : (t.progressPercent ?? 0); return pct > 0 && t.status !== 'cancelled' ? (
                      <span className="shrink-0 flex items-center gap-1.5 w-20" title={`进度 ${pct}%`}>
                        <span className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: 'var(--bg-input)' }}>
                          <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: progressColor(pct, t.status) }} />
                        </span>
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{pct}%</span>
                      </span>
                    ) : null; })()}
                    <span className="text-[11px] shrink-0 w-16 text-right" style={{ color: 'var(--text-muted)' }}>{s.label}</span>
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }} className="opacity-0 group-hover:opacity-100 p-0.5 shrink-0" style={{ color: 'var(--text-muted)' }}><Trash2 size={13} /></button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {tab === 'tasks' && viewMode === 'gantt' && (
        <MilestonesBar projectId={projectId} milestones={milestones} canManage={project.ownerId === myId || project.leaderId === myId} onChanged={loadMilestones} />
      )}
      {tasks.length > 0 && tab === 'tasks' && viewMode === 'gantt' && (
        <GanttChart tasks={filtered} milestones={milestones} onOpen={setOpenTask}
          onMilestoneMove={(project.ownerId === myId || project.leaderId === myId)
            ? async (id, iso) => { const r = await updatePmMilestone(id, { dueAt: iso }); if (r.success) loadMilestones(); }
            : undefined} />
      )}

      {tab === 'milestones' && (
        <MilestonesPanel projectId={projectId} milestones={milestones} goals={goals} tasks={tasks}
          businessGoal={project.businessGoal} canManage={project.ownerId === myId || project.leaderId === myId} onChanged={loadMilestones} />
      )}

      {tab === 'library' && (
        <div className="flex-1 min-h-0 flex flex-col gap-3">
          <div className="shrink-0 inline-flex gap-1 rounded-lg p-1 self-start" style={{ background: 'var(--bg-base)' }}>
            {LIBRARY_TABS.map((lt) => {
              const Icon = lt.icon;
              const active = libraryTab === lt.key;
              return (
                <button key={lt.key} onClick={() => setLibraryTab(lt.key)}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] transition-colors shrink-0"
                  style={{ background: active ? 'var(--bg-card)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                  <Icon size={13} /> {lt.label}
                </button>
              );
            })}
          </div>
          {libraryTab === 'weekly' && <WeeklyReportsPanel projectId={projectId} targetReportId={targetWeeklyId} onTargetConsumed={() => setTargetWeeklyId(undefined)} />}
          {libraryTab === 'meetings' && <MeetingsPanel projectId={projectId} />}
          {libraryTab === 'knowledge' && <KnowledgePanel projectId={projectId} />}
        </div>
      )}

      {tab === 'goals' && <GoalsPanel projectId={projectId} businessGoal={project.businessGoal} canManage={project.ownerId === myId || project.leaderId === myId} onNavigateTask={navigateToTask} onNavigateWeekly={navigateToWeekly} />}

      {tab === 'members' && (
        <MembersPanel projectId={projectId} canManage={project.ownerId === myId || project.leaderId === myId} />
      )}

      {tab === 'decisions' && <DecisionsPanel projectId={projectId} goals={goals} tasks={tasks} canManageRisk={project.ownerId === myId || project.leaderId === myId || project.memberIds.includes(myId)} />}

      {tab === 'risks' && <RiskPanel projectId={projectId} canManage={project.ownerId === myId || project.leaderId === myId || project.memberIds.includes(myId)} goals={goals} tasks={tasks} milestones={milestones} />}

      {tab === 'report' && <BurndownPanel projectId={projectId} />}

      {tab === 'stakeholders' && (
        <StakeholderPanel projectId={projectId} stakeholders={project.stakeholders} onSaved={() => load()} />
      )}

      {openTask && (
        <TaskDetailDrawer
          task={openTask}
          allTasks={tasks}
          milestones={milestones}
          goals={goals}
          onClose={() => setOpenTask(null)}
          onSaved={(u) => { setTasks((prev) => prev.map((t) => (t.id === u.id ? u : t))); setOpenTask(null); loadMilestones(); }}
          onDeleted={(id) => { setTasks((prev) => prev.filter((t) => t.id !== id)); setOpenTask(null); loadMilestones(); }}
          onChanged={load}
        />
      )}

      {showDecompose && (
        <DecomposePanel projectId={projectId} businessGoal={project.businessGoal}
          onClose={() => setShowDecompose(false)} onCreated={() => { setShowDecompose(false); load(); }} />
      )}

      {showEvaluate && (
        <EvaluatePanel project={project} onClose={() => setShowEvaluate(false)} onChanged={load} />
      )}

      {showClosure && (
        <ClosureReportPanel projectId={projectId} projectNo={project.projectNo} onClose={() => setShowClosure(false)} />
      )}

      {showDiagnosis && (
        <HealthDiagnosisPanel projectId={projectId} projectNo={project.projectNo} onClose={() => setShowDiagnosis(false)} />
      )}
    </div>
  );
}
