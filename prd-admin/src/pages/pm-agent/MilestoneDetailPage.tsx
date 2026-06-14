import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Milestone as MilestoneIcon, Target, CircleCheck, Check, Plus, Trash2, Package,
  User, Lock, Settings2, X, ListTodo, ExternalLink, Pencil,
} from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { getPmProject, listPmMilestones, listPmGoals, updatePmMilestone, updatePmProject } from '@/services';
import type { PmMilestone, PmGoal, PmTask, PmProject, PmDeliverableRef } from '@/services/contracts/pmAgent';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { MILESTONE_HEALTH_REGISTRY, TASK_STATUS_REGISTRY } from './pmConstants';

/** 内置交付物类型（项目字典为空时的默认；key 为存储值，中文为展示名） */
const BUILTIN_DELIVERABLE_TYPES: { key: string; label: string }[] = [
  { key: 'weekly', label: '周报' },
  { key: 'decision', label: '决策' },
  { key: 'link', label: '外链' },
  { key: 'doc', label: '文档' },
  { key: 'other', label: '其他' },
];
const deliverableLabel = (type: string) => BUILTIN_DELIVERABLE_TYPES.find((t) => t.key === type)?.label ?? type;

function fmtDate(s?: string | null) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** KR 完成度（与后端 PmKeyResult.ComputeProgress 同口径） */
function krProgress(kr: { type: string; startValue: number; targetValue: number; currentValue: number }) {
  if (kr.type === 'binary') return kr.currentValue >= (kr.targetValue || 1) ? 100 : (kr.currentValue >= 1 ? 100 : 0);
  const span = kr.targetValue - kr.startValue;
  if (Math.abs(span) < 1e-9) return kr.currentValue >= kr.targetValue ? 100 : 0;
  return Math.round(Math.min(1, Math.max(0, (kr.currentValue - kr.startValue) / span)) * 100);
}

/**
 * 里程碑详情页（全屏路由 /pm-agent/p/:projectId/milestone/:milestoneId）——
 * 把 OKR（关联目标 + KR 完成度）、验收标准 DoD、名下任务、交付物（项目级自定义类型字典）管理起来。
 */
