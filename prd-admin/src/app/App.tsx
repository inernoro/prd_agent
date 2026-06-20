import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { initializeTheme } from '@/stores/themeStore';
import AppShell from '@/layouts/AppShell';
import { TipsDrawer } from '@/components/daily-tips/TipsDrawer';
import { SpotlightOverlay } from '@/components/daily-tips/SpotlightOverlay';
import { SkillShareDialog } from '@/components/marketplace/SkillShareDialog';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { getAdminAuthzMe, getAdminMenuCatalog } from '@/services';
import { ToastContainer } from '@/components/ui/Toast';
import { AgentSwitcherProvider } from '@/components/agent-switcher';
import { BranchBadge } from '@/components/BranchBadge';
import { NavigationProgressBar } from '@/components/effects/NavigationProgressBar';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { SuspenseVideoLoader } from '@/components/ui/VideoLoader';
import { RequireAuth, RequirePermission } from '@/app/RouteGuards';
import { NAV_REGISTRY } from '@/app/navRegistry';
import { initBehaviorTracker, trackRouteChange } from '@/lib/behaviorTracker';

/**
 * BehaviorTrackerMount — 行为信号采集（行为洞察面板的数据来源）。
 * 挂在 Router 内、Routes 外：记录全站路由停留/跳转，登录后才上报。
 */
function BehaviorTrackerMount() {
  const location = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  useEffect(() => {
    initBehaviorTracker();
  }, []);
  useEffect(() => {
    if (isAuthenticated) trackRouteChange(location.pathname);
  }, [location.pathname, isAuthenticated]);
  return null;
}

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

// ── 仅 App.tsx 直接需要的路由 lazy 加载 ──
//
// 注：NAV_REGISTRY 接管的页面（智能体 / 百宝箱 / 实用工具 / 基础设施）
// 已在 navRegistry.tsx 内 lazy 引入。本文件只保留：
//   1. 顶层路由（login / share / dev / fullscreen 非 nav）
//   2. AppShell 内但不进 launcher 的路由（admin 后端菜单 / 移动端 / 子路由）
//   3. 子路由专用组件（如 LiteraryAgentEditorPageWrapper / WorkflowEditorPage 等）
const LoginPage = lazy(() => import('@/pages/LoginPage'));
const InlineCommentBubbleMockupPage = lazy(() => import('@/pages/_mockup/InlineCommentBubbleMockupPage'));
const InlineCommentOverlayProbe = lazy(() => import('@/pages/_mockup/InlineCommentOverlayProbe'));
const JoinTeamPage = lazy(() => import('@/pages/JoinTeamPage'));
const ShareViewPage = lazy(() => import('@/pages/ShareViewPage'));
const ShortLinkRouter = lazy(() => import('@/pages/ShortLinkRouter'));
const PublicProfilePage = lazy(() => import('@/pages/PublicProfilePage'));
const ReportTeamShareViewPage = lazy(() => import('@/pages/ReportTeamShareViewPage'));
const ShareLinkTesterPage = lazy(() => import('@/pages/labs/ShareLinkTesterPage'));
const LiquidGlassDemoPage = lazy(() => import('@/pages/labs/LiquidGlassDemoPage'));
const MySharesPage = lazy(() => import('@/pages/labs/MySharesPage'));
const SkillShareViewPage = lazy(() => import('@/pages/SkillShareViewPage'));
const SharedConversation = lazy(() => import('@/pages/ai-toolbox/SharedConversation').then(m => ({ default: m.SharedConversation })));
const ShortcutInstallPage = lazy(() => import('@/pages/shortcuts-agent').then(m => ({ default: m.ShortcutInstallPage })));
const LandingPage = lazy(() => import('@/pages/home').then(m => ({ default: m.LandingPage })));
const RichComposerLab = lazy(() => import('@/pages/_dev/RichComposerLab'));
const StreamingTextLab = lazy(() => import('@/pages/_dev/StreamingTextLab'));
const MobileAuditPage = lazy(() => import('@/pages/_dev/MobileAuditPage'));
const PortfolioShowcasePage = lazy(() => import('@/pages/PortfolioShowcasePage'));

