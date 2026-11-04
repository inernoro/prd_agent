import { useCallback, useEffect, useState } from 'react';
import type { ApiResponse } from '@/types/api';
import type { TeamActivityRequestOptions } from '@/services/contracts/teamActivity';

/** Each VOC section owns its request; superseded windows are cancelled and never rendered. */
export function useActivityResource<T>(load: (options: TeamActivityRequestOptions) => Promise<ApiResponse<T>>) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    load: typeof load;
    revision: number;
    data: T | null;
    error: string | null;
    loading: boolean;
  } | null>(null);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ load, revision, data: null, error: null, loading: true });
    void load({ signal: controller.signal, timeoutMs: 45_000 }).then((response) => {
      if (controller.signal.aborted) return;
      setState({ load, revision, data: response.success ? response.data : null,
        error: response.success ? null : response.error?.message ?? '加载失败，请重试', loading: false });
    }).catch(() => {
      if (!controller.signal.aborted) {
        setState({ load, revision, data: null, error: '加载失败，请重试', loading: false });
      }
    });
    return () => controller.abort();
  }, [load, revision]);

  // Hide the previous window immediately, before the replacement effect runs.
  const current = state?.load === load && state.revision === revision;
  return { data: current ? state.data : null, error: current ? state.error : null,
    loading: current ? state.loading : true, reload };
}
