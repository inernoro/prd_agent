/**
 * 我的资源路由：移动端使用 MobileAssetsPage，桌面端使用增强版 DesktopAssetsPage。
 * 从 App.tsx 抽取以便 navRegistry 引用。
 */

import { lazy, Suspense } from 'react';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { SuspenseVideoLoader } from '@/components/ui/VideoLoader';

const MobileAssetsPage = lazy(() => import('@/pages/MobileAssetsPage'));
const DesktopAssetsPage = lazy(() => import('@/pages/DesktopAssetsPage'));

export default function MyAssetsPage() {
  const { isMobile } = useBreakpoint();
  return (
    <Suspense fallback={<SuspenseVideoLoader />}>
      {isMobile ? <MobileAssetsPage /> : <DesktopAssetsPage />}
    </Suspense>
  );
}
