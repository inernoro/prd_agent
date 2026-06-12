import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, Trash2, Plus, ListTodo, Milestone as MilestoneIcon, CircleCheck, Flag, Lock, Package, ShieldAlert, FileText, Gavel, ExternalLink, Target } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import { createPmMilestone, updatePmMilestone, deletePmMilestone, listPmWeeklyReports, listPmDecisions, listPmRisks } from '@/services';
import type { PmMilestone, PmGoal, PmTask, PmWeeklyReport, PmDecision, PmRisk, PmDeliverableType } from '@/services/contracts/pmAgent';
import { MILESTONE_HEALTH_REGISTRY, TASK_STATUS_REGISTRY, riskScore, riskScoreColor } from './pmConstants';
import { fmtDate } from './materialUtils';

interface DraftCriterion { id: string; text: string; done: boolean }
interface DraftDeliverable { type: PmDeliverableType; refId?: string; title: string; url?: string }

interface Props {
  projectId: string;
  /** 编辑现有里程碑；null = 新建 */
  milestone: PmMilestone | null;
  /** 同项目全部里程碑（供选前置 + 受阻判定） */
  allMilestones: PmMilestone[];
  goals: PmGoal[];
  tasks: PmTask[];
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const inputCls = 'w-full text-[12.5px] rounded-md px-2.5 py-2 outline-none border';
const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' } as const;

let _cidSeq = 0;
const newCid = () => `tmp-${Date.now()}-${_cidSeq++}`;

/**
 * 里程碑详情抽屉 —— 负责人 + 验收标准(DoD 清单) + 说明 + 关联目标 + 其下任务 + 计划/实际偏差。
 * 验收标准未全部勾选时禁止「标记达成」（里程碑=被验收，不是到日期）。
 */
export function MilestoneDetailDrawer({ projectId, milestone, allMilestones, goals, tasks, canManage, onClose, onSaved }: Props) {
  const isCreate = !milestone;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [reachedAt, setReachedAt] = useState('');
  const [goalId, setGoalId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [criteria, setCriteria] = useState<DraftCriterion[]>([]);
  const [newItem, setNewItem] = useState('');
  const [dependsOn, setDependsOn] = useState<string[]>([]);
  const [deliverables, setDeliverables] = useState<DraftDeliverable[]>([]);
  const [saving, setSaving] = useState(false);
  // 交付物候选 + 反查风险
  const [weeklies, setWeeklies] = useState<PmWeeklyReport[]>([]);
  const [decisions, setDecisions] = useState<PmDecision[]>([]);
  const [risks, setRisks] = useState<PmRisk[]>([]);
  // 交付物 composer
  const [delivType, setDelivType] = useState<PmDeliverableType>('weekly');
  const [delivRefId, setDelivRefId] = useState('');
  const [delivLinkTitle, setDelivLinkTitle] = useState('');
  const [delivLinkUrl, setDelivLinkUrl] = useState('');

  const teamGoals = goals.filter((g) => g.scope === 'team');
  const kids = useMemo(() => (milestone ? tasks.filter((t) => t.milestoneId === milestone.id) : []), [milestone, tasks]);
  const otherMilestones = useMemo(() => allMilestones.filter((x) => x.id !== milestone?.id), [allMilestones, milestone]);
  const msById = useMemo(() => new Map(allMilestones.map((x) => [x.id, x])), [allMilestones]);
  const linkedRisks = useMemo(() => (milestone ? risks.filter((r) => r.relatedMilestoneId === milestone.id) : []), [risks, milestone]);
  const unreachedPrereqs = dependsOn.filter((id) => msById.get(id) && msById.get(id)!.status !== 'reached');

  useEffect(() => {
    if (milestone) {
      setTitle(milestone.title);
      setDescription(milestone.description || '');
      setDueAt(milestone.dueAt ? milestone.dueAt.slice(0, 10) : '');
      setReachedAt(milestone.reachedAt ? milestone.reachedAt.slice(0, 10) : '');
      setGoalId(milestone.goalId || '');
      setOwnerId(milestone.ownerId || '');
      setCriteria((milestone.acceptanceCriteria ?? []).map((c) => ({ id: c.id, text: c.text, done: c.done })));
      setDependsOn(milestone.dependsOn ?? []);
      setDeliverables((milestone.deliverables ?? []).map((d) => ({ type: d.type, refId: d.refId ?? undefined, title: d.title, url: d.url ?? undefined })));
    } else {
      setTitle(''); setDescription(''); setDueAt(''); setReachedAt(''); setGoalId(''); setOwnerId(''); setCriteria([]); setDependsOn([]); setDeliverables([]);
    }
  }, [milestone]);

  // 拉取交付物候选 + 反查风险（一次）
  useEffect(() => {
    let alive = true;
    (async () => {
      const [wr, dr, rr] = await Promise.all([listPmWeeklyReports(projectId), listPmDecisions(projectId), listPmRisks(projectId)]);
      if (!alive) return;
      if (wr.success) setWeeklies(wr.data.items);
      if (dr.success) setDecisions(dr.data.items);
      if (rr.success) setRisks(rr.data.items);
    })();
    return () => { alive = false; };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const doneCount = criteria.filter((c) => c.done).length;
  const allCriteriaDone = criteria.length === 0 || doneCount === criteria.length;
  const isReached = milestone?.status === 'reached';
  const health = milestone ? MILESTONE_HEALTH_REGISTRY[milestone.health] : null;

  const addCriterion = () => {
    const t = newItem.trim();
    if (!t) return;
    setCriteria((p) => [...p, { id: newCid(), text: t, done: false }]);
    setNewItem('');
  };
  const toggleCriterion = (id: string) => setCriteria((p) => p.map((c) => c.id === id ? { ...c, done: !c.done } : c));
  const editCriterionText = (id: string, text: string) => setCriteria((p) => p.map((c) => c.id === id ? { ...c, text } : c));
  const removeCriterion = (id: string) => setCriteria((p) => p.filter((c) => c.id !== id));

  const toggleDep = (id: string) => setDependsOn((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);
  const addDeliverable = () => {
    if (delivType === 'link') {
      if (!delivLinkTitle.trim() || !delivLinkUrl.trim()) { toast.error('请填写链接标题与地址', ''); return; }
      setDeliverables((p) => [...p, { type: 'link', title: delivLinkTitle.trim(), url: delivLinkUrl.trim() }]);
      setDelivLinkTitle(''); setDelivLinkUrl('');
    } else {
      if (!delivRefId) return;
      const title = delivType === 'weekly' ? (weeklies.find((w) => w.id === delivRefId)?.title ?? '周报') : (decisions.find((d) => d.id === delivRefId)?.title ?? '决策');
      if (deliverables.some((d) => d.type === delivType && d.refId === delivRefId)) { toast.error('已添加过该交付物', ''); return; }
      setDeliverables((p) => [...p, { type: delivType, refId: delivRefId, title }]);
      setDelivRefId('');
    }
  };
  const removeDeliverable = (idx: number) => setDeliverables((p) => p.filter((_, i) => i !== idx));

  const buildPayload = (status?: 'planned' | 'reached' | 'cancelled') => ({
    title: title.trim(),
    description,
    dueAt: dueAt || undefined,
    goalId: goalId || undefined,
    ownerId: ownerId || '',
    acceptanceCriteria: criteria.filter((c) => c.text.trim()).map((c) => ({ id: c.id.startsWith('tmp-') ? undefined : c.id, text: c.text.trim(), done: c.done })),
    dependsOn,
    deliverables: deliverables.map((d) => ({ type: d.type, refId: d.refId, title: d.title, url: d.url })),
    ...(status ? { status } : {}),
  });

  const save = async () => {
    if (!title.trim()) { toast.error('请填写里程碑名称', ''); return; }
    setSaving(true);
    // 实际完成时间：填了即设置（早于/等于计划截止不算逾期），清空则显式清除
    const reachedPayload = reachedAt
      ? { reachedAt: new Date(reachedAt + 'T00:00:00').toISOString() }
      : { clearReachedAt: true };
    const res = isCreate
      ? await createPmMilestone(projectId, { ...buildPayload(), ...reachedPayload })
      : await updatePmMilestone(milestone!.id, { ...buildPayload(), ...reachedPayload });
    setSaving(false);
    if (res.success) { toast.success(isCreate ? '已新增' : '已保存', ''); onSaved(); }
    else toast.error('保存失败', res.error?.message || '');
  };

  const toggleReached = async () => {
    if (!milestone) return;
    if (!isReached && !allCriteriaDone) {
      toast.error('还有验收项未完成', `请先勾选全部 ${criteria.length} 条验收标准`);
      return;
    }
    if (!isReached && unreachedPrereqs.length > 0) {
      toast.error('前置里程碑未达成', unreachedPrereqs.map((id) => msById.get(id)?.title).filter(Boolean).join('、'));
      return;
    }
    setSaving(true);
    const res = await updatePmMilestone(milestone.id, buildPayload(isReached ? 'planned' : 'reached'));
    setSaving(false);
    if (res.success) { toast.success(isReached ? '已取消达成' : '已标记达成', ''); onSaved(); }
    else toast.error('操作失败', res.error?.message || '');
  };

  const resetBaseline = async () => {
    if (!milestone) return;
    setSaving(true);
    const res = await updatePmMilestone(milestone.id, { ...buildPayload(), resetBaseline: true });
    setSaving(false);
    if (res.success) { toast.success('已重设基线', '基线计划日已对齐当前计划日'); onSaved(); }
    else toast.error('操作失败', res.error?.message || '');
  };

  const remove = async () => {
    if (!milestone) return;
    if (!window.confirm(`删除里程碑「${milestone.title}」？其下任务将解除归属（任务本身保留）。`)) return;
    setSaving(true);
    const res = await deletePmMilestone(milestone.id);
    setSaving(false);
    if (res.success) { toast.success('已删除', ''); onSaved(); }
    else toast.error('删除失败', res.error?.message || '');
  };

  const drawer = (
    <div className="fixed inset-0 z-[100] flex justify-end" onClick={onClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.4)' }} />
      <div className="relative h-full flex flex-col border-l" style={{ width: 440, maxWidth: '94vw', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <MilestoneIcon size={16} style={{ color: '#A855F7' }} />
          <span className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{isCreate ? '新增里程碑' : '里程碑详情'}</span>
          {milestone?.autoFromGoal && (
            <span className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1 shrink-0" style={{ background: 'rgba(168,85,247,0.14)', color: '#A855F7' }} title="由目标「设为里程碑」联动创建，与目标同步（在目标侧取消即移除）"><Target size={9} />来自目标</span>
          )}
          {health && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${health.color}22`, color: health.color }}>{health.label}</span>}
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70 shrink-0" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        <div className="flex-1 px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {!canManage && !isCreate && (
            <div className="text-[11px] rounded-md px-3 py-2" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>只读：仅立项人 / 负责人可编辑里程碑</div>
          )}

          {/* 进度 + 计划/实际 */}
          {!isCreate && milestone && (
            <div className="rounded-lg border p-3 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                  <div style={{ width: `${milestone.progress}%`, height: '100%', background: health?.color }} />
                </div>
                <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{milestone.progress}%</span>
              </div>
              <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: 'var(--text-muted)' }}>
                <span>任务 {milestone.taskDone}/{milestone.taskTotal}</span>
                {criteria.length > 0 && <span className="inline-flex items-center gap-1"><CircleCheck size={11} />验收 {doneCount}/{criteria.length}</span>}
                {milestone.baselineDueAt && (
                  <span title="基线计划日">基线 {fmtDate(milestone.baselineDueAt)}{typeof milestone.driftDays === 'number' && milestone.driftDays !== 0 ? `（${milestone.driftDays > 0 ? '+' : ''}${milestone.driftDays} 天）` : ''}</span>
                )}
                {milestone.reachedAt && <span style={{ color: '#10B981' }}>已达成 {fmtDate(milestone.reachedAt)}</span>}
                {typeof milestone.slippageDays === 'number' && milestone.slippageDays !== 0 && (
                  <span style={{ color: milestone.slippageDays > 0 ? '#EF4444' : '#10B981' }}>
                    {milestone.slippageDays > 0 ? `延期 ${milestone.slippageDays} 天` : `提前 ${-milestone.slippageDays} 天`}
                  </span>
                )}
                {canManage && milestone.dueAt && (
                  <button onClick={resetBaseline} disabled={saving} className="hover:underline" style={{ color: '#3B82F6' }} title="把基线计划日重设为当前计划日，清零滑移">重设基线</button>
                )}
              </div>
            </div>
          )}

          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>名称</label>
          <input autoFocus value={title} disabled={!canManage} onChange={(e) => setTitle(e.target.value)} placeholder="里程碑名称（如：架构评审通过）" className={inputCls} style={inputStyle} />

          <div className="flex gap-2">
            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>计划截止</label>
              <input type="date" value={dueAt} disabled={!canManage} onChange={(e) => setDueAt(e.target.value)} className={inputCls} style={inputStyle} />
            </div>
            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>实际完成</label>
              <input type="date" value={reachedAt} disabled={!canManage} onChange={(e) => setReachedAt(e.target.value)} className={inputCls} style={inputStyle} />
            </div>
          </div>
          <div className="flex flex-col gap-1 min-w-0">
            <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>负责人</label>
            {canManage
              ? <UserSearchSelect value={ownerId} onChange={(uid) => setOwnerId(uid || '')} placeholder="指派负责人（可选）" />
              : <div className="text-[12.5px] px-2.5 py-2 rounded-md border" style={{ ...inputStyle }}>{milestone?.ownerName || '未指派'}</div>}
          </div>
          {reachedAt && dueAt && (
            <div className="text-[11px]" style={{ color: reachedAt <= dueAt ? '#10B981' : '#F59E0B' }}>
              {reachedAt <= dueAt
                ? '实际完成早于/等于计划截止 —— 按时达成，不计逾期'
                : `实际完成晚于计划截止 ${Math.round((new Date(reachedAt).getTime() - new Date(dueAt).getTime()) / 86400000)} 天`}
            </div>
          )}
          {!reachedAt && (
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>填写「实际完成」时间后，若不晚于计划截止则不再标记逾期</div>
          )}

          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>关联目标</label>
          <select value={goalId} disabled={!canManage} onChange={(e) => setGoalId(e.target.value)} className={inputCls} style={inputStyle}>
            <option value="">不关联目标</option>
            {teamGoals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>

          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>说明</label>
          <textarea value={description} disabled={!canManage} onChange={(e) => setDescription(e.target.value)} placeholder="里程碑的背景 / 交付物 / 关键说明" rows={5} className={`${inputCls} resize-y`} style={{ ...inputStyle, minHeight: 120, lineHeight: 1.6 }} />

          {/* 验收标准 DoD */}
          <div className="flex items-center gap-1.5 mt-1">
            <CircleCheck size={13} style={{ color: '#10B981' }} />
            <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>验收标准 (DoD)</span>
            {criteria.length > 0 && <span className="text-[10.5px] px-1.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>{doneCount}/{criteria.length}</span>}
          </div>
          <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>全部勾选后才允许「标记达成」——里程碑是被验收，不是到日期。</div>
          <div className="flex flex-col gap-1.5">
            {criteria.map((c) => (
              <div key={c.id} className="flex items-center gap-2">
                <input type="checkbox" checked={c.done} disabled={!canManage} onChange={() => toggleCriterion(c.id)} />
                {canManage
                  ? <input value={c.text} onChange={(e) => editCriterionText(c.id, e.target.value)} className="flex-1 text-[12.5px] rounded-md px-2 py-1 outline-none border" style={{ ...inputStyle, textDecoration: c.done ? 'line-through' : 'none' }} />
                  : <span className="flex-1 text-[12.5px]" style={{ color: 'var(--text-secondary)', textDecoration: c.done ? 'line-through' : 'none' }}>{c.text}</span>}
                {canManage && <button onClick={() => removeCriterion(c.id)} style={{ color: 'var(--text-muted)' }}><Trash2 size={12} /></button>}
              </div>
            ))}
            {criteria.length === 0 && <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无验收标准</div>}
            {canManage && (
              <div className="flex items-center gap-2 mt-0.5">
                <input value={newItem} onChange={(e) => setNewItem(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addCriterion(); }}
                  placeholder="添加验收项，回车确认" className="flex-1 text-[12.5px] rounded-md px-2 py-1 outline-none border" style={inputStyle} />
                <Button variant="ghost" size="sm" onClick={addCriterion}><Plus size={13} />添加</Button>
              </div>
            )}
          </div>

          {/* 前置里程碑（依赖门禁） */}
          {otherMilestones.length > 0 && (
            <div className="flex flex-col gap-1.5 pt-2 mt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="text-[12px] font-medium flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}><Lock size={12} style={{ color: '#A855F7' }} />前置里程碑</div>
              <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>前置未达成时本里程碑受阻，且不能标记达成（保持 DAG，不可成环）</div>
              {unreachedPrereqs.length > 0 && (
                <div className="text-[11px] inline-flex items-center gap-1" style={{ color: '#EF4444' }}><Lock size={11} />受阻：{unreachedPrereqs.map((id) => msById.get(id)?.title).filter(Boolean).join('、')} 未达成</div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {otherMilestones.map((ms) => {
                  const on = dependsOn.includes(ms.id);
                  const reached = ms.status === 'reached';
                  return (
                    <button key={ms.id} type="button" disabled={!canManage} onClick={() => toggleDep(ms.id)}
                      className="text-[11px] px-1.5 py-0.5 rounded-md border inline-flex items-center gap-1 max-w-[190px]"
                      style={{ borderColor: on ? '#A855F7' : 'var(--border-subtle)', background: on ? 'rgba(168,85,247,0.12)' : 'transparent', color: on ? '#A855F7' : 'var(--text-secondary)' }} title={ms.title}>
                      {reached ? <Check size={10} /> : <Flag size={10} />}<span className="truncate">{ms.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* 交付物 */}
          <div className="flex flex-col gap-1.5 pt-2 mt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="text-[12px] font-medium flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}><Package size={12} style={{ color: '#10B981' }} />交付物</div>
            <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>里程碑验收/批准的产物：周报 / 决策 / 外链</div>
            {deliverables.length > 0 ? deliverables.map((d, i) => {
              const Icon = d.type === 'weekly' ? FileText : d.type === 'decision' ? Gavel : ExternalLink;
              return (
                <div key={i} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                  <Icon size={11} className="shrink-0" style={{ color: '#10B981' }} />
                  {d.type === 'link' && d.url
                    ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="truncate flex-1 hover:underline" style={{ color: '#3B82F6' }}>{d.title}</a>
                    : <span className="truncate flex-1" title={d.title}>{d.title}</span>}
                  {canManage && <button onClick={() => removeDeliverable(i)} style={{ color: 'var(--text-muted)' }}><Trash2 size={11} /></button>}
                </div>
              );
            }) : <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无交付物</div>}
            {canManage && (
              <div className="flex items-center gap-1.5 flex-wrap">
                <select value={delivType} onChange={(e) => { setDelivType(e.target.value as PmDeliverableType); setDelivRefId(''); }} className="text-[12px] rounded-md px-2 py-1 outline-none border" style={inputStyle}>
                  <option value="weekly">周报</option><option value="decision">决策</option><option value="link">外链</option>
                </select>
                {delivType === 'weekly' && (
                  <select value={delivRefId} onChange={(e) => setDelivRefId(e.target.value)} className="flex-1 min-w-[120px] text-[12px] rounded-md px-2 py-1 outline-none border" style={inputStyle}>
                    <option value="">选择周报…</option>{weeklies.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
                  </select>
                )}
                {delivType === 'decision' && (
                  <select value={delivRefId} onChange={(e) => setDelivRefId(e.target.value)} className="flex-1 min-w-[120px] text-[12px] rounded-md px-2 py-1 outline-none border" style={inputStyle}>
                    <option value="">选择决策…</option>{decisions.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                  </select>
                )}
                {delivType === 'link' && (
                  <>
                    <input value={delivLinkTitle} onChange={(e) => setDelivLinkTitle(e.target.value)} placeholder="标题" className="text-[12px] rounded-md px-2 py-1 outline-none border" style={{ ...inputStyle, width: 96 }} />
                    <input value={delivLinkUrl} onChange={(e) => setDelivLinkUrl(e.target.value)} placeholder="https://" className="flex-1 min-w-[120px] text-[12px] rounded-md px-2 py-1 outline-none border" style={inputStyle} />
                  </>
                )}
                <Button variant="ghost" size="sm" onClick={addDeliverable}><Plus size={13} />添加</Button>
              </div>
            )}
          </div>

          {/* 其下任务 */}
          {!isCreate && (
            <div className="flex flex-col gap-1.5 pt-2 mt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="text-[11px] flex items-center gap-1" style={{ color: '#F59E0B' }}><ListTodo size={12} />其下任务（{kids.length}）</div>
              {kids.length === 0 ? (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无任务归属本里程碑。在「任务」详情里设置任务的「所属里程碑」。</div>
              ) : kids.map((t) => {
                const st = TASK_STATUS_REGISTRY[t.status];
                return (
                  <div key={t.id} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: st.color }} />
                    <span className="truncate flex-1" title={t.title}>{t.title}</span>
                    {t.assigneeName && <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>{t.assigneeName}</span>}
                    <span className="text-[10px] shrink-0" style={{ color: st.color }}>{st.label}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* 威胁本里程碑的风险（反查 relatedMilestoneId） */}
          {!isCreate && (
            <div className="flex flex-col gap-1.5 pt-2 mt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="text-[11px] flex items-center gap-1" style={{ color: '#EF4444' }}><ShieldAlert size={12} />威胁本里程碑的风险（{linkedRisks.length}）</div>
              {linkedRisks.length === 0 ? (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>暂无风险关联本里程碑。在「风险」里把风险关联到本里程碑。</div>
              ) : linkedRisks.map((r) => {
                const sc = riskScore(r.probability, r.impact);
                return (
                  <div key={r.id} className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
                    <span className="text-[10px] font-semibold w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ background: `${riskScoreColor(sc)}22`, color: riskScoreColor(sc) }}>{sc}</span>
                    <span className="truncate flex-1" title={r.title}>{r.title}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {canManage && (
          <div className="flex items-center gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            {!isCreate && (
              <>
                <Button variant={isReached ? 'ghost' : 'secondary'} size="sm" onClick={toggleReached} disabled={saving || (!isReached && (!allCriteriaDone || unreachedPrereqs.length > 0))}
                  title={!isReached && !allCriteriaDone ? '需先完成全部验收标准' : !isReached && unreachedPrereqs.length > 0 ? '前置里程碑未达成' : ''}>
                  <Flag size={13} />{isReached ? '取消达成' : '标记达成'}
                </Button>
                <Button variant="ghost" size="sm" onClick={remove} disabled={saving}><Trash2 size={13} />删除</Button>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" onClick={onClose}>取消</Button>
              <Button variant="primary" onClick={save} disabled={saving}>{saving ? <MapSpinner size={14} /> : <Check size={14} />}保存</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(drawer, document.body);
}
