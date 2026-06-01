import { useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, ChevronRight, ChevronDown, Target, Milestone as MilestoneIcon } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { createPmMilestone, updatePmMilestone, deletePmMilestone } from '@/services';
import type { PmMilestone, PmGoal, PmTask } from '@/services/contracts/pmAgent';
import { MILESTONE_HEALTH_REGISTRY, TASK_STATUS_REGISTRY } from './pmConstants';

interface Props {
  projectId: string;
  milestones: PmMilestone[];
  goals: PmGoal[];
  tasks: PmTask[];
  canManage: boolean;
  onChanged: () => void;
}

function fmtDate(s?: string | null) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 里程碑独立面板（第一公民）—— 按 dueAt 时间轴排列，菱形健康色 + 进度滚动 + 关联目标 + 展开看其下任务。
 * owner/leader 可新建/编辑/标达成/删除。进度由后端按任务完成度滚动计算（ListMilestones）。
 */
export function MilestonesPanel({ projectId, milestones, goals, tasks, canManage, onChanged }: Props) {
  const [editing, setEditing] = useState<string | null>(null); // 'new' | id
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [goalId, setGoalId] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const teamGoals = goals.filter((g) => g.scope === 'team');
  const goalTitle = (id?: string | null) => (id ? teamGoals.find((g) => g.id === id)?.title ?? goals.find((g) => g.id === id)?.title ?? null : null);
  const tasksOf = (mId: string) => tasks.filter((t) => t.milestoneId === mId);
  const sorted = [...milestones].sort((a, b) => {
    const av = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const bv = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    return av - bv || (a.orderKey ?? 0) - (b.orderKey ?? 0);
  });

  const startNew = () => { setEditing('new'); setTitle(''); setDueAt(''); setGoalId(''); };
  const startEdit = (m: PmMilestone) => { setEditing(m.id); setTitle(m.title); setDueAt(m.dueAt ? m.dueAt.slice(0, 10) : ''); setGoalId(m.goalId || ''); };
  const cancel = () => setEditing(null);
  const toggle = (id: string) => setExpanded((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const save = async () => {
    if (!title.trim()) { toast.error('请填写里程碑名称', ''); return; }
    setBusy(true);
    const payload = { title: title.trim(), dueAt: dueAt || undefined, goalId: goalId || undefined };
    const res = editing === 'new' ? await createPmMilestone(projectId, payload) : await updatePmMilestone(editing!, payload);
    setBusy(false);
    if (res.success) { setEditing(null); onChanged(); } else toast.error('保存失败', res.error?.message || '');
  };
  const markReached = async (m: PmMilestone) => {
    const next = m.status === 'reached' ? 'planned' : 'reached';
    const res = await updatePmMilestone(m.id, { status: next });
    if (res.success) onChanged(); else toast.error('操作失败', res.error?.message || '');
  };
  const remove = async (m: PmMilestone) => {
    if (!window.confirm(`删除里程碑「${m.title}」？其下任务将解除归属（任务本身保留）。`)) return;
    const res = await deletePmMilestone(m.id);
    if (res.success) onChanged(); else toast.error('删除失败', res.error?.message || '');
  };

  const editor = (
    <div className="rounded-lg border p-3 flex items-center gap-2 flex-wrap" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-elevated)' }}>
      <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="里程碑名称（如：架构评审通过）"
        className="text-[13px] rounded-md px-2.5 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', width: 260 }} />
      <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} title="预计达成时间"
        className="text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
      <select value={goalId} onChange={(e) => setGoalId(e.target.value)} title="关联目标"
        className="text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
        <option value="">不关联目标</option>
        {teamGoals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
      </select>
      <Button variant="primary" size="sm" onClick={save} disabled={busy}>{busy ? <MapSpinner size={12} /> : <Check size={12} />}保存</Button>
      <Button variant="ghost" size="sm" onClick={cancel}><X size={12} />取消</Button>
    </div>
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      <div className="flex items-center gap-2 shrink-0">
        <MilestoneIcon size={15} style={{ color: '#A855F7' }} />
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>里程碑</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>阶段关键节点，按时间排列；进度按其下任务完成度自动滚动</span>
        {canManage && editing !== 'new' && <Button variant="primary" size="sm" className="ml-auto" onClick={startNew}><Plus size={13} />新增里程碑</Button>}
      </div>

      {editing === 'new' && editor}

      {sorted.length === 0 && editing !== 'new' ? (
        <div className="text-[12px] text-center py-10 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
          {canManage ? '还没有里程碑。点「新增里程碑」设定阶段节点，再到「任务」把任务归属进来，进度会自动滚动。' : '暂无里程碑。'}
        </div>
      ) : (
        <div className="flex flex-col">
          {sorted.map((m, idx) => {
            const h = MILESTONE_HEALTH_REGISTRY[m.health];
            const kids = tasksOf(m.id);
            const isOpen = expanded.has(m.id);
            const gName = goalTitle(m.goalId);
            if (editing === m.id) return <div key={m.id} className="mb-2">{editor}</div>;
            return (
              <div key={m.id} className="flex gap-3">
                {/* 左侧时间轴：菱形 + 连接线 */}
                <div className="flex flex-col items-center shrink-0" style={{ width: 16 }}>
                  <span style={{ width: 12, height: 12, background: h.color, transform: 'rotate(45deg)', display: 'inline-block', borderRadius: 2, marginTop: 14 }} />
                  {idx < sorted.length - 1 && <span className="flex-1" style={{ width: 2, background: 'var(--border-subtle)', marginTop: 4 }} />}
                </div>
                {/* 卡片 */}
                <div className="group flex-1 min-w-0 rounded-lg border p-3 mb-2 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                  <div className="flex items-center gap-2">
                    {kids.length > 0 && (
                      <button onClick={() => toggle(m.id)} style={{ color: 'var(--text-muted)' }} title={isOpen ? '收起任务' : '展开任务'}>
                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    )}
                    <span className="text-[13px] font-medium truncate flex-1" style={{ color: 'var(--text-primary)' }}>{m.title}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: `${h.color}22`, color: h.color }}>{h.label}</span>
                    {canManage && (
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
                        <button onClick={() => markReached(m)} title={m.status === 'reached' ? '取消达成' : '标记达成'} style={{ color: m.status === 'reached' ? '#10B981' : 'var(--text-muted)' }}><Check size={13} /></button>
                        <button onClick={() => startEdit(m)} title="编辑" style={{ color: 'var(--text-muted)' }}><Pencil size={12} /></button>
                        <button onClick={() => remove(m)} title="删除" style={{ color: 'var(--text-muted)' }}><Trash2 size={12} /></button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)' }}>
                      <div style={{ width: `${m.progress}%`, height: '100%', background: h.color }} />
                    </div>
                    <span className="text-[11px] tabular-nums w-9 text-right" style={{ color: 'var(--text-muted)' }}>{m.progress}%</span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] flex-wrap" style={{ color: 'var(--text-muted)' }}>
                    {m.dueAt && <span>截止 {fmtDate(m.dueAt)}</span>}
                    <span>任务 {m.taskDone}/{m.taskTotal}</span>
                    {gName && <span className="inline-flex items-center gap-1"><Target size={10} />{gName}</span>}
                    {m.reachedAt && <span style={{ color: '#10B981' }}>已达成 {fmtDate(m.reachedAt)}</span>}
                  </div>
                  {isOpen && kids.length > 0 && (
                    <div className="flex flex-col gap-1 pt-1 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                      {kids.map((t) => {
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
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
