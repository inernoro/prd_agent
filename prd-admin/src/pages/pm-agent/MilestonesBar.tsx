import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, Check, X, Flag } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { createPmMilestone, updatePmMilestone, deletePmMilestone, listPmGoals } from '@/services';
import type { PmMilestone, PmGoal } from '@/services/contracts/pmAgent';
import { MILESTONE_HEALTH_REGISTRY } from './pmConstants';

interface Props {
  projectId: string;
  milestones: PmMilestone[];
  canManage: boolean;
  onChanged: () => void;
}

function fmtDate(s?: string | null) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 里程碑管理条 —— 任务甘特视图上方。展示里程碑（菱形健康色 + 进度滚动），
 * owner/leader 可新建/改/标达成/删除。进度由后端按任务完成度滚动计算。
 */
export function MilestonesBar({ projectId, milestones, canManage, onChanged }: Props) {
  const [editing, setEditing] = useState<string | null>(null); // 'new' | id
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [goalId, setGoalId] = useState('');
  const [goals, setGoals] = useState<PmGoal[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canManage) return;
    listPmGoals(projectId).then((res) => { if (res.success) setGoals(res.data.items.filter((g) => g.scope === 'team')); });
  }, [projectId, canManage]);

  const startNew = () => { setEditing('new'); setTitle(''); setDueAt(''); setGoalId(''); };
  const startEdit = (m: PmMilestone) => { setEditing(m.id); setTitle(m.title); setDueAt(m.dueAt ? m.dueAt.slice(0, 10) : ''); setGoalId(m.goalId || ''); };
  const cancel = () => setEditing(null);

  const save = async () => {
    if (!title.trim()) { toast.error('请填写里程碑名称', ''); return; }
    setBusy(true);
    const payload = { title: title.trim(), dueAt: dueAt || undefined, goalId: goalId || undefined };
    const res = editing === 'new'
      ? await createPmMilestone(projectId, payload)
      : await updatePmMilestone(editing!, payload);
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

  return (
    <div className="shrink-0 rounded-lg border p-2.5 flex flex-col gap-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
      <div className="flex items-center gap-2">
        <Flag size={14} style={{ color: '#A855F7' }} />
        <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-primary)' }}>里程碑</span>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>阶段关键节点，进度按任务完成度自动滚动</span>
        {canManage && editing === null && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={startNew}><Plus size={13} />新增</Button>
        )}
      </div>

      {editing === 'new' && (
        <div className="flex items-center gap-2 flex-wrap">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="里程碑名称（如：架构评审通过）"
            className="text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', width: 240 }} />
          <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} title="预计达成时间"
            className="text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
          <select value={goalId} onChange={(e) => setGoalId(e.target.value)} title="关联目标"
            className="text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
            <option value="">不关联目标</option>
            {goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
          <Button variant="primary" size="sm" onClick={save} disabled={busy}>{busy ? <MapSpinner size={12} /> : <Check size={12} />}保存</Button>
          <Button variant="ghost" size="sm" onClick={cancel}><X size={12} />取消</Button>
        </div>
      )}

      {milestones.length === 0 && editing !== 'new' ? (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{canManage ? '还没有里程碑，点「新增」设定阶段节点，再把任务归属进来。' : '暂无里程碑。'}</div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          {milestones.map((m) => {
            const h = MILESTONE_HEALTH_REGISTRY[m.health];
            if (editing === m.id) {
              return (
                <div key={m.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-elevated)' }}>
                  <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
                    className="text-[12px] rounded px-1.5 py-1 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', width: 160 }} />
                  <input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)}
                    className="text-[12px] rounded px-1.5 py-1 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }} />
                  <select value={goalId} onChange={(e) => setGoalId(e.target.value)} title="关联目标"
                    className="text-[12px] rounded px-1.5 py-1 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', maxWidth: 120 }}>
                    <option value="">不关联</option>
                    {goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                  </select>
                  <button onClick={save} disabled={busy} title="保存" style={{ color: '#10B981' }}>{busy ? <MapSpinner size={13} /> : <Check size={14} />}</button>
                  <button onClick={cancel} title="取消" style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
                </div>
              );
            }
            return (
              <div key={m.id} className="group flex items-center gap-2 rounded-md border px-2.5 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)' }}>
                <span style={{ width: 10, height: 10, background: h.color, transform: 'rotate(45deg)', display: 'inline-block', borderRadius: 2 }} />
                <div className="flex flex-col">
                  <span className="text-[12px] leading-tight" style={{ color: 'var(--text-primary)' }}>{m.title}</span>
                  <span className="text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
                    {m.dueAt ? `${fmtDate(m.dueAt)} · ` : ''}{m.progress}%（{m.taskDone}/{m.taskTotal}）· <span style={{ color: h.color }}>{h.label}</span>
                  </span>
                </div>
                {canManage && (
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                    <button onClick={() => markReached(m)} title={m.status === 'reached' ? '取消达成' : '标记达成'} style={{ color: m.status === 'reached' ? '#10B981' : 'var(--text-muted)' }}><Check size={13} /></button>
                    <button onClick={() => startEdit(m)} title="编辑" style={{ color: 'var(--text-muted)' }}><Pencil size={12} /></button>
                    <button onClick={() => remove(m)} title="删除" style={{ color: 'var(--text-muted)' }}><Trash2 size={12} /></button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