export function MilestoneDetailPage() {
  const navigate = useNavigate();
  const { projectId = '', milestoneId = '' } = useParams();
  const myId = useAuthStore((s) => s.user?.userId ?? '');
  const [project, setProject] = useState<PmProject | null>(null);
  const [milestone, setMilestone] = useState<PmMilestone | null>(null);
  const [goals, setGoals] = useState<PmGoal[]>([]);
  const [tasks, setTasks] = useState<PmTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 标题行内编辑
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  // 新增验收标准
  const [newCriterion, setNewCriterion] = useState('');
  // 新增交付物
  const [dType, setDType] = useState('');
  const [dTitle, setDTitle] = useState('');
  const [dUrl, setDUrl] = useState('');
  // 类型字典管理
  const [typeMgrOpen, setTypeMgrOpen] = useState(false);
  const [newType, setNewType] = useState('');

  const load = useCallback(async () => {
    const [pr, mr, gr] = await Promise.all([getPmProject(projectId), listPmMilestones(projectId), listPmGoals(projectId)]);
    if (pr.success) { setProject(pr.data.project); setTasks(pr.data.tasks); }
    if (gr.success) setGoals(gr.data.items);
    if (mr.success) {
      const m = mr.data.items.find((x) => x.id === milestoneId) ?? null;
      setMilestone(m);
      if (!m) toast.error('里程碑不存在', '可能已被删除');
    } else toast.error('加载失败', mr.error?.message || '');
    setLoading(false);
  }, [projectId, milestoneId]);

  useEffect(() => { load(); }, [load]);

  const canManage = !!project && (project.ownerId === myId || project.leaderId === myId);
  const goal = useMemo(() => goals.find((g) => g.id === milestone?.goalId) ?? null, [goals, milestone]);
  const myTasks = useMemo(() => tasks.filter((t) => t.milestoneId === milestoneId && t.status !== 'cancelled'), [tasks, milestoneId]);
  const typeDict = useMemo(() => {
    const custom = (project?.deliverableTypes ?? []).filter(Boolean);
    return custom.length > 0
      ? [...BUILTIN_DELIVERABLE_TYPES, ...custom.filter((c) => !BUILTIN_DELIVERABLE_TYPES.some((b) => b.key === c || b.label === c)).map((c) => ({ key: c, label: c }))]
      : BUILTIN_DELIVERABLE_TYPES;
  }, [project]);

  const patch = useCallback(async (input: Parameters<typeof updatePmMilestone>[1], okMsg = '已保存') => {
    setBusy(true);
    const res = await updatePmMilestone(milestoneId, input);
    setBusy(false);
    if (res.success) { if (okMsg) toast.success(okMsg, ''); await load(); return true; }
    toast.error('保存失败', res.error?.message || '');
    return false;
  }, [milestoneId, load]);

  if (loading) return <div className="h-full min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载里程碑…" /></div>;
  if (!milestone || !project) {
    return (
      <div className="h-full min-h-0 flex flex-col items-center justify-center gap-3">
        <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>里程碑不存在或已被删除</div>
        <Button variant="secondary" onClick={() => navigate(`/pm-agent/p/${projectId}?tab=milestones`)}><ArrowLeft size={14} />返回里程碑</Button>
      </div>
    );
  }

  const h = MILESTONE_HEALTH_REGISTRY[milestone.health];
  const reached = milestone.status === 'reached';
  const criteria = milestone.acceptanceCriteria ?? [];
  const deliverables = milestone.deliverables ?? [];

  const toggleCriterion = (id: string) => {
    void patch({ acceptanceCriteria: criteria.map((c) => (c.id === id ? { id: c.id, text: c.text, done: !c.done } : { id: c.id, text: c.text, done: c.done })) }, '');
  };
  const addCriterion = () => {
    const text = newCriterion.trim();
    if (!text) return;
    setNewCriterion('');
    void patch({ acceptanceCriteria: [...criteria.map((c) => ({ id: c.id, text: c.text, done: c.done })), { text, done: false }] }, '已添加验收标准');
  };
  const removeCriterion = (id: string) => {
    void patch({ acceptanceCriteria: criteria.filter((c) => c.id !== id).map((c) => ({ id: c.id, text: c.text, done: c.done })) }, '');
  };

  const addDeliverable = () => {
    const title = dTitle.trim();
    const type = dType || typeDict[0].key;
    if (!title) { toast.error('请填写交付物标题', ''); return; }
    setDTitle(''); setDUrl('');
    void patch({ deliverables: [...deliverables.map((d) => ({ type: d.type, refId: d.refId ?? undefined, title: d.title, url: d.url ?? undefined })), { type, title, url: dUrl.trim() || undefined }] }, '已添加交付物');
  };
  const removeDeliverable = (idx: number) => {
    void patch({ deliverables: deliverables.filter((_, i) => i !== idx).map((d) => ({ type: d.type, refId: d.refId ?? undefined, title: d.title, url: d.url ?? undefined })) }, '');
  };

  const saveTypes = async (next: string[]) => {
    const res = await updatePmProject(projectId, { deliverableTypes: next });
    if (res.success) { setProject((p) => (p ? { ...p, deliverableTypes: next } : p)); toast.success('类型字典已更新', ''); }
    else toast.error('保存失败', res.error?.message || '');
  };

  const sectionCls = 'rounded-lg border p-4 flex flex-col gap-3';
  const sectionStyle = { borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' } as const;

  return (
    <div className="h-full min-h-0 flex flex-col gap-3 p-4 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      {/* 头部 */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/pm-agent/p/${projectId}?tab=milestones`)}><ArrowLeft size={14} />返回</Button>
        <MilestoneIcon size={16} style={{ color: '#A855F7' }} />
        {editingTitle && canManage ? (
          <input autoFocus value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && titleDraft.trim()) { void patch({ title: titleDraft.trim() }); setEditingTitle(false); }
              if (e.key === 'Escape') setEditingTitle(false);
            }}
            onBlur={() => { if (titleDraft.trim() && titleDraft.trim() !== milestone.title) void patch({ title: titleDraft.trim() }); setEditingTitle(false); }}
            className="text-[16px] font-semibold rounded-md px-2 py-1 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)', minWidth: 280 }} />
        ) : (
          <span className="text-[16px] font-semibold inline-flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
            {milestone.title}
            {canManage && <button onClick={() => { setTitleDraft(milestone.title); setEditingTitle(true); }} className="p-0.5 rounded opacity-60 hover:opacity-100" title="重命名"><Pencil size={13} style={{ color: 'var(--text-muted)' }} /></button>}
          </span>
        )}
        <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${h.color}22`, color: h.color }}>{h.label}</span>
        {milestone.autoFromGoal && <span className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1" style={{ background: 'rgba(168,85,247,0.14)', color: '#A855F7' }}><Target size={9} />来自目标</span>}
        {milestone.blocked && <span className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1" style={{ background: 'rgba(239,68,68,0.14)', color: '#EF4444' }}><Lock size={9} />受阻</span>}
        {canManage && (
          <div className="ml-auto flex items-center gap-1.5">
            <Button variant={reached ? 'ghost' : 'primary'} size="sm" disabled={busy}
              onClick={() => void patch({ status: reached ? 'planned' : 'reached' }, reached ? '已取消达成' : '已标记达成')}>
              {busy ? <MapSpinner size={13} /> : <Check size={13} />}{reached ? '取消达成' : '标记达成'}
            </Button>
          </div>
        )}
      </div>

      {/* 概要：计划/基线/达成 + 负责人 + 进度 */}
      <div className={`${sectionCls} shrink-0`} style={sectionStyle}>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div className="flex flex-col gap-1">
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>计划截止</span>
            {canManage ? (
              <input type="date" value={milestone.dueAt ? milestone.dueAt.slice(0, 10) : ''}
                onChange={(e) => { if (e.target.value) void patch({ dueAt: e.target.value }, '计划日已更新'); }}
                className="text-[12.5px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
            ) : <span className="text-[12.5px]" style={{ color: 'var(--text-primary)' }}>{milestone.dueAt ? fmtDate(milestone.dueAt) : '未排期'}</span>}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>基线计划</span>
            <span className="text-[12.5px]" style={{ color: 'var(--text-primary)' }}>
              {milestone.baselineDueAt ? fmtDate(milestone.baselineDueAt) : '无'}
              {typeof milestone.driftDays === 'number' && milestone.driftDays !== 0 && (
                <span className="ml-2 text-[11px]" style={{ color: milestone.driftDays > 0 ? '#EF4444' : '#10B981' }}>{milestone.driftDays > 0 ? `+${milestone.driftDays} 天` : `${milestone.driftDays} 天`}</span>
              )}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>实际达成</span>
            <span className="text-[12.5px]" style={{ color: reached ? '#10B981' : 'var(--text-primary)' }}>{milestone.reachedAt ? fmtDate(milestone.reachedAt) : '未达成'}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}><User size={10} />负责人</span>
            {canManage
              ? <UserSearchSelect value={milestone.ownerId || ''} onChange={(uid) => void patch({ ownerId: uid }, '负责人已更新')} placeholder="指派负责人" uiSize="sm" />
              : <span className="text-[12.5px]" style={{ color: 'var(--text-primary)' }}>{milestone.ownerName || '未指派'}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
            <div style={{ width: `${milestone.progress}%`, height: '100%', background: h.color }} />
          </div>
          <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{milestone.progress}% · 任务 {milestone.taskDone}/{milestone.taskTotal}</span>
        </div>
      </div>

      <div className="grid gap-3 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
        {/* OKR：关联目标 + KR 完成度 */}
        <div className={sectionCls} style={sectionStyle}>
          <div className="flex items-center gap-1.5">
            <Target size={13} style={{ color: '#3B82F6' }} />
            <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>OKR · 关联目标</span>
            <button onClick={() => navigate(`/pm-agent/p/${projectId}?tab=goals`)} className="ml-auto text-[11px] inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--text-muted)' }}>去目标视图<ExternalLink size={10} /></button>
          </div>
          {goal ? (
            <div className="flex flex-col gap-2">
              <div className="rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-medium flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{goal.title}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(59,130,246,0.14)', color: '#3B82F6' }}>进度 {goal.progress}%</span>
                </div>
                {goal.metric && <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>指标：{goal.metric}</div>}
              </div>
              {(goal.keyResults ?? []).length > 0 ? (goal.keyResults ?? []).map((kr) => {
                const p = krProgress(kr);
                return (
                  <div key={kr.id} className="flex items-center gap-2">
                    <span className="text-[11.5px] flex-1 truncate" style={{ color: 'var(--text-secondary)' }} title={kr.title}>{kr.title}</span>
                    <div className="w-24 h-1.5 rounded-full overflow-hidden shrink-0" style={{ background: 'var(--bg-base)' }}>
                      <div style={{ width: `${p}%`, height: '100%', background: p >= 100 ? '#10B981' : '#3B82F6' }} />
                    </div>
                    <span className="text-[10.5px] tabular-nums w-8 text-right shrink-0" style={{ color: 'var(--text-muted)' }}>{p}%</span>
                  </div>
                );
              }) : <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>该目标暂无关键结果 KR，可在目标详情里添加。</div>}
            </div>
          ) : (
            <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>未关联目标。在里程碑编辑里选择「关联目标」后，这里会展示目标进度与 KR 完成度。</div>
          )}
        </div>

        {/* 验收标准 DoD */}
        <div className={sectionCls} style={sectionStyle}>
          <div className="flex items-center gap-1.5">
            <CircleCheck size={13} style={{ color: '#10B981' }} />
            <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>验收标准 DoD（{criteria.filter((c) => c.done).length}/{criteria.length}）</span>
          </div>
          {criteria.length === 0 && <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>还没有验收标准。逐条列出"做到什么才算达成"，全部勾选才允许标记达成。</div>}
          {criteria.map((c) => (
            <div key={c.id} className="group flex items-center gap-2">
              <button disabled={!canManage} onClick={() => toggleCriterion(c.id)} className="shrink-0 inline-flex items-center justify-center rounded disabled:cursor-default"
                style={{ width: 16, height: 16, border: `1.5px solid ${c.done ? '#10B981' : 'var(--border-strong)'}`, background: c.done ? '#10B981' : 'transparent' }}>
                {c.done && <Check size={11} style={{ color: '#fff' }} />}
              </button>
              <span className="text-[12px] flex-1" style={{ color: c.done ? 'var(--text-muted)' : 'var(--text-secondary)', textDecoration: c.done ? 'line-through' : 'none' }}>{c.text}</span>
              {canManage && <button onClick={() => removeCriterion(c.id)} className="opacity-0 group-hover:opacity-100 p-0.5" title="移除" style={{ color: 'var(--text-muted)' }}><X size={12} /></button>}
            </div>
          ))}
          {canManage && (
            <div className="flex items-center gap-2">
              <input value={newCriterion} onChange={(e) => setNewCriterion(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCriterion(); }}
                placeholder="新增验收标准，回车添加" className="flex-1 text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
              <Button variant="ghost" size="sm" onClick={addCriterion}><Plus size={13} /></Button>
            </div>
          )}
        </div>

        {/* 名下任务 */}
        <div className={sectionCls} style={sectionStyle}>
          <div className="flex items-center gap-1.5">
            <ListTodo size={13} style={{ color: '#F59E0B' }} />
            <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>名下任务（{myTasks.length}）</span>
            <button onClick={() => navigate(`/pm-agent/p/${projectId}?tab=tasks`)} className="ml-auto text-[11px] inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--text-muted)' }}>去任务看板<ExternalLink size={10} /></button>
          </div>
          {myTasks.length === 0 ? (
            <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>暂无任务归属本里程碑。在任务详情里设置「所属里程碑」，进度将按任务完成度自动滚动。</div>
          ) : myTasks.map((t) => {
            const st = TASK_STATUS_REGISTRY[t.status];
            return (
              <button key={t.id} onClick={() => navigate(`/pm-agent/p/${projectId}/task/${t.id}`)}
                className="flex items-center gap-2 text-left rounded px-1 py-1 hover:bg-[var(--bg-base)]">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.color }} />
                <span className="text-[12px] truncate flex-1" style={{ color: 'var(--text-secondary)' }}>{t.title}</span>
                {t.assigneeName && <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>{t.assigneeName}</span>}
                <span className="text-[10px] shrink-0" style={{ color: st.color }}>{st.label}</span>
              </button>
            );
          })}
        </div>

        {/* 交付物（项目级自定义类型字典） */}
        <div className={sectionCls} style={sectionStyle}>
          <div className="flex items-center gap-1.5">
            <Package size={13} style={{ color: '#A855F7' }} />
            <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>交付物（{deliverables.length}）</span>
            {canManage && (
              <button onClick={() => setTypeMgrOpen((v) => !v)} className="ml-auto text-[11px] inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--text-muted)' }} title="维护项目级交付物类型字典">
                <Settings2 size={11} />类型管理
              </button>
            )}
          </div>
          {typeMgrOpen && canManage && (
            <div className="rounded-lg border p-2.5 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
              <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>内置类型（周报/决策/外链/文档/其他）不可删；自定义类型项目内全员可用：</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {(project.deliverableTypes ?? []).map((t) => (
                  <span key={t} className="text-[11px] px-2 py-0.5 rounded-full inline-flex items-center gap-1" style={{ background: 'rgba(168,85,247,0.12)', color: '#A855F7' }}>
                    {t}
                    <button onClick={() => void saveTypes((project.deliverableTypes ?? []).filter((x) => x !== t))} title="删除类型"><X size={10} /></button>
                  </span>
                ))}
                <input value={newType} onChange={(e) => setNewType(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newType.trim()) {
                      void saveTypes([...(project.deliverableTypes ?? []), newType.trim()]);
                      setNewType('');
                    }
                  }}
                  placeholder="新增类型，回车保存" className="text-[11px] rounded-md px-2 py-1 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', width: 140 }} />
              </div>
            </div>
          )}
          {deliverables.length === 0 && <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>暂无交付物。记录被本里程碑验收的产物：周报、决策、文档、外链或自定义类型。</div>}
          {deliverables.map((d: PmDeliverableRef, i) => (
            <div key={`${d.type}-${d.refId ?? d.url ?? i}`} className="group flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(168,85,247,0.12)', color: '#A855F7' }}>{deliverableLabel(d.type)}</span>
              {d.url
                ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-[12px] truncate flex-1 hover:underline" style={{ color: 'var(--text-secondary)' }}>{d.title}</a>
                : <span className="text-[12px] truncate flex-1" style={{ color: 'var(--text-secondary)' }}>{d.title}</span>}
              {canManage && <button onClick={() => removeDeliverable(i)} className="opacity-0 group-hover:opacity-100 p-0.5" title="移除" style={{ color: 'var(--text-muted)' }}><Trash2 size={12} /></button>}
            </div>
          ))}
          {canManage && (
            <div className="flex items-center gap-2 flex-wrap">
              <select value={dType || typeDict[0].key} onChange={(e) => setDType(e.target.value)} title="交付物类型"
                className="text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
                {typeDict.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <input value={dTitle} onChange={(e) => setDTitle(e.target.value)} placeholder="交付物标题"
                className="flex-1 text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', minWidth: 140 }} />
              <input value={dUrl} onChange={(e) => setDUrl(e.target.value)} placeholder="链接（可选）"
                className="flex-1 text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', minWidth: 140 }} />
              <Button variant="secondary" size="sm" onClick={addDeliverable}><Plus size={13} />添加</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
