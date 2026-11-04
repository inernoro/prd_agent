import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export type ProductListSection = 'requirements' | 'versions';

/** 同一列表的入口只携带筛选条件，不维护第二套单产品页面。 */
export function productListPath(section: ProductListSection, productId = '', source?: URLSearchParams): string {
  const params = new URLSearchParams({ section });
  if (productId) params.set('productId', productId);
  if (section === 'versions') {
    for (const key of ['versionTab', 'versionAction']) {
      const value = source?.get(key);
      if (value) params.set(key, value);
    }
  }
  return `/product-agent?${params.toString()}`;
}

export function useProductListScope(fallbackProductId = '') {
  const [params, setParams] = useSearchParams();
  const productId = params.get('productId') ?? fallbackProductId;
  const setProductId = useCallback((value: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value || fallbackProductId) next.set('productId', value);
      else next.delete('productId');
      return next;
    }, { replace: true });
  }, [fallbackProductId, setParams]);
  return { productId, setProductId };
}
