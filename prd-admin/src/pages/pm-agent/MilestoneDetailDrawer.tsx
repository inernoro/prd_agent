import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, Trash2, Plus, ListTodo, Milestone as MilestoneIcon, CircleCheck, Flag } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import { createPmMilestone, updatePmMilestone, deletePmMilestone } from '@/services';
import type { PmMilestone, PmGoal, PmTask } from '@/services/contracts/pmAgent';
import { MILESTONE_HEALTH_REGISTRY, TASK_STATUS_REGISTRY } from './pmConstants';
import { fmtDate } from './materialUtils';

interface DraftCriterion { id: string; text: string; done: boolean }

interface Props {
  projectId: string;
  /** 编辑现有里程碑；null = 新建 */
  milestone: PmMilestone | null;
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
export function MilestoneDetailDrawer({ projectId, milestone, goals, tasks, canManage, onClose, onSaved }: Props) {
  const isCreate = !milestone;
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [goalId, setGoalId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [criteria, setCriteria] = useState<DraftCriterion[]>([]);
  const [newItem, setNewItem] = useState('');
  const [saving, setSaving] = useState(false);

  const teamGoals = goals.filter((g) => g.scope === 'team');
  const kids = useMemo(() => (milestone ? tasks.filter((t) => t.milestoneId === milestone.id) : []), [milestone, tasks]);

  useEffect(() => {
    if (milestone) {
      setTitle(milestone.title);
      setDescription(milestone.description || '');
      setDueAt(milestone.dueAt ? milestone.dueAt.slice(0, 10) : '');
      setGoalId(milestone.goalId || '');
      setOwnerId(milestone.ownerId || '');
      setCriteria((milestone.acceptanceCriteria ?? []).map((c) => ({ id: c.id, text: c.text, done: c.done })));
    } else {
      setTitle(''); setDescription(''); setDueAt(''); setGoalId(''); setOwnerId(''); setCriteria([]);
    }
  }, [milestone]);

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

  const buildPayload = (status?: 'planned' | 'reached' | 'cancelled') => ({
    title: title.trim(),
    description,
    dueAt: dueAt || undefined,
    goalId: goalId || undefined,
    ownerId: ownerId || '',
    acceptanceCriteria: criteria.filter((c) => c.text.trim()).map((c) => ({ id: c.id.startsWith('tmp-') ? undefined : c.id, text: c.text.trim(), done: c.done })),
    ...(status ? { status } : {}),
  });

  const save = async () => {
    if (!title.trim()) { toast.error('请填写里程碑名称', ''); return; }
    setSaving(true);
    const res = isCreate
      ? await createPmMilestone(projectId, buildPayload())
      : await updatePmMilestone(milestone!.id, buildPayload());
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
    setSaving(true);
    const res = await updatePmMilestone(milestone.id, buildPayload(isReached ? 'planned' : 'reached'));
    setSaving(false);
    if (res.success) { toast.success(isReached ? '已取消达成' : '已标记达成', ''); onSaved(); }
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
                {milestone.reachedAt && <span style={{ color: '#10B981' }}>已达成 {fmtDate(milestone.reachedAt)}</span>}
                {typeof milestone.slippageDays === 'number' && milestone.slippageDays !== 0 && (
                  <span style={{ color: milestone.slippageDays > 0 ? '#EF4444' : '#10B981' }}>
                    {milestone.slippageDays > 0 ? `延期 ${milestone.slippageDays} 天` : `提前 ${-milestone.slippageDays} 天`}
                  </span>
                )}
              </div>
            </div>
          )}

          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>名称</label>
          <input autoFocus value={title} disabled={!canManage} onChange={(e) => setTitle(e.target.value)} placeholder="里程碑名称（如：架构评审通过）" className={inputCls} style={inputStyle} />

          <div className="flex gap-2">
            <div className="flex flex-col gap-1" style={{ width: 150 }}>
              <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>计划截止</label>
              <input type="date" value={dueAt} disabled={!canManage} onChange={(e) => setDueAt(e.target.value)} className={inputCls} style={inputStyle} />
            </div>
            <div className="flex-1 flex flex-col gap-1 min-w-0">
              <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>负责人</label>
              {canManage
                ? <UserSearchSelect value={ownerId} onChange={(uid) => setOwnerId(uid || '')} placeholder="指派负责人（可选）" />
                : <div className="text-[12.5px] px-2.5 py-2 rounded-md border" style={{ ...inputStyle }}>{milestone?.ownerName || '未指派'}</div>}
            </div>
          </div>

          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>关联目标</label>
          <select value={goalId} disabled={!canManage} onChange={(e) => setGoalId(e.target.value)} className={inputCls} style={inputStyle}>
            <option value="">不关联目标</option>
            {teamGoals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>

          <label className="text-[11px]" style={{ color: 'var(--text-muted)' }}>说明</label>
          <textarea value={description} disabled={!canManage} onChange={(e) => setDescription(e.target.value)} placeholder="里程碑的背景 / 交付物 / 关键说明" rows={3} className={`${inputCls} resize-y`} style={inputStyle} />

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
        </div>

        {canManage && (
          <div className="flex items-center gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            {!isCreate && (
              <>
                <Button variant={isReached ? 'ghost' : 'secondary'} size="sm" onClick={toggleReached} disabled={saving || (!isReached && !allCriteriaDone)}
                  title={!isReached && !allCriteriaDone ? '需先完成全部验收标准' : ''}>
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
