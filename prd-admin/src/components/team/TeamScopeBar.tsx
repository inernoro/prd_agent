import { useEffect, useState } from 'react';
import { ChevronDown, Settings, Users } from 'lucide-react';
import { useTeamStore } from '@/stores/teamStore';
import { TeamManagerPanel } from '@/components/team/TeamManagerPanel';

export interface TeamScope {
  scope: 'mine' | 'team';
  teamId: string | null;
}

/**
 * 「我的 / 团队」切换栏 + 团队选择下拉 + 「管理团队」入口。
 * 网页托管与知识库共用，保证两个模块交互一致（默认我的，规则 #9 / 决策 8）。
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

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  const selectedTeam = teams.find((t) => t.team.id === value.teamId);

  const applyMine = () => {
    setScope(moduleKey, 'mine', null);
    onChange({ scope: 'mine', teamId: null });
  };

  const applyTeam = (teamId: string) => {
    setScope(moduleKey, 'team', teamId);
    onChange({ scope: 'team', teamId });
    setTeamDropdownOpen(false);
  };

  const onTeamPillClick = () => {
    // 切到团队：默认选第一个团队（若有），否则打开管理面板去创建
    if (teams.length === 0) {
      setManagerOpen(true);
      return;
    }
    const target = value.teamId && teams.some((t) => t.team.id === value.teamId)
      ? value.teamId
      : teams[0].team.id;
    applyTeam(target);
  };

  const pillBase = 'px-3 h-8 rounded-[8px] text-[13px] font-medium transition-colors flex items-center gap-1.5';

  return (
    <>
      <div className="flex items-center gap-2">
        {/* 我的 / 团队 双 pill */}
        <div
          className="flex items-center gap-1 p-1 rounded-[10px]"
          style={{ background: 'var(--bg-input)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <button
            type="button"
            className={pillBase}
            style={
              value.scope === 'mine'
                ? { background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' }
                : { color: 'var(--text-muted)' }
            }
            onClick={applyMine}
          >
            我的
          </button>
          <button
            type="button"
            className={pillBase}
            style={
              value.scope === 'team'
                ? { background: 'var(--accent-gold, #d4af37)', color: '#1a1a1a' }
                : { color: 'var(--text-muted)' }
            }
            onClick={onTeamPillClick}
          >
            <Users size={13} />
            团队
          </button>
        </div>

        {/* 团队选择下拉（仅团队作用域时显示） */}
        {value.scope === 'team' && teams.length > 0 && (
          <div className="relative">
            <button
              type="button"
              className="h-8 px-3 rounded-[8px] text-[13px] flex items-center gap-1.5"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: 'var(--text-primary)',
              }}
              onClick={() => setTeamDropdownOpen((o) => !o)}
            >
              {selectedTeam?.team.name ?? '选择团队'}
              <ChevronDown size={13} style={{ color: 'var(--text-muted)' }} />
            </button>
            {teamDropdownOpen && (
              <div
                className="absolute left-0 top-[36px] z-[120] min-w-[200px] rounded-[10px] py-1 max-h-[300px] overflow-auto"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
                }}
              >
                {teams.map((t) => (
                  <button
                    key={t.team.id}
                    type="button"
                    className="w-full text-left px-3 py-2 text-[13px] hover:bg-white/8 flex items-center justify-between"
                    style={{ color: 'var(--text-primary)' }}
                    onClick={() => applyTeam(t.team.id)}
                  >
                    <span>{t.team.name}</span>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {t.memberCount} 人
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 管理团队 */}
        <button
          type="button"
          className="h-8 px-3 rounded-[8px] text-[13px] flex items-center gap-1.5"
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'var(--text-muted)',
          }}
          onClick={() => setManagerOpen(true)}
        >
          <Settings size={13} />
          管理团队
        </button>
      </div>

      {managerOpen && (
        <TeamManagerPanel
          onClose={() => {
            setManagerOpen(false);
            // 关闭后刷新团队列表（可能新建/加入了团队）
            void loadTeams(true);
          }}
        />
      )}
    </>
  );
}
