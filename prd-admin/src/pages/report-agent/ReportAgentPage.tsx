import { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Users, Settings, RefreshCw } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import { ReportMainView } from './components/ReportMainView';
import { TeamDashboard } from './components/TeamDashboard';
import { SettingsPanel } from './components/SettingsPanel';
import { ZoomControl, ZOOM_SCALE, type ZoomLevel } from './components/ZoomControl';
import { ThemeControl, type ColorScheme } from './components/ThemeControl';

const ZOOM_STORAGE_KEY = 'report-agent:zoom';
const COLOR_SCHEME_STORAGE_KEY = 'report-agent:color-scheme';

function readZoomFromStorage(): ZoomLevel {
  if (typeof window === 'undefined') return 'normal';
  const raw = window.sessionStorage.getItem(ZOOM_STORAGE_KEY);
  if (raw === 'large' || raw === 'extra') return raw;
  return 'normal';
}

function readColorSchemeFromStorage(): ColorScheme {
  if (typeof window === 'undefined') return 'dark';
  const raw = window.sessionStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
  return raw === 'light' ? 'light' : 'dark';
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
  const [zoom, setZoom] = useState<ZoomLevel>(readZoomFromStorage);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem(ZOOM_STORAGE_KEY, zoom);
  }, [zoom]);
  const [colorScheme, setColorScheme] = useState<ColorScheme>(readColorSchemeFromStorage);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem(COLOR_SCHEME_STORAGE_KEY, colorScheme);
  }, [colorScheme]);

  // 把 data-theme 同步到 <html>,让 AppShell 的 <main>/body 也进入 scope;
  // 组件卸载或切回暗色时清除,避免污染其他 Agent 页面。
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (colorScheme === 'light') {
      root.setAttribute('data-theme', 'light');
    } else {
      root.removeAttribute('data-theme');
    }
    return () => {
      root.removeAttribute('data-theme');
    };
  }, [colorScheme]);

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

  // 首次进入页面、团队数据加载完成后做一次性默认 Tab 校准:
  // - 用户在任何团队中(含 leader 或成员)→ 默认落在「团队」tab
  // - 没有任何团队成员关系 → 默认「周报」tab
  // 用 ref 标记仅执行一次,避免覆盖用户在会话内主动切换的 tab。
  const tabLandingRef = useRef(false);
  useEffect(() => {
    if (tabLandingRef.current) return;
    if (loading) return; // loadAll 还在跑,等数据稳定
    tabLandingRef.current = true;
    if (hasTeamWorkspace && activeTab === 'report') {
      setActiveTab('team');
    }
  }, [loading, hasTeamWorkspace, activeTab, setActiveTab]);

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
    <div className="flex items-center gap-2 ml-auto">
      <ZoomControl value={zoom} onChange={setZoom} />
      <ThemeControl value={colorScheme} onChange={setColorScheme} />
    </div>
  );

  // Resolve current tab — default to 'report' if current tab not in items
  const currentTab = tabItems.find((t) => t.key === activeTab) ? activeTab : 'report';

  return (
    <div
      className="h-full min-h-0 flex flex-col gap-4"
      data-theme={colorScheme === 'light' ? 'light' : undefined}
      style={{ background: colorScheme === 'light' ? 'var(--bg-base)' : undefined }}
    >
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
    </div>
  );
}
