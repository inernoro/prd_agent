import { useEffect, useRef, useState } from 'react';
import { Activity, FolderPlus, Plus, Search, Settings, UserPlus, Users, X } from 'lucide-react';
import { useTeamStore } from '@/stores/teamStore';
import { TeamManagerPanel } from '@/components/team/TeamManagerPanel';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toast } from '@/lib/toast';
import { WEB_HOSTING_ROLE_LABEL } from '@/lib/webHostingRole';
import {
  addTeamMembers,
  createTeam,
  getTeam,
  joinTeam,
  listTeamActivity,
  searchTeamUsers,
  type TeamActivityItem,
  type TeamMember,
  type TeamRole,
  type UserCard,
  type WebHostingRole,
} from '@/services/real/teams';

export interface TeamScope {
  scope: 'mine' | 'team';
  teamId: string | null;
}

type Panel = 'members' | 'invite' | 'activity' | 'create' | null;

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
  'store.shared': '分享了空间',
  'entry.created': '新增了文档',
  'entry.updated': '更新了文档',
  'entry.deleted': '删除了文档',
};

/**
 * 「我的 / 共享文件夹」切换 + 选择下拉 + 共享文件夹页签头部的一排轻量操作（成员 / 邀请 / 活动 / 新建）。
 * 网页托管与知识库共用。底层实体仍是按 Id 隔离的 Team（防窜数据），这里只是换轻量的脸。
 */
