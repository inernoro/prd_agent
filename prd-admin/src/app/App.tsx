import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { initializeTheme } from '@/stores/themeStore';
import AppShell from '@/layouts/AppShell';
import { getAdminAuthzMe, getAdminMenuCatalog } from '@/services';
import { ToastContainer } from '@/components/ui/Toast';
import { AgentSwitcherProvider } from '@/components/agent-switcher';
import { BranchBadge } from '@/components/BranchBadge';
import { NavigationProgressBar } from '@/components/effects/NavigationProgressBar';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { SuspenseVideoLoader } from '@/components/ui/VideoLoader';

/**
 * NavigationBridge — Exposes React Router's navigate() to non-React code.
 *
 * CDS Widget's Page Agent Bridge needs to trigger SPA navigation from outside React.
 * This component listens for a custom DOM event and calls navigate() internally.
 *
 * Usage from Widget (or any non-React JS):
 *   window.dispatchEvent(new CustomEvent('bridge:navigate', { detail: { path: '/report-agent' } }));
 */
function NavigationBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent).detail?.path;
      if (path && typeof path === 'string') {
        navigate(path);
      }
    };
    window.addEventListener('bridge:navigate', handler);
    return () => window.removeEventListener('bridge:navigate', handler);
  }, [navigate]);
  return null;
}

