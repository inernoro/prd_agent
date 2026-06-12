import { useEffect, useState } from 'react';
import { Plus, Settings, User, UserPlus, Users, X } from 'lucide-react';
import { useTeamStore } from '@/stores/teamStore';
import { TeamManagerPanel } from '@/components/team/TeamManagerPanel';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { toast } from '@/lib/toast';
import { createTeam, getTeam, joinTeam, updateTeam, type TeamMember, type WebHostingRole } from '@/services/real/teams';

/** 当前空间：个人空间 或 某个团队空间 */
export type Space = { kind: 'personal' } | { kind: 'team'; teamId: string };

// 记住「团队空间」一级 tab 下最近停留的团队，切回时直达（UI 偏好，旧值无害）
const LAST_TEAM_KEY = 'webpages.pref.lastTeamId';

/**
 * SaaS 空间切换器（只管「在哪个空间」）。
 * 一级导航固定两项：个人空间 | 团队空间；选中团队空间后，第二行以标签 chips
 * 平铺所有已加入的团队（含新建/加入入口），不再把每个团队顶到一级导航。
 * 团队空间的协作头部抽到独立的 TeamSpaceHeader（由页面放在搜索行下方，保证切换时搜索框不跳位）。
 */
export function SpaceBar({
  current,
  onChange,
}: {
  current: Space;
  onChange: (s: Space) => void;
}) {
  const { teams, loadTeams, renameTeamLocal } = useTeamStore();
  // 行内新建/加入：单输入框，输名称回车创建，粘贴 INV- 邀请码回车加入（无浮层，零布局跳动）
  const [adding, setAdding] = useState(false);
  const [addValue, setAddValue] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  // 双击团队 chip 就地改名（仅团队管理员）
  const [renaming, setRenaming] = useState<{ teamId: string; value: string } | null>(null);

  const commitTeamRename = async () => {
    if (!renaming) return;
    const t = teams.find((x) => x.team.id === renaming.teamId);
    const next = renaming.value.trim();
    setRenaming(null);
    if (!t || !next || next === t.team.name) return;
    const prev = t.team.name;
    renameTeamLocal(t.team.id, next); // 乐观更新：chip 立即显示新名
    const res = await updateTeam(t.team.id, { name: next });
    if (!res.success) {
      renameTeamLocal(t.team.id, prev); // 失败回滚
      toast.error('重命名失败', res.error?.message);
    }
  };

  useEffect(() => { void loadTeams(); }, [loadTeams]);

  useEffect(() => {
    if (current.kind === 'team') sessionStorage.setItem(LAST_TEAM_KEY, current.teamId);
  }, [current]);

  const submitAdd = async () => {
    const v = addValue.trim();
    if (!v || addBusy) return;
    setAddBusy(true);
    if (/^INV-/i.test(v)) {
      const res = await joinTeam(v);
      setAddBusy(false);
      if (res.success) {
        setAddValue('');
        setAdding(false);
        await loadTeams(true);
        onChange({ kind: 'team', teamId: res.data.teamId });
      } else {
        toast.error('加入失败', res.error?.message);
      }
      return;
    }
    const res = await createTeam({ name: v });
    setAddBusy(false);
    if (res.success) {
      setAddValue('');
      setAdding(false);
      await loadTeams(true);
      onChange({ kind: 'team', teamId: res.data.team.id });
    } else {
      toast.error('创建失败', res.error?.message);
    }
  };

  // 点一级「团队空间」：回到最近停留的团队（无记忆则第一个）；一个团队都没有时直接展开新建输入框
  const enterTeamSection = () => {
    if (current.kind === 'team') return;
    const remembered = sessionStorage.getItem(LAST_TEAM_KEY);
    const target = teams.find((t) => t.team.id === remembered) ?? teams[0];
    if (target) onChange({ kind: 'team', teamId: target.team.id });
    else setAdding(true);
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
    <div data-tour-id="webpages-space-bar" className="flex flex-col gap-2 w-full">
      {/* 一级导航：个人空间 | 团队空间 */}
      <div className="flex items-center gap-2 overflow-x-auto pb-0.5" style={{ overscrollBehavior: 'contain' }}>
        {pill(<><User size={13} /> 个人空间</>, current.kind === 'personal', () => onChange({ kind: 'personal' }), 'personal')}
        {pill(<><Users size={13} /> 团队空间{teams.length > 0 && <span className="opacity-60">{teams.length}</span>}</>, current.kind === 'team', enterTeamSection, 'team-section')}
        {/* 「+」常驻一级行：没有任何团队时也能从这里新建/加入；点开后行内展开输入框，不弹浮层 */}
        <button
          type="button"
          data-tour-id="webpages-space-add"
          title="新建 / 加入团队空间"
          onClick={() => { setAdding((o) => !o); setAddValue(''); }}
          className="h-8 w-8 rounded-[8px] flex items-center justify-center shrink-0"
          style={{ background: 'var(--bg-input)', border: '1px dashed rgba(255,255,255,0.2)', color: 'var(--text-muted)' }}
        >
          {adding ? <X size={15} /> : <Plus size={15} />}
        </button>
        {adding && (
          <input
            autoFocus
            value={addValue}
            disabled={addBusy}
            onChange={(e) => setAddValue(e.target.value)}
            placeholder="输入名称创建团队，或粘贴 INV- 邀请码加入"
            className="h-8 px-3 rounded-[8px] text-[13px] outline-none shrink-0 w-[280px]"
            style={{ background: 'var(--bg-input)', border: '1px solid rgba(212,175,55,0.5)', color: 'var(--text-primary)', opacity: addBusy ? 0.6 : 1 }}
            onBlur={() => { if (!addValue.trim()) setAdding(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitAdd();
              if (e.key === 'Escape') { setAdding(false); setAddValue(''); }
            }}
          />
        )}
      </div>

      {/* 二级：团队标签 chips（仅团队空间下展示，平铺不下拉） */}
      {current.kind === 'team' && teams.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" style={{ overscrollBehavior: 'contain' }}>
          {teams.map((t) => {
            if (renaming?.teamId === t.team.id) {
              return (
                <input
                  key={t.team.id}
                  autoFocus
                  value={renaming.value}
                  onChange={(e) => setRenaming({ teamId: t.team.id, value: e.target.value })}
                  onBlur={() => void commitTeamRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitTeamRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  className="h-7 px-2.5 rounded-full text-[12px] outline-none shrink-0"
                  style={{
                    // 宽度随内容自适应（中文按 2ch 估），改名时 chip 不跳位
                    width: `${Math.min(30, Math.max(6, [...renaming.value].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0) + 4))}ch`,
                    background: 'var(--bg-input)',
                    border: '1px solid rgba(212,175,55,0.5)',
                    color: 'var(--text-primary)',
                  }}
                />
              );
            }
            const canRename = t.myRole === 'admin';
            return (
              <button
                key={t.team.id}
                type="button"
                onClick={() => onChange({ kind: 'team', teamId: t.team.id })}
                onDoubleClick={() => { if (canRename) setRenaming({ teamId: t.team.id, value: t.team.name }); }}
                title={canRename ? '双击重命名空间' : undefined}
                className="h-7 px-2.5 rounded-full text-[12px] flex items-center gap-1 shrink-0 transition-colors"
                style={current.teamId === t.team.id
                  ? { background: 'rgba(212,175,55,0.18)', color: 'var(--accent-gold, #d4af37)', border: '1px solid rgba(212,175,55,0.4)' }
                  : { background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.1)', color: 'var(--text-muted)' }}
              >
                <Users size={11} /> {t.team.name} <span className="opacity-60">{t.memberCount}</span>
              </button>
            );
          })}
        </div>
      )}
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
  const [managerOpen, setManagerOpen] = useState(false);
  // null：默认 / 'invite'：打开管理面板并跳到「添加成员」tab
  const [managerInitialTab, setManagerInitialTab] = useState<'invite' | null>(null);

  useEffect(() => {
    let alive = true;
    void getTeam(teamId).then((r) => { if (alive && r.success) setMembers(r.data.members); });
    return () => { alive = false; };
  }, [teamId]);

  if (!team) return null;

  return (
    <div className="flex items-center gap-3 mt-3">
      <button type="button" className="flex items-center -space-x-1.5" title="成员（点击管理）" onClick={() => { setManagerInitialTab(null); setManagerOpen(true); }}>
        {members.slice(0, 5).map((m) => (
          <UserAvatar key={m.userId} src={resolveAvatarUrl({ avatarFileName: m.avatarFileName })} className="w-6 h-6 rounded-full" style={{ border: '1.5px solid var(--bg-card)' }} />
        ))}
        {team.memberCount > 5 && (
          <span className="w-6 h-6 rounded-full flex items-center justify-center text-[10px]" style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', border: '1.5px solid var(--bg-card)' }}>+{team.memberCount - 5}</span>
        )}
      </button>
      {team.myRole === 'admin' && (
        <button type="button" className="h-8 px-3 rounded-[8px] text-[12px] flex items-center gap-1.5"
          style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-primary)' }}
          onClick={() => { setManagerInitialTab('invite'); setManagerOpen(true); }} title="搜索用户并直接添加为成员">
          <UserPlus size={13} />
          邀请成员
        </button>
      )}
      {myWebHostingRole === 'viewer' && (
        <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-muted)' }}>你是查看者（只读）</span>
      )}
      {team.myRole === 'admin' && (
        <button type="button" className="h-8 w-8 rounded-[8px] flex items-center justify-center ml-auto"
          style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', color: 'var(--text-muted)' }}
          title="成员与角色 / 重命名 / 删除空间" onClick={() => { setManagerInitialTab(null); setManagerOpen(true); }}>
          <Settings size={15} />
        </button>
      )}
      {managerOpen && (
        <TeamManagerPanel initialTab={managerInitialTab ?? undefined} initialTeamId={teamId} onClose={() => {
          setManagerOpen(false);
          setManagerInitialTab(null);
          void loadTeams(true);
          void getTeam(teamId).then((r) => { if (r.success) setMembers(r.data.members); });
        }} />
      )}
    </div>
  );
}
