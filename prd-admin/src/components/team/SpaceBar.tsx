import { useEffect, useState } from 'react';
import { ChevronDown, Plus, Settings, User, UserPlus, Users, X } from 'lucide-react';
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
// 记住上次停留在哪个空间（个人 / 某团队），下次进来直接落回去
const LAST_SPACE_KEY = 'webpages.pref.lastSpace';

/** 上次停留的空间；没有记忆或那个团队已经不在了，就落回个人空间 */
export function readLastSpace(): Space {
  try {
    const raw = sessionStorage.getItem(LAST_SPACE_KEY);
    if (!raw) return { kind: 'personal' };
    const v = JSON.parse(raw) as Space;
    if (v?.kind === 'team' && typeof v.teamId === 'string' && v.teamId) return v;
  } catch {
    /* 脏值当没记忆 */
  }
  return { kind: 'personal' };
}

export function rememberSpace(space: Space) {
  try {
    sessionStorage.setItem(LAST_SPACE_KEY, JSON.stringify(space));
    if (space.kind === 'team') sessionStorage.setItem(LAST_TEAM_KEY, space.teamId);
  } catch {
    /* 存不进去不影响使用 */
  }
}

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
      className="h-8 px-3 rounded-[8px] text-[13px] flex items-center gap-1.5 shrink-0 whitespace-nowrap transition-colors"
      style={on
        ? { background: 'var(--accent-primary-solid)', color: 'var(--accent-on-solid)' }
        : { background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
    >
      {label}
    </button>
  );

  return (
    <div data-tour-id="webpages-space-bar" className="flex flex-col gap-2 w-full">
      {/* 一级导航：个人空间 | 团队空间 */}
      <div className="flex min-w-0 items-center gap-2 overflow-x-auto pb-0.5" style={{ overscrollBehavior: 'contain', scrollbarWidth: 'none' }}>
        {pill(<><User size={13} /> 个人空间</>, current.kind === 'personal', () => onChange({ kind: 'personal' }), 'personal')}
        {pill(<><Users size={13} /> 团队空间{teams.length > 0 && <span className="opacity-60">{teams.length}</span>}</>, current.kind === 'team', enterTeamSection, 'team-section')}
        {/* 「+」常驻一级行：没有任何团队时也能从这里新建/加入；点开后行内展开输入框，不弹浮层 */}
        <button
          type="button"
          data-tour-id="webpages-space-add"
          title="新建 / 加入团队空间"
          onClick={() => { setAdding((o) => !o); setAddValue(''); }}
          className="h-8 w-8 rounded-[8px] flex items-center justify-center shrink-0"
          style={{ background: 'var(--bg-input)', border: '1px dashed var(--border-subtle)', color: 'var(--text-muted)' }}
        >
          {adding ? <X size={15} /> : <Plus size={15} />}
        </button>
        {adding && (
          <>
            <input
              autoFocus
              value={addValue}
              disabled={addBusy}
              onChange={(e) => setAddValue(e.target.value)}
              placeholder="输入团队空间名称"
              title="输入名称回车或点「创建」；粘贴 INV- 邀请码可直接加入"
              className="h-8 px-3 rounded-[8px] text-[13px] outline-none shrink-0 w-[240px]"
              style={{ background: 'var(--bg-input)', border: '1px solid rgba(212,175,55,0.5)', color: 'var(--text-primary)', opacity: addBusy ? 0.6 : 1 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitAdd();
                if (e.key === 'Escape') { setAdding(false); setAddValue(''); }
              }}
            />
            <button
              type="button"
              disabled={!addValue.trim() || addBusy}
              onClick={() => void submitAdd()}
              className="h-8 px-3 rounded-[8px] text-[13px] shrink-0"
              style={addValue.trim() && !addBusy
                ? { background: 'var(--accent-primary-solid)', color: 'var(--accent-on-solid)' }
                : { background: 'var(--nested-block-bg)', color: 'var(--text-muted)', cursor: 'not-allowed' }}
            >
              {addBusy ? '处理中…' : /^INV-/i.test(addValue.trim()) ? '加入' : '创建'}
            </button>
          </>
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
                  : { background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
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
 * 顶栏的空间/团队切换器（设计稿屏 1·A 顶栏中段）：
 * `[人形] 团队 · PRD Agent [OWNER] [头像堆叠] ˅`，点开是空间列表 + 成员管理入口。
 *
 * 左栏「空间」节只放两行聚合（个人 / 团队），具体是哪个团队在这里换 —— 设计稿就是这么分工的。
 */
export function TeamSwitcher({
  current,
  onChange,
  roleLabel,
}: {
  current: Space;
  onChange: (s: Space) => void;
  /** 当前团队里我的网页托管角色，深色小徽章；个人空间不显示 */
  roleLabel?: string | null;
}) {
  const { teams, loadTeams } = useTeamStore();
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [managerOpen, setManagerOpen] = useState(false);
  const team = current.kind === 'team' ? teams.find((t) => t.team.id === current.teamId) ?? null : null;

  useEffect(() => { void loadTeams(); }, [loadTeams]);
  useEffect(() => {
    if (current.kind !== 'team') { setMembers([]); return; }
    let alive = true;
    void getTeam(current.teamId).then((r) => { if (alive && r.success) setMembers(r.data.members ?? []); });
    return () => { alive = false; };
  }, [current]);

  const label = current.kind === 'team' ? `团队 · ${team?.team.name ?? '团队空间'}` : '个人空间';

  return (
    <div className="relative">
      <button
        type="button"
        data-tour-id="webpages-team-switcher"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-2 rounded-[9px] px-2.5 text-[12.5px] transition-colors"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
      >
        {current.kind === 'team' ? <Users size={13} /> : <User size={13} />}
        <span className="max-w-[180px] truncate">{label}</span>
        {roleLabel && (
          <span
            className="rounded-[4px] px-1 text-[10px] uppercase"
            style={{ fontFamily: 'var(--font-code)', color: 'var(--accent-fg-success)', border: '1px solid rgba(34,197,94,0.35)' }}
          >
            {roleLabel}
          </span>
        )}
        {members.length > 0 && (
          <span className="flex items-center">
            {members.slice(0, 3).map((m, i) => (
              <UserAvatar
                key={m.userId}
                src={resolveAvatarUrl({ avatarFileName: m.avatarFileName })}
                className="h-[19px] w-[19px] rounded-full"
                style={{ border: '1.5px solid var(--bg-elevated)', marginLeft: i === 0 ? 0 : -6 }}
              />
            ))}
            {members.length > 3 && (
              <span
                className="flex h-[19px] items-center justify-center rounded-full px-1 text-[9px]"
                style={{ background: 'var(--avatar-bg-neutral)', color: 'var(--text-secondary)', border: '1.5px solid var(--bg-elevated)', marginLeft: -6 }}
              >
                +{members.length - 3}
              </span>
            )}
          </span>
        )}
        <ChevronDown size={12} style={{ color: 'var(--text-tertiary)' }} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div
            className="absolute left-0 top-[36px] z-[61] w-[240px] rounded-[12px] p-1.5"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', boxShadow: '0 18px 40px rgba(0,0,0,0.5)' }}
          >
            <button
              type="button"
              onClick={() => { onChange({ kind: 'personal' }); setOpen(false); }}
              className="flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-[12.5px]"
              style={current.kind === 'personal'
                ? { background: 'var(--selection-bg)', color: 'var(--selection-text)' }
                : { color: 'var(--text-primary)' }}
            >
              <User size={13} /> 个人空间
            </button>
            {teams.map((t) => (
              <button
                key={t.team.id}
                type="button"
                onClick={() => { onChange({ kind: 'team', teamId: t.team.id }); setOpen(false); }}
                className="flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-[12.5px]"
                style={current.kind === 'team' && current.teamId === t.team.id
                  ? { background: 'var(--selection-bg)', color: 'var(--selection-text)' }
                  : { color: 'var(--text-primary)' }}
              >
                <Users size={13} />
                <span className="flex-1 truncate text-left">{t.team.name}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{t.memberCount} 人</span>
              </button>
            ))}
            {team?.myRole === 'admin' && (
              <>
                <div className="my-1 h-px" style={{ background: 'var(--border-subtle)' }} />
                <button
                  type="button"
                  onClick={() => { setManagerOpen(true); setOpen(false); }}
                  className="flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-[12.5px]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <UserPlus size={13} /> 成员与角色
                </button>
              </>
            )}
          </div>
        </>
      )}

      {managerOpen && current.kind === 'team' && (
        <TeamManagerPanel initialTeamId={current.teamId} onClose={() => { setManagerOpen(false); void loadTeams(true); }} />
      )}
    </div>
  );
}

/**
 * 空间切换的竖排形态（设计稿屏 1·A 左栏「空间」节）：个人空间 + 每个团队各占一行，
 * 右侧带成员数，行内「+」新建/加入。与横排 SpaceBar 同一套 createTeam/joinTeam 行为，
 * 只是换了摆法 —— 桌面走这一份（常驻左栏），移动端筛选抽屉仍用横排那份。
 */
export function SpaceRailSection({
  current,
  onChange,
  personalCount,
  teamCount,
  hint,
}: {
  current: Space;
  onChange: (s: Space) => void;
  /** 个人空间的站点数；拿不到就不显示数字，不编 */
  personalCount?: number | null;
  /** 团队空间的站点数（当前团队）；拿不到就不显示 */
  teamCount?: number | null;
  hint?: string;
}) {
  const { teams, loadTeams } = useTeamStore();

  useEffect(() => { void loadTeams(); }, [loadTeams]);

  // 设计稿左栏只有两行聚合：团队空间 / 个人空间，数字都是站点数。
  // 具体切到哪个团队走顶栏的 TeamSwitcher —— 设计稿就是这么分工的。
  const enterTeam = () => {
    if (current.kind === 'team') return;
    const remembered = sessionStorage.getItem(LAST_TEAM_KEY);
    const target = teams.find((t) => t.team.id === remembered) ?? teams[0];
    if (target) onChange({ kind: 'team', teamId: target.team.id });
  };

  const row = (opts: { key: string; on: boolean; icon: React.ReactNode; label: string; count?: number | null; disabled?: boolean; onClick: () => void }) => (
    <button
      key={opts.key}
      type="button"
      disabled={opts.disabled}
      onClick={opts.onClick}
      className="flex w-full items-center gap-2.5 transition-colors"
      style={{
        height: 34,
        padding: '0 8px',
        borderRadius: 'var(--radius-control)',
        fontSize: 13,
        cursor: opts.disabled ? 'not-allowed' : 'pointer',
        ...(opts.on
          ? { background: 'var(--selection-bg)', border: '1px solid var(--selection-border)', color: 'var(--selection-text)' }
          : { background: 'transparent', border: '1px solid transparent', color: opts.disabled ? 'var(--text-disabled)' : 'var(--text-primary)' }),
      }}
    >
      <span className="shrink-0 opacity-80">{opts.icon}</span>
      <span className="flex-1 truncate text-left">{opts.label}</span>
      {typeof opts.count === 'number' && (
        <span className="shrink-0 tabular-nums" style={{ fontFamily: 'var(--font-code)', fontSize: 11, color: 'var(--text-tertiary)' }}>
          {opts.count.toLocaleString()}
        </span>
      )}
    </button>
  );

  return (
    <div data-tour-id="webpages-space-bar" className="space-y-0.5">
      <div className="px-2 pb-1.5" style={{ fontFamily: 'var(--font-code)', fontSize: 10, letterSpacing: 'var(--tracking-eyebrow)', color: 'var(--text-tertiary)' }}>空间</div>
      {row({
        key: 'team',
        on: current.kind === 'team',
        icon: <Users size={13} />,
        label: '团队空间',
        count: current.kind === 'team' ? teamCount ?? null : null,
        disabled: teams.length === 0,
        onClick: enterTeam,
      })}
      {row({
        key: 'personal',
        on: current.kind === 'personal',
        icon: <User size={13} />,
        label: '个人空间',
        count: current.kind === 'personal' ? personalCount ?? null : null,
        onClick: () => onChange({ kind: 'personal' }),
      })}
      {hint && (
        <div className="px-2 pt-2" style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--text-tertiary)' }}>{hint}</div>
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
        <button type="button" className="h-8 px-3 rounded-[8px] text-[12px] flex items-center gap-1.5 border border-token-subtle"
          style={{ background: 'var(--bg-input)', color: 'var(--text-primary)' }}
          onClick={() => { setManagerInitialTab('invite'); setManagerOpen(true); }} title="搜索用户并直接添加为成员">
          <UserPlus size={13} />
          邀请成员
        </button>
      )}
      {myWebHostingRole === 'viewer' && (
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-token-nested" style={{ color: 'var(--text-muted)' }}>你是查看者（只读）</span>
      )}
      {team.myRole === 'admin' && (
        <button type="button" className="h-8 w-8 rounded-[8px] flex items-center justify-center ml-auto border border-token-subtle"
          style={{ background: 'transparent', color: 'var(--text-muted)' }}
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
