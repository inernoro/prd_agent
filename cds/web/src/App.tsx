import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { reportDashboardRenderError } from '@/lib/client-diagnostics';
import { CdsLogoLoader } from '@/components/brand/CdsMetallicLogo';

const BranchDetailPage = lazy(() => import('@/pages/BranchDetailPage').then((m) => ({ default: m.BranchDetailPage })));
const BranchListPage = lazy(() => import('@/pages/BranchListPage').then((m) => ({ default: m.BranchListPage })));
const BranchTopologyPage = lazy(() => import('@/pages/BranchTopologyPage').then((m) => ({ default: m.BranchTopologyPage })));
const CdsSettingsPage = lazy(() => import('@/pages/CdsSettingsPage').then((m) => ({ default: m.CdsSettingsPage })));
const HelloPage = lazy(() => import('@/pages/HelloPage').then((m) => ({ default: m.HelloPage })));
const HomePage = lazy(() => import('@/pages/HomePage').then((m) => ({ default: m.HomePage })));
const LoginPage = lazy(() => import('@/pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const PreviewPreparingPage = lazy(() => import('@/pages/PreviewPreparingPage').then((m) => ({ default: m.PreviewPreparingPage })));
const ProjectListPage = lazy(() => import('@/pages/ProjectListPage').then((m) => ({ default: m.ProjectListPage })));
const ProjectSettingsPage = lazy(() => import('@/pages/ProjectSettingsPage').then((m) => ({ default: m.ProjectSettingsPage })));

/**
 * 路由切换时 Suspense fallback。用品牌 logo + 加载文案,跟 CDS 视觉调性一致。
 * 2026-05-28 用户反馈:之前是裸 <div>加载中...</div> 一行小字,丑爆。
 */
function RouteFallback(): JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <CdsLogoLoader size="xl" inline={false} label={<span className="text-sm text-muted-foreground">加载中…</span>} />
    </div>
  );
}

class DashboardErrorBoundary extends Component<{ children: ReactNode }, { message: string | null; isChunkLoad: boolean }> {
  state = { message: null as string | null, isChunkLoad: false };

