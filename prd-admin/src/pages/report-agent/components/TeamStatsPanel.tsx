import { useState, useEffect, useCallback } from 'react';
import { BarChart3, RefreshCw, Users, FileText, Sparkles } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { getTeamDashboard } from '@/services';
import type { TeamDashboardData, TeamDashboardMember } from '@/services/contracts/reportAgent';

interface TeamStatsPanelProps {
  teamId: string;
  weekYear?: number;
  weekNumber?: number;
}

const statusColors: Record<string, { bg: string; text: string; label: string }> = {
  submitted: { bg: 'rgba(34, 197, 94, 0.12)', text: 'rgba(34, 197, 94, 0.95)', label: '已提交' },
  reviewed: { bg: 'rgba(59, 130, 246, 0.12)', text: 'rgba(59, 130, 246, 0.95)', label: '已审阅' },
  viewed: { bg: 'rgba(139, 92, 246, 0.12)', text: 'rgba(139, 92, 246, 0.95)', label: '已查看' },
  draft: { bg: 'rgba(234, 179, 8, 0.12)', text: 'rgba(234, 179, 8, 0.95)', label: '草稿' },
  'not-started': { bg: 'rgba(156, 163, 175, 0.12)', text: 'rgba(156, 163, 175, 0.95)', label: '未开始' },
  vacation: { bg: 'rgba(244, 114, 182, 0.12)', text: 'rgba(244, 114, 182, 0.95)', label: '请假' },
  overdue: { bg: 'rgba(239, 68, 68, 0.12)', text: 'rgba(239, 68, 68, 0.95)', label: '逾期' },
};

export function TeamStatsPanel({ teamId, weekYear, weekNumber }: TeamStatsPanelProps) {
  const [data, setData] = useState<TeamDashboardData | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getTeamDashboard({ teamId, weekYear, weekNumber });
      if (res.success && res.data) setData(res.data);
    } finally {
      setLoading(false);
    }
  }, [teamId, weekYear, weekNumber]);

  useEffect(() => { void load(); }, [load]);

  if (!data) {
    return loading ? (
      <GlassCard className="p-3">
        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          <RefreshCw size={12} className="animate-spin" /> 加载团队数据...
        </div>
      </GlassCard>
    ) : null;
  }

  const submissionRate = data.stats.total > 0
    ? Math.round((data.stats.submitted + data.stats.reviewed) / data.stats.total * 100)
    : 0;

  return (
    <div className="space-y-3">
      {/* Stats Overview */}
      <GlassCard className="p-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <BarChart3 size={14} style={{ color: 'var(--accent-primary)' }} />
            <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
              {data.team.name} — W{data.weekNumber} 产出概览
            </span>
          </div>
          <Button variant="secondary" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </Button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard icon={Users} label="团队成员" value={data.stats.total} />
          <StatCard icon={FileText} label="已提交" value={data.stats.submitted} accent />
          <StatCard icon={Sparkles} label="已审阅" value={data.stats.reviewed} />
          <StatCard icon={BarChart3} label="提交率" value={`${submissionRate}%`} />
        </div>
      </GlassCard>

      {/* Member Table */}
      <GlassCard className="p-3">
        <div className="text-[12px] font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>成员产出</div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-primary)' }}>
                <th className="text-left py-1.5 px-2 font-medium" style={{ color: 'var(--text-tertiary)' }}>成员</th>
                <th className="text-left py-1.5 px-2 font-medium" style={{ color: 'var(--text-tertiary)' }}>岗位</th>
                <th className="text-center py-1.5 px-2 font-medium" style={{ color: 'var(--text-tertiary)' }}>状态</th>
                <th className="text-right py-1.5 px-2 font-medium" style={{ color: 'var(--text-tertiary)' }}>提交时间</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((member) => (
                <MemberRow key={member.userId} member={member} />
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, accent }: {
  icon: typeof Users;
  label: string;
  value: number | string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 p-2 rounded" style={{ background: 'var(--bg-secondary)' }}>
      <div className="flex items-center gap-1">
        <Icon size={11} style={{ color: 'var(--text-tertiary)' }} />
        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
      </div>
      <span
        className="text-[16px] font-semibold"
        style={{ color: accent ? 'var(--accent-primary)' : 'var(--text-primary)' }}
      >
        {value}
      </span>
    </div>
  );
}

function MemberRow({ member }: { member: TeamDashboardMember }) {
  const status = statusColors[member.reportStatus] || statusColors['not-started'];
  return (
    <tr style={{ borderBottom: '1px solid var(--border-primary)' }}>
      <td className="py-1.5 px-2" style={{ color: 'var(--text-primary)' }}>
        {member.userName || member.userId}
      </td>
      <td className="py-1.5 px-2" style={{ color: 'var(--text-tertiary)' }}>
        {member.jobTitle || '-'}
      </td>
      <td className="py-1.5 px-2 text-center">
        <span
          className="inline-block px-1.5 py-0.5 rounded text-[11px]"
          style={{ background: status.bg, color: status.text }}
        >
          {status.label}
        </span>
      </td>
      <td className="py-1.5 px-2 text-right" style={{ color: 'var(--text-tertiary)' }}>
        {member.submittedAt ? new Date(member.submittedAt).toLocaleString() : '-'}
      </td>
    </tr>
  );
}
