import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Save, Crown, UserCircle } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toast } from '@/lib/toast';
import { getPmMembers, setPmMembers } from '@/services';
import type { PmMember } from '@/services/contracts/pmAgent';

interface Props {
  projectId: string;
  /** 当前用户是否可管理成员（owner/leader） */
  canManage: boolean;
}

/**
 * 项目成员管理 — 参与干活的人（区别于干系人）。
 * 从 MAP 用户中选择，项目经理/创建人带标识，整体保存。
 */
export function MembersPanel({ projectId, canManage }: Props) {
  const [members, setMembers] = useState<PmMember[]>([]);
  const [leaderId, setLeaderId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pickId, setPickId] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const res = await getPmMembers(projectId);
    if (res.success) { setMembers(res.data.members); setLeaderId(res.data.leaderId); setOwnerId(res.data.ownerId); }
    else toast.error('加载失败', res.error?.message || '');
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const addMember = (uid: string) => {
    setPickId('');
    if (!uid || members.some((m) => m.userId === uid)) return;
    // 用占位，保存后由后端回填显示名/头像
    setMembers((prev) => [...prev, { userId: uid, displayName: uid, avatarFileName: null }]);
    setDirty(true);
  };
  const remove = (uid: string) => { setMembers((prev) => prev.filter((m) => m.userId !== uid)); setDirty(true); };

  const save = async () => {
    setSaving(true);
    const res = await setPmMembers(projectId, members.map((m) => m.userId));
    setSaving(false);
    if (res.success) { setMembers(res.data.members); setDirty(false); toast.success('已保存', `${res.data.members.length} 位成员`); }
    else toast.error('保存失败', res.error?.message || '');
  };

  if (loading) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载成员…" /></div>;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>项目成员（{members.length}）</div>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>参与项目执行的人，区别于评价相关的干系人</span>
        {canManage && dirty && (
          <Button variant="primary" size="sm" className="ml-auto" onClick={save} disabled={saving}>
            {saving ? <MapSpinner size={13} /> : <Save size={13} />}保存
          </Button>
        )}
      </div>

      {canManage && (
        <div className="flex items-center gap-2" style={{ maxWidth: 320 }}>
          <UserSearchSelect value={pickId} onChange={addMember} placeholder="搜索并添加成员…" uiSize="sm" />
          <Plus size={15} style={{ color: 'var(--text-muted)' }} />
        </div>
      )}

      <div className="flex flex-col gap-2">
        {members.length === 0 && (
          <div className="text-[12px] text-center py-8 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
            还没有成员。{canManage ? '上方搜索用户添加。' : '仅项目经理/创建人可管理成员。'}
          </div>
        )}
        {members.map((m) => {
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
              {isLeader && <span className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-0.5" style={{ background: 'rgba(245,158,11,0.15)', color: '#F59E0B' }}><Crown size={10} />项目经理</span>}
              {isOwner && !isLeader && <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(59,130,246,0.15)', color: '#3B82F6' }}>创建人</span>}
              {canManage && (
                <button onClick={() => remove(m.userId)} className="opacity-0 group-hover:opacity-100 p-1 rounded shrink-0" style={{ color: 'var(--text-muted)' }} title="移除成员"><Trash2 size={14} /></button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