// 全屏路由的子路由组件（NAV_REGISTRY 已注册了主路由，这些是 sub-route 专用）
const VisualAgentFullscreenPage = lazy(() => import('@/pages/visual-agent/VisualAgentFullscreenPage'));
const LibraryStoreDetailPage = lazy(() => import('@/pages/library/LibraryStoreDetailPage').then(m => ({ default: m.LibraryStoreDetailPage })));
const LibraryShareViewPage = lazy(() => import('@/pages/library/LibraryShareViewPage').then(m => ({ default: m.LibraryShareViewPage })));
const WorkflowCanvasPage = lazy(() => import('@/pages/workflow-agent').then(m => ({ default: m.WorkflowCanvasPage })));
const WorkflowEditorPage = lazy(() => import('@/pages/workflow-agent').then(m => ({ default: m.WorkflowEditorPage })));
const LiteraryAgentEditorPageWrapper = lazy(() => import('@/pages/literary-agent').then(m => ({ default: m.LiteraryAgentEditorPageWrapper })));
const ReportDetailPage = lazy(() => import('@/pages/report-agent').then(m => ({ default: m.ReportDetailPage })));
const ReviewAgentSubmitPage = lazy(() => import('@/pages/review-agent').then(m => ({ default: m.ReviewAgentSubmitPage })));
const ReviewAgentResultPage = lazy(() => import('@/pages/review-agent').then(m => ({ default: m.ReviewAgentResultPage })));
const ReviewAgentAllPage = lazy(() => import('@/pages/review-agent').then(m => ({ default: m.ReviewAgentAllPage })));
const WeeklyPosterWizardPage = lazy(() => import('@/pages/weekly-poster/WeeklyPosterWizardPage'));
const WeeklyPosterEditorPage = lazy(() => import('@/pages/weekly-poster/WeeklyPosterEditorPage'));

// 后端 menuCatalog 注册的路由（admin 类，不进 launcher，保留 JSX）
const AiToolboxPage = lazy(() => import('@/pages/ai-toolbox').then(m => ({ default: m.AiToolboxPage })));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const DataTransferPage = lazy(() => import('@/pages/DataTransferPage'));
const SkillsPage = lazy(() => import('@/pages/SkillsPage'));
const AssetsManagePage = lazy(() => import('@/pages/AssetsManagePage'));
const PosterDesignerPage = lazy(() => import('@/pages/weekly-poster/PosterDesignerPage'));
const ExecutiveDashboardPage = lazy(() => import('@/pages/ExecutiveDashboardPage'));

// 移动端入口
const MobileHomePage = lazy(() => import('@/pages/MobileHomePage'));
const MobileProfilePage = lazy(() => import('@/pages/MobileProfilePage'));
const MobileNotificationsPage = lazy(() => import('@/pages/MobileNotificationsPage'));

// 首页 Agent Launcher（既是 / 的 IndexPage，也是 /agent-launcher 的目标）
const AgentLauncherPage = lazy(() => import('@/pages/AgentLauncherPage'));

/** 首页路由：移动端渲染 MobileHomePage，桌面端渲染 Agent 选择页。 */
function IndexPage() {
  const loaded = useAuthStore((s) => s.permissionsLoaded);
  const { isMobile } = useBreakpoint();
  if (!loaded) return null;
  if (isMobile) return <MobileHomePage />;
  return <AgentLauncherPage />;
}

