import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LogOut, Plus, Search, Trash2, UserPlus, X } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { useAuthStore } from '@/stores/authStore';
import {
  addTeamMembers,
  createTeam,
  deleteTeam,
  getTeam,
  listMyTeams,
  listTeamActivity,
  removeTeamMember,
  searchTeamUsers,
  updateMemberLabels,
  updateMemberWebHostingRole,
  updateTeamMemberRole,
  type Team,
  type TeamActivityItem,
  type TeamListItem,
  type TeamMember,
  type TeamRole,
  type UserCard,
  type WebHostingRole,
} from '@/services/real/teams';
import {
  WEB_HOSTING_ROLE_HINT,
  WEB_HOSTING_ROLE_LABEL,
  WEB_HOSTING_ROLE_OPTIONS,
} from '@/lib/webHostingRole';

type Tab = 'members' | 'invite' | 'activity';

const ACTION_LABEL: Record<string, string> = {
  'team.created': '创建了团队空间',
  'team.updated': '更新了团队空间',
  'member.added': '添加了成员',
  'member.joined': '加入了团队空间',
  'member.removed': '移除了成员',
  'member.role_changed': '调整了成员角色',
  'site.shared': '分享了网页',
  'site.updated': '更新了网页',
  'site.deleted': '删除了网页',
  'store.shared': '分享了知识库',
  'entry.created': '新增了文档',
  'entry.updated': '更新了文档',
  'entry.deleted': '删除了文档',
};

