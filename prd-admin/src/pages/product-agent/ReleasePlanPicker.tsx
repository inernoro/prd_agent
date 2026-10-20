import { useMemo, useState } from 'react';
import { ItemSearchSelect } from '@/components/ItemSearchSelect';
import type { VersionApplicationProduct } from '@/services/real/productAgent';
import type { ProductInitiation } from './types';
import { toProductOptions } from './comboboxOptions';
import { filterReleasePlans } from './releasePlanOptions';
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
  const [productFilter, setProductFilter] = useState('');
  const [scaleFilter, setScaleFilter] = useState('');
  const visible = useMemo(() => filterReleasePlans(plans, productFilter, scaleFilter), [plans, productFilter, scaleFilter]);
  const productNames = useMemo(() => new Map(products.map((product) => [product.id, product.name])), [products]);
  const changeFilter = (product: string, scale: string) => {
    setProductFilter(product); setScaleFilter(scale);
    if (value && !filterReleasePlans(plans, product, scale).some((plan) => plan.id === value)) onChange('');
  };
  return <div className="space-y-2">
    {loading && <p role="status" className="flex items-center gap-2 text-xs text-token-secondary"><MapSpinner size={14} />正在补充可选方案（{progress?.completed ?? 0}/{progress?.total ?? products.length} 个应用），可先填写其他字段或选择已加载方案。</p>}
    {error && <p role="alert" className="text-xs text-token-secondary">{error}<button type="button" onClick={onRetry} className="ml-2 hover:underline">重试方案加载</button></p>}
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-44 flex-1" role="group" aria-label="按应用筛选方案"><ItemSearchSelect value={productFilter} onChange={(id) => changeFilter(id, scaleFilter)} options={toProductOptions(products)} clearOptionLabel="全部应用" placeholder="搜索应用" uiSize="sm" countUnit="个应用" /></div>
      <select aria-label="按版本级别筛选方案" value={scaleFilter} onChange={(event) => changeFilter(productFilter, event.target.value)} className="rounded-md border border-token-subtle bg-token-nested px-2.5 py-1.5 text-xs text-token-primary"><option value="">全部级别</option><option value="minor">小版本</option><option value="medium">中版本</option><option value="major">大版本</option></select>
    </div>
    <ItemSearchSelect value={value} onChange={onChange} options={visible.map((plan) => ({ id: plan.id, label: plan.planName, subLabel: `${plan.tCode} · ${productNames.get(plan.productId) ?? plan.appName ?? ''}`, searchExtra: `${plan.tCode} ${plan.planName} ${plan.appName ?? ''} ${productNames.get(plan.productId) ?? ''}` }))} placeholder="搜索方案名称或 T 号" emptyText={loading ? '方案仍在加载，可先填写其他字段' : error ? '部分方案未能读取，请重试' : '没有符合筛选条件的已通过方案'} countUnit="个方案" />
  </div>;
}