  static getDerivedStateFromError(error: unknown): { message: string; isChunkLoad: boolean } {
    const message = error instanceof Error ? error.message : String(error);
    return { message, isChunkLoad: isDynamicImportFailure(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the dashboard debuggable without crashing the whole React tree.
    // eslint-disable-next-line no-console
    console.error('[cds-dashboard] render failed', error, info.componentStack);
    reportDashboardRenderError(error, info.componentStack || undefined);
    // 2026-05-28 用户反馈"chunk-load 失败大面板太可怕":
    //   chunk hash 失效是部署后的正常代价,**唯一正确处理是静默自动 reload**。
    //   - 用 5s 冷却而非 60s(失败一次就 reload,不要看到 banner)
    //   - 即使冷却内再次失败,也只显示**右下角小 toast**(见 render 里 isChunkLoad 分支)
    //     绝不在主区域显示红色大面板。
    if (isDynamicImportFailure(error) && shouldAutoReloadAfterChunkFailure()) {
      window.location.reload();
    }
  }

  render(): ReactNode {
    if (!this.state.message) return this.props.children;
    // chunk-load 失败:右下角小 toast(冷却期内的二次失败才会到这里 — 一般用户看不到)
    // 普通 runtime 错误:也走右下角小 toast,绝不占满主区
    // 主区继续渲染 children,让用户能继续操作其他路由
    const isChunkLoad = this.state.isChunkLoad;
    return (
      <>
        {this.props.children}
        <ErrorToastPortal
          message={this.state.message}
          isChunkLoad={isChunkLoad}
          onDismiss={() => this.setState({ message: null, isChunkLoad: false })}
        />
      </>
    );
  }
}

/**
 * 右下角小 toast 错误提示。
 *
 * 2026-05-28 设计意图:用户反馈"右上左下都不行,绝不允许占满主区"。
 * 这里走 createPortal 挂到 document.body,position:fixed 右下角,
 * z-index 99999(toast 顶级层,见 .claude/rules/cds-theme-tokens.md #4)。
 * 双主题适配:用 var(--bg-card) + var(--text-primary) + var(--destructive)
 * 边框,跟主题自动翻转。
 */
function ErrorToastPortal({
  message,
  isChunkLoad,
  onDismiss,
}: {
  message: string;
  isChunkLoad: boolean;
  onDismiss: () => void;
}): JSX.Element | null {
  // chunk-load 错误:5s 后自动消失(冷却期一般会自动 reload,toast 只是兜底)
  // 普通错误:不自动消失,用户点 X 关闭
  useEffect(() => {
    if (!isChunkLoad) return;
    const t = window.setTimeout(onDismiss, 5_000);
    return () => window.clearTimeout(t);
  }, [isChunkLoad, onDismiss]);

  if (typeof document === 'undefined') return null;
  const toast = (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 99999,
        maxWidth: 360,
        background: 'var(--card, #1E1F20)',
        color: 'var(--card-foreground, #e8e8ec)',
        border: '1px solid rgba(220, 38, 38, 0.45)',
        borderRadius: 8,
        padding: '12px 14px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
        fontSize: 13,
        lineHeight: 1.5,
      }}
      role="alert"
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
        <strong style={{ color: 'hsl(var(--destructive))' }}>
          {isChunkLoad ? '前端代码已更新,正在刷新…' : '页面渲染异常'}
        </strong>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭提示"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            cursor: 'pointer',
            opacity: 0.6,
            fontSize: 16,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ opacity: 0.85, marginBottom: 8 }}>
        {isChunkLoad
          ? 'CDS 已部署新版本,旧的页面代码片段已失效。如果几秒后仍未自动刷新,请手动刷新。'
          : '当前操作触发了一个未捕获的错误,主面板已保留。点下方刷新或继续浏览其它页面。'}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            // 2026-05-28: 改走 token 防止白天主题硬编码暗色违反 cds-theme-tokens 规则
            background: 'hsl(var(--destructive))',
            color: 'hsl(var(--destructive-foreground))',
            border: 'none',
            borderRadius: 6,
            padding: '6px 12px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          刷新页面
        </button>
        {!isChunkLoad ? (
          <button
            type="button"
            onClick={onDismiss}
            style={{
              background: 'transparent',
              color: 'inherit',
              border: '1px solid rgba(127,127,127,0.35)',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            继续浏览
          </button>
        ) : null}
      </div>
      <details style={{ marginTop: 8, opacity: 0.55, fontSize: 11 }}>
        <summary style={{ cursor: 'pointer' }}>错误详情</summary>
        <pre style={{ marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto' }}>
          {message}
        </pre>
      </details>
    </div>
  );
  return createPortal(toast, document.body);
}

function isDynamicImportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \d+ failed/i
    .test(message);
}

function shouldAutoReloadAfterChunkFailure(): boolean {
  // 2026-05-28 改:60s → 5s。chunk-load 失败的根因是部署后旧 SPA 引用了
  // 不存在的 chunk hash,reload 加载新 HTML + 新 chunks 后就好。
  // 60s 冷却太长 → 部署当下 5-10s 内必出 reload 风暴误报,误把用户暴露给大红面板。
  // 改 5s 后:正常部署只会 reload 一次(因为 reload 后 SPA 拿到的就是新代码),
  // 5s 内连发两次基本只可能是真的网络问题,这时候 toast 提示就够了。
  const key = 'cds:chunk-load-reload-at';
  const now = Date.now();
  const last = Number(window.sessionStorage.getItem(key) || '0');
  if (Number.isFinite(last) && now - last < 5_000) return false;
  window.sessionStorage.setItem(key, String(now));
  return true;
}

/*
 * Router root for the React-based CDS Dashboard.
 *
 * The Express server (cds/src/server.ts) serves the built React index.html
 * for every non-API dashboard route. React Router owns the page map; legacy
 * static HTML is no longer a runtime fallback.
 *
 * Currently migrated:
 *   /                       CDS marketing/control-plane home
 *   /login                  React basic-auth login page
 *   /preview-preparing      Preview-window handoff loading page
 *   /hello                  Foundation demo page (Tailwind / theme / API / Dialog)
 *   /cds-settings           CDS system settings
 *   /project-list           Project list
 *   /branches/:projectId    Branch list + one-click preview
 *   /branch-list?project=   Back-compat entry to the React branch list
 *   /branch-panel/:branchId Branch detail + logs + single-service actions
 *   /branch-topology        Project service topology
 *   /settings/:projectId    Project settings
 */
export function App(): JSX.Element {
  return (
    <DashboardErrorBoundary>
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/preview-preparing" element={<PreviewPreparingPage />} />
            <Route path="/hello" element={<HelloPage />} />
            <Route path="/cds-settings" element={<CdsSettingsPage />} />
            <Route path="/project-list" element={<ProjectListPage />} />
            <Route path="/branches/:projectId" element={<BranchListPage />} />
            <Route path="/branch-list" element={<BranchListPage />} />
            <Route path="/branch-panel" element={<BranchDetailPage />} />
            <Route path="/branch-panel/:branchId" element={<BranchDetailPage />} />
            <Route path="/branch-topology" element={<BranchTopologyPage />} />
            <Route path="/settings/:projectId" element={<ProjectSettingsPage />} />
            <Route path="*" element={<Navigate to="/project-list" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </DashboardErrorBoundary>
  );
}
