import { useAuthStore } from '@/stores/authStore';
import { ProductPermissionWorkbookPanel } from './ProductPermissionWorkbookPanel';
import { PRODUCT_MAP_ADMIN } from './productPermissionAccess';

export type ProductPermissionTab = 'menu' | 'function' | 'role';

export function ProductPermissionsPanel({ tab }: { tab: ProductPermissionTab }) {
  const permissions = useAuthStore((state) => state.permissions);
  const isRoot = useAuthStore((state) => state.isRoot);
  if (isRoot || permissions.includes(PRODUCT_MAP_ADMIN)) return <ProductPermissionWorkbookPanel tab={tab} />;
  return <div role="status" className="rounded-lg border border-token-subtle bg-token-nested p-4">
    <p className="text-sm font-medium text-token-primary">仅MAP管理员可配置产品权限</p>
    <p className="mt-2 text-xs leading-6 text-token-secondary">导入、导出和人员权限修改仅向MAP管理员开放；产品应用管理员及授权管理员不自动获得此能力。独立评审智能体仍在原权限管理中配置。</p>
  </div>;
}
