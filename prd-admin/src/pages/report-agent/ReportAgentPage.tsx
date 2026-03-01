import { useEffect, useMemo } from 'react';
import { FileBarChart, Users, FileText, Building2, RefreshCw, CalendarCheck, GitBranch, BarChart3 } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import { MyReportsList } from './components/MyReportsList';
import { TeamDashboard } from './components/TeamDashboard';
import { TemplateManager } from './components/TemplateManager';
import { TeamManager } from './components/TeamManager';
import { DailyLogPanel } from './components/DailyLogPanel';
import { DataSourceManager } from './components/DataSourceManager';
import { HistoryTrendsPanel } from './components/HistoryTrendsPanel';

export default function ReportAgentPage() {
  const {
    loading,
    error,
    activeTab,
    setActiveTab,
    loadAll,
    teams,
  } = useReportAgentStore();

  const permissions = useAuthStore((s) => s.permissions);
  const userId = useAuthStore((s) => s.user?.userId);

  const hasTemplateManage = permissions.includes('report-agent.template.manage') || permissions.includes('super');
  const hasTeamManage = permissions.includes('report-agent.team.manage') || permissions.includes('super');
  const hasDataSourceManage = permissions.includes('report-agent.datasource.manage') || permissions.includes('super');

  // Check if user is a leader of any team
  const isLeader = useMemo(() => {
    return teams.some((t) => t.leaderUserId === userId);
  }, [teams, userId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const tabItems = useMemo(() => {
    const items = [
      { key: 'my-reports', label: '我的周报', icon: <FileText size={14} /> },
      { key: 'daily-log', label: '每日打点', icon: <CalendarCheck size={14} /> },
    ];
    if (isLeader) {
      items.push({ key: 'team-dashboard', label: '团队面板', icon: <Users size={14} /> });
    }
    // Trends tab - visible to everyone
    items.push({ key: 'trends', label: '数据统计', icon: <BarChart3 size={14} /> });
    if (hasTemplateManage) {
      items.push({ key: 'templates', label: '模板管理', icon: <FileBarChart size={14} /> });
    }
    if (hasTeamManage) {
      items.push({ key: 'teams', label: '团队管理', icon: <Building2 size={14} /> });
    }
    if (hasDataSourceManage) {
      items.push({ key: 'data-sources', label: '数据源', icon: <GitBranch size={14} /> });
    }
    return items;
  }, [isLeader, hasTemplateManage, hasTeamManage, hasDataSourceManage]);

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <TabBar
        title="周报管理"
        icon={<FileBarChart size={16} />}
        items={tabItems}
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as typeof activeTab)}
      />

      {error && (
        <GlassCard glow className="py-2 px-3">
          <div className="flex items-center justify-between">
            <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{error}</div>
            <Button variant="secondary" size="sm" onClick={() => loadAll()}>
              <RefreshCw size={12} /> 重试
            </Button>
          </div>
        </GlassCard>
      )}

      {loading && !error && (
        <GlassCard glow className="py-3 px-3">
          <div className="text-[12px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            <RefreshCw size={12} className="animate-spin" />
            加载中...
          </div>
        </GlassCard>
      )}

      <div className="flex-1 min-h-0">
        {activeTab === 'my-reports' && <MyReportsList />}
        {activeTab === 'daily-log' && <DailyLogPanel />}
        {activeTab === 'team-dashboard' && <TeamDashboard />}
        {activeTab === 'trends' && <HistoryTrendsPanel />}
        {activeTab === 'templates' && <TemplateManager />}
        {activeTab === 'teams' && <TeamManager />}
        {activeTab === 'data-sources' && <DataSourceManager />}
      </div>
    </div>
  );
}
