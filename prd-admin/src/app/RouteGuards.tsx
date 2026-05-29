/**
 * 路由守卫（从 App.tsx 提取，供 navRegistry / 其他路由消费方共用）：
 *   - RequireAuth: 未登录跳 /login，记录 returnUrl
 *   - RequirePermission: 缺权限时先尝试静默刷新一次 /api/authz/me；仍缺才显示提示页 + 重试/退出按钮
 */

import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { SuspenseVideoLoader } from '@/components/ui/VideoLoader';
import { getAdminAuthzMe } from '@/services';

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

export function RequirePermission({ perm, children }: { perm: string | string[]; children: React.ReactNode }) {
  const perms = useAuthStore((s) => s.permissions);
  const loaded = useAuthStore((s) => s.permissionsLoaded);
  const logout = useAuthStore((s) => s.logout);
  const setPermissions = useAuthStore((s) => s.setPermissions);
  const navigate = useNavigate();

  const [refreshing, setRefreshing] = useState(false);
  // 防止同一次挂载内反复静默刷新（指纹未变时只试一次）
  const silentRefreshTriedRef = useRef(false);

  const required = Array.isArray(perm) ? perm : [perm];
  const has = Array.isArray(perms) && required.some((p) => perms.includes(p));

  // 缺权限时静默尝试一次刷新 /api/authz/me —— 应对「后端刚加了权限但前端 store 还是老快照」场景
  useEffect(() => {
    if (!loaded || has || silentRefreshTriedRef.current || refreshing) return;
    silentRefreshTriedRef.current = true;
    void refreshPermissions(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, has]);

  async function refreshPermissions(silent: boolean) {
    setRefreshing(true);
    try {
      const me = await getAdminAuthzMe();
      if (me.success && me.data) {
        setPermissions(me.data.effectivePermissions || []);
      }
    } catch {
      // best effort，失败就让用户走手动退出登录
      if (!silent) {
        // noop —— 静默失败由 UI 反馈
      }
    } finally {
      setRefreshing(false);
    }
  }

  if (!loaded || refreshing) {
    return <SuspenseVideoLoader />;
  }

  if (!has) {
    return (
      <div className="h-full w-full flex items-center justify-center" style={{ background: 'var(--bg-base)' }}>
        <div className="text-center">
          <div className="text-[20px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            无权限访问
          </div>
          <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            缺少权限：{required.join(' 或 ')}
          </div>
          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            刚部署后如刚加权限，可点「重新获取权限」立即拉取最新角色配置；仍不行请联系管理员在「权限管理」里勾选。
          </div>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              onClick={() => { void refreshPermissions(false); }}
              className="px-4 py-2 text-sm rounded-md transition-colors"
              style={{
                background: 'var(--accent-bg, rgba(88,166,255,0.14))',
                color: 'var(--accent, #58a6ff)',
                border: '1px solid var(--accent, #58a6ff)',
              }}
            >
              重新获取权限
            </button>
            <button
              onClick={() => { logout(); navigate('/login', { replace: true }); }}
              className="px-4 py-2 text-sm rounded-md transition-colors"
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
      </div>
    );
  }
  return <>{children}</>;
}
