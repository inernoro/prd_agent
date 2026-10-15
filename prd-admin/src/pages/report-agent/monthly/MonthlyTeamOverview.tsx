import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Link2, ChevronRight } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { getMonthlyTeamOverview } from '@/services';
import type { MonthlyTeamOverview as Overview } from '@/services/contracts/reportAgentMonthly';
import { formatYearMonth, getMonthlyStatusMeta } from './monthlyMeta';

const NOT_STARTED_META = {
  label: '未开始',
  color: 'var(--text-muted)',
  bg: 'var(--bg-secondary)',
  border: 'var(--border-primary)',
};

const ROLE_LABEL: Record<string, string> = { leader: '负责人', deputy: '副负责人' };

/** 负责人视角：本月团队里谁交了月报。草稿只显示状态，点不进去（草稿只有作者本人可见）。 */
export function MonthlyTeamOverview({ teamId, year, month }: { teamId: string; year: number; month: number }) {
  const navigate = useNavigate();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let alive = true;
    setData(null);
    setError(null);
    (async () => {
      const res = await getMonthlyTeamOverview({ teamId, year, month });
      if (!alive) return;
      if (res.success && res.data) setData(res.data);
      else setError(res.error?.message || '团队月报加载失败');
    })();
    return () => {
      alive = false;
    };
  }, [teamId, year, month]);

  if (!teamId) {
    return (
      <GlassCard variant="subtle" className="flex-1 min-h-0 flex items-center justify-center p-8 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        你还不是任何团队的负责人
      </GlassCard>
    );
  }
  if (error) {
    return (
      <GlassCard variant="subtle" className="p-8 text-center text-[13px]" style={{ color: 'var(--accent-fg-error)' }}>
        {error}
      </GlassCard>
    );
  }
  if (!data) return <MapSectionLoader text="正在加载团队月报…" />;

  const pending = data.memberCount - data.submittedCount;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3" data-testid="monthly-team-overview">
      <GlassCard variant="subtle" className="px-4 py-3 shrink-0">
        <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {data.teamName} · {formatYearMonth(data.year, data.month)}：{data.submittedCount} / {data.memberCount} 人已提交月报
        </div>
        <div className="text-[12px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
          {pending > 0 ? `还有 ${pending} 人没有提交（请假豁免的成员不计入）` : '全员都已提交'}
        </div>
      </GlassCard>

      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        {data.items.length === 0 ? (
          <div className="text-[12px] py-10 text-center" style={{ color: 'var(--text-muted)' }}>这个团队还没有成员</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {data.items.map((m) => {
              const meta = m.status === 'not-started' ? NOT_STARTED_META : getMonthlyStatusMeta(m.status);
              const clickable = !!m.reportId;
              return (
                <button
                  key={m.userId}
                  type="button"
                  disabled={!clickable}
                  onClick={() => m.reportId && navigate(`/report-agent/monthly/${m.reportId}`)}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-left ${clickable ? 'hover-bg-soft' : ''}`}
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-primary)',
                    cursor: clickable ? 'pointer' : 'default',
                    opacity: m.isExcused ? 0.6 : 1,
                  }}
                  data-testid="monthly-team-member"
                >
                  <UserAvatar
                    src={resolveAvatarUrl({ username: m.userName, avatarFileName: m.avatarFileName })}
                    className="w-8 h-8 rounded-full object-cover shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{m.userName}</span>
                      {ROLE_LABEL[m.role] && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}>
                          {ROLE_LABEL[m.role]}
                        </span>
                      )}
                      {m.isExcused && <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>请假</span>}
                    </div>
                    <div className="text-[11px] mt-0.5 flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                      {m.submittedAt && <span>提交于 {new Date(m.submittedAt).toLocaleDateString('zh-CN')}</span>}
                      {m.reportId && (
                        <span className="inline-flex items-center gap-1"><Link2 size={10} /> {m.weeklyLinkCount} 份周报</span>
                      )}
                      {m.status === 'draft' && <span>正在写，草稿只有本人可见</span>}
                    </div>
                  </div>
                  <span
                    className="text-[11px] px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap"
                    style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.border}` }}
                  >
                    {meta.label}
                  </span>
                  {clickable && <ChevronRight size={14} className="shrink-0" style={{ color: 'var(--text-muted)' }} />}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        <Users size={11} /> 只有负责人、副负责人能看到这份概览
      </div>
    </div>
  );
}
