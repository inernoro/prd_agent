import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { getProductPermissionMe } from '@/services/real/productPermissions';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import { hasProductMenu, hasProductReviewPermission, PRODUCT_MENU_KEYS, productRouteMenu } from './productPermissionAccess';

/** 同步本人的最新产品权限；直达URL与侧栏复用同一准入，不更改其他应用权限。 */
export function ProductPermissionGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void getProductPermissionMe(controller.signal).then((res) => {
      if (controller.signal.aborted) return;
      if (res.success) useAuthStore.getState().setPermissions(res.data.permissions);
      else setError(res.error.message);
    }).catch(() => { if (!controller.signal.aborted) setError('产品权限未能读取，请重试。'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [location.pathname, location.search, retry]);
  if (loading) return <MapSectionLoader text="正在核对产品菜单权限…" />;
  if (error) return <div role="alert" className="p-6 text-sm text-token-secondary">{error}<Button size="sm" onClick={() => setRetry((n) => n + 1)}>重试</Button></div>;
  const menu = productRouteMenu(location.pathname, location.search);
  const allowed = menu ? hasProductMenu(permissions, menu, isRoot) : PRODUCT_MENU_KEYS.some((key) => hasProductMenu(permissions, key, isRoot));
  if (!allowed) return <div role="alert" className="p-6 text-sm text-token-secondary">当前账号没有此产品管理菜单的权限，请联系MAP管理员调整权限表。</div>;
  return <>{children}</>;
}

export function ProductReviewPermissionGate({ permission, children }: { permission: string; children: ReactNode }) {
  const permissions = useAuthStore((s) => s.permissions);
  const isRoot = useAuthStore((s) => s.isRoot);
  return isRoot || hasProductReviewPermission(permissions, permission) ? <>{children}</> : <div role="alert" className="p-6 text-sm text-token-secondary">当前账号没有此产品评审功能的权限。</div>;
}
