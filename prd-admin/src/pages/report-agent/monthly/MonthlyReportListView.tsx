import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarRange, FilePlus2, Link2, Users, ArrowRight } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { createMonthlyReport, listMonthlyReports } from '@/services';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import type { MonthlyReport } from '@/services/contracts/reportAgentMonthly';
import { currentYearMonth, formatYearMonth, getMonthlyStatusMeta, recentMonths } from './monthlyMeta';

/** 写完 / 打开一份月报：草稿进编辑页，已提交进详情页（详情页有评论与点赞） */
export function monthlyReportPath(report: Pick<MonthlyReport, 'id' | 'status'>, viewerIsOwner: boolean) {
  return viewerIsOwner && report.status === 'draft'
    ? `/report-agent/monthly/${report.id}/edit`
    : `/report-agent/monthly/${report.id}`;
}

export function MonthlyReportListView() {
  const navigate = useNavigate();
  const teams = useReportAgentStore((s) => s.teams);
  const myTeams = useMemo(() => teams.filter((t) => !!t.myRole), [teams]);

  const months = useMemo(() => recentMonths(12), []);
  const [teamId, setTeamId] = useState<string>('');
  const [ym, setYm] = useState(currentYearMonth);
  const [items, setItems] = useState<MonthlyReport[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!teamId && myTeams.length > 0) setTeamId(myTeams[0].id);
  }, [myTeams, teamId]);

  const load = useCallback(async () => {
    const res = await listMonthlyReports({ scope: 'my' });
    if (res.success && res.data) setItems(res.data.items);
    else {
      setItems([]);
      toast.error(res.error?.message || '月报列表加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const existing = useMemo(
    () => items?.find((r) => r.teamId === teamId && r.year === ym.year && r.month === ym.month) ?? null,
    [items, teamId, ym]
  );

  const handlePrimary = async () => {
    if (existing) {
      navigate(monthlyReportPath(existing, true));
      return;
    }
    if (!teamId) {
      toast.error('你还没有加入任何团队，加入团队后才能写月报');
      return;
    }
    setCreating(true);
    const res = await createMonthlyReport({ teamId, year: ym.year, month: ym.month });
    setCreating(false);
    if (res.success && res.data) {
      navigate(`/report-agent/monthly/${res.data.report.id}/edit`);
    } else {
      toast.error(res.error?.message || '创建月报失败');
    }
  };

  const primaryLabel = existing
    ? existing.status === 'draft'
      ? `继续编辑 ${ym.month} 月月报`
      : `查看 ${ym.month} 月月报`
    : `写 ${ym.month} 月月报`;

  const selectStyle: React.CSSProperties = {
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-primary)',
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4" data-testid="monthly-report-list">
      <GlassCard variant="subtle" className="px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 overflow-x-auto">
          <CalendarRange size={16} className="shrink-0" style={{ color: 'var(--text-secondary)' }} />
          <span className="text-[14px] font-semibold shrink-0 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
            月报
          </span>
          <div className="flex-1" />
          {myTeams.length > 1 && (
            <select
              className="text-[12px] px-2 py-1.5 rounded-lg shrink-0"
              style={selectStyle}
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              aria-label="选择团队"
            >
              {myTeams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
          <select
            className="text-[12px] px-2 py-1.5 rounded-lg shrink-0"
            style={selectStyle}
            value={`${ym.year}-${ym.month}`}
            onChange={(e) => {
              const [y, m] = e.target.value.split('-').map(Number);
              setYm({ year: y, month: m });
            }}
            aria-label="选择月份"
          >
            {months.map((m) => (
              <option key={`${m.year}-${m.month}`} value={`${m.year}-${m.month}`}>{formatYearMonth(m.year, m.month)}</option>
            ))}
          </select>
          <Button variant="primary" size="sm" onClick={handlePrimary} disabled={creating || myTeams.length === 0}>
            {creating ? <MapSpinner size={13} /> : existing ? <ArrowRight size={13} /> : <FilePlus2 size={13} />}
            <span className="whitespace-nowrap">{primaryLabel}</span>
          </Button>
        </div>
      </GlassCard>

      {items === null ? (
        <MapSectionLoader text="正在加载月报…" />
      ) : items.length === 0 ? (
        <GlassCard variant="subtle" className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <CalendarRange size={28} style={{ color: 'var(--text-muted)' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>还没有写过月报</div>
          <div className="text-[12px] max-w-[420px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            月报分四章：本月工作成果（可直接勾选这个月的周报）、问题与对策、本月印象最深刻的三个伙伴、对上级/团队/公司的建议。
          </div>
          <Button variant="primary" size="sm" onClick={handlePrimary} disabled={creating || myTeams.length === 0}>
            {creating ? <MapSpinner size={13} /> : <FilePlus2 size={13} />}
            {myTeams.length === 0 ? '加入团队后才能写月报' : primaryLabel}
          </Button>
        </GlassCard>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {items.map((r) => (
              <MonthlyReportCard key={r.id} report={r} onOpen={() => navigate(monthlyReportPath(r, true))} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MonthlyReportCard({ report, onOpen }: { report: MonthlyReport; onOpen: () => void }) {
  const meta = getMonthlyStatusMeta(report.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left rounded-xl p-4 flex flex-col gap-3 transition-colors hover-bg-soft"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-primary)', minHeight: 148 }}
      data-testid="monthly-report-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {formatYearMonth(report.year, report.month)}
          </div>
          <div className="text-[12px] mt-0.5 truncate" style={{ color: 'var(--text-muted)' }}>{report.teamName}</div>
        </div>
        <span
          className="text-[11px] px-2 py-0.5 rounded-full shrink-0 whitespace-nowrap"
          style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.border}` }}
        >
          {meta.label}
        </span>
      </div>
      <div className="text-[12px] leading-relaxed line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
        {report.achievementsText?.trim() || (report.weeklyLinks.length > 0 ? '本月成果见关联的周报' : '还没有填写本月成果')}
      </div>
      <div className="mt-auto flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
        <span className="inline-flex items-center gap-1"><Link2 size={11} /> {report.weeklyLinks.length} 份周报</span>
        <span className="inline-flex items-center gap-1"><Users size={11} /> {report.partners.length}/3 位伙伴</span>
        <span className="ml-auto">{new Date(report.updatedAt).toLocaleDateString('zh-CN')}</span>
      </div>
    </button>
  );
}
