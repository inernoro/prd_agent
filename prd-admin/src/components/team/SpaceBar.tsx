import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Plus, Settings, User, Users } from 'lucide-react';
import { useTeamStore } from '@/stores/teamStore';
import { TeamManagerPanel } from '@/components/team/TeamManagerPanel';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toast } from '@/lib/toast';
import { createTeam, getTeam, joinTeam, type TeamMember, type WebHostingRole } from '@/services/real/teams';

/** 当前空间：个人空间 或 某个团队空间 */
export type Space = { kind: 'personal' } | { kind: 'team'; teamId: string };

/**
 * SaaS 空间切换器（只管「在哪个空间」）：个人空间 + 各团队空间 + 新建/加入。
 * 团队空间的协作头部抽到独立的 TeamSpaceHeader（由页面放在搜索行下方，保证切换时搜索框不跳位）。
 */
export function SpaceBar({
  current,
  onChange,
}: {
  current: Space;
  onChange: (s: Space) => void;
}) {
  const { teams, loadTeams } = useTeamStore();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const addRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { void loadTeams(); }, [loadTeams]);

  useEffect(() => {
    if (!adding) return;
    const h = (e: MouseEvent) => { if (addRef.current && !addRef.current.contains(e.target as Node)) setAdding(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [adding]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const res = await createTeam({ name: newName.trim() });
    if (res.success) { setNewName(''); setAdding(false); await loadTeams(true); onChange({ kind: 'team', teamId: res.data.team.id }); }
    else toast.error('创建失败', res.error?.message);
  };
  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    const res = await joinTeam(joinCode.trim());
    if (res.success) { setJoinCode(''); setAdding(false); await loadTeams(true); onChange({ kind: 'team', teamId: res.data.teamId }); }
    else toast.error('加入失败', res.error?.message);
  };

  const pill = (label: React.ReactNode, on: boolean, onClick: () => void, key: string) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className="h-8 px-3 rounded-[8px] text-[13px] flex items-center gap-1.5 shrink-0 transition-colors"
      style={on
        ? { background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' }
        : { background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-muted)' }}
    >
      {label}
    </button>
  );

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-0.5 w-full" style={{ overscrollBehavior: 'contain' }}>
      {pill(<><User size={13} /> 个人空间</>, current.kind === 'personal', () => onChange({ kind: 'personal' }), 'personal')}
      {teams.map((t) =>
        pill(
          <><Users size={13} /> {t.team.name} <span className="opacity-60">{t.memberCount}</span></>,
          current.kind === 'team' && current.teamId === t.team.id,
          () => onChange({ kind: 'team', teamId: t.team.id }),
          t.team.id,
        ),
      )}
      <div className="relative shrink-0" ref={addRef}>
        <button
          type="button"
          title="新建 / 加入团队空间"
          onClick={() => setAdding((o) => !o)}
          className="h-8 w-8 rounded-[8px] flex items-center justify-center"
          style={{ background: 'var(--bg-input)', border: '1px dashed rgba(255,255,255,0.2)', color: 'var(--text-muted)' }}
        >
          <Plus size={15} />
        </button>
        {adding && (
          <div className="absolute left-0 top-[38px] z-[130] w-[300px] rounded-[12px] p-3 space-y-2"
            style={{ background: 'var(--bg-elevated)', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 12px 40px rgba(0,0,0,0.4)' }}>
            <div className="flex gap-1.5">
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新建团队空间名称"
                className="flex-1 h-8 px-2 rounded-[8px] text-[13px] outline-none"
                style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()} />
              <button type="button" className="px-3 h-8 rounded-[8px] text-[12px]" style={{ background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' }} onClick={handleCreate}>创建</button>
            </div>
            <div className="flex gap-1.5">
              <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="或输入邀请码加入"
                className="flex-1 h-8 px-2 rounded-[8px] text-[12px] outline-none"
                style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()} />
              <button type="button" className="px-3 h-8 rounded-[8px] text-[12px]" style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-muted)' }} onClick={handleJoin}>加入</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 团队空间协作头部：成员头像 + 一键邀请链接 + 管理（成员/角色/重命名/删除）+ viewer 只读提示。
 * 由页面放在搜索行下方，避免它出现/消失时把搜索框顶上顶下（保证切换统一性）。
 */
export function TeamSpaceHeader({
  teamId,
  myWebHostingRole,
}: {
  teamId: string;
  myWebHostingRole: WebHostingRole | null;
}) {
  const { teams, loadTeams } = useTeamStore();
  const team = teams.find((t) => t.team.id === teamId) ?? null;
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [copied, setCopied] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void getTeam(teamId).then((r) => { if (alive && r.success) setMembers(r.data.members); });
    return () => { alive = false; };
  }, [teamId]);

  if (!team) return null;
  const inviteLink = `${window.location.origin}/join/${team.team.inviteCode}`;
  const copyInvite = () => {
    void navigator.clipboard.writeText(inviteLink).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };

  return (
    <div className="flex items-center gap-3 mt-3">
      <button type="button" className="flex items-center -space-x-1.5" title="成员（点击管理）" onClick={() => setManagerOpen(true)}>
        {members.slice(0, 5).map((m) => (
          <UserAvatar key={m.userId} src={resolveAvatarUrl({ avatarFileName: m.avatarFileName })} className="w-6 h-6 rounded-full" style={{ border: '1.5px solid var(--bg-card)' }} />
        ))}
        {team.memberCount > 5 && (
          <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px]" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1.5px solid var(--bg-card)' }}>+{team.memberCount - 5}</span>
        )}
      </button>
      <button type="button" className="h-8 px-3 rounded-[8px] text-[12px] flex items-center gap-1.5"
        style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
        onClick={copyInvite} title={inviteLink}>
        {copied ? <Check size={13} style={{ color: '#22c55e' }} /> : <Copy size={13} />}
        {copied ? '链接已复制' : '邀请协作（复制链接）'}
      </button>
      {myWebHostingRole === 'viewer' && (
        <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>你是查看者（只读）</span>
      )}
      {team.myRole === 'admin' && (
        <button type="button" className="h-8 w-8 rounded-[8px] flex items-center justify-center ml-auto"
          style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-muted)' }}
          title="成员与角色 / 重命名 / 删除空间" onClick={() => setManagerOpen(true)}>
          <Settings size={15} />
        </button>
      )}
      {managerOpen && (
        <TeamManagerPanel onClose={() => {
          setManagerOpen(false);
          void loadTeams(true);
          void getTeam(teamId).then((r) => { if (r.success) setMembers(r.data.members); });
        }} />
      )}
    </div>
  );
}
