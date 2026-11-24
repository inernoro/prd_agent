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
import { stashReturnFragment } from './returnFragment';
import { hasEffectivePermission } from '@/lib/permissionAccess';

/**
 * 未登录时该把人送去哪、登录完该回到哪。
 *
 * `#` 后面的东西有两种截然不同的含义，这里必须分开：
 * - `#/transcript-agent` 是 hash 路由，`#` 后就是完整路径，取它当 returnUrl；
 * - `#code=...&state=...` 是**当前路由的 fragment**（跨实例同步授权回跳就长这样），
 *   它不是路径。旧代码把它当路径，登录完会跳到 `code=...` 这种不存在的路由，
 *   而那个 60 秒的一次性授权码就此丢失，整条授权链要重走一遍。
 *   但它也**不能**被原样搬进 returnUrl —— 见下面 fragRef 那段。
 *
 * 拆成纯函数是为了能直接对这三种输入断言，不必起一个 Router。
 */
export function decideAuthRedirect(
  pathname: string,
  search: string,
  rawHash: string,
  stash: (fragment: string) => string = stashReturnFragment,
): { kind: 'home' } | { kind: 'login'; returnUrl: string } {
  const hash = (rawHash || '').replace(/^#/, '');
  if (hash.startsWith('/') && hash !== '/') {
    return { kind: 'login', returnUrl: hash };
  }
  // 根路径未登录 → 展示公开首页
  if (pathname === '/') return { kind: 'home' };
  // fragment **不进 returnUrl**。它里面可能装着授权码这种「特意放在 fragment 里
  // 免得进服务器日志」的东西，塞进 query 等于亲手拆掉那层保护（登录页会带着这个
  // query 发同源请求，SSO 还会把它拼进外部重定向地址）。所以只留一个不含语义的
  // 引用键，值存在 sessionStorage 里。
  const fragment = hash.length > 0 && !hash.startsWith('/') ? `#${hash}` : '';
  const ref = fragment ? stash(fragment) : '';
  const query = ref ? `${search || ''}${search ? '&' : '?'}fragRef=${encodeURIComponent(ref)}` : search;
  return { kind: 'login', returnUrl: pathname + query };
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();
  if (!isAuthenticated) {
    const decision = decideAuthRedirect(location.pathname, location.search, window.location.hash);
    if (decision.kind === 'home') return <Navigate to="/home" replace />;
    return <Navigate to={`/login?returnUrl=${encodeURIComponent(decision.returnUrl)}`} replace />;
  }
  return <>{children}</>;
}

export function RequirePermission({ perm, children }: { perm: string | string[]; children: React.ReactNode }) {
  const perms = useAuthStore((s) => s.permissions);
  const loaded = useAuthStore((s) => s.permissionsLoaded);
  const logout = useAuthStore((s) => s.logout);
  const setPermissions = useAuthStore((s) => s.setPermissions);
  const isRoot = useAuthStore((s) => s.isRoot);
  const navigate = useNavigate();

  const [refreshing, setRefreshing] = useState(false);
  // 防止同一次挂载内反复静默刷新（指纹未变时只试一次）
  const silentRefreshTriedRef = useRef(false);

  const required = Array.isArray(perm) ? perm : [perm];
  const has = Array.isArray(perms) && hasEffectivePermission(perms, required, isRoot);

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
