import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Save, Crown, UserCircle, Eye } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toast } from '@/lib/toast';
import { getPmMembers, setPmMembers, setPmObservers } from '@/services';
import type { PmMember } from '@/services/contracts/pmAgent';
import type { AdminUser } from '@/types/admin';

interface Props {
  projectId: string;
  /** 当前用户是否可管理成员（owner/leader） */
  canManage: boolean;
}

/**
 * 项目成员管理 — 分两区块：
 * - 成员：参与项目执行 / 日常事务的人
 * - 观察者：拥有与成员一样的权限，但主要是看，一般不参与日常事务（与成员互斥，可同时是干系人）
 * 从 MAP 用户中选择，项目经理/创建人带标识，整体保存（一次保存同时落库成员 + 观察者）。
 */
export function MembersPanel({ projectId, canManage }: Props) {
  const [members, setMembers] = useState<PmMember[]>([]);
  const [observers, setObservers] = useState<PmMember[]>([]);
  const [leaderId, setLeaderId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pickMember, setPickMember] = useState('');
  const [pickObserver, setPickObserver] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const res = await getPmMembers(projectId);
    if (res.success) {
      setMembers(res.data.members);
      setObservers(res.data.observers);
      setLeaderId(res.data.leaderId);
      setOwnerId(res.data.ownerId);
      setDirty(false);
    } else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // 互斥：加成员时从观察者剔除；加观察者时从成员剔除（项目经理不可作观察者）。
  // 姓名/头像由 UserSearchSelect 的 onSelectUser 直接给到（directory 搜索普通用户可用，不再预取管理员用户列表）
  const addMember = (u: AdminUser) => {
    setPickMember('');
    const uid = u.userId;
    if (!uid || members.some((m) => m.userId === uid)) return;
    setObservers((prev) => prev.filter((o) => o.userId !== uid));
    setMembers((prev) => [...prev, { userId: uid, displayName: u.displayName || u.username || uid, avatarFileName: u.avatarFileName ?? null }]);
    setDirty(true);
  };
  const addObserver = (u: AdminUser) => {
    setPickObserver('');
    const uid = u.userId;
    if (!uid || uid === leaderId || observers.some((o) => o.userId === uid)) return;
    setMembers((prev) => prev.filter((m) => m.userId !== uid));
    setObservers((prev) => [...prev, { userId: uid, displayName: u.displayName || u.username || uid, avatarFileName: u.avatarFileName ?? null }]);
    setDirty(true);
  };
  const removeMember = (uid: string) => { setMembers((prev) => prev.filter((m) => m.userId !== uid)); setDirty(true); };
  const removeObserver = (uid: string) => { setObservers((prev) => prev.filter((o) => o.userId !== uid)); setDirty(true); };

  const save = async () => {
    setSaving(true);
    // 顺序要紧：先落成员（后端会把新成员从观察者剔除），再落观察者（后端拒绝仍属成员的 id）
    const r1 = await setPmMembers(projectId, members.map((m) => m.userId));
    if (!r1.success) { setSaving(false); toast.error('保存失败', r1.error?.message || ''); return; }
    const r2 = await setPmObservers(projectId, observers.map((o) => o.userId));
    setSaving(false);
    if (!r2.success) { toast.error('保存失败', r2.error?.message || ''); return; }
    toast.success('已保存', `${members.length} 位成员 · ${observers.length} 位观察者`);
    await load();
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载成员…" /></div>;

  const sortedMembers = [...members].sort((a, b) => (a.userId === leaderId ? -1 : 0) - (b.userId === leaderId ? -1 : 0));

  const renderRow = (m: PmMember, kind: 'member' | 'observer') => {
    const avatar = resolveAvatarUrl({ avatarFileName: m.avatarFileName });
    const isLeader = m.userId === leaderId;
    const isOwner = m.userId === ownerId;
    return (
      <div key={m.userId} className="group flex items-center gap-3 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        {avatar ? (
          <img src={avatar} alt="" className="w-7 h-7 rounded-full object-cover shrink-0" />
        ) : (
          <UserCircle size={28} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
        )}
        <span className="text-[13px] flex-1 min-w-0 truncate" style={{ color: 'var(--text-primary)' }}>{m.displayName}</span>
        {kind === 'member' && isLeader && <span className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-0.5" style={{ background: 'rgba(245,158,11,0.15)', color: '#F59E0B' }}><Crown size={10} />项目经理</span>}
        {kind === 'member' && isOwner && !isLeader && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(59,130,246,0.15)', color: '#3B82F6' }}>创建人</span>}
        {canManage && !(kind === 'member' && isLeader) && (
          <button onClick={() => (kind === 'member' ? removeMember(m.userId) : removeObserver(m.userId))} className="opacity-0 group-hover:opacity-100 p-1 rounded shrink-0" style={{ color: 'var(--text-muted)' }} title={kind === 'member' ? '移除成员' : '移除观察者'}><Trash2 size={14} /></button>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-5 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      {/* 顶部：标题 + 统一保存 */}
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>团队成员</div>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>成员参与干活，观察者主要旁观；二者权限相同、身份互斥</span>
        {canManage && dirty && (
          <Button variant="primary" size="sm" className="ml-auto" onClick={save} disabled={saving}>
            {saving ? <MapSpinner size={13} /> : <Save size={13} />}保存
          </Button>
        )}
      </div>

      {/* 成员区块 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <UserCircle size={14} style={{ color: '#3B82F6' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>成员（{members.length}）</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>参与项目执行与日常事务</span>
        </div>
        {canManage && (
          <div className="flex items-center gap-2" style={{ maxWidth: 320 }}>
            <UserSearchSelect value={pickMember} onChange={() => {}} onSelectUser={addMember} placeholder="搜索并添加成员…" uiSize="sm" />
            <Plus size={15} style={{ color: 'var(--text-muted)' }} />
          </div>
        )}
        {members.length === 0 ? (
          <div className="text-[12px] text-center py-6 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
            还没有成员。{canManage ? '上方搜索用户添加。' : '仅项目经理/创建人可管理。'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">{sortedMembers.map((m) => renderRow(m, 'member'))}</div>
        )}
      </div>

      {/* 观察者区块 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Eye size={14} style={{ color: '#8B5CF6' }} />
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>观察者（{observers.length}）</span>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>权限同成员，主要是看，一般不参与日常事务</span>
        </div>
        {canManage && (
          <div className="flex items-center gap-2" style={{ maxWidth: 320 }}>
            <UserSearchSelect value={pickObserver} onChange={() => {}} onSelectUser={addObserver} placeholder="搜索并添加观察者…" uiSize="sm" />
            <Plus size={15} style={{ color: 'var(--text-muted)' }} />
          </div>
        )}
        {observers.length === 0 ? (
          <div className="text-[12px] text-center py-6 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
            还没有观察者。{canManage ? '可邀请关注项目但不直接参与的人旁观。' : '仅项目经理/创建人可管理。'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">{observers.map((o) => renderRow(o, 'observer'))}</div>
        )}
      </div>
    </div>
  );
}
