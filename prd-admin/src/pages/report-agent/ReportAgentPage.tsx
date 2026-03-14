import { useEffect, useMemo } from 'react';
import { FileText, Users, Settings, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import { ReportMainView } from './components/ReportMainView';
import { TeamDashboard } from './components/TeamDashboard';
import { SettingsPanel } from './components/SettingsPanel';

/**
 * v3.0 周报系统 — 奥卡姆剃刀重设计
 *
 * 8 tabs → 3 tabs:
 *   周报 = 我的周报 + 每日打点 + 数据统计 (合并为一个完整工作区)
 *   团队 = 团队面板 (仅 leader 可见)
 *   设置 = 我的数据源 + 模板管理 + 团队管理 + 数据源管理 (一次性配置)
 */
export default function ReportAgentPage() {
  const {
    loading,
    error,
    activeTab,
    setActiveTab,
    loadAll,
    teams,
    mockPreviewMode,
    setMockPreviewMode,
  } = useReportAgentStore();

  const permissions = useAuthStore((s) => s.permissions);
  const userId = useAuthStore((s) => s.user?.userId);

  const hasAnyManage =
    permissions.includes('report-agent.template.manage') ||
    permissions.includes('report-agent.team.manage') ||
    permissions.includes('report-agent.datasource.manage') ||
    permissions.includes('super');

  const isLeader = useMemo(() => {
    return teams.some((t) => t.leaderUserId === userId);
  }, [teams, userId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 兼容旧 tab key —— 如果用户通过外部导航到旧 tab, 映射到新 tab
  useEffect(() => {
    const oldToNew: Record<string, string> = {
      'my-reports': 'report',
      'daily-log': 'report',
      'my-sources': 'settings',
      'trends': 'report',
      'templates': 'settings',
      'teams': 'settings',
      'data-sources': 'settings',
      'team-dashboard': 'team',
    };
    if (oldToNew[activeTab]) {
      setActiveTab(oldToNew[activeTab] as typeof activeTab);
    }
  }, []);

  const tabItems = useMemo(() => {
    const items = [
      { key: 'report', label: '周报', icon: <FileText size={14} /> },
    ];
    if (isLeader) {
      items.push({ key: 'team', label: '团队', icon: <Users size={14} /> });
    }
    if (hasAnyManage || true) { // settings always visible for personal data source
      items.push({ key: 'settings', label: '设置', icon: <Settings size={14} /> });
    }
    return items;
  }, [isLeader, hasAnyManage]);

  // Resolve current tab — default to 'report' if current tab not in items
  const currentTab = tabItems.find((t) => t.key === activeTab) ? activeTab : 'report';

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <TabBar
        items={tabItems}
        activeKey={currentTab}
        onChange={(key) => setActiveTab(key as typeof activeTab)}
        actions={
          <button
            onClick={() => setMockPreviewMode(!mockPreviewMode)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all duration-200 cursor-pointer"
            style={{
              color: mockPreviewMode ? 'rgba(168, 85, 247, 0.95)' : 'var(--text-muted)',
              background: mockPreviewMode ? 'rgba(168, 85, 247, 0.1)' : 'transparent',
              border: mockPreviewMode ? '1px solid rgba(168, 85, 247, 0.2)' : '1px solid transparent',
            }}
            title={mockPreviewMode ? '关闭预览模式' : '一键预览效果 — 用 Mock 数据展示配置完善后的效果'}
          >
            {mockPreviewMode ? <EyeOff size={12} /> : <Eye size={12} />}
            {mockPreviewMode ? '退出预览' : '预览效果'}
          </button>
        }
      />

      {/* Mock mode banner */}
      {mockPreviewMode && (
        <div
          className="flex items-center gap-2.5 text-[12px] px-5 py-2.5 rounded-xl"
          style={{
            color: 'rgba(168, 85, 247, 0.9)',
            background: 'rgba(168, 85, 247, 0.06)',
            border: '1px solid rgba(168, 85, 247, 0.12)',
          }}
        >
          <Eye size={14} />
          <span>预览模式 — 展示的是模拟数据，帮助你了解配置完善后的效果。</span>
          <button
            onClick={() => setMockPreviewMode(false)}
            className="ml-auto text-[11px] px-2 py-0.5 rounded cursor-pointer hover:bg-[rgba(168,85,247,0.1)] transition-colors"
            style={{ color: 'rgba(168, 85, 247, 0.7)' }}
          >
            关闭
          </button>
        </div>
      )}

      {error && !mockPreviewMode && (
        <GlassCard glow className="py-2 px-3">
          <div className="flex items-center justify-between">
            <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>{error}</div>
            <Button variant="secondary" size="sm" onClick={() => loadAll()}>
              <RefreshCw size={12} /> 重试
            </Button>
          </div>
        </GlassCard>
      )}

      {loading && !error && !mockPreviewMode && (
        <GlassCard glow className="py-3 px-3">
          <div className="text-[12px] flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
            <RefreshCw size={12} className="animate-spin" />
            加载中...
          </div>
        </GlassCard>
      )}

      <div className="flex-1 min-h-0">
        {currentTab === 'report' && <ReportMainView />}
        {currentTab === 'team' && <TeamDashboard />}
        {currentTab === 'settings' && <SettingsPanel />}
      </div>
    </div>
  );
}
