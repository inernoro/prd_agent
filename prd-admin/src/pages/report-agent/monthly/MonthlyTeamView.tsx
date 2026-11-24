import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, AlertCircle, ExternalLink, FileText, Link2 } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { UserAvatar } from '@/components/ui/UserAvatar';
import { resolveAvatarUrl } from '@/lib/avatar';
import { getMonthlyTeamOverview } from '@/services';
import type { ReportTeam } from '@/services/contracts/reportAgent';
import type { MonthlyTeamOverview, MonthlyTeamOverviewItem } from '@/services/contracts/reportAgentMonthly';
import { useDataTheme } from '../hooks/useDataTheme';
import { useStatusChipConfig } from '../hooks/useStatusChipConfig';
import { MonthNavRail } from './MonthNavRail';
import { currentYearMonth, formatYearMonth } from './monthlyMeta';
import MonthlyReportDetailPage from './MonthlyReportDetailPage';

const ROW_STATUS: Record<string, { label: string; icon: typeof CheckCircle2 }> = {
  submitted: { label: '已提交', icon: AlertCircle },
  viewed: { label: '负责人已查看', icon: CheckCircle2 },
};

/**
 * 团队月报（负责人视角），版式与周报「团队」页一致：
 * 左侧月导航（年 / 月两级，展开看已提交成员），右侧顶栏 + 「团队月报列表」卡片
 * （团队人数 / 已提交 / 待提交，悬停「待提交」看名单），点成员或「查看」在右侧直接阅读。
 */
