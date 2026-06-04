/**
 * 产品类型（ProductCategory）共享缓存 + 解析器。
 *
 * 取代写死的 PRODUCT_GRADE_LABEL / GRADE_COLOR：所有展示标签/色从后端可管理的
 * 类型列表解析，找不到时回退到内置 id 的兜底色/名。模块级缓存 + 订阅，使「设置」
 * 里的增删改即时传播到产品卡片、筛选 chips、单产品视图等所有消费点。
 */
import { useEffect, useState } from 'react';
import { listProductCategories } from '@/services/real/productAgent';
import type { ProductCategory } from './types';
import { PRODUCT_GRADE_LABEL } from './types';

/** 内置 4 项的兜底色（后端未返回时使用，与种子色对齐） */
const FALLBACK_COLOR: Record<string, string> = {
  core: '#22D3EE',
  important: '#FBBF24',
  normal: '#94A3B8',
  experimental: '#A78BFA',
};

let cache: ProductCategory[] | null = null;
const subscribers = new Set<(items: ProductCategory[]) => void>();

/** 拉取最新类型列表并广播给所有订阅者。 */
export async function refreshProductCategories(): Promise<ProductCategory[]> {
  const res = await listProductCategories();
  if (res.success) {
    cache = res.data.items;
    subscribers.forEach((fn) => fn(cache!));
  }
  return cache ?? [];
}

/** 订阅式 hook：组件挂载即拿到缓存（或触发首拉），后续设置变更自动刷新。 */
export function useProductCategories() {
  const [categories, setCategories] = useState<ProductCategory[]>(cache ?? []);
  useEffect(() => {
    const sub = (items: ProductCategory[]) => setCategories(items);
    subscribers.add(sub);
    if (cache) setCategories(cache);
    else void refreshProductCategories();
    return () => {
      subscribers.delete(sub);
    };
  }, []);
  return { categories, reload: refreshProductCategories };
}

/** 解析类型中文名（找不到回退内置标签，再回退 id 本身）。 */
export function categoryLabel(categories: ProductCategory[], id?: string | null): string {
  if (!id) return '';
  return categories.find((c) => c.id === id)?.name ?? PRODUCT_GRADE_LABEL[id] ?? id;
}

/** 解析类型展示色（找不到回退内置色，再回退中性灰）。 */
export function categoryColor(categories: ProductCategory[], id?: string | null): string {
  if (!id) return '#94A3B8';
  return categories.find((c) => c.id === id)?.color ?? FALLBACK_COLOR[id] ?? '#94A3B8';
}