// ── Route-level lazy loading ──
// Each page is loaded on-demand, drastically reducing initial bundle in dev mode.
// Default exports use lazy() directly; named exports use .then() to re-export as default.
const LoginPage = lazy(() => import('@/pages/LoginPage'));
const UsersPage = lazy(() => import('@/pages/UsersPage'));
const ModelManageTabsPage = lazy(() => import('@/pages/ModelManageTabsPage').then(m => ({ default: m.ModelManageTabsPage })));
const LlmLogsPage = lazy(() => import('@/pages/LlmLogsPage'));
const LabPage = lazy(() => import('@/pages/LabPage'));
const SkillsPage = lazy(() => import('@/pages/SkillsPage'));
const AssetsManagePage = lazy(() => import('@/pages/AssetsManagePage'));
const VisualAgentFullscreenPage = lazy(() => import('@/pages/visual-agent/VisualAgentFullscreenPage'));
const LiteraryAgentWorkspaceListPage = lazy(() => import('@/pages/literary-agent').then(m => ({ default: m.LiteraryAgentWorkspaceListPage })));
const LiteraryAgentEditorPageWrapper = lazy(() => import('@/pages/literary-agent').then(m => ({ default: m.LiteraryAgentEditorPageWrapper })));
const DefectAgentPage = lazy(() => import('@/pages/defect-agent').then(m => ({ default: m.DefectAgentPage })));
const VideoAgentPage = lazy(() => import('@/pages/video-agent').then(m => ({ default: m.VideoAgentPage })));
const ReportAgentPage = lazy(() => import('@/pages/report-agent').then(m => ({ default: m.ReportAgentPage })));
const ReportDetailPage = lazy(() => import('@/pages/report-agent').then(m => ({ default: m.ReportDetailPage })));
const TranscriptAgentPage = lazy(() => import('@/pages/transcript-agent').then(m => ({ default: m.TranscriptAgentPage })));
const ShortcutsPage = lazy(() => import('@/pages/shortcuts-agent').then(m => ({ default: m.ShortcutsPage })));
const ShortcutInstallPage = lazy(() => import('@/pages/shortcuts-agent').then(m => ({ default: m.ShortcutInstallPage })));
const WorkflowListPage = lazy(() => import('@/pages/workflow-agent').then(m => ({ default: m.WorkflowListPage })));
const WorkflowEditorPage = lazy(() => import('@/pages/workflow-agent').then(m => ({ default: m.WorkflowEditorPage })));
const WorkflowCanvasPage = lazy(() => import('@/pages/workflow-agent').then(m => ({ default: m.WorkflowCanvasPage })));
const MarketplacePage = lazy(() => import('@/pages/marketplace').then(m => ({ default: m.MarketplacePage })));
const DocumentStorePage = lazy(() => import('@/pages/document-store').then(m => ({ default: m.DocumentStorePage })));
const LibraryLandingPage = lazy(() => import('@/pages/library/LibraryLandingPage').then(m => ({ default: m.LibraryLandingPage })));
const LibraryStoreDetailPage = lazy(() => import('@/pages/library/LibraryStoreDetailPage').then(m => ({ default: m.LibraryStoreDetailPage })));
const EmergenceExplorerPage = lazy(() => import('@/pages/emergence').then(m => ({ default: m.EmergenceExplorerPage })));
const ChangelogPage = lazy(() => import('@/pages/changelog/ChangelogPage'));
const SkillAgentPage = lazy(() => import('@/pages/SkillAgentPage'));
const AiToolboxPage = lazy(() => import('@/pages/ai-toolbox').then(m => ({ default: m.AiToolboxPage })));
const SharedConversation = lazy(() => import('@/pages/ai-toolbox/SharedConversation').then(m => ({ default: m.SharedConversation })));
const ArenaPage = lazy(() => import('@/pages/arena/ArenaPage').then(m => ({ default: m.ArenaPage })));
const ReviewAgentPage = lazy(() => import('@/pages/review-agent').then(m => ({ default: m.ReviewAgentPage })));
const ReviewAgentSubmitPage = lazy(() => import('@/pages/review-agent').then(m => ({ default: m.ReviewAgentSubmitPage })));
const ReviewAgentResultPage = lazy(() => import('@/pages/review-agent').then(m => ({ default: m.ReviewAgentResultPage })));
const ReviewAgentAllPage = lazy(() => import('@/pages/review-agent').then(m => ({ default: m.ReviewAgentAllPage })));
const PrReviewPage = lazy(() => import('@/pages/pr-review').then(m => ({ default: m.PrReviewPage })));
const LandingPage = lazy(() => import('@/pages/home').then(m => ({ default: m.LandingPage })));
const OpenPlatformTabsPage = lazy(() => import('@/pages/OpenPlatformTabsPage'));
const AutomationRulesPage = lazy(() => import('@/pages/AutomationRulesPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const DataTransferPage = lazy(() => import('@/pages/DataTransferPage'));
const WebPagesPage = lazy(() => import('@/pages/WebPagesPage'));
const ShareViewPage = lazy(() => import('@/pages/ShareViewPage'));
const PublicProfilePage = lazy(() => import('@/pages/PublicProfilePage'));
const ReportTeamShareViewPage = lazy(() => import('@/pages/ReportTeamShareViewPage'));
const ExecutiveDashboardPage = lazy(() => import('@/pages/ExecutiveDashboardPage'));
// 注：PrdAgentTabsPage 仅供桌面端使用，Web 端路由已下线
const AgentLauncherPage = lazy(() => import('@/pages/AgentLauncherPage'));
const WeeklyPosterWizardPage = lazy(() => import('@/pages/weekly-poster/WeeklyPosterWizardPage'));
const WeeklyPosterEditorPage = lazy(() => import('@/pages/weekly-poster/WeeklyPosterEditorPage'));
const MobileHomePage = lazy(() => import('@/pages/MobileHomePage'));
const MobileAssetsPage = lazy(() => import('@/pages/MobileAssetsPage'));
const DesktopAssetsPage = lazy(() => import('@/pages/DesktopAssetsPage'));
const MobileProfilePage = lazy(() => import('@/pages/MobileProfilePage'));
const MobileNotificationsPage = lazy(() => import('@/pages/MobileNotificationsPage'));
const PortfolioShowcasePage = lazy(() => import('@/pages/PortfolioShowcasePage'));
const RichComposerLab = lazy(() => import('@/pages/_dev/RichComposerLab'));
const MobileAuditPage = lazy(() => import('@/pages/_dev/MobileAuditPage'));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();
  if (!isAuthenticated) {
    // 兼容 hash URL：如 /#/transcript-agent → 提取 /transcript-agent 作为 returnUrl
    const hashPath = window.location.hash?.replace(/^#/, '') || '';
    if (hashPath && hashPath !== '/') {
      return <Navigate to={`/login?returnUrl=${encodeURIComponent(hashPath)}`} replace />;
    }
    // 根路径未登录 → 展示公开首页；其他受保护路由 → 跳转登录页
    if (location.pathname === '/') {
      return <Navigate to="/home" replace />;
    }
    const returnUrl = location.pathname + location.search;
    return <Navigate to={`/login?returnUrl=${encodeURIComponent(returnUrl)}`} replace />;
  }
  return <>{children}</>;
}

function RequirePermission({ perm, children }: { perm: string; children: React.ReactNode }) {
  const perms = useAuthStore((s) => s.permissions);
  const loaded = useAuthStore((s) => s.permissionsLoaded);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();

  if (!loaded) {
    return <SuspenseVideoLoader />;
  }

  const has = Array.isArray(perms) && perms.includes(perm);
  if (!has) {
    return (
      <div className="h-full w-full flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="text-center">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            无权限访问
          </div>
          <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            缺少权限：{perm}
          </div>
          <button
            onClick={() => { logout(); navigate('/login', { replace: true }); }}
            className="mt-4 px-4 py-2 text-sm rounded-md transition-colors"
            style={{
              background: 'var(--bg-elevated)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-default)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--bg-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--bg-elevated)';
            }}
          >
            退出登录
          </button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

/** 首页路由：移动端渲染 MobileHomePage，桌面端渲染 Agent 选择页。
 *  首页与总裁面板是独立路由，互不干扰。 */
function IndexPage() {
  const loaded = useAuthStore((s) => s.permissionsLoaded);
  const { isMobile } = useBreakpoint();
  if (!loaded) return null;
  if (isMobile) return <MobileHomePage />;
  return <AgentLauncherPage />;
}

/** 我的资产路由：移动端使用 MobileAssetsPage，桌面端使用增强版 DesktopAssetsPage。 */
function MyAssetsPage() {
  const { isMobile } = useBreakpoint();
  if (isMobile) return <MobileAssetsPage />;
  return <DesktopAssetsPage />;
}

/** /executive 路由：独立的总裁面板，不与首页绑定。 */
function ExecutivePage() {
  return <ExecutiveDashboardPage />;
}

export default function App() {
  // 显式订阅 location 变化，确保 <Routes> 在路由切换时一定重新匹配。
  // 根因：ReactFlow (@xyflow/react) 内部有 53+ 个 zustand useSyncExternalStore 订阅，
  // 在 React 18 并发模式下，大量同步 store 更新可能导致 <Routes> 内部的 location
  // 订阅被调度器跳过。显式传递 location prop 让 <Routes> 不依赖内部订阅。
  const location = useLocation();

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const setPermissions = useAuthStore((s) => s.setPermissions);
  const permissionsLoaded = useAuthStore((s) => s.permissionsLoaded);
  const setPermissionsLoaded = useAuthStore((s) => s.setPermissionsLoaded);
  const setIsRoot = useAuthStore((s) => s.setIsRoot);
  const setCdnBaseUrl = useAuthStore((s) => s.setCdnBaseUrl);
  const setPermFingerprint = useAuthStore((s) => s.setPermFingerprint);
  const setMenuCatalog = useAuthStore((s) => s.setMenuCatalog);
  const menuCatalogLoaded = useAuthStore((s) => s.menuCatalogLoaded);
  const logout = useAuthStore((s) => s.logout);

  // 初始化主题（应用启动时立即执行）
  useEffect(() => {
    initializeTheme();
  }, []);

  // 刷新/回到主页时补齐权限（避免"持久化 token 但 permissions 为空"导致误判）
  // cdnBaseUrl 每次都刷新（后端切换存储 Provider 后域名会变）
  useEffect(() => {
    if (!isAuthenticated) return;
    (async () => {
      const res = await getAdminAuthzMe();
      if (!res.success) {
        // 仅 UNAUTHORIZED 才注销；网络中断/服务不可用不应导致注销
        // apiClient 已在 401 响应时处理了 logout+跳转，这里只作兜底
        const code = res.error?.code;
        if (!code || code === 'UNAUTHORIZED') {
          logout();
        }
        return;
      }
      if (!permissionsLoaded) {
        setPermissions(res.data.effectivePermissions || []);
        setIsRoot(res.data.isRoot ?? false);
        setPermissionsLoaded(true);
      }
      if (res.data.cdnBaseUrl) setCdnBaseUrl(res.data.cdnBaseUrl);
      if (res.data.permissionFingerprint) setPermFingerprint(res.data.permissionFingerprint);
    })();
  }, [isAuthenticated, permissionsLoaded, setPermissions, setPermissionsLoaded, setIsRoot, setCdnBaseUrl, setPermFingerprint, logout]);

  // 加载菜单目录
  useEffect(() => {
    if (!isAuthenticated) return;
    if (menuCatalogLoaded) return;
    (async () => {
      const res = await getAdminMenuCatalog();
      if (res.success && res.data?.items) {
        setMenuCatalog(res.data.items);
      }
    })();
  }, [isAuthenticated, menuCatalogLoaded, setMenuCatalog]);

  return (
    <AgentSwitcherProvider>
      <ToastContainer />
      <BranchBadge />
      <NavigationBridge />
      {/* 路由切换顶栏进度条：绕过 Suspense transition 语义，立刻给用户视觉反馈 */}
      <NavigationProgressBar />
      <Suspense fallback={<SuspenseVideoLoader />}>
      <Routes location={location}>
        {/* Landing page - public · 用透明 fallback，避免 MAP 闪屏打断朦胧动效节奏 */}
        <Route path="/home" element={
          <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#030306' }} />}>
            <LandingPage />
          </Suspense>
        } />

        <Route path="/login" element={<LoginPage />} />

        {/* 公开分享页面 - 无需登录 */}
        <Route path="/s/wp/:token" element={<ShareViewPage />} />
        <Route path="/s/shortcut/:id" element={<ShortcutInstallPage />} />
        <Route path="/shared/toolbox/:shareId" element={<SharedConversation />} />
        {/* 个人公开主页 - 聚合展示用户公开的托管网页 */}
        <Route path="/u/:username" element={<PublicProfilePage />} />

        {/* 团队周报分享页面 - 需登录，团队成员免密码，非成员需密码 */}
        <Route path="/s/report-team/:token" element={<ReportTeamShareViewPage />} />

        {/* 开发试验场 - 无需权限 */}
        <Route path="/_dev/rich-composer-lab" element={<RichComposerLab />} />
        <Route path="/_dev/mobile-audit" element={<MobileAuditPage />} />

        {/* 智识殿堂 - 独立全屏页面（实验性 claymorphism 风格），不使用 AppShell 布局 */}
        <Route path="/library" element={<LibraryLandingPage />} />
        <Route path="/library/:storeId" element={<LibraryStoreDetailPage />} />

        {/* 视觉创作 Agent - 独立全屏页面，不使用 AppShell 布局 */}
        <Route
          path="/visual-agent"
          element={
            <RequireAuth>
              <RequirePermission perm="visual-agent.use">
                <VisualAgentFullscreenPage />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/visual-agent/:workspaceId"
          element={
            <RequireAuth>
              <RequirePermission perm="visual-agent.use">
                <VisualAgentFullscreenPage />
              </RequirePermission>
            </RequireAuth>
          }
        />
        {/* 兼容旧路由 */}
        <Route
          path="/visual-agent-fullscreen"
          element={
            <RequireAuth>
              <RequirePermission perm="visual-agent.use">
                <VisualAgentFullscreenPage />
              </RequirePermission>
            </RequireAuth>
          }
        />
        <Route
          path="/visual-agent-fullscreen/:workspaceId"
          element={
            <RequireAuth>
              <RequirePermission perm="visual-agent.use">
                <VisualAgentFullscreenPage />
              </RequirePermission>
            </RequireAuth>
          }
        />


        {/* 作品广场 - 独立全屏页面 */}
        <Route
          path="/showcase"
          element={
            <RequireAuth>
              <RequirePermission perm="access">
                <PortfolioShowcasePage />
              </RequirePermission>
            </RequireAuth>
          }
        />

        {/* 工作流画布 - 独立全屏页面（ReactFlow 的 zustand 会干扰 AppShell 的 Outlet 路由更新） */}
        <Route
          path="/workflow-agent/:workflowId/canvas"
          element={
            <RequireAuth>
              <RequirePermission perm="workflow-agent.use">
                <WorkflowCanvasPage />
              </RequirePermission>
            </RequireAuth>
          }
        />

      <Route
        path="/"
        element={
          <RequireAuth>
            <RequirePermission perm="access">
              <AppShell />
            </RequirePermission>
          </RequireAuth>
        }
      >
        <Route index element={<IndexPage />} />
        <Route path="agent-launcher" element={<AgentLauncherPage />} />
        <Route path="users" element={<RequirePermission perm="users.read"><UsersPage /></RequirePermission>} />
        <Route path="mds" element={<RequirePermission perm="mds.read"><ModelManageTabsPage /></RequirePermission>} />
        {/* PRD 解读智能体 Web 端已下线，老书签 / 误链接重定向回首页 */}
        <Route path="prd-agent" element={<Navigate to="/" replace />} />
        <Route path="prd-agent/*" element={<Navigate to="/" replace />} />
        <Route path="literary-agent" element={<RequirePermission perm="literary-agent.use"><LiteraryAgentWorkspaceListPage /></RequirePermission>} />
        <Route path="literary-agent/:workspaceId" element={<RequirePermission perm="literary-agent.use"><LiteraryAgentEditorPageWrapper /></RequirePermission>} />
        <Route path="review-agent" element={<RequirePermission perm="review-agent.use"><ReviewAgentPage /></RequirePermission>} />
        <Route path="review-agent/submit" element={<RequirePermission perm="review-agent.use"><ReviewAgentSubmitPage /></RequirePermission>} />
        <Route path="review-agent/submissions/:id" element={<RequirePermission perm="review-agent.use"><ReviewAgentResultPage /></RequirePermission>} />
        <Route path="review-agent/all" element={<RequirePermission perm="review-agent.view-all"><ReviewAgentAllPage /></RequirePermission>} />
        <Route path="pr-review" element={<RequirePermission perm="pr-review.use"><PrReviewPage /></RequirePermission>} />
        <Route path="defect-agent" element={<RequirePermission perm="defect-agent.use"><DefectAgentPage /></RequirePermission>} />
        <Route path="video-agent" element={<RequirePermission perm="video-agent.use"><VideoAgentPage /></RequirePermission>} />
        <Route path="report-agent" element={<RequirePermission perm="report-agent.use"><ReportAgentPage /></RequirePermission>} />
        <Route path="report-agent/report/:reportId" element={<RequirePermission perm="report-agent.use"><ReportDetailPage /></RequirePermission>} />
        <Route path="transcript-agent" element={<RequirePermission perm="transcript-agent.use"><TranscriptAgentPage /></RequirePermission>} />
        <Route path="shortcuts-agent" element={<RequirePermission perm="access"><ShortcutsPage /></RequirePermission>} />
        <Route path="workflow-agent" element={<RequirePermission perm="workflow-agent.use"><WorkflowListPage /></RequirePermission>} />
        <Route path="workflow-agent/:workflowId" element={<RequirePermission perm="workflow-agent.use"><WorkflowEditorPage /></RequirePermission>} />
        <Route path="ai-toolbox" element={<RequirePermission perm="ai-toolbox.use"><AiToolboxPage /></RequirePermission>} />
        <Route path="logs" element={<RequirePermission perm="logs.read"><LlmLogsPage /></RequirePermission>} />
        <Route path="open-platform" element={<RequirePermission perm="open-platform.manage"><OpenPlatformTabsPage /></RequirePermission>} />
        <Route path="automations" element={<RequirePermission perm="automations.manage"><AutomationRulesPage /></RequirePermission>} />
        <Route path="assets" element={<RequirePermission perm="assets.read"><AssetsManagePage /></RequirePermission>} />
        <Route path="skills" element={<RequirePermission perm="skills.read"><SkillsPage /></RequirePermission>} />
        <Route path="web-pages" element={<RequirePermission perm="web-pages.read"><WebPagesPage /></RequirePermission>} />
        <Route path="marketplace" element={<RequirePermission perm="access"><MarketplacePage /></RequirePermission>} />
        <Route path="document-store" element={<RequirePermission perm="access"><DocumentStorePage /></RequirePermission>} />
        <Route path="emergence" element={<RequirePermission perm="emergence-agent.use"><EmergenceExplorerPage /></RequirePermission>} />
        <Route path="changelog" element={<RequirePermission perm="access"><ChangelogPage /></RequirePermission>} />
        <Route path="weekly-poster" element={<RequirePermission perm="report-agent.template.manage"><WeeklyPosterWizardPage /></RequirePermission>} />
        <Route path="weekly-poster/advanced" element={<RequirePermission perm="report-agent.template.manage"><WeeklyPosterEditorPage /></RequirePermission>} />
        <Route path="skill-agent" element={<RequirePermission perm="access"><SkillAgentPage /></RequirePermission>} />
        <Route path="arena" element={<RequirePermission perm="arena-agent.use"><ArenaPage /></RequirePermission>} />
        <Route path="lab" element={<RequirePermission perm="lab.read"><LabPage /></RequirePermission>} />
        <Route path="settings" element={<RequirePermission perm="access"><SettingsPage /></RequirePermission>} />
        <Route path="data-transfers" element={<RequirePermission perm="access"><DataTransferPage /></RequirePermission>} />
        <Route path="executive" element={<RequirePermission perm="access"><ExecutivePage /></RequirePermission>} />
        {/* 我的资产：桌面端/移动端自动切换 */}
        <Route path="my-assets" element={<RequirePermission perm="access"><MyAssetsPage /></RequirePermission>} />
        {/* 移动端专属路由 */}
        <Route path="profile" element={<RequirePermission perm="access"><MobileProfilePage /></RequirePermission>} />
        <Route path="notifications" element={<RequirePermission perm="access"><MobileNotificationsPage /></RequirePermission>} />
        <Route path="stats" element={<Navigate to="/" replace />} />
      </Route>

        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
      </Suspense>
    </AgentSwitcherProvider>
  );
}
