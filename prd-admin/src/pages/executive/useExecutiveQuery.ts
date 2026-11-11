import { useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '@/types/api';

const CACHE_TTL = 60_000;

/** 页面内缓存；切换标签复用结果和在途请求，离开页面即释放。 */
export function useExecutiveQuery<T>(
  fetcher: (days: number) => Promise<ApiResponse<T>>,
  days: number,
  enabled: boolean,
  revision: number,
) {
  const cache = useRef(new Map<string, { data?: T; expires: number; pending?: Promise<T> }>());
  const key = `${days}:${revision}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: '' });

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    // 刷新后的旧版本不再复用；筛选项有限，缓存仅在本页面存活。
    for (const cachedKey of cache.current.keys()) {
      if (!cachedKey.endsWith(`:${revision}`)) cache.current.delete(cachedKey);
    }
    let entry = cache.current.get(key);
    if (entry?.data !== undefined && entry.expires > Date.now()) {
      setState({ key, data: entry.data });
      return;
    }
    setState({ key });
    if (!entry?.pending) {
      entry = { expires: 0 };
      cache.current.set(key, entry);
      const target = entry;
      target.pending = Promise.resolve().then(() => fetcher(days)).then(response => {
        if (!response.success) throw new Error(response.error.message);
        target.data = response.data;
        target.expires = Date.now() + CACHE_TTL;
        return response.data;
      }).finally(() => { target.pending = undefined; });
    }
    entry.pending!.then(
      data => { if (current) setState({ key, data }); },
      error => { if (current) setState({ key, error: error instanceof Error ? error.message : '统计数据加载失败' }); },
    );
    return () => { current = false; };
  }, [fetcher, days, enabled, revision, key]);

  return {
    data: state.key === key ? state.data : undefined,
    error: enabled && state.key === key ? state.error : undefined,
    loading: enabled && (state.key !== key || (state.data === undefined && !state.error)),
  };
}
