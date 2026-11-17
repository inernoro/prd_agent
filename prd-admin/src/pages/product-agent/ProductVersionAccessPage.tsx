import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { productListPath } from '@/lib/productListScope';
import { SingleProductView } from './SingleProductView';

/** 单产品的需求和版本标签共用全局列表，通过 URL 保留产品筛选。 */
export function ProductVersionProductRoute() {
  const { productId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const tab = searchParams.get('tab');
  if (tab === 'requirements') return <Navigate to={productListPath('requirements', productId)} replace />;
  if (tab === 'versions') return <Navigate to={productListPath('versions', productId, searchParams)} replace />;
  return <SingleProductView />;
}
