import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { productListPath } from '@/lib/productListScope';
import { SingleProductView } from './SingleProductView';
import { ProductObjectDetailPage } from './ProductObjectDetailPage';
import { ReleaseWorkflowDetail } from './ReleaseWorkflowDetail';
import { InitiationWorkflowDetail } from './InitiationWorkflowDetail';

function useFullProductPermission() {
  const permissions = useAuthStore((state) => state.permissions ?? []);
  const isRoot = useAuthStore((state) => state.isRoot);
  return hasEffectivePermission(permissions, 'product-agent.use', isRoot);
}

/** 全域和单产品只进入同一列表，产品路径转为可清空的 URL 筛选。 */
export function ProductVersionProductRoute() {
  const fullProductAccess = useFullProductPermission();
  const { productId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  if (fullProductAccess && tab === 'requirements') {
    return <Navigate to={productListPath('requirements', productId)} replace />;
  }
  if (!fullProductAccess || tab === 'versions') {
    return <Navigate to={productListPath('versions', productId, searchParams)} replace />;
  }
  return <SingleProductView />;
}

/** 详情 URL 仍兼容；独立申领权限只允许 T/V 详情，不能靠改 kind 访问需求等对象。 */
export function ProductVersionDetailRoute() {
  const fullProductAccess = useFullProductPermission();
  const navigate = useNavigate();
  const { productId = '', kind = '', id = '' } = useParams();
  if (fullProductAccess) return <ProductObjectDetailPage />;
  if (kind !== 'release' && kind !== 'initiation') {
    return <div className="flex h-screen flex-col items-center justify-center gap-3 bg-token-card text-sm text-token-muted">
      <span>该页面需要产品管理权限</span>
      <button type="button" onClick={() => navigate('/product-agent?section=versions')} className="text-cyan-300 hover:underline">返回版本列表</button>
    </div>;
  }
  return <div className="flex h-screen min-h-0 flex-col bg-token-card">
    <div className="shrink-0 border-b border-token-subtle px-5 py-3">
      <button type="button" onClick={() => navigate(productListPath('versions', productId, new URLSearchParams({ versionTab: kind === 'initiation' ? 'initiation' : 'release' })))} className="flex items-center gap-1.5 text-sm text-token-secondary hover-text-primary"><ArrowLeft size={15} />返回{kind === 'release' ? '正式版本' : '内部版本'}</button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 xl:px-8">
      {kind === 'release'
        ? <ReleaseWorkflowDetail productId={productId} releaseId={id} isNew={id === 'new'} />
        : <InitiationWorkflowDetail productId={productId} initiationId={id} />}
    </div>
  </div>;
}
