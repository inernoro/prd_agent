import { useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '@/types/api';

const CACHE_TTL = 60_000;
type Snapshot<T> = { data?: T; dataDays?: number; updatedAt?: number };

/** 页面内缓存和在途请求复用；更新期间保留带原始窗口的上一份快照。 */
export function useExecutiveQuery<T>(
  fetcher: (days: number) => Promise<ApiResponse<T>>,
  days: number,
  enabled: boolean,
  revision: number,
) {
  const cache = useRef(new Map<string, { data?: T; updatedAt?: number; pending?: Promise<T> }>());
  const key = `${days}:${revision}`;
  const [state, setState] = useState<Snapshot<T> & { key: string; error?: string; pending?: boolean }>({ key: '' });

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    for (const cachedKey of cache.current.keys()) {
      if (!cachedKey.endsWith(`:${revision}`)) cache.current.delete(cachedKey);
    }
    let entry = cache.current.get(key);
    if (entry?.data !== undefined && entry.updatedAt !== undefined && Date.now() - entry.updatedAt < CACHE_TTL) {
      setState({ key, data: entry.data, dataDays: days, updatedAt: entry.updatedAt });
      return;
    }
    const previousEntry = entry;
    setState(previous => ({
      key, pending: true,
      data: previousEntry?.data ?? previous.data,
      dataDays: previousEntry?.data !== undefined ? days : previous.dataDays,
      updatedAt: previousEntry?.updatedAt ?? previous.updatedAt,
    }));
    if (!entry?.pending) {
      entry = {};
      cache.current.set(key, entry);
      const target = entry;
      target.pending = Promise.resolve().then(() => fetcher(days)).then(response => {
        if (!response.success) throw new Error(response.error.message);
        target.data = response.data;
        target.updatedAt = Date.now();
        return response.data;
      }).finally(() => { target.pending = undefined; });
    }
    const target = entry;
    entry.pending!.then(
      data => { if (current) setState({ key, data, dataDays: days, updatedAt: target.updatedAt }); },
      error => {
        if (current) setState(previous => ({ ...previous, key, pending: false, error: error instanceof Error ? error.message : '统计数据加载失败' }));
      },
    );
    return () => { current = false; };
  }, [fetcher, days, enabled, revision, key]);

  const error = enabled && state.key === key ? state.error : undefined;
  const loading = enabled && (state.key !== key || state.pending === true);
  return {
    data: state.data,
    dataDays: state.dataDays,
    updatedAt: state.updatedAt,
    error,
    loading,
    stale: enabled && state.data !== undefined && (loading || Boolean(error) || state.dataDays !== days),
  };
}
