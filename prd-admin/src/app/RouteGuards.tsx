/**
 * 路由守卫（从 App.tsx 提取，供 navRegistry / 其他路由消费方共用）：
 *   - RequireAuth: 未登录跳 /login，记录 returnUrl
 *   - RequirePermission: 缺权限显示提示页 + 退出按钮
 */

import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { SuspenseVideoLoader } from '@/components/ui/VideoLoader';

export function RequireAuth({ children }: { children: React.ReactNode }) {
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

export function RequirePermission({ perm, children }: { perm: string; children: React.ReactNode }) {
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
