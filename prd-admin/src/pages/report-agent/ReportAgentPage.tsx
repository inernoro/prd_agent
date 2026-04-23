import { useEffect, useMemo, useState } from 'react';
import { FileText, Users, Settings, RefreshCw, HelpCircle } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import { ReportMainView } from './components/ReportMainView';
import { TeamDashboard } from './components/TeamDashboard';
import { SettingsPanel } from './components/SettingsPanel';
import { UsageGuideOverlay } from './components/UsageGuideOverlay';
import { ZoomControl, ZOOM_SCALE, type ZoomLevel } from './components/ZoomControl';

const ZOOM_STORAGE_KEY = 'report-agent:zoom';

function readZoomFromStorage(): ZoomLevel {
  if (typeof window === 'undefined') return 'normal';
  const raw = window.sessionStorage.getItem(ZOOM_STORAGE_KEY);
  if (raw === 'large' || raw === 'extra') return raw;
  return 'normal';
}

/**
 * v3.0 周报系统 — 奥卡姆剃刀重设计
 *
 * 8 tabs → 3 tabs:
 *   周报 = 我的周报 + 每日打点 + 数据统计 (合并为一个完整工作区)
 *   团队 = 团队面板（区分我管理/我加入）
 *   设置 = 我的数据源 + 模板管理 + 团队管理 + 数据源管理 (一次性配置)
 */
export default function ReportAgentPage() {
  const {
    loading,
    error,
    activeTab,
    setActiveTab,
    setSelectedReportId,
    setShowReportEditor,
    showReportEditor,
    loadAll,
    teams,
  } = useReportAgentStore();

  const userId = useAuthStore((s) => s.user?.userId);
  const [showUsageGuide, setShowUsageGuide] = useState(false);
  const [zoom, setZoom] = useState<ZoomLevel>(readZoomFromStorage);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem(ZOOM_STORAGE_KEY, zoom);
  }, [zoom]);
  const [guideRole, setGuideRole] = useState<'manager' | 'member'>(() => {
    if (typeof window === 'undefined') return 'member';
    const cached = window.localStorage.getItem('report-agent.guide-role');
    return cached === 'manager' ? 'manager' : 'member';
  });

  const hasTeamWorkspace = useMemo(() => {
    if (!userId) return false;
    return teams.some((t) => {
      const role = t.myRole ?? (t.leaderUserId === userId ? 'leader' : undefined);
      return !!role;
    });
  }, [teams, userId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('report-agent.guide-role', guideRole);
  }, [guideRole]);

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
  }, [activeTab, setActiveTab]);

  // 切换离开“周报”标签时，重置编辑态，避免再次回到周报时直接落在创建页
  useEffect(() => {
    if (activeTab === 'report' || !showReportEditor) return;
    setShowReportEditor(false);
    setSelectedReportId(null);
  }, [activeTab, setSelectedReportId, setShowReportEditor, showReportEditor]);

  const tabItems = useMemo(() => {
    const items = [
      { key: 'report', label: '周报', icon: <FileText size={14} /> },
    ];
    if (hasTeamWorkspace) {
      items.push({ key: 'team', label: '团队', icon: <Users size={14} /> });
    }
    items.push({ key: 'settings', label: '设置', icon: <Settings size={14} /> });
    return items;
  }, [hasTeamWorkspace]);

  const usageGuideActions = (
    <div className="flex items-center gap-2">
      <ZoomControl value={zoom} onChange={setZoom} />
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setShowUsageGuide((prev) => !prev);
        }}
        className="whitespace-nowrap"
      >
        <HelpCircle size={13} />
        使用指引
      </Button>
    </div>
  );

  // Resolve current tab — default to 'report' if current tab not in items
  const currentTab = tabItems.find((t) => t.key === activeTab) ? activeTab : 'report';

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <TabBar
        items={tabItems}
        activeKey={currentTab}
        onChange={(key) => {
          setActiveTab(key as typeof activeTab);
        }}
        actions={usageGuideActions}
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
            <MapSpinner size={12} />
            加载中...
          </div>
        </GlassCard>
      )}

      <div
        className="flex-1 min-h-0"
        style={{ zoom: ZOOM_SCALE[zoom] }}
      >
        {currentTab === 'report' && <ReportMainView />}
        {currentTab === 'team' && <TeamDashboard />}
        {currentTab === 'settings' && <SettingsPanel />}
      </div>
      <UsageGuideOverlay
        open={showUsageGuide}
        moduleKey={currentTab as 'report' | 'team' | 'settings'}
        role={guideRole}
        onRoleChange={setGuideRole}
        onClose={() => setShowUsageGuide(false)}
        onSwitchTab={(tab) => setActiveTab(tab)}
        onOpenDailyLog={() => {
          setActiveTab('report');
          window.dispatchEvent(new CustomEvent('report-agent:open-daily-log'));
        }}
        onCreateReport={() => {
          setActiveTab('report');
          setSelectedReportId(null);
          setShowReportEditor(true);
        }}
      />
    </div>
  );
}
