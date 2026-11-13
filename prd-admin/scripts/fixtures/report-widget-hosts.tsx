// 本地真实组件停靠回归入口；业务响应由配套浏览器脚本提供固定数据。
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Outlet, Route, Routes } from 'react-router-dom';
import ReportAgentPage from '/src/pages/report-agent/ReportAgentPage';
import ReportDetailPage from '/src/pages/report-agent/ReportDetailPage';
import MonthlyReportDetailPage from '/src/pages/report-agent/monthly/MonthlyReportDetailPage';
import ReportTeamShareViewPage from '/src/pages/ReportTeamShareViewPage';
import { ThemeControl } from '/src/pages/report-agent/components/ThemeControl';
import { MobileTabBar } from '/src/components/ui/MobileTabBar';
import { useIsMobile } from '/src/hooks/useBreakpoint';
import { useAuthStore } from '/src/stores/authStore';
import { useReportAgentStore } from '/src/stores/reportAgentStore';
import '/src/styles/tokens.css';
import '/src/styles/tailwind.css';

useAuthStore.setState({ token: 'local-fixture-not-a-real-token', isAuthenticated: true, user: { userId: 'author', username: 'author', displayName: '固定作者', role: 'ADMIN' } });
useReportAgentStore.setState({ teams: [{ id: 'widget-team', name: '预览停靠固定团队', leaderUserId: 'author', myRole: 'leader', createdAt: '2026-11-13', updatedAt: '2026-11-13' }], teamsLoaded: true, activeTab: 'team', loading: false, loadAll: async () => {} });
const agent = '/report-agent?teamId=widget-team&weekYear=2026&weekNumber=46';
function Shell() {
  const mobile = useIsMobile();
  return <><header style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 48, zIndex: 100, background: 'var(--panel-solid)' }}><Link to="/scripts/fixtures/report-widget-hosts.html">退出报告宿主</Link><span> 本地真实报告宿主</span></header><div style={{ height: '100dvh', paddingTop: 48, paddingBottom: mobile ? 60 : 0, boxSizing: 'border-box' }}><main style={{ height: '100%', position: 'relative', marginInline: 8, overflowY: 'auto' }}><Outlet /></main></div>{mobile && <MobileTabBar />}</>;
}

function Landing() {
  return <div style={{ padding: 16 }}><h1>报告宿主停靠回归固定入口</h1><ThemeControl /><p><Link to={agent}>打开团队周报宿主</Link></p><p><Link to={agent}>打开日常记录宿主</Link></p><p><Link to={agent}>打开月报宿主</Link></p><p><Link to="/report-agent/report/widget-weekly">打开独立周报宿主</Link></p><p><Link to="/s/report-team/widget-share">打开团队分享宿主</Link></p></div>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><Routes><Route path="/s/report-team/:token" element={<ReportTeamShareViewPage />} /><Route element={<Shell />}><Route path="/report-agent" element={<ReportAgentPage />} /><Route path="/report-agent/report/:reportId" element={<ReportDetailPage />} /><Route path="/report-agent/monthly/:reportId" element={<MonthlyReportDetailPage />} /><Route path="*" element={<Landing />} /></Route></Routes></BrowserRouter>);
