import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Plus, Search, Trash2, UserPlus, X } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import {
  addTeamMembers,
  createTeam,
  deleteTeam,
  getTeam,
  joinTeam,
  listMyTeams,
  listTeamActivity,
  regenerateInviteCode,
  removeTeamMember,
  searchTeamUsers,
  updateTeamMemberRole,
  type Team,
  type TeamActivityItem,
  type TeamListItem,
  type TeamMember,
  type TeamRole,
  type UserCard,
} from '@/services/real/teams';

type Tab = 'members' | 'invite' | 'activity';

const ACTION_LABEL: Record<string, string> = {
  'team.created': '创建了团队',
  'team.updated': '更新了团队',
  'member.added': '添加了成员',
  'member.joined': '加入了团队',
  'member.removed': '移除了成员',
  'member.role_changed': '调整了成员角色',
  'site.shared': '分享了网页到团队',
  'site.updated': '更新了网页',
  'site.deleted': '删除了网页',
  'store.shared': '分享了知识库到团队',
  'entry.created': '新增了文档',
  'entry.updated': '更新了文档',
  'entry.deleted': '删除了文档',
};

export function TeamManagerPanel({ onClose }: { onClose: () => void }) {
  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [loadingTeams, setLoadingTeams] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('members');

  // 详情
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [myRole, setMyRole] = useState<TeamRole | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // 活动
  const [activity, setActivity] = useState<TeamActivityItem[]>([]);

  // 创建团队
  const [creating, setCreating] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [joinCode, setJoinCode] = useState('');

  // 添加成员搜索
  const [memberQuery, setMemberQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserCard[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isAdmin = myRole === 'admin';

  const reloadTeams = useCallback(async () => {
    setLoadingTeams(true);
    const res = await listMyTeams();
    if (res.success) {
      setTeams(res.data.items);
      if (!selectedId && res.data.items.length > 0) setSelectedId(res.data.items[0].team.id);
    }
    setLoadingTeams(false);
  }, [selectedId]);

  useEffect(() => {
    void reloadTeams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setLoadingDetail(true);
    const res = await getTeam(id);
    if (res.success) {
      setTeam(res.data.team);
      setMembers(res.data.members);
      setMyRole(res.data.myRole);
    }
    setLoadingDetail(false);
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (selectedId && tab === 'activity') {
      void listTeamActivity(selectedId, { limit: 100 }).then((res) => {
        if (res.success) setActivity(res.data.items);
      });
    }
  }, [selectedId, tab]);

  // ESC 关闭
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  // 成员搜索（防抖）
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!memberQuery.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimer.current = setTimeout(() => {
      void searchTeamUsers(memberQuery.trim()).then((res) => {
        if (res.success) {
          const existing = new Set(members.map((m) => m.userId));
          setSearchResults(res.data.items.filter((u) => !existing.has(u.userId)));
        }
      });
    }, 300);
  }, [memberQuery, members]);

  const handleCreate = async () => {
    if (!newTeamName.trim()) return;
    const res = await createTeam({ name: newTeamName.trim() });
    if (res.success) {
      setNewTeamName('');
      setCreating(false);
      await reloadTeams();
      setSelectedId(res.data.team.id);
    } else {
      alert(res.error?.message ?? '创建失败');
    }
  };

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    const res = await joinTeam(joinCode.trim());
    if (res.success) {
      setJoinCode('');
      await reloadTeams();
      setSelectedId(res.data.teamId);
    } else {
      alert(res.error?.message ?? '加入失败');
    }
  };

  const handleAddMember = async (userId: string) => {
    if (!selectedId) return;
    const res = await addTeamMembers(selectedId, [userId]);
    if (res.success) {
      setMemberQuery('');
      setSearchResults([]);
      await loadDetail(selectedId);
    } else {
      alert(res.error?.message ?? '添加失败');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!selectedId) return;
    const res = await removeTeamMember(selectedId, userId);
    if (res.success) await loadDetail(selectedId);
    else alert(res.error?.message ?? '移除失败');
  };

  const handleRoleChange = async (userId: string, role: TeamRole) => {
    if (!selectedId) return;
    const res = await updateTeamMemberRole(selectedId, userId, role);
    if (res.success) await loadDetail(selectedId);
    else alert(res.error?.message ?? '调整失败');
  };

  const handleDeleteTeam = async () => {
    if (!selectedId || !team) return;
    if (!confirm(`确认删除团队「${team.name}」？该团队下所有分享将解除。`)) return;
    const res = await deleteTeam(selectedId);
    if (res.success) {
      setSelectedId(null);
      setTeam(null);
      await reloadTeams();
    } else {
      alert(res.error?.message ?? '删除失败');
    }
  };

  const handleRegenInvite = async () => {
    if (!selectedId) return;
    const res = await regenerateInviteCode(selectedId);
    if (res.success && team) {
      setTeam({ ...team, inviteCode: res.data.inviteCode, inviteExpireAt: res.data.inviteExpireAt });
    }
  };

  const [copied, setCopied] = useState(false);
  const copyInvite = () => {
    if (!team) return;
    void navigator.clipboard.writeText(team.inviteCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const modal = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={onClose}
    >
      <div
        className="rounded-[14px] flex flex-col w-full"
        style={{
          height: '80vh',
          maxHeight: '80vh',
          maxWidth: '880px',
          background: 'var(--bg-elevated)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="shrink-0 flex items-center justify-between px-5 h-[52px]"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}
        >
          <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            团队管理
          </span>
          <button type="button" onClick={onClose} style={{ color: 'var(--text-muted)' }}>
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* 左：团队列表 */}
          <div
            className="w-[240px] shrink-0 flex flex-col"
            style={{ borderRight: '1px solid rgba(255,255,255,0.08)' }}
          >
            <div className="flex-1 min-h-0 overflow-auto py-2" style={{ overscrollBehavior: 'contain' }}>
              {loadingTeams ? (
                <MapSectionLoader text="加载团队…" />
              ) : teams.length === 0 ? (
                <div className="px-4 py-6 text-[12px] text-center" style={{ color: 'var(--text-muted)' }}>
                  还没有团队，新建或凭邀请码加入
                </div>
              ) : (
                teams.map((t) => (
                  <button
                    key={t.team.id}
                    type="button"
                    className="w-full text-left px-4 py-2.5 text-[13px] flex items-center justify-between hover:bg-white/5"
                    style={{
                      color: 'var(--text-primary)',
                      background: t.team.id === selectedId ? 'rgba(255,255,255,0.06)' : 'transparent',
                    }}
                    onClick={() => setSelectedId(t.team.id)}
                  >
                    <span className="truncate">{t.team.name}</span>
                    <span className="text-[11px] shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>
                      {t.memberCount}
                    </span>
                  </button>
                ))
              )}
            </div>

            {/* 新建 / 加入 */}
            <div className="shrink-0 p-3 space-y-2" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              {creating ? (
                <div className="space-y-1.5">
                  <input
                    autoFocus
                    value={newTeamName}
                    onChange={(e) => setNewTeamName(e.target.value)}
                    placeholder="团队名称"
                    className="w-full h-8 px-2 rounded-[8px] text-[13px] outline-none"
                    style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  />
                  <div className="flex gap-1.5">
                    <button type="button" className="flex-1 h-8 rounded-[8px] text-[12px]" style={{ background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' }} onClick={handleCreate}>
                      创建
                    </button>
                    <button type="button" className="px-2 h-8 rounded-[8px] text-[12px]" style={{ color: 'var(--text-muted)' }} onClick={() => setCreating(false)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="w-full h-8 rounded-[8px] text-[12px] flex items-center justify-center gap-1.5"
                  style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  onClick={() => setCreating(true)}
                >
                  <Plus size={13} /> 新建团队
                </button>
              )}
              <div className="flex gap-1.5">
                <input
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="邀请码加入"
                  className="flex-1 h-8 px-2 rounded-[8px] text-[12px] outline-none"
                  style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                />
                <button type="button" className="px-2.5 h-8 rounded-[8px] text-[12px]" style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-muted)' }} onClick={handleJoin}>
                  加入
                </button>
              </div>
            </div>
          </div>

          {/* 右：团队详情 */}
          <div className="flex-1 min-h-0 flex flex-col">
            {!selectedId || !team ? (
              <div className="flex-1 flex items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
                选择左侧团队查看详情
              </div>
            ) : loadingDetail ? (
              <MapSectionLoader text="加载详情…" />
            ) : (
              <>
                {/* Tabs */}
                <div className="shrink-0 flex items-center gap-1 px-4 h-[44px]" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                  {(['members', 'invite', 'activity'] as Tab[]).map((tk) => (
                    <button
                      key={tk}
                      type="button"
                      className="px-3 h-8 rounded-[8px] text-[13px]"
                      style={tab === tk ? { background: 'rgba(255,255,255,0.08)', color: 'var(--text-primary)' } : { color: 'var(--text-muted)' }}
                      onClick={() => setTab(tk)}
                    >
                      {tk === 'members' ? '成员' : tk === 'invite' ? '邀请' : '活动日志'}
                    </button>
                  ))}
                  {isAdmin && (
                    <button type="button" className="ml-auto px-2.5 h-8 rounded-[8px] text-[12px] flex items-center gap-1" style={{ color: 'var(--danger, #ef4444)' }} onClick={handleDeleteTeam}>
                      <Trash2 size={12} /> 删除团队
                    </button>
                  )}
                </div>

                <div className="flex-1 min-h-0 overflow-auto p-4" style={{ overscrollBehavior: 'contain' }}>
                  {tab === 'members' && (
                    <div className="space-y-3">
                      {isAdmin && (
                        <div className="relative">
                          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                          <input
                            value={memberQuery}
                            onChange={(e) => setMemberQuery(e.target.value)}
                            placeholder="搜索用户昵称 / 用户名添加成员"
                            className="w-full h-9 pl-8 pr-3 rounded-[8px] text-[13px] outline-none"
                            style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                          />
                          {searchResults.length > 0 && (
                            <div className="mt-1 rounded-[8px] py-1 max-h-[200px] overflow-auto" style={{ background: 'var(--bg-elevated)', border: '1px solid rgba(255,255,255,0.12)' }}>
                              {searchResults.map((u) => (
                                <button key={u.userId} type="button" className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/8 text-left" onClick={() => handleAddMember(u.userId)}>
                                  <UserAvatar src={resolveAvatarUrl({ avatarFileName: u.avatarFileName })} className="w-6 h-6 rounded-full" />
                                  <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{u.displayName}</span>
                                  <span className="text-[11px] ml-auto" style={{ color: 'var(--text-muted)' }}>@{u.username}</span>
                                  <UserPlus size={13} style={{ color: 'var(--accent-gold)' }} />
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {members.map((m) => (
                        <div key={m.userId} className="flex items-center gap-3 py-1.5">
                          <UserAvatar src={resolveAvatarUrl({ avatarFileName: m.avatarFileName })} className="w-8 h-8 rounded-full" />
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] truncate" style={{ color: 'var(--text-primary)' }}>
                              {m.userName ?? m.userId}
                              {m.userId === team.ownerUserId && (
                                <span className="ml-1.5 text-[10px] px-1 py-px rounded" style={{ background: 'rgba(212,175,55,0.15)', color: 'var(--accent-gold)' }}>创建者</span>
                              )}
                            </div>
                          </div>
                          {isAdmin && m.userId !== team.ownerUserId ? (
                            <select
                              value={m.role}
                              onChange={(e) => handleRoleChange(m.userId, e.target.value as TeamRole)}
                              className="h-7 px-2 rounded-[6px] text-[12px] outline-none"
                              style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                            >
                              <option value="member">成员</option>
                              <option value="admin">管理员</option>
                            </select>
                          ) : (
                            <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                              {m.role === 'admin' ? '管理员' : '成员'}
                            </span>
                          )}
                          {isAdmin && m.userId !== team.ownerUserId && (
                            <button type="button" onClick={() => handleRemoveMember(m.userId)} style={{ color: 'var(--text-muted)' }}>
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {tab === 'invite' && (
                    <div className="space-y-3 max-w-[420px]">
                      <div className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                        把邀请码发给同事，对方在「管理团队」里凭码加入。
                      </div>
                      <div className="flex items-center gap-2">
                        <div
                          className="flex-1 h-10 px-3 rounded-[8px] flex items-center font-mono text-[14px]"
                          style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                        >
                          {team.inviteCode}
                        </div>
                        <button type="button" className="h-10 px-3 rounded-[8px] flex items-center gap-1.5 text-[13px]" style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }} onClick={copyInvite}>
                          {copied ? <Check size={14} style={{ color: '#22c55e' }} /> : <Copy size={14} />}
                          {copied ? '已复制' : '复制'}
                        </button>
                      </div>
                      {isAdmin && (
                        <button type="button" className="text-[12px]" style={{ color: 'var(--accent-gold)' }} onClick={handleRegenInvite}>
                          重新生成邀请码
                        </button>
                      )}
                    </div>
                  )}

                  {tab === 'activity' && (
                    <div className="space-y-2.5">
                      {activity.length === 0 ? (
                        <div className="text-[13px] text-center py-8" style={{ color: 'var(--text-muted)' }}>暂无活动记录</div>
                      ) : (
                        activity.map((a) => (
                          <div key={a.id} className="flex items-start gap-2.5">
                            <UserAvatar src={resolveAvatarUrl({ avatarFileName: a.actorAvatarFileName })} className="w-6 h-6 rounded-full mt-0.5" />
                            <div className="flex-1 min-w-0 text-[13px]" style={{ color: 'var(--text-primary)' }}>
                              <span className="font-medium">{a.actorName}</span>
                              <span style={{ color: 'var(--text-muted)' }}> {ACTION_LABEL[a.action] ?? a.action}</span>
                              {a.targetTitle && <span> 「{a.targetTitle}」</span>}
                              <span className="block text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                {new Date(a.createdAt).toLocaleString()}
                              </span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
