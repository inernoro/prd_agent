import { useEffect, useMemo, useState } from 'react';
import { FileText, Users, Settings, RefreshCw, CalendarCheck } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { GlassCard } from '@/components/design/GlassCard';
import { TabBar } from '@/components/design/TabBar';
import { Button } from '@/components/design/Button';
import { useReportAgentStore } from '@/stores/reportAgentStore';
import { useAuthStore } from '@/stores/authStore';
import { ReportMainView } from './components/ReportMainView';
import { TeamDashboard } from './components/TeamDashboard';
import { SettingsPanel } from './components/SettingsPanel';
import { DailyLogInline } from './components/DailyLogInline';
import { ZoomControl, ZOOM_SCALE, type ZoomLevel } from './components/ZoomControl';
import { ThemeControl, type ColorScheme } from './components/ThemeControl';
import { getMyDefaultTab } from '@/services';
import type { DefaultTabKey } from '@/services/contracts/reportAgent';

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
    teamsLoaded,
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

  // 自定义登录页偏好仅在「从外部进入」时应用一次：
  //   - 用户在周报 Agent 内部 navigate（如打开周报详情子路由 → back 回来）：保持当前 tab，不强制跳转
  //   - 用户从其他 Agent / 首页 / 直接刷新进入 `/report-agent`：应用偏好
  // 用 sessionStorage 标记本次浏览会话已经登录过周报 Agent，离开 `/report-agent` 主路径（包含所有子路由）时清除。
  // 这样能精确区分「外部进入」与「内部跳转/back」，避免 location.key 每次 navigate 变化导致的误触发。
  const [defaultTabPref, setDefaultTabPref] = useState<DefaultTabKey | null | undefined>(undefined);
  useEffect(() => {
    void (async () => {
      const res = await getMyDefaultTab();
      if (res.success && res.data) {
        setDefaultTabPref(res.data.tab ?? null);
      } else {
        setDefaultTabPref(null);
      }
    })();
  }, []);
  useEffect(() => {
    if (!teamsLoaded) return;
    if (defaultTabPref === undefined) return; // 等偏好拉完
    if (typeof window === 'undefined') return;
    const SESSION_KEY = 'report-agent:session-landed';
    const landed = window.sessionStorage.getItem(SESSION_KEY) === '1';
    if (landed) return; // 本会话已经登录过周报 Agent，保持当前 tab（处理子路由 back 等内部跳转）
    window.sessionStorage.setItem(SESSION_KEY, '1');
    if (defaultTabPref) {
      setActiveTab(defaultTabPref);
    } else {
      setActiveTab(hasTeamWorkspace ? 'team' : 'report');
    }
  }, [teamsLoaded, hasTeamWorkspace, setActiveTab, defaultTabPref]);

  // 离开周报 Agent（包括所有子路由 `/report-agent/*`）时清除会话标记，
  // 这样用户从其他 Agent 切回来才会再次被视为「外部进入」并应用偏好。
  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      // unmount 时 react-router 已切到新 location；只有真正离开 /report-agent 主路径或子路由时才清除。
      // 用 `=== '/report-agent' || startsWith('/report-agent/')` 严格匹配，避免 /report-agent2 等假阳性命中。
      const pn = window.location.pathname;
      const stillInReportAgent = pn === '/report-agent' || pn.startsWith('/report-agent/');
      if (!stillInReportAgent) {
        window.sessionStorage.removeItem('report-agent:session-landed');
      }
    };
  }, []);

  // 兼容旧 tab key —— 如果用户通过外部导航到旧 tab, 映射到新 tab
  useEffect(() => {
    const oldToNew: Record<string, string> = {
      'my-reports': 'report',
      'daily-log': 'dailyLog',
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
      { key: 'dailyLog', label: '日常记录', icon: <CalendarCheck size={14} /> },
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
        {currentTab === 'dailyLog' && <DailyLogInline />}
        {currentTab === 'report' && <ReportMainView />}
        {currentTab === 'team' && <TeamDashboard />}
        {currentTab === 'settings' && <SettingsPanel />}
      </div>
    </div>
  );
}
