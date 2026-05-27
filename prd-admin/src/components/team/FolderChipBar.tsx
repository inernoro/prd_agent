import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FolderPlus, Folders, MoreHorizontal, Plus, User } from 'lucide-react';
import { useTeamStore } from '@/stores/teamStore';
import { TeamManagerPanel } from '@/components/team/TeamManagerPanel';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toast } from '@/lib/toast';
import { createTeam, getTeam, joinTeam, type TeamMember, type WebHostingRole } from '@/services/real/teams';

/** 当前选中的文件夹标签：全部 / 个人文件夹（按名字） / 共享文件夹（按 Id） */
export type FolderChip =
  | { kind: 'all' }
  | { kind: 'personal'; folder: string }
  | { kind: 'shared'; teamId: string };

/**
 * 纯文件夹模型的标签行：个人文件夹与共享文件夹并列成 chip（不再有「我的/共享」模式切换）。
 * 选中共享文件夹时，下方出现极简上下文条（成员头像 + 一键邀请 + 更多）。
 * 隔离：共享 chip 永远按团队 Id 过滤；个人 chip 永远只是「我自己的、该名字标签」的站点。
 */
export function FolderChipBar({
  personalFolders,
  active,
  onChange,
}: {
  moduleKey: string;
  personalFolders: string[];
  active: FolderChip;
  onChange: (next: FolderChip) => void;
}) {
  const { teams, loadTeams } = useTeamStore();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [myRole, setMyRole] = useState<WebHostingRole | null>(null);
  const [copied, setCopied] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const addRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  const activeTeamId = active.kind === 'shared' ? active.teamId : null;
  const activeTeam = teams.find((t) => t.team.id === activeTeamId);

  // 选中共享文件夹时拉成员 + 我的角色，渲染上下文条
  useEffect(() => {
    if (!activeTeamId) {
      setMembers([]);
      setMyRole(null);
      return;
    }
    let alive = true;
    void getTeam(activeTeamId).then((res) => {
      if (!alive || !res.success) return;
      setMembers(res.data.members);
      setMyRole(res.data.myWebHostingRole ?? null);
    });
    return () => { alive = false; };
  }, [activeTeamId]);

  // 点外部关闭「+」
  useEffect(() => {
    if (!adding) return;
    const h = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAdding(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [adding]);

  const inviteLink = activeTeam ? `${window.location.origin}/join/${activeTeam.team.inviteCode}` : '';

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const res = await createTeam({ name: newName.trim() });
    if (res.success) {
      setNewName('');
      setAdding(false);
      await loadTeams(true);
      onChange({ kind: 'shared', teamId: res.data.team.id });
    } else {
      toast.error('创建失败', res.error?.message);
    }
  };

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    const res = await joinTeam(joinCode.trim());
    if (res.success) {
      setJoinCode('');
      setAdding(false);
      await loadTeams(true);
      onChange({ kind: 'shared', teamId: res.data.teamId });
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

  const chip = (label: React.ReactNode, on: boolean, onClick: () => void, key: string, title?: string) => (
    <button
      key={key}
      type="button"
      title={title}
      onClick={onClick}
      className="h-8 px-3 rounded-full text-[13px] flex items-center gap-1.5 shrink-0 transition-colors"
      style={on
        ? { background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' }
        : { background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-muted)' }}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-2 w-full">
      {/* 标签行 */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1" style={{ overscrollBehavior: 'contain' }}>
        {chip('全部', active.kind === 'all', () => onChange({ kind: 'all' }), 'all')}

        {personalFolders.map((f) =>
          chip(
            <><User size={12} /> {f}</>,
            active.kind === 'personal' && active.folder === f,
            () => onChange({ kind: 'personal', folder: f }),
            'p:' + f,
            '个人文件夹',
          ),
        )}

        {teams.map((t) =>
          chip(
            <><Folders size={12} /> {t.team.name} <span className="opacity-60">{t.memberCount}</span></>,
            active.kind === 'shared' && active.teamId === t.team.id,
            () => onChange({ kind: 'shared', teamId: t.team.id }),
            's:' + t.team.id,
            '共享文件夹',
          ),
        )}

        {/* 新建 / 加入 */}
        <div className="relative shrink-0" ref={addRef}>
          <button
            type="button"
            title="新建 / 加入共享文件夹"
            onClick={() => setAdding((o) => !o)}
            className="h-8 w-8 rounded-full flex items-center justify-center"
            style={{ background: 'var(--bg-input)', border: '1px dashed rgba(255,255,255,0.2)', color: 'var(--text-muted)' }}
          >
            <Plus size={15} />
          </button>
          {adding && (
            <div
              className="absolute left-0 top-[38px] z-[130] w-[300px] rounded-[12px] p-3 space-y-2"
              style={{ background: 'var(--bg-elevated)', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}
            >
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="新建共享文件夹名称"
                  className="flex-1 h-8 px-2 rounded-[8px] text-[13px] outline-none"
                  style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                />
                <button type="button" className="px-3 h-8 rounded-[8px] text-[12px] flex items-center gap-1" style={{ background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' }} onClick={handleCreate}>
                  <FolderPlus size={12} /> 创建
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
      </div>

      {/* 共享文件夹上下文条（仅选中共享文件夹时） */}
      {activeTeam && (
        <div className="flex items-center gap-3 px-1">
          {/* 成员头像 */}
          <button
            type="button"
            className="flex items-center -space-x-1.5"
            title="成员（点击管理）"
            onClick={() => setManagerOpen(true)}
          >
            {members.slice(0, 5).map((m) => (
              <UserAvatar
                key={m.userId}
                src={resolveAvatarUrl({ avatarFileName: m.avatarFileName })}
                className="w-6 h-6 rounded-full"
                style={{ border: '1.5px solid var(--bg-card)' }}
              />
            ))}
            {members.length > 5 && (
              <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px]" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1.5px solid var(--bg-card)' }}>
                +{members.length - 5}
              </span>
            )}
          </button>

          {/* 邀请：一键复制链接 */}
          <button
            type="button"
            className="h-8 px-3 rounded-[8px] text-[12px] flex items-center gap-1.5"
            style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
            onClick={copyInvite}
            title={inviteLink}
          >
            {copied ? <Check size={13} style={{ color: '#22c55e' }} /> : <Copy size={13} />}
            {copied ? '链接已复制' : '邀请（复制链接）'}
          </button>

          {myRole === 'viewer' && (
            <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>
              你是查看者（只读）
            </span>
          )}

          {/* 更多：成员角色 / 活动 / 改名 / 删除 / 退出 都在面板里 */}
          <button
            type="button"
            className="h-8 w-8 rounded-[8px] flex items-center justify-center ml-auto"
            style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-muted)' }}
            title="更多（成员角色 / 活动日志 / 改名 / 删除）"
            onClick={() => setManagerOpen(true)}
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
      )}

      {managerOpen && (
        <TeamManagerPanel
          onClose={() => {
            setManagerOpen(false);
            void loadTeams(true);
            if (activeTeamId) void getTeam(activeTeamId).then((r) => { if (r.success) { setMembers(r.data.members); setMyRole(r.data.myWebHostingRole ?? null); } });
          }}
        />
      )}
    </div>
  );
}
