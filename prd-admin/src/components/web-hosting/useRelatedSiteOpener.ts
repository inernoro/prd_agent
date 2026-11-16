import { useCallback, useEffect, useRef } from 'react';
import { getSite, type HostedSite } from '@/services/real/webPages';

/** 关联切换只更新预览状态，不跳转路由；每次打开仍重新检查目标权限。 */
export function useRelatedSiteOpener(onOpened: (site: HostedSite) => void, onError: (message: string) => void) {
  const generation = useRef(0);
  const cancel = useCallback(() => { generation.current++; }, []);
  useEffect(() => cancel, [cancel]);
  const open = useCallback(async (id: string) => {
    const current = ++generation.current;
    onError('');
    try {
      const result = await getSite(id);
      if (current !== generation.current) return;
      if (result.success) onOpened(result.data);
      else onError(result.error?.message || '文档不存在或无权访问');
    } catch {
      if (current === generation.current) onError('打开关联文档失败，请重试');
    }
  }, [onOpened, onError]);
  return { open, cancel };
}