export function TeamScopeBar({
  moduleKey,
  value,
  onChange,
  hideScopeToggle = false,
}: {
  moduleKey: string;
  value: TeamScope;
  onChange: (next: TeamScope) => void;
  /** 隐藏「我的 / 团队空间」双 pill toggle 及「新建团队空间」inline 入口。
   *  调用方已通过外部 tab 控制作用域时（如 DocumentStorePage 顶部 tab），传 true 避免重复入口。 */
  hideScopeToggle?: boolean;
}) {
  const { teams, loadTeams, setScope } = useTeamStore();
  const [managerOpen, setManagerOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 成员 / 活动 数据（打开对应 popover 时按需拉取）
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [webRoles, setWebRoles] = useState<Record<string, WebHostingRole>>({});
  const [myRole, setMyRole] = useState<TeamRole | null>(null);
  const [activity, setActivity] = useState<TeamActivityItem[]>([]);
  const [newName, setNewName] = useState('');
  const [joinCode, setJoinCode] = useState('');

  // 直接添加成员（邀请 popover 用）
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteResults, setInviteResults] = useState<UserCard[]>([]);
  const [inviteAdding, setInviteAdding] = useState<string | null>(null);
  const inviteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // fetch 防 stale 响应：快速切换 panel/输入搜索时，旧请求回填会覆盖新数据
  const detailFetchSeq = useRef(0);
  const activityFetchSeq = useRef(0);
  const inviteSearchSeq = useRef(0);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  // 点击外部关闭 popover
  useEffect(() => {
    if (!panel) return;
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPanel(null);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [panel]);

  const selectedTeam = teams.find((t) => t.team.id === value.teamId);
  const isAdmin = myRole === 'admin';

  const applyMine = () => {
    setPanel(null);
    setScope(moduleKey, 'mine', null);
    onChange({ scope: 'mine', teamId: null });
  };

  // teamId 为 null = 「全部」聚合视图（我加入的所有团队）
  const applyTeam = (teamId: string | null) => {
    setScope(moduleKey, 'team', teamId);
    onChange({ scope: 'team', teamId });
  };

  const onTeamPillClick = () => {
    // 没有任何共享文件夹时：不切作用域（避免空 teamId），直接开「新建」轻面板
    if (teams.length === 0) {
      setPanel('create');
      return;
    }
    const target = value.teamId && teams.some((t) => t.team.id === value.teamId)
      ? value.teamId
      : null; // 默认进「全部」聚合视图
    applyTeam(target);
  };

  const loadDetail = async (teamId: string) => {
    const mySeq = ++detailFetchSeq.current;
    const res = await getTeam(teamId);
    if (detailFetchSeq.current !== mySeq) return; // 旧团队的响应丢弃
    if (res.success) {
      setMembers(res.data.members);
      setWebRoles(res.data.webHostingRoles ?? {});
      setMyRole(res.data.myRole);
    }
  };

  const openPanel = async (p: Exclude<Panel, null>) => {
    if (panel === p) { setPanel(null); return; }
    setPanel(p);
    if (p === 'invite') {
      setInviteQuery('');
      setInviteResults([]);
    }
    if ((p === 'members' || p === 'invite') && value.teamId) await loadDetail(value.teamId);
    if (p === 'activity' && value.teamId) {
      const mySeq = ++activityFetchSeq.current;
      const res = await listTeamActivity(value.teamId, { limit: 50 });
      if (activityFetchSeq.current !== mySeq) return;
      if (res.success) setActivity(res.data.items);
    }
  };

  // 邀请搜索防抖
  useEffect(() => {
    if (inviteTimer.current) clearTimeout(inviteTimer.current);
    if (!inviteQuery.trim()) { setInviteResults([]); return; }
    inviteTimer.current = setTimeout(() => {
      const mySeq = ++inviteSearchSeq.current;
      void searchTeamUsers(inviteQuery.trim()).then((res) => {
        if (inviteSearchSeq.current !== mySeq) return; // 用户继续输入，旧结果丢弃
        if (res.success) {
          const existing = new Set(members.map((m) => m.userId));
          setInviteResults(res.data.items.filter((u) => !existing.has(u.userId)));
        }
      });
    }, 300);
  }, [inviteQuery, members]);

  const handleAddMember = async (u: UserCard) => {
    if (!value.teamId) return;
    setInviteAdding(u.userId);
    const res = await addTeamMembers(value.teamId, [u.userId]);
    setInviteAdding(null);
    if (res.success) {
      setInviteResults((prev) => prev.filter((x) => x.userId !== u.userId));
      await loadDetail(value.teamId);
      toast.success(`已添加 ${u.displayName}`);
    } else {
      toast.error('添加失败', res.error?.message);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const res = await createTeam({ name: newName.trim() });
    if (res.success) {
      setNewName('');
      setPanel(null);
      await loadTeams(true);
      applyTeam(res.data.team.id);
    } else {
      toast.error('创建失败', res.error?.message);
    }
  };

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    const res = await joinTeam(joinCode.trim());
    if (res.success) {
      setJoinCode('');
      setPanel(null);
      await loadTeams(true);
      applyTeam(res.data.teamId);
    } else {
      toast.error('加入失败', res.error?.message);
    }
  };

  const pillBase = 'px-3 h-8 rounded-[8px] text-[13px] font-medium transition-colors flex items-center gap-1.5';
  const actionBtn = 'h-8 px-2.5 rounded-[8px] text-[12px] flex items-center gap-1 transition-colors';
  const actionStyle = { background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-muted)' };
  const popStyle = {
    background: 'var(--bg-elevated)',
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
  };

  const inTeam = value.scope === 'team' && teams.length > 0;

  return (
    <>
      <div className="relative flex items-center gap-2" ref={wrapRef}>
        {/* 我的 / 团队空间 双 pill（外部 tab 接管作用域切换时由 hideScopeToggle 隐藏） */}
        {!hideScopeToggle && (
          <div
            className="flex items-center gap-1 p-1 rounded-[10px]"
            style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <button
              type="button"
              className={pillBase}
              style={value.scope === 'mine' ? { background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' } : { color: 'var(--text-muted)' }}
              onClick={applyMine}
            >
              我的
            </button>
            <button
              type="button"
              className={pillBase}
              style={value.scope === 'team' ? { background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' } : { color: 'var(--text-muted)' }}
              onClick={onTeamPillClick}
            >
              <Users size={13} />
              团队空间
            </button>
          </div>
        )}

        {/* 团队标签平铺（不下拉）：「全部」= 聚合我加入的所有团队 */}
        {inTeam && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 max-w-[480px]" style={{ overscrollBehavior: 'contain' }}>
            <button
              type="button"
              className="h-7 px-2.5 rounded-full text-[12px] shrink-0 transition-colors"
              style={value.teamId === null
                ? { background: 'rgba(212,175,55,0.18)', color: 'var(--accent-gold, #d4af37)', border: '1px solid rgba(212,175,55,0.4)' }
                : { background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-muted)' }}
              onClick={() => applyTeam(null)}
            >
              全部
            </button>
            {teams.map((t) => (
              <button
                key={t.team.id}
                type="button"
                className="h-7 px-2.5 rounded-full text-[12px] shrink-0 flex items-center gap-1 transition-colors"
                style={value.teamId === t.team.id
                  ? { background: 'rgba(212,175,55,0.18)', color: 'var(--accent-gold, #d4af37)', border: '1px solid rgba(212,175,55,0.4)' }
                  : { background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-muted)' }}
                onClick={() => applyTeam(t.team.id)}
              >
                <Users size={11} /> {t.team.name} <span className="opacity-60">{t.memberCount}</span>
              </button>
            ))}
          </div>
        )}

        {/* banner 操作行：仅团队空间页签出现；成员/邀请/活动需选中具体团队（「全部」视图下隐藏） */}
        {inTeam && (
          <div className="flex items-center gap-1.5">
            {value.teamId && (
              <>
                <button type="button" className={actionBtn} style={actionStyle} onClick={() => openPanel('members')}>
                  <Users size={13} /> 成员{selectedTeam ? ` ${selectedTeam.memberCount}` : ''}
                </button>
                <button type="button" className={actionBtn} style={actionStyle} onClick={() => openPanel('invite')}>
                  <UserPlus size={13} /> 邀请
                </button>
                <button type="button" className={actionBtn} style={actionStyle} onClick={() => openPanel('activity')}>
                  <Activity size={13} /> 活动日志
                </button>
              </>
            )}
            <button type="button" className={actionBtn} style={actionStyle} onClick={() => openPanel('create')}>
              <FolderPlus size={13} /> 新建团队空间
            </button>
          </div>
        )}

        {/* 我的作用域：仅留一个轻量「新建团队空间」入口（hideScopeToggle 时由外部控制，无需此入口） */}
        {!hideScopeToggle && value.scope === 'mine' && (
          <button type="button" className={actionBtn} style={actionStyle} onClick={() => setPanel('create')}>
            <FolderPlus size={13} /> 新建团队空间
          </button>
        )}

        {/* hideScopeToggle 且 team 作用域但还没选 team：给一个空态入口 */}
        {hideScopeToggle && value.scope === 'team' && teams.length === 0 && (
          <button type="button" className={actionBtn} style={actionStyle} onClick={() => setPanel('create')}>
            <FolderPlus size={13} /> 新建团队空间
          </button>
        )}

        {/* ── Popovers ── */}
        {panel === 'members' && (
          <div className="absolute left-0 top-[40px] z-[130] w-[320px] rounded-[12px] p-2" style={popStyle}>
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>成员（{members.length}）</span>
              <button type="button" onClick={() => setPanel(null)} style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
            </div>
            <div className="max-h-[280px] overflow-auto" style={{ overscrollBehavior: 'contain' }}>
              {members.map((m) => (
                <div key={m.userId} className="flex items-center gap-2 px-2 py-1.5">
                  <UserAvatar src={resolveAvatarUrl({ avatarFileName: m.avatarFileName })} className="w-6 h-6 rounded-full" />
                  <span className="text-[13px] truncate flex-1" style={{ color: 'var(--text-primary)' }}>{m.userName ?? m.userId}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>
                    {WEB_HOSTING_ROLE_LABEL[webRoles[m.userId] ?? 'editor']}
                  </span>
                </div>
              ))}
            </div>
            {isAdmin && (
              <button
                type="button"
                className="mt-1 w-full h-8 rounded-[8px] text-[12px] flex items-center justify-center gap-1.5"
                style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                onClick={() => { setPanel(null); setManagerOpen(true); }}
              >
                <Settings size={12} /> 管理成员与角色
              </button>
            )}
          </div>
        )}

        {panel === 'invite' && (
          <div className="absolute left-0 top-[40px] z-[130] w-[340px] rounded-[12px] p-3 space-y-2" style={popStyle}>
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>添加成员</span>
              <button type="button" onClick={() => setPanel(null)} style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
            </div>
            {!isAdmin ? (
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>只有管理员可以添加成员</p>
            ) : (
              <>
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                  <input
                    autoFocus
                    value={inviteQuery}
                    onChange={(e) => setInviteQuery(e.target.value)}
                    placeholder="搜索用户昵称 / 用户名"
                    className="w-full h-8 pl-8 pr-3 rounded-[8px] text-[13px] outline-none"
                    style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  />
                </div>
                {inviteResults.length > 0 && (
                  <div className="rounded-[8px] py-1 max-h-[220px] overflow-auto" style={{ background: 'var(--bg-base)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    {inviteResults.map((u) => (
                      <button
                        key={u.userId}
                        type="button"
                        disabled={inviteAdding === u.userId}
                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 text-left"
                        onClick={() => handleAddMember(u)}
                      >
                        <UserAvatar src={resolveAvatarUrl({ avatarFileName: u.avatarFileName })} className="w-6 h-6 rounded-full shrink-0" />
                        <span className="text-[13px] flex-1 truncate" style={{ color: 'var(--text-primary)' }}>{u.displayName}</span>
                        <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>@{u.username}</span>
                        <span className="shrink-0 text-[11px]" style={{ color: 'var(--accent-gold)' }}>
                          {inviteAdding === u.userId ? '添加中…' : '+ 添加'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {inviteQuery.trim() && inviteResults.length === 0 && (
                  <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>未找到匹配用户</p>
                )}
              </>
            )}
          </div>
        )}

        {panel === 'activity' && (
          <div className="absolute left-0 top-[40px] z-[130] w-[360px] rounded-[12px] p-2" style={popStyle}>
            <div className="flex items-center justify-between px-2 py-1.5">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>活动日志</span>
              <button type="button" onClick={() => setPanel(null)} style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
            </div>
            <div className="max-h-[300px] overflow-auto space-y-2 px-2 pb-1" style={{ overscrollBehavior: 'contain' }}>
              {activity.length === 0 ? (
                <div className="text-[12px] text-center py-6" style={{ color: 'var(--text-muted)' }}>暂无活动</div>
              ) : activity.map((a) => (
                <div key={a.id} className="flex items-start gap-2">
                  <UserAvatar src={resolveAvatarUrl({ avatarFileName: a.actorAvatarFileName })} className="w-5 h-5 rounded-full mt-0.5" />
                  <div className="flex-1 min-w-0 text-[12px]" style={{ color: 'var(--text-primary)' }}>
                    <span className="font-medium">{a.actorName}</span>
                    <span style={{ color: 'var(--text-muted)' }}> {ACTION_LABEL[a.action] ?? a.action}</span>
                    {a.targetTitle && <span>「{a.targetTitle}」</span>}
                    <span className="block text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{new Date(a.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {panel === 'create' && (
          <div className="absolute left-0 top-[40px] z-[130] w-[320px] rounded-[12px] p-3 space-y-3" style={popStyle}>
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>新建 / 加入团队空间</span>
              <button type="button" onClick={() => setPanel(null)} style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
            </div>
            <div className="flex gap-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="团队空间名称"
                className="flex-1 h-8 px-2 rounded-[8px] text-[13px] outline-none"
                style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <button type="button" className="px-3 h-8 rounded-[8px] text-[12px] flex items-center gap-1" style={{ background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' }} onClick={handleCreate}>
                <Plus size={12} /> 创建
              </button>
            </div>
            <div className="flex gap-1.5">
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                placeholder="或输入邀请码加入"
                className="flex-1 h-8 px-2 rounded-[8px] text-[12px] outline-none"
                style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              />
              <button type="button" className="px-3 h-8 rounded-[8px] text-[12px]" style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-muted)' }} onClick={handleJoin}>
                加入
              </button>
            </div>
          </div>
        )}
      </div>

      {managerOpen && (
        <TeamManagerPanel
          onClose={() => {
            setManagerOpen(false);
            void loadTeams(true);
            if (value.teamId) void loadDetail(value.teamId);
          }}
        />
      )}
    </>
  );
}