export function TeamManagerPanel({ onClose, initialTab, initialTeamId }: {
  onClose: () => void;
  initialTab?: Tab;
  initialTeamId?: string;
}) {
  const myUserId = useAuthStore((s) => s.user?.userId ?? '');

  const [teams, setTeams] = useState<TeamListItem[]>([]);
  const [loadingTeams, setLoadingTeams] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(initialTeamId ?? null);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'members');

  // 详情
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [myRole, setMyRole] = useState<TeamRole | null>(null);
  const [webHostingRoles, setWebHostingRoles] = useState<Record<string, WebHostingRole>>({});
  const [loadingDetail, setLoadingDetail] = useState(false);

  // 活动
  const [activity, setActivity] = useState<TeamActivityItem[]>([]);

  // fetch 防 stale 响应：每次发起 fetch 递增 seq，回填前比对，避免快速切换团队/切 tab 时旧响应覆盖新结果
  const activityFetchSeq = useRef(0);

  // 创建团队
  const [creating, setCreating] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');

  // 多选邀请（invite tab）
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState<UserCard[]>([]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [pendingCards, setPendingCards] = useState<Map<string, UserCard>>(new Map());
  const [inviting, setInviting] = useState(false);
  const inviteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isAdmin = myRole === 'admin';
  const isOwner = team != null && myUserId === team.ownerUserId;
  const canLeave = !isOwner && myUserId != null && members.some((m) => m.userId === myUserId);

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
      setWebHostingRoles(res.data.webHostingRoles ?? {});
    }
    setLoadingDetail(false);
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (selectedId && tab === 'activity') {
      const mySeq = ++activityFetchSeq.current;
      void listTeamActivity(selectedId, { limit: 100 }).then((res) => {
        if (activityFetchSeq.current !== mySeq) return; // 已被更新的请求覆盖，丢弃
        if (res.success) setActivity(res.data.items);
      });
    }
  }, [selectedId, tab]);

  // 切换团队时重置邀请状态
  useEffect(() => {
    setInviteQuery('');
    setInviteResults([]);
    setPendingIds(new Set());
    setPendingCards(new Map());
  }, [selectedId]);

  // ESC 关闭
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [onClose]);

  // 邀请搜索（防抖）
  useEffect(() => {
    if (inviteTimer.current) clearTimeout(inviteTimer.current);
    if (!inviteQuery.trim()) {
      setInviteResults([]);
      return;
    }
    inviteTimer.current = setTimeout(() => {
      void searchTeamUsers(inviteQuery.trim()).then((res) => {
        if (res.success) {
          const existing = new Set(members.map((m) => m.userId));
          setInviteResults(res.data.items.filter((u) => !existing.has(u.userId)));
        }
      });
    }, 300);
  }, [inviteQuery, members]);

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

  const togglePending = (u: UserCard) => {
    const next = new Set(pendingIds);
    const nextCards = new Map(pendingCards);
    if (next.has(u.userId)) {
      next.delete(u.userId);
      nextCards.delete(u.userId);
    } else {
      next.add(u.userId);
      nextCards.set(u.userId, u);
    }
    setPendingIds(next);
    setPendingCards(nextCards);
  };

  const handleConfirmInvite = async () => {
    if (!selectedId || pendingIds.size === 0) return;
    setInviting(true);
    const res = await addTeamMembers(selectedId, [...pendingIds]);
    setInviting(false);
    if (res.success) {
      setPendingIds(new Set());
      setPendingCards(new Map());
      setInviteQuery('');
      setInviteResults([]);
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

  const handleLeave = async () => {
    if (!selectedId || !myUserId) return;
    if (!confirm('确认退出该团队空间？退出后不再能查看团队共享内容。')) return;
    const res = await removeTeamMember(selectedId, myUserId);
    if (res.success) {
      setSelectedId(null);
      setTeam(null);
      await reloadTeams();
    } else {
      alert(res.error?.message ?? '退出失败');
    }
  };

  const handleRoleChange = async (userId: string, role: TeamRole) => {
    if (!selectedId) return;
    const res = await updateTeamMemberRole(selectedId, userId, role);
    if (res.success) await loadDetail(selectedId);
    else alert(res.error?.message ?? '调整失败');
  };

  const handleWebHostingRoleChange = async (userId: string, role: WebHostingRole) => {
    if (!selectedId) return;
    const res = await updateMemberWebHostingRole(selectedId, userId, role);
    if (res.success) await loadDetail(selectedId);
    else alert(res.error?.message ?? '调整失败');
  };

  // ── 角色标签（仅作授权分组用，本身不产生权限）──
  const [labelInput, setLabelInput] = useState<{ userId: string; value: string } | null>(null);
  // 双击标签 chip 就地改名
  const [labelEdit, setLabelEdit] = useState<{ userId: string; oldLabel: string; value: string } | null>(null);

  const saveLabels = async (userId: string, labels: string[]) => {
    if (!selectedId) return;
    // 乐观更新：chips 立即增删，不走 loadDetail（避免整个面板 loading 闪刷）；失败回滚
    const prev = members;
    setMembers(prev.map((m) => (m.userId === userId ? { ...m, labels } : m)));
    const res = await updateMemberLabels(selectedId, userId, labels);
    if (!res.success) {
      setMembers(prev);
      alert(res.error?.message ?? '标签更新失败');
    }
  };

  const handleAddLabel = async (m: TeamMember) => {
    const value = labelInput?.value.trim();
    setLabelInput(null);
    if (!value) return;
    const current = m.labels ?? [];
    if (current.includes(value)) return;
    await saveLabels(m.userId, [...current, value]);
  };

  const handleRemoveLabel = async (m: TeamMember, label: string) => {
    await saveLabels(m.userId, (m.labels ?? []).filter((l) => l !== label));
  };

  const commitLabelRename = async (m: TeamMember) => {
    if (!labelEdit) return;
    const { oldLabel } = labelEdit;
    const next = labelEdit.value.trim();
    setLabelEdit(null);
    if (!next || next === oldLabel) return;
    // 同名标签已存在 → 等价于合并：移除旧标签即可
    const renamed = (m.labels ?? []).map((l) => (l === oldLabel ? next : l));
    await saveLabels(m.userId, [...new Set(renamed)]);
  };

  // 团队内已有标签字典（union），加标签时可快速复用
  const teamLabelDict = [...new Set(members.flatMap((m) => m.labels ?? []))];

  const handleDeleteTeam = async () => {
    if (!selectedId || !team) return;
    if (!confirm(
      `确认解散团队空间「${team.name}」？\n\n` +
      `你的托管站点将移入「${team.name} 团队解散文件夹」，其他成员的站点将回到各自的个人空间。此操作不可撤销。`
    )) return;
    const res = await deleteTeam(selectedId);
    if (res.success) {
      setSelectedId(null);
      setTeam(null);
      await reloadTeams();
    } else {
      alert(res.error?.message ?? '解散失败');
    }
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
            团队空间管理
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
                <MapSectionLoader text="加载团队空间…" />
              ) : teams.length === 0 ? (
                <div className="px-4 py-6 text-[12px] text-center" style={{ color: 'var(--text-muted)' }}>
                  还没有团队空间，新建或加入
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

            {/* 新建 */}
            <div className="shrink-0 p-3" style={{ borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              {creating ? (
                <div className="space-y-1.5">
                  <input
                    autoFocus
                    value={newTeamName}
                    onChange={(e) => setNewTeamName(e.target.value)}
                    placeholder="团队空间名称"
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
                  <Plus size={13} /> 新建团队空间
                </button>
              )}
            </div>
          </div>

          {/* 右：团队详情 */}
          <div className="flex-1 min-h-0 flex flex-col">
            {!selectedId || !team ? (
              <div className="flex-1 flex items-center justify-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
                选择左侧团队空间查看详情
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
                      {tk === 'members' ? '成员' : tk === 'invite' ? '添加成员' : '活动日志'}
                    </button>
                  ))}
                  <div className="ml-auto flex items-center gap-1">
                    {canLeave && (
                      <button type="button" className="px-2.5 h-8 rounded-[8px] text-[12px] flex items-center gap-1" style={{ color: 'var(--text-muted)' }} onClick={handleLeave}>
                        <LogOut size={12} /> 退出
                      </button>
                    )}
                    {isAdmin && (
                      <button type="button" className="px-2.5 h-8 rounded-[8px] text-[12px] flex items-center gap-1" style={{ color: 'var(--danger, #ef4444)' }} onClick={handleDeleteTeam}>
                        <Trash2 size={12} /> 解散团队
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-auto p-4" style={{ overscrollBehavior: 'contain' }}>
                  {tab === 'members' && (
                    <div className="space-y-1">
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
                            {/* 角色标签：如「前端组」「测试组」，供分组权限按标签批量授权 */}
                            <div className="flex flex-wrap items-center gap-1 mt-0.5">
                              {(m.labels ?? []).map((label) => (
                                labelEdit?.userId === m.userId && labelEdit.oldLabel === label ? (
                                  <input
                                    key={label}
                                    autoFocus
                                    value={labelEdit.value}
                                    onChange={(e) => setLabelEdit({ userId: m.userId, oldLabel: label, value: e.target.value })}
                                    onBlur={() => void commitLabelRename(m)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') void commitLabelRename(m);
                                      if (e.key === 'Escape') setLabelEdit(null);
                                    }}
                                    className="h-5 px-1.5 rounded-full text-[10px] outline-none"
                                    style={{
                                      width: `${Math.min(24, Math.max(5, [...labelEdit.value].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0) + 3))}ch`,
                                      background: 'var(--bg-input)',
                                      border: '1px solid rgba(212,175,55,0.5)',
                                      color: 'var(--text-primary)',
                                    }}
                                  />
                                ) : (
                                <span
                                  key={label}
                                  onDoubleClick={() => { if (isAdmin) setLabelEdit({ userId: m.userId, oldLabel: label, value: label }); }}
                                  title={isAdmin ? '双击重命名标签' : undefined}
                                  className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-px rounded-full"
                                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-muted)', cursor: isAdmin ? 'default' : undefined }}
                                >
                                  {label}
                                  {isAdmin && (
                                    <button
                                      type="button"
                                      title="移除标签"
                                      className="cursor-pointer p-1 -m-1 opacity-70 hover:opacity-100"
                                      onClick={() => void handleRemoveLabel(m, label)}
                                      style={{ color: 'var(--text-muted)' }}
                                    >
                                      <X size={10} />
                                    </button>
                                  )}
                                </span>
                                )
                              ))}
                              {isAdmin && (
                                labelInput?.userId === m.userId ? (
                                  <span className="inline-flex items-center gap-1">
                                    <input
                                      autoFocus
                                      list={`team-label-dict-${team.id}`}
                                      value={labelInput.value}
                                      onChange={(e) => setLabelInput({ userId: m.userId, value: e.target.value })}
                                      onBlur={() => void handleAddLabel(m)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') void handleAddLabel(m);
                                        if (e.key === 'Escape') setLabelInput(null);
                                      }}
                                      placeholder="如：前端组"
                                      className="h-5 w-[100px] px-1.5 rounded-full text-[10px] outline-none"
                                      style={{ background: 'var(--bg-input)', border: '1px solid rgba(212,175,55,0.5)', color: 'var(--text-primary)' }}
                                    />
                                    <datalist id={`team-label-dict-${team.id}`}>
                                      {teamLabelDict.map((l) => <option key={l} value={l} />)}
                                    </datalist>
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    title="添加角色标签（如「前端组」），分组权限可按标签批量授权"
                                    className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-px rounded-full"
                                    style={{ border: '1px dashed rgba(255,255,255,0.2)', color: 'var(--text-muted)' }}
                                    onClick={() => setLabelInput({ userId: m.userId, value: '' })}
                                  >
                                    <Plus size={9} /> 标签
                                  </button>
                                )
                              )}
                            </div>
                          </div>
                          {isAdmin && m.userId !== team.ownerUserId ? (
                            <select
                              value={webHostingRoles[m.userId] ?? 'editor'}
                              onChange={(e) => handleWebHostingRoleChange(m.userId, e.target.value as WebHostingRole)}
                              title="网页托管权限"
                              className="h-7 px-2 rounded-[6px] text-[12px] outline-none"
                              style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                            >
                              {WEB_HOSTING_ROLE_OPTIONS.map((r) => (
                                <option key={r} value={r}>
                                  网页·{WEB_HOSTING_ROLE_LABEL[r]}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span
                              className="text-[11px] px-1.5 py-0.5 rounded"
                              title={WEB_HOSTING_ROLE_HINT[webHostingRoles[m.userId] ?? (m.userId === team.ownerUserId ? 'owner' : 'editor')]}
                              style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}
                            >
                              网页·{WEB_HOSTING_ROLE_LABEL[webHostingRoles[m.userId] ?? (m.userId === team.ownerUserId ? 'owner' : 'editor')]}
                            </span>
                          )}
                          {isAdmin && m.userId !== team.ownerUserId ? (
                            <select
                              value={m.role}
                              onChange={(e) => handleRoleChange(m.userId, e.target.value as TeamRole)}
                              title="管理权限"
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
                    <div className="space-y-3">
                      {!isAdmin ? (
                        <div className="text-[13px] py-8 text-center" style={{ color: 'var(--text-muted)' }}>
                          只有管理员可以添加成员
                        </div>
                      ) : (
                        <>
                          {/* 搜索框 */}
                          <div className="relative">
                            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                            <input
                              value={inviteQuery}
                              onChange={(e) => setInviteQuery(e.target.value)}
                              placeholder="搜索用户昵称 / 用户名"
                              className="w-full h-9 pl-8 pr-3 rounded-[8px] text-[13px] outline-none"
                              style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                            />
                          </div>

                          {/* 搜索结果（多选） */}
                          {inviteResults.length > 0 && (
                            <div className="rounded-[8px] py-1" style={{ background: 'var(--bg-base)', border: '1px solid rgba(255,255,255,0.08)' }}>
                              {inviteResults.map((u) => {
                                const selected = pendingIds.has(u.userId);
                                return (
                                  <button
                                    key={u.userId}
                                    type="button"
                                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 text-left"
                                    onClick={() => togglePending(u)}
                                  >
                                    <UserAvatar src={resolveAvatarUrl({ avatarFileName: u.avatarFileName })} className="w-6 h-6 rounded-full shrink-0" />
                                    <span className="text-[13px] flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{u.displayName}</span>
                                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>@{u.username}</span>
                                    <div
                                      className="w-5 h-5 rounded-[4px] flex items-center justify-center shrink-0"
                                      style={selected
                                        ? { background: 'var(--accent-gold, #d4af37)' }
                                        : { border: '1px solid rgba(255,255,255,0.2)', background: 'transparent' }}
                                    >
                                      {selected && <Check size={12} color="#1a1a1a" />}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          )}

                          {/* 已选用户 */}
                          {pendingIds.size > 0 && (
                            <div className="space-y-1">
                              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>已选 {pendingIds.size} 人</div>
                              <div className="flex flex-wrap gap-1.5">
                                {[...pendingCards.values()].map((u) => (
                                  <div
                                    key={u.userId}
                                    className="flex items-center gap-1 h-7 pl-1.5 pr-1 rounded-full text-[12px]"
                                    style={{ background: 'rgba(212,175,55,0.12)', border: '1px solid rgba(212,175,55,0.25)', color: 'var(--text-primary)' }}
                                  >
                                    <UserAvatar src={resolveAvatarUrl({ avatarFileName: u.avatarFileName })} className="w-4 h-4 rounded-full" />
                                    <span>{u.displayName}</span>
                                    <button type="button" className="ml-0.5" onClick={() => togglePending(u)} style={{ color: 'var(--text-muted)' }}>
                                      <X size={12} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* 确认按钮 */}
                          <button
                            type="button"
                            disabled={pendingIds.size === 0 || inviting}
                            className="flex items-center gap-1.5 h-9 px-4 rounded-[8px] text-[13px]"
                            style={pendingIds.size > 0
                              ? { background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a', cursor: 'pointer' }
                              : { background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)', cursor: 'not-allowed' }}
                            onClick={handleConfirmInvite}
                          >
                            <UserPlus size={14} />
                            {inviting ? '添加中…' : `确认添加${pendingIds.size > 0 ? ` (${pendingIds.size}人)` : ''}`}
                          </button>
                        </>
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
