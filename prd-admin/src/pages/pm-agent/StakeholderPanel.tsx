import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, X, Star } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { toast } from '@/lib/toast';
import { setPmStakeholders, getUsers } from '@/services';
import type { AdminUser } from '@/types/admin';
import type { PmStakeholder, PmStakeholderRole, PmStakeholderAxis } from '@/services/contracts/pmAgent';
import { STAKEHOLDER_ROLE_REGISTRY, POWER_INTEREST_MATRIX } from './pmConstants';

interface Props {
  projectId: string;
  stakeholders: PmStakeholder[];
  onSaved: (list: PmStakeholder[]) => void;
}

const ROLES: PmStakeholderRole[] = ['beneficiary', 'management', 'team', 'other'];
// 矩阵象限顺序：左上(low-high) 右上(high-high) / 左下(low-low) 右下(high-low)
const QUADRANTS: { power: PmStakeholderAxis; interest: PmStakeholderAxis }[] = [
  { power: 'low', interest: 'high' },
  { power: 'high', interest: 'high' },
  { power: 'low', interest: 'low' },
  { power: 'high', interest: 'low' },
];

let tmpSeq = 0;
const tmpId = () => `tmp-${Date.now()}-${tmpSeq++}`;

export function StakeholderPanel({ projectId, stakeholders, onSaved }: Props) {
  const [list, setList] = useState<PmStakeholder[]>(stakeholders);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);

  // 保持与最新数据一致：父级 reload 后同步
  useEffect(() => { setList(stakeholders); setEditingId(null); }, [stakeholders]);
  useEffect(() => { void getUsers({ page: 1, pageSize: 200 }).then((res) => { if (res.success) setUsers(res.data.items); }); }, []);
  const userName = useMemo(() => new Map(users.map((u) => [u.userId, u.displayName || u.username])), [users]);

  const nameOf = (s: PmStakeholder) => (s.userId ? (userName.get(s.userId) || s.name || '未选用户') : '未选用户');
  const editing = list.find((s) => s.id === editingId) || null;
  const update = (id: string, patch: Partial<PmStakeholder>) => setList((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const remove = (id: string) => { setList((prev) => prev.filter((s) => s.id !== id)); if (editingId === id) setEditingId(null); };
  const addToCell = (power: PmStakeholderAxis, interest: PmStakeholderAxis) => {
    const id = tmpId();
    setList((prev) => [...prev, { id, name: '', userId: '', isRepresentative: false, note: '', role: 'team', power, interest }]);
    setEditingId(id);
  };

  const save = async () => {
    const cleaned = list.filter((s) => s.userId);
    const badRep = cleaned.find((s) => s.isRepresentative && !(s.note ?? '').trim());
    if (badRep) { toast.warning('备注必填', `代表「${nameOf(badRep)}」需填写备注`); setEditingId(badRep.id); return; }
    setSaving(true);
    const res = await setPmStakeholders(projectId, {
      stakeholders: cleaned.map((s) => ({
        id: s.id.startsWith('tmp-') ? undefined : s.id,
        userId: s.userId!,
        isRepresentative: s.isRepresentative,
        note: s.isRepresentative ? (s.note ?? '').trim() : undefined,
        role: s.role, power: s.power, interest: s.interest,
      })),
    });
    setSaving(false);
    if (res.success) { toast.success('已保存', `${res.data.stakeholders.length} 位干系人`); onSaved(res.data.stakeholders); }
    else toast.error('保存失败', res.error?.message || '');
  };

  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>干系人 · 权力利益矩阵</div>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>点格子里的「+」加人，点头像卡编辑</span>
        <Button variant="primary" size="sm" className="ml-auto" onClick={save} disabled={saving}>{saving ? <MapSpinner size={13} /> : <Save size={13} />}保存</Button>
      </div>

      {/* 权力利益矩阵 = 干系人主界面 */}
      <div className="grid grid-cols-2 gap-2" style={{ gridTemplateRows: 'repeat(2, minmax(132px, auto))' }}>
        {QUADRANTS.map((q) => {
          const key = `${q.power}-${q.interest}`;
          const meta = POWER_INTEREST_MATRIX[key];
          const members = list.filter((s) => s.power === q.power && s.interest === q.interest);
          return (
            <div key={key} className="rounded-lg border p-3 flex flex-col" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
                <span className="text-[12px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
                <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>权力{q.power === 'high' ? '高' : '低'}·利益{q.interest === 'high' ? '高' : '低'}</span>
              </div>
              <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-muted)' }}>{meta.strategy}</div>
              <div className="flex flex-wrap gap-1.5 mt-2 flex-1 content-start">
                {members.map((s) => {
                  const roleMeta = STAKEHOLDER_ROLE_REGISTRY[s.role];
                  const active = editingId === s.id;
                  return (
                    <button key={s.id} onClick={() => setEditingId(s.id)}
                      className="group inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border"
                      style={{ background: active ? `${roleMeta.color}22` : 'var(--bg-card)', borderColor: active ? roleMeta.color : 'var(--border-subtle)', color: 'var(--text-primary)' }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: roleMeta.color }} />
                      {nameOf(s)}
                      {s.isRepresentative && <Star size={10} style={{ color: '#F59E0B' }} />}
                    </button>
                  );
                })}
                <button onClick={() => addToCell(q.power, q.interest)} className="inline-flex items-center gap-0.5 text-[11px] px-2 py-1 rounded-md border border-dashed" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                  <Plus size={11} />添加
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* 单个干系人编辑卡（不再整列展开） */}
      {editing && (
        <div className="rounded-xl border p-3.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>编辑干系人</span>
            <button onClick={() => remove(editing.id)} className="ml-auto p-1 rounded" style={{ color: '#EF4444' }} title="移除"><Trash2 size={14} /></button>
            <button onClick={() => setEditingId(null)} className="p-1 rounded" style={{ color: 'var(--text-muted)' }} title="收起"><X size={15} /></button>
          </div>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <div>
              <label className="text-[11px] block mb-1" style={{ color: 'var(--text-secondary)' }}>系统用户（必选）</label>
              <UserSearchSelect value={editing.userId || ''} onChange={(uid) => update(editing.id, { userId: uid, name: userName.get(uid) || '' })} users={users} placeholder="搜索 MAP 用户…" uiSize="sm" />
            </div>
            <div>
              <label className="text-[11px] block mb-1" style={{ color: 'var(--text-secondary)' }}>角色（权重）</label>
              <select className="w-full rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle} value={editing.role} onChange={(e) => update(editing.id, { role: e.target.value as PmStakeholderRole })}>
                {ROLES.map((r) => <option key={r} value={r}>{STAKEHOLDER_ROLE_REGISTRY[r].label}（{STAKEHOLDER_ROLE_REGISTRY[r].weightLabel}）</option>)}
              </select>
            </div>
            <div>
              <label className="text-[11px] block mb-1" style={{ color: 'var(--text-secondary)' }}>权力</label>
              <select className="w-full rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle} value={editing.power} onChange={(e) => update(editing.id, { power: e.target.value as PmStakeholderAxis })}>
                <option value="high">权力高</option><option value="low">权力低</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] block mb-1" style={{ color: 'var(--text-secondary)' }}>利益</label>
              <select className="w-full rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle} value={editing.interest} onChange={(e) => update(editing.id, { interest: e.target.value as PmStakeholderAxis })}>
                <option value="high">利益高</option><option value="low">利益低</option>
              </select>
            </div>
          </div>
          <label className="flex items-center gap-2 mt-3 text-[12px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={editing.isRepresentative} onChange={(e) => update(editing.id, { isRepresentative: e.target.checked })} style={{ accentColor: '#F59E0B' }} />
            作为外部方代表（代表无系统账号的客户/单位参与）
          </label>
          {editing.isRepresentative && (
            <div className="mt-2">
              <label className="text-[11px] block mb-1" style={{ color: 'var(--text-secondary)' }}>备注 <span style={{ color: '#EF4444' }}>*</span>（代表谁 / 职责）</label>
              <input className="w-full rounded-lg px-2 py-1.5 text-[12px] outline-none border" style={inputStyle} value={editing.note ?? ''} onChange={(e) => update(editing.id, { note: e.target.value })} placeholder="例如：代表客户 XX 公司采购部" />
            </div>
          )}

          {/* 保存放在编辑区底部，紧挨操作 */}
          <div className="flex items-center justify-end gap-2 mt-3.5 pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
            <span className="text-[11px] mr-auto" style={{ color: 'var(--text-muted)' }}>编辑完点「保存」落库（保存全部干系人）</span>
            <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>完成</Button>
            <Button variant="primary" onClick={save} disabled={saving}>{saving ? <MapSpinner size={14} /> : <Save size={14} />}保存</Button>
          </div>
        </div>
      )}
    </div>
  );
}