/** /executive 路由：独立的总裁面板。 */
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

  // 教程数据预加载:与 TipsDrawer 的条件挂载解耦。TipsDrawer 在 /home/login 等页不挂载,
  // 若只靠它 load(),用户停在登录后默认落地页 /home 时 tips 不会预拉,等导航到第一个有教程的
  // 页面才 mount→异步 fetch→才能强制开讲,造成「人已经在操作了教程才弹」的延迟(Bugbot)。
  // 这里在登录后无条件预拉一次(load 内部按 loaded 幂等),保证进任意教程页时数据已就绪。
  const loadTips = useDailyTipsStore((s) => s.load);
  const tipsLoaded = useDailyTipsStore((s) => s.loaded);
  useEffect(() => {
    if (isAuthenticated && !tipsLoaded) void loadTips();
  }, [isAuthenticated, tipsLoaded, loadTips]);

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
      <BehaviorTrackerMount />
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

        {/* 静态 mockup（无需登录），仅供评审样式 */}
        <Route path="/_mockup/inline-comment-bubble" element={<InlineCommentBubbleMockupPage />} />
        {/* 真实 InlineCommentOverlay 自测页（Playwright 取头像 img 尺寸断言） */}
        <Route path="/_mockup/inline-comment-overlay-probe" element={<InlineCommentOverlayProbe />} />

        {/* 公开分享页面 - 无需登录 */}
        <Route path="/s/wp/:token" element={<ShareViewPage />} />
        <Route path="/s/shortcut/:id" element={<ShortcutInstallPage />} />
        <Route path="/shared/toolbox/:shareId" element={<SharedConversation />} />
        <Route path="/u/:username" element={<PublicProfilePage />} />
        <Route path="/s/report-team/:token" element={<ReportTeamShareViewPage />} />
        <Route path="/s/skill/:token" element={<SkillShareViewPage />} />
        <Route path="/s/lib/:token" element={<LibraryShareViewPage />} />
        {/* 统一短链 /s/{seq}（数字）— 兼容所有分享系统，老链接继续走上方专属路由 */}
        <Route path="/s/:slug" element={<ShortLinkRouter />} />

        {/* 开发试验场 - 无需权限 */}
        <Route path="/_dev/rich-composer-lab" element={<RichComposerLab />} />
        <Route path="/_dev/mobile-audit" element={<MobileAuditPage />} />
        <Route path="/_dev/streaming-text-lab" element={<StreamingTextLab />} />

        {/* ── NAV_REGISTRY 中 placement='fullscreen' 的条目（独立全屏，不进 AppShell） */}
        {/* 教程入口/引导由 App 根挂载的 TipsDrawer + SpotlightOverlay 统一承载（跨全屏路由不丢失）。 */}
        {NAV_REGISTRY.filter((e) => e.placement === 'fullscreen').map((e) => (
          <Route key={e.path} path={e.path} element={e.element} />
        ))}

        {/* 自动加入共享文件夹（邀请链接）：登录后自动加入并跳网页托管 */}
        <Route
          path="/join/:code"
          element={
            <RequireAuth>
              <JoinTeamPage />
            </RequireAuth>
          }
        />

        {/* 子路由：智识殿堂详情 */}
        <Route path="/library/:storeId" element={<LibraryStoreDetailPage />} />

        {/* 子路由：视觉创作 workspace + 旧路径兼容 */}
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

        {/* 工作流画布 - 独立全屏页面（ReactFlow zustand 会干扰 AppShell Outlet） */}
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

        {/* ── NAV_REGISTRY 中 shell（默认）条目：自动渲染所有可定制导航的路由 */}
        {NAV_REGISTRY.filter((e) => !e.placement || e.placement === 'shell').map((e) => (
          <Route
            key={e.path}
            path={e.path.startsWith('/') ? e.path.slice(1) : e.path}
            element={e.element}
          />
        ))}

        {/* PRD 解读智能体 Web 端已下线，老书签 / 误链接重定向回首页 */}
        <Route path="prd-agent" element={<Navigate to="/" replace />} />
        <Route path="prd-agent/*" element={<Navigate to="/" replace />} />

        {/* 子路由（不进导航的内部跳转页） */}
        <Route path="literary-agent/:workspaceId" element={<RequirePermission perm="literary-agent.use"><LiteraryAgentEditorPageWrapper /></RequirePermission>} />
        <Route path="review-agent/submit" element={<RequirePermission perm="review-agent.use"><ReviewAgentSubmitPage /></RequirePermission>} />
        <Route path="review-agent/submissions/:id" element={<RequirePermission perm="review-agent.use"><ReviewAgentResultPage /></RequirePermission>} />
        <Route path="review-agent/all" element={<RequirePermission perm="review-agent.view-all"><ReviewAgentAllPage /></RequirePermission>} />
        <Route path="report-agent/report/:reportId" element={<RequirePermission perm="report-agent.use"><ReportDetailPage /></RequirePermission>} />
        <Route path="workflow-agent/:workflowId" element={<RequirePermission perm="workflow-agent.use"><WorkflowEditorPage /></RequirePermission>} />
        <Route path="weekly-poster/wizard" element={<RequirePermission perm="report-agent.template.manage"><WeeklyPosterWizardPage /></RequirePermission>} />
        <Route path="weekly-poster/advanced" element={<RequirePermission perm="report-agent.template.manage"><WeeklyPosterEditorPage /></RequirePermission>} />

        {/* 后端 menuCatalog 注册的路由（admin / 特殊权限页，前端不进 launcher） */}
        <Route path="ai-toolbox" element={<RequirePermission perm="ai-toolbox.use"><AiToolboxPage /></RequirePermission>} />
        <Route path="labs/share-link-tester" element={<ShareLinkTesterPage />} />
        <Route path="labs/liquid-glass" element={<LiquidGlassDemoPage />} />
        <Route path="my/shares" element={<MySharesPage />} />
        {/* open-platform 已移入 NAV_REGISTRY（SSOT），路由由其自动生成 */}
        <Route path="assets" element={<RequirePermission perm="assets.read"><AssetsManagePage /></RequirePermission>} />
        <Route path="skills" element={<RequirePermission perm="skills.read"><SkillsPage /></RequirePermission>} />
        <Route path="weekly-poster" element={<RequirePermission perm="report-agent.template.manage"><PosterDesignerPage /></RequirePermission>} />
        <Route path="data-transfers" element={<RequirePermission perm="access"><DataTransferPage /></RequirePermission>} />
        <Route path="executive" element={<RequirePermission perm="access"><ExecutivePage /></RequirePermission>} />
        <Route path="settings" element={<RequirePermission perm="access"><SettingsPage /></RequirePermission>} />

        {/* 移动端专属路由 */}
        <Route path="profile" element={<RequirePermission perm="access"><MobileProfilePage /></RequirePermission>} />
        <Route path="notifications" element={<RequirePermission perm="access"><MobileNotificationsPage /></RequirePermission>} />
        <Route path="stats" element={<Navigate to="/" replace />} />
      </Route>

        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
      </Suspense>
      {/* 教程入口 + 引导:挂在 App 根(Router 内、Routes 外),全局唯一实例。
          这样跨任意路由(含 shell→全屏编辑器)导航时都不卸载,本页教程能从列表「贯通」进编辑器;
          入口也始终在右上角常驻。
          仅在「登录后的真实应用页」渲染:登录页/落地页/各种分享只读页(/s/、/shared/、/join)、
          开发页(/_dev/)、CDS 终端(/cds-agent)、公开主页(/u/)、智识殿堂公开详情(/library/:storeId)
          一律不挂——这些公开只读页不该冒出内部新手教程(用户 2026-06-02 指出;Codex P2)。
          注意 '/library/' 带尾斜杠:只排除详情子路由,'/library' 落地页(带 library-landing 教程)保留。 */}
      {isAuthenticated
        && location.pathname !== '/home'
        && location.pathname !== '/login'
        && !['/s/', '/shared/', '/join/', '/_dev/', '/cds-agent', '/u/', '/library/'].some((p) => location.pathname.startsWith(p))
        && (
        <>
          <TipsDrawer />
          <SpotlightOverlay />
        </>
      )}
      {/* 技能分享弹窗（全局单例，渲染走 createPortal；无目标时返回 null） */}
      <SkillShareDialog />
    </AgentSwitcherProvider>
  );
}
