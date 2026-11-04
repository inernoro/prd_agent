import { createContext, useCallback, useContext, useEffect, useRef } from 'react';

export type SettingsRead = () => Promise<unknown>;
export const ProjectSettingsRefreshContext = createContext<((read: SettingsRead) => () => void) | null>(null);

/** 页面刷新只重取已挂载子页的读请求，不重挂载表单，也不触发保存、探测或部署。 */
export function useProjectSettingsRefresh(read: SettingsRead): void {
  const register = useContext(ProjectSettingsRefreshContext);
  const latest = useRef(read);
  useEffect(() => { latest.current = read; });
  useEffect(() => register?.(() => latest.current()), [register]);
}

/** 同一读请求只接收最新结果；切页和卸载时取消等待。 */
export function useSettingsReadRequest(): () => AbortSignal {
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  return useCallback(() => {
    request.current?.abort();
    request.current = new AbortController();
    return request.current.signal;
  }, []);
}

/** 逐字段更新未编辑的值，保留正在编辑的配置。 */
export function mergeCleanSettings<T>(current: Record<string, T>, previous: Record<string, T>, next: Record<string, T>): Record<string, T> {
  const result = { ...next };
  for (const key of new Set([...Object.keys(current), ...Object.keys(previous)])) {
    if (JSON.stringify(current[key]) !== JSON.stringify(previous[key])) {
      if (Object.hasOwn(current, key)) result[key] = current[key];
      else delete result[key];
    }
  }
  return result;
}
