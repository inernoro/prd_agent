import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, Trash2, Check, Pencil, CalendarRange, Archive, RotateCcw } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { createPmGoalCycle, updatePmGoalCycle, deletePmGoalCycle } from '@/services';
import type { PmGoalCycle } from '@/services/contracts/pmAgent';

interface Props {
  projectId: string;
  cycles: PmGoalCycle[];
  onClose: () => void;
  onChanged: () => void;
}

const inputCls = 'text-[12px] rounded-md px-2 py-1.5 outline-none border';
const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' } as const;
const d10 = (s?: string | null) => (s ? s.slice(0, 10) : '');

/** OKR 周期管理 —— 新建 / 改名 / 起止 / 关闭(盘点归档) / 删除（删周期不删目标，仅解除归属）。 */
export function CycleManagerModal({ projectId, cycles, onClose, onChanged }: Props) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [eName, setEName] = useState('');
  const [eStart, setEStart] = useState('');
  const [eEnd, setEEnd] = useState('');

  const create = async () => {
    if (!name.trim()) { toast.error('请填写周期名称', ''); return; }
    setBusy(true);
    const res = await createPmGoalCycle(projectId, { name: name.trim(), startAt: start || undefined, endAt: end || undefined });
    setBusy(false);
    if (res.success) { setName(''); setStart(''); setEnd(''); toast.success('已新建周期', ''); onChanged(); }
    else toast.error('创建失败', res.error?.message || '');
  };
  const startEdit = (c: PmGoalCycle) => { setEditing(c.id); setEName(c.name); setEStart(d10(c.startAt)); setEEnd(d10(c.endAt)); };
  const saveEdit = async (c: PmGoalCycle) => {
    if (!eName.trim()) { toast.error('请填写周期名称', ''); return; }
    setBusy(true);
    const res = await updatePmGoalCycle(c.id, { name: eName.trim(), startAt: eStart || undefined, endAt: eEnd || undefined });
    setBusy(false);
    if (res.success) { setEditing(null); onChanged(); } else toast.error('保存失败', res.error?.message || '');
  };
  const toggleClose = async (c: PmGoalCycle) => {
    const res = await updatePmGoalCycle(c.id, { status: c.status === 'closed' ? 'active' : 'closed' });
    if (res.success) onChanged(); else toast.error('操作失败', res.error?.message || '');
  };
  const remove = async (c: PmGoalCycle) => {
    if (!window.confirm(`删除周期「${c.name}」？其下目标不会被删除，仅解除周期归属。`)) return;
    const res = await deletePmGoalCycle(c.id);
    if (res.success) { toast.success('已删除', ''); onChanged(); } else toast.error('删除失败', res.error?.message || '');
  };

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 560, maxHeight: '82vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <CalendarRange size={16} style={{ color: '#A855F7' }} />
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>OKR 周期管理</div>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>
        <div className="flex-1 px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {/* 新建 */}
          <div className="rounded-lg border p-2.5 flex items-end gap-2 flex-wrap" style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-card)' }}>
            <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
              <label className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>周期名称</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：2026 Q2" className={`w-full ${inputCls}`} style={inputStyle} />
            </div>
            <div className="flex flex-col gap-1"><label className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>起</label><input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} style={inputStyle} /></div>
            <div className="flex flex-col gap-1"><label className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>止</label><input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className={inputCls} style={inputStyle} /></div>
            <Button variant="primary" size="sm" onClick={create} disabled={busy}>{busy ? <MapSpinner size={12} /> : <Plus size={13} />}新建</Button>
          </div>
          {/* 列表 */}
          {cycles.length === 0 ? (
            <div className="text-[12px] text-center py-8" style={{ color: 'var(--text-muted)' }}>还没有周期。新建一个 OKR 周期（如 2026 Q2），再把目标归入。</div>
          ) : cycles.map((c) => (
            <div key={c.id} className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
              {editing === c.id ? (
                <div className="flex items-end gap-2 flex-wrap">
                  <input value={eName} onChange={(e) => setEName(e.target.value)} className={`flex-1 min-w-[120px] ${inputCls}`} style={inputStyle} />
                  <input type="date" value={eStart} onChange={(e) => setEStart(e.target.value)} className={inputCls} style={inputStyle} />
                  <input type="date" value={eEnd} onChange={(e) => setEEnd(e.target.value)} className={inputCls} style={inputStyle} />
                  <Button variant="primary" size="sm" onClick={() => saveEdit(c)} disabled={busy}><Check size={12} />保存</Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}><X size={12} />取消</Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{c.name}</span>
                  {c.status === 'closed' && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(148,163,184,0.2)', color: 'var(--text-muted)' }}>已归档</span>}
                  {(c.startAt || c.endAt) && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{d10(c.startAt)} ~ {d10(c.endAt)}</span>}
                  <div className="ml-auto flex items-center gap-1">
                    <button onClick={() => toggleClose(c)} title={c.status === 'closed' ? '重新激活' : '关闭/归档'} style={{ color: 'var(--text-muted)' }}>{c.status === 'closed' ? <RotateCcw size={13} /> : <Archive size={13} />}</button>
                    <button onClick={() => startEdit(c)} title="编辑" style={{ color: 'var(--text-muted)' }}><Pencil size={13} /></button>
                    <button onClick={() => remove(c)} title="删除" style={{ color: 'var(--text-muted)' }}><Trash2 size={13} /></button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
