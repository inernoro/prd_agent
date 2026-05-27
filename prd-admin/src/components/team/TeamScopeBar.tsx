import { useEffect, useRef, useState } from 'react';
import { Activity, Check, ChevronDown, Copy, FolderPlus, Link2, Plus, Settings, UserPlus, Users, X } from 'lucide-react';
import { useTeamStore } from '@/stores/teamStore';
import { TeamManagerPanel } from '@/components/team/TeamManagerPanel';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toast } from '@/lib/toast';
import { WEB_HOSTING_ROLE_LABEL } from '@/lib/webHostingRole';
import {
  createTeam,
  getTeam,
  joinTeam,
  listTeamActivity,
  regenerateInviteCode,
  type TeamActivityItem,
  type TeamMember,
  type TeamRole,
  type WebHostingRole,
} from '@/services/real/teams';

export interface TeamScope {
  scope: 'mine' | 'team';
  teamId: string | null;
}

type Panel = 'members' | 'invite' | 'activity' | 'create' | null;

const ACTION_LABEL: Record<string, string> = {
  'team.created': '创建了共享文件夹',
  'team.updated': '更新了共享文件夹',
  'member.added': '添加了成员',
  'member.joined': '加入了共享文件夹',
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

/**
 * 「我的 / 共享文件夹」切换 + 选择下拉 + 共享文件夹页签头部的一排轻量操作（成员 / 邀请 / 活动 / 新建）。
 * 网页托管与知识库共用。底层实体仍是按 Id 隔离的 Team（防窜数据），这里只是换轻量的脸。
 */
export function TeamScopeBar({
  moduleKey,
  value,
  onChange,
}: {
  moduleKey: string;
  value: TeamScope;
  onChange: (next: TeamScope) => void;
}) {
  const { teams, loadTeams, setScope } = useTeamStore();
  const [managerOpen, setManagerOpen] = useState(false);
  const [teamDropdownOpen, setTeamDropdownOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 成员 / 活动 数据（打开对应 popover 时按需拉取）
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [webRoles, setWebRoles] = useState<Record<string, WebHostingRole>>({});
  const [myRole, setMyRole] = useState<TeamRole | null>(null);
  const [activity, setActivity] = useState<TeamActivityItem[]>([]);
  const [newName, setNewName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  // 点击外部关闭 popover
  useEffect(() => {
    if (!panel && !teamDropdownOpen) return;
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPanel(null);
        setTeamDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [panel, teamDropdownOpen]);

  const selectedTeam = teams.find((t) => t.team.id === value.teamId);
  const isAdmin = myRole === 'admin';
  const inviteLink = selectedTeam
    ? `${window.location.origin}/join/${selectedTeam.team.inviteCode}`
    : '';

  const applyMine = () => {
    setPanel(null);
    setScope(moduleKey, 'mine', null);
    onChange({ scope: 'mine', teamId: null });
  };

  const applyTeam = (teamId: string) => {
    setScope(moduleKey, 'team', teamId);
    onChange({ scope: 'team', teamId });
    setTeamDropdownOpen(false);
  };

  const onTeamPillClick = () => {
    // 没有任何共享文件夹时：不切作用域（避免空 teamId），直接开「新建」轻面板
    if (teams.length === 0) {
      setPanel('create');
      return;
    }
    const target = value.teamId && teams.some((t) => t.team.id === value.teamId)
      ? value.teamId
      : teams[0].team.id;
    applyTeam(target);
  };

  const loadDetail = async (teamId: string) => {
    const res = await getTeam(teamId);
    if (res.success) {
      setMembers(res.data.members);
      setWebRoles(res.data.webHostingRoles ?? {});
      setMyRole(res.data.myRole);
    }
  };

  const openPanel = async (p: Exclude<Panel, null>) => {
    if (panel === p) { setPanel(null); return; }
    setPanel(p);
    if ((p === 'members' || p === 'invite') && value.teamId) await loadDetail(value.teamId);
    if (p === 'activity' && value.teamId) {
      const res = await listTeamActivity(value.teamId, { limit: 50 });
      if (res.success) setActivity(res.data.items);
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

  const copyInvite = () => {
    if (!inviteLink) return;
    void navigator.clipboard.writeText(inviteLink).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleRegen = async () => {
    if (!value.teamId) return;
    const res = await regenerateInviteCode(value.teamId);
    if (res.success) {
      await loadTeams(true);
      toast.success('邀请链接已重置');
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
        {/* 我的 / 共享文件夹 双 pill */}
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
            共享文件夹
          </button>
        </div>

        {/* 选择下拉（仅共享文件夹作用域且有空间时） */}
        {inTeam && (
          <div className="relative">
            <button
              type="button"
              className="h-8 px-3 rounded-[8px] text-[13px] flex items-center gap-1.5"
              style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
              onClick={() => setTeamDropdownOpen((o) => !o)}
            >
              {selectedTeam?.team.name ?? '选择共享文件夹'}
              <ChevronDown size={13} style={{ color: 'var(--text-muted)' }} />
            </button>
            {teamDropdownOpen && (
              <div className="absolute left-0 top-[36px] z-[120] min-w-[200px] rounded-[10px] py-1 max-h-[300px] overflow-auto" style={popStyle}>
                {teams.map((t) => (
                  <button
                    key={t.team.id}
                    type="button"
                    className="w-full text-left px-3 py-2 text-[13px] hover:bg-white/8 flex items-center justify-between"
                    style={{ color: 'var(--text-primary)' }}
                    onClick={() => applyTeam(t.team.id)}
                  >
                    <span className="truncate">{t.team.name}</span>
                    <span className="text-[11px] shrink-0 ml-2" style={{ color: 'var(--text-muted)' }}>{t.memberCount} 人</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* banner 操作行：仅共享文件夹页签出现 */}
        {inTeam && (
          <div className="flex items-center gap-1.5">
            <button type="button" className={actionBtn} style={actionStyle} onClick={() => openPanel('members')}>
              <Users size={13} /> 成员{selectedTeam ? ` ${selectedTeam.memberCount}` : ''}
            </button>
            <button type="button" className={actionBtn} style={actionStyle} onClick={() => openPanel('invite')}>
              <UserPlus size={13} /> 邀请
            </button>
            <button type="button" className={actionBtn} style={actionStyle} onClick={() => openPanel('activity')}>
              <Activity size={13} /> 活动日志
            </button>
            <button type="button" className={actionBtn} style={actionStyle} onClick={() => openPanel('create')}>
              <FolderPlus size={13} /> 新建
            </button>
          </div>
        )}

        {/* 我的作用域：仅留一个轻量「新建共享文件夹」入口 */}
        {value.scope === 'mine' && (
          <button type="button" className={actionBtn} style={actionStyle} onClick={() => setPanel('create')}>
            <FolderPlus size={13} /> 新建共享文件夹
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
          <div className="absolute left-0 top-[40px] z-[130] w-[360px] rounded-[12px] p-3 space-y-2" style={popStyle}>
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>邀请链接</span>
              <button type="button" onClick={() => setPanel(null)} style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
            </div>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>对方打开链接、登录后自动加入该共享文件夹，无需填写任何内容。</p>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-9 px-2.5 rounded-[8px] flex items-center text-[12px] font-mono truncate" style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }} title={inviteLink}>
                {inviteLink}
              </div>
              <button type="button" className="h-9 px-3 rounded-[8px] flex items-center gap-1.5 text-[12px]" style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }} onClick={copyInvite}>
                {copied ? <Check size={13} style={{ color: '#22c55e' }} /> : <Copy size={13} />} {copied ? '已复制' : '复制'}
              </button>
            </div>
            {isAdmin && (
              <button type="button" className="text-[11px] flex items-center gap-1" style={{ color: 'var(--accent-gold)' }} onClick={handleRegen}>
                <Link2 size={11} /> 重置链接（旧链接失效）
              </button>
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
              <span className="text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>新建 / 加入共享文件夹</span>
              <button type="button" onClick={() => setPanel(null)} style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
            </div>
            <div className="flex gap-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="共享文件夹名称"
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
