import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save } from 'lucide-react';
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
const QUADRANTS: { power: PmStakeholderAxis; interest: PmStakeholderAxis }[] = [
  { power: 'low', interest: 'high' },
  { power: 'high', interest: 'high' },
  { power: 'low', interest: 'low' },
  { power: 'high', interest: 'low' },
];

let tmpSeq = 0;
const tmpId = () => `tmp-${Date.now()}-${tmpSeq++}`;

type Row = PmStakeholder;

export function StakeholderPanel({ projectId, stakeholders, onSaved }: Props) {
  const [list, setList] = useState<Row[]>(stakeholders);
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState<AdminUser[]>([]);

  useEffect(() => { void getUsers({ page: 1, pageSize: 200 }).then((res) => { if (res.success) setUsers(res.data.items); }); }, []);
  const userName = useMemo(() => new Map(users.map((u) => [u.userId, u.displayName || u.username])), [users]);

  const addInternal = () => setList((prev) => [...prev, { id: tmpId(), name: '', userId: '', isExternal: false, role: 'team', power: 'low', interest: 'high' }]);
  const addExternal = () => setList((prev) => [...prev, { id: tmpId(), name: '', userId: null, isExternal: true, role: 'beneficiary', power: 'high', interest: 'high' }]);
  const update = (id: string, patch: Partial<Row>) => setList((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const remove = (id: string) => setList((prev) => prev.filter((s) => s.id !== id));

  // 行的展示名（内部=用户名，外部=手填名）
  const rowName = (s: Row) => (s.isExternal ? s.name : (s.userId ? (userName.get(s.userId) || s.name || '(已选用户)') : ''));

  const save = async () => {
    const cleaned = list.filter((s) => (s.isExternal ? s.name.trim() : !!s.userId));
    setSaving(true);
    const res = await setPmStakeholders(projectId, {
      stakeholders: cleaned.map((s) => ({
        id: s.id.startsWith('tmp-') ? undefined : s.id,
        name: s.isExternal ? s.name.trim() : undefined,
        userId: s.isExternal ? undefined : (s.userId || undefined),
        isExternal: s.isExternal,
        role: s.role, power: s.power, interest: s.interest,
      })),
    });
    setSaving(false);
    if (res.success) { toast.success('已保存', `${res.data.stakeholders.length} 位干系人`); onSaved(res.data.stakeholders); setList(res.data.stakeholders); }
    else toast.error('保存失败', res.error?.message || '');
  };

  const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      {/* 权力利益矩阵 2×2 */}
      <div>
        <div className="text-[13px] font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>权力利益矩阵</div>
        <div className="grid grid-cols-2 gap-2" style={{ gridTemplateRows: 'repeat(2, minmax(110px, auto))' }}>
          {QUADRANTS.map((q) => {
            const key = `${q.power}-${q.interest}`;
            const meta = POWER_INTEREST_MATRIX[key];
            const members = list.filter((s) => s.power === q.power && s.interest === q.interest && rowName(s).trim());
            return (
              <div key={key} className="rounded-lg border p-3 flex flex-col" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
                  <span className="text-[12px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
                  <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>权力{q.power === 'high' ? '高' : '低'}·利益{q.interest === 'high' ? '高' : '低'}</span>
                </div>
                <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-muted)' }}>{meta.strategy}</div>
                <div className="flex flex-wrap gap-1 mt-2">
                  {members.map((s) => (
                    <span key={s.id} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)' }}>{rowName(s)}{s.isExternal ? ' · 外部' : ''}</span>
                  ))}
                  {members.length === 0 && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>—</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 干系人列表编辑 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>干系人列表</div>
          <div className="flex gap-1.5">
            <Button variant="secondary" size="sm" onClick={addInternal}><Plus size={13} />成员</Button>
            <Button variant="ghost" size="sm" onClick={addExternal}><Plus size={13} />外部</Button>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          {list.length === 0 && (
            <div className="text-[12px] text-center py-6 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
              暂无干系人。「成员」从系统用户中选（可在线打分）；「外部」用于无账号的客户（由立项人代录评分）。
            </div>
          )}
          {list.map((s) => {
            const roleMeta = STAKEHOLDER_ROLE_REGISTRY[s.role];
            return (
              <div key={s.id} className="rounded-lg border p-2.5 flex items-center gap-2 flex-wrap" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
                <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: s.isExternal ? 'rgba(245,158,11,0.15)' : 'rgba(59,130,246,0.15)', color: s.isExternal ? '#F59E0B' : '#3B82F6' }}>{s.isExternal ? '外部' : '成员'}</span>
                <div className="flex-1 min-w-[160px]">
                  {s.isExternal ? (
                    <input className="w-full rounded px-2 py-1 text-[12px] outline-none border" style={inputStyle} value={s.name} onChange={(e) => update(s.id, { name: e.target.value })} placeholder="外部干系人姓名 / 单位" />
                  ) : (
                    <UserSearchSelect value={s.userId || ''} onChange={(uid) => update(s.id, { userId: uid, name: userName.get(uid) || '' })} users={users} placeholder="从系统用户选择…" uiSize="sm" />
                  )}
                </div>
                <select className="rounded px-2 py-1 text-[11px] outline-none border" style={{ ...inputStyle, color: roleMeta.color }} value={s.role} onChange={(e) => update(s.id, { role: e.target.value as PmStakeholderRole })}>
                  {ROLES.map((r) => <option key={r} value={r}>{STAKEHOLDER_ROLE_REGISTRY[r].label}（{STAKEHOLDER_ROLE_REGISTRY[r].weightLabel}）</option>)}
                </select>
                <select className="rounded px-2 py-1 text-[11px] outline-none border" style={inputStyle} value={s.power} onChange={(e) => update(s.id, { power: e.target.value as PmStakeholderAxis })}>
                  <option value="high">权力高</option>
                  <option value="low">权力低</option>
                </select>
                <select className="rounded px-2 py-1 text-[11px] outline-none border" style={inputStyle} value={s.interest} onChange={(e) => update(s.id, { interest: e.target.value as PmStakeholderAxis })}>
                  <option value="high">利益高</option>
                  <option value="low">利益低</option>
                </select>
                <button onClick={() => remove(s.id)} className="p-1 rounded shrink-0" style={{ color: 'var(--text-muted)' }}><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>
        <div className="flex justify-end mt-3">
          <Button variant="primary" onClick={save} disabled={saving}>{saving ? <MapSpinner size={14} /> : <Save size={14} />}保存干系人</Button>
        </div>
      </div>
    </div>
  );
}
