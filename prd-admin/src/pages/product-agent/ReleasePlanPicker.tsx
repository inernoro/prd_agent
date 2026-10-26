import { useMemo } from 'react';
import { ItemSearchSelect } from '@/components/ItemSearchSelect';
import type { VersionApplicationProduct } from '@/services/real/productAgent';
import type { ProductInitiation } from './types';
import { filterReleasePlans, releasePlanOption } from './releasePlanOptions';
import { MapSpinner } from '@/components/ui/VideoLoader';

export function ReleasePlanPicker({ plans, products, value, onChange, loading, error, progress, onRetry }: {
  loading?: boolean;
  error?: string;
  progress?: { completed: number; total: number };
  onRetry?: () => void;
  plans: ProductInitiation[];
  products: VersionApplicationProduct[];
  value: string;
  onChange: (id: string) => void;
}) {
  const visible = useMemo(() => filterReleasePlans(plans, '', ''), [plans]);
  const productNames = useMemo(() => new Map(products.map((product) => [product.id, product.name])), [products]);
  return <div className="space-y-2">
    {loading && <p role="status" className="flex items-center gap-2 text-xs text-token-secondary"><MapSpinner size={14} />正在补充可选方案（{progress?.completed ?? 0}/{progress?.total ?? products.length} 个应用），可先填写其他字段或选择已加载方案。</p>}
    {error && <p role="alert" className="text-xs text-token-secondary">{error}<button type="button" onClick={onRetry} className="ml-2 hover:underline">重试方案加载</button></p>}
    <ItemSearchSelect value={value} onChange={onChange} options={visible.map((plan) => releasePlanOption(plan, productNames.get(plan.productId)))} truncateSelectedLabel={false} placeholder="搜索方案名称或 T 号" emptyText={loading ? 'T版本记录仍在加载，可先填写其他字段' : error ? '部分T版本记录未能读取，请重试' : '暂无已发号的T版本记录'} countUnit="条T版本记录" />
  </div>;
}
