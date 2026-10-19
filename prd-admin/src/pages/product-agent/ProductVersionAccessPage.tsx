import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, GitBranch } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { getVersionApplicationProduct } from '@/services/real/productAgent';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { ProductAgentLayout } from './ProductAgentLayout';
import { VersionWorkflowTab } from './VersionWorkflowTab';
import { SingleProductView } from './SingleProductView';
import { ProductObjectDetailPage } from './ProductObjectDetailPage';
import { ReleaseWorkflowDetail } from './ReleaseWorkflowDetail';
import { InitiationWorkflowDetail } from './InitiationWorkflowDetail';

function useFullProductPermission() {
  const permissions = useAuthStore((state) => state.permissions ?? []);
  const isRoot = useAuthStore((state) => state.isRoot);
  return hasEffectivePermission(permissions, 'product-agent.use', isRoot);
}

/** 同一 URL 下，独立申领用户只渲染版本页，不装载单产品的其它模块。 */
export function ProductVersionProductRoute() {
  const fullProductAccess = useFullProductPermission();
  return fullProductAccess ? <SingleProductView /> : <VersionOnlyProductPage />;
}

function VersionOnlyProductPage() {
  const navigate = useNavigate();
  const { productId = '' } = useParams();
  const [productName, setProductName] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void getVersionApplicationProduct(productId).then((result) => {
      if (!alive) return;
      setProductName(result.success ? result.data.name : '');
      setLoading(false);
    });
    return () => { alive = false; };
  }, [productId]);

  if (loading) return <div className="flex h-screen items-center justify-center bg-token-card"><MapSectionLoader text="正在加载版本申领…" /></div>;
  if (!productName) return <div className="flex h-screen items-center justify-center bg-token-card text-sm text-token-muted">产品不存在或无权访问</div>;

  return <ProductAgentLayout
    title={productName}
    subtitle="版本号申领"
    topSlot={<button type="button" onClick={() => navigate('/product-agent?section=versions')} className="mb-2 flex items-center gap-1.5 text-[11px] text-token-muted hover-text-primary"><ArrowLeft size={13} />返回版本列表</button>}
    items={[{ key: 'versions', label: '版本', icon: GitBranch }]}
    active="versions"
    onSelect={() => undefined}
  >
    <div className="h-full min-h-0 overflow-y-auto p-5"><VersionWorkflowTab productId={productId} /></div>
  </ProductAgentLayout>;
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
      <button type="button" onClick={() => navigate(`/product-agent/p/${productId}?tab=versions`)} className="flex items-center gap-1.5 text-sm text-token-secondary hover-text-primary"><ArrowLeft size={15} />返回{kind === 'release' ? '正式版本' : '内部版本'}</button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 xl:px-8">
      {kind === 'release'
        ? <ReleaseWorkflowDetail productId={productId} releaseId={id} isNew={id === 'new'} />
        : <InitiationWorkflowDetail productId={productId} initiationId={id} />}
    </div>
  </div>;
}