export function MonthlyTeamView({ managedTeams }: { managedTeams: ReportTeam[] }) {
  const navigate = useNavigate();
  const isLight = useDataTheme() === 'light';
  const statusColors = useStatusChipConfig(isLight);

  const [teamId, setTeamId] = useState(managedTeams[0]?.id ?? '');
  const [ym, setYm] = useState(currentYearMonth);
  const [data, setData] = useState<MonthlyTeamOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MonthlyTeamOverviewItem | null>(null);

  useEffect(() => {
    if (!managedTeams.some((t) => t.id === teamId)) setTeamId(managedTeams[0]?.id ?? '');
  }, [managedTeams, teamId]);

  const load = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    setError(null);
    const res = await getMonthlyTeamOverview({ teamId, year: ym.year, month: ym.month });
    setLoading(false);
    if (res.success && res.data) setData(res.data);
    else {
      setData(null);
      setError(res.error?.message || '团队月报加载失败');
    }
  }, [teamId, ym]);

  useEffect(() => {
    setSelected(null);
    void load();
  }, [load]);

  // 「待提交」悬停名单（与周报团队页同一交互）
  const pendingChipRef = useRef<HTMLSpanElement | null>(null);
  const [pendingPos, setPendingPos] = useState<{ left: number; top: number } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const openPending = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    const rect = pendingChipRef.current?.getBoundingClientRect();
    if (rect) setPendingPos({ left: rect.left, top: rect.bottom + 6 });
  };
  const schedulePendingClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setPendingPos(null), 120);
  };
  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  const items = data?.items ?? [];
  const submittedItems = items.filter((m) => !!m.reportId);
  const pendingMembers = items.filter((m) => !m.reportId && !m.isExempt);
  const selectedTeam = managedTeams.find((t) => t.id === teamId);

  const openInline = (m: MonthlyTeamOverviewItem) => {
    if (m.reportId) setSelected(m);
  };

  return (
    <div className="flex-1 h-full min-h-0 flex flex-col gap-3 lg:flex-row lg:gap-4" data-testid="monthly-team-view">
      <MonthNavRail
        selectedYear={ym.year}
        selectedMonth={ym.month}
        selectedMemberUserId={selected?.userId ?? null}
        members={items}
        loading={loading}
        teamName={selectedTeam?.name}
        onSelectMonth={(year, month) => setYm({ year, month })}
        onSelectMember={openInline}
      />

      <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-4 overflow-y-auto lg:pr-1" style={{ overscrollBehavior: 'contain' }}>
        {selected?.reportId ? (
          <MonthlyReportDetailPage
            key={selected.reportId}
            reportIdOverride={selected.reportId}
            onBack={() => {
              setSelected(null);
              void load();
            }}
          />
        ) : (
          <>
            <GlassCard variant="subtle" className="px-5 py-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span className="text-[13px] font-semibold whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                  {formatYearMonth(ym.year, ym.month)}
                </span>
                <select
                  className="surface-inset px-3 py-2 rounded-xl text-[13px] min-w-[220px]"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  disabled={managedTeams.length === 0}
                  aria-label="选择团队"
                >
                  {managedTeams.length > 0
                    ? managedTeams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)
                    : <option value="">暂无你负责的团队</option>}
                </select>
              </div>
            </GlassCard>

            <GlassCard variant="subtle" className="surface-raised p-0 overflow-hidden flex-1 min-h-0 flex flex-col">
              <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--border-primary)' }}>
                <div className="flex items-center gap-2.5">
                  <FileText size={16} />
                  <span className="text-[16px] font-semibold tracking-tight">团队月报列表</span>
                </div>
                <div className="mt-2 flex items-center flex-wrap gap-2 text-[11px]">
                  <span className="surface-inset rounded-full px-2 py-0.5" style={{ color: 'var(--text-secondary)' }}>
                    团队人数 {data?.memberCount ?? 0}
                  </span>
                  <span className="surface-inset rounded-full px-2 py-0.5" style={{ color: 'var(--status-done)' }} data-testid="monthly-submitted-count">
                    已提交 {data?.submittedCount ?? 0}
                  </span>
                  <span
                    ref={pendingChipRef}
                    className="surface-inset rounded-full px-2 py-0.5 cursor-default"
                    style={{ color: 'var(--accent-fg-warning)' }}
                    onMouseEnter={openPending}
                    onMouseLeave={schedulePendingClose}
                    data-testid="monthly-pending-count"
                  >
                    待提交 {data?.pendingCount ?? 0}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>负责人与请假成员免交</span>
                </div>
              </div>

              <div className="px-5 py-4 flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                {error ? (
                  <div className="text-[12px] text-center py-10" style={{ color: 'var(--accent-fg-error)' }}>{error}</div>
                ) : loading && !data ? (
                  <div className="text-[12px] text-center py-10" style={{ color: 'var(--text-muted)' }}>加载中...</div>
                ) : submittedItems.length === 0 ? (
                  <div className="surface-inset rounded-xl px-4 py-8 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    本月暂无已提交的月报
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {submittedItems.map((item) => {
                      const colors = statusColors[item.status] || statusColors.submitted;
                      const meta = ROW_STATUS[item.status] || ROW_STATUS.submitted;
                      const StatusIcon = meta.icon;
                      return (
                        <button
                          key={item.userId}
                          type="button"
                          className="surface-row rounded-xl px-4 py-3 text-left flex items-center justify-between gap-3"
                          onClick={() => openInline(item)}
                          data-testid="monthly-team-row"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <UserAvatar
                              src={resolveAvatarUrl({ username: item.userName, avatarFileName: item.avatarFileName })}
                              alt={item.userName}
                              className="w-8 h-8 rounded-full object-cover flex-none"
                            />
                            <div className="min-w-0">
                              <div className="text-[13px] font-medium truncate">{item.userName}</div>
                              <div className="mt-1 flex items-center flex-wrap gap-2 text-[11px]">
                                <span className="flex items-center gap-1 px-2 py-0.5 rounded-full font-medium" style={{ color: colors.color, background: colors.bg }}>
                                  <StatusIcon size={10} />
                                  {meta.label}
                                </span>
                                <span style={{ color: 'var(--text-muted)' }}>
                                  提交于 {item.submittedAt ? new Date(item.submittedAt).toLocaleString('zh-CN') : '-'}
                                </span>
                                <span className="inline-flex items-center gap-1" style={{ color: 'var(--text-muted)' }}>
                                  <Link2 size={10} /> {item.weeklyLinkCount} 份周报
                                </span>
                              </div>
                            </div>
                          </div>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (item.reportId) navigate(`/report-agent/monthly/${item.reportId}`);
                            }}
                          >
                            <ExternalLink size={13} />
                            查看
                          </Button>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </GlassCard>
          </>
        )}
      </div>

      {pendingPos && pendingMembers.length > 0 && createPortal(
        <div
          className="surface rounded-xl"
          style={{
            position: 'fixed',
            left: pendingPos.left,
            top: pendingPos.top,
            zIndex: 100,
            minWidth: 220,
            maxWidth: 320,
            maxHeight: 360,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: 10,
            boxShadow: 'var(--shadow-card-hover)',
          }}
          onMouseEnter={openPending}
          onMouseLeave={schedulePendingClose}
          data-testid="monthly-pending-popover"
        >
          <div className="px-1 pb-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            待提交成员 · {pendingMembers.length}
          </div>
          <div className="flex flex-col gap-1">
            {pendingMembers.map((m) => (
              <div key={m.userId} className="flex items-center gap-2 px-1 py-1 rounded-md surface-row">
                <UserAvatar
                  src={resolveAvatarUrl({ username: m.userName, avatarFileName: m.avatarFileName })}
                  alt={m.userName}
                  className="w-6 h-6 rounded-full object-cover flex-none"
                />
                <span className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>{m.userName}</span>
                <span className="ml-auto text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                  {m.status === 'draft' ? '正在写' : '未开始'}
                </span>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
