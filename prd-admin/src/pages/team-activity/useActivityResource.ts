import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '@/types/api';
import type { TeamActivityRequestOptions } from '@/services/contracts/teamActivity';

export const ACTIVITY_REQUEST_TIMEOUT_MS = 180_000;

export type ActivityResource<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

/** Requests belong to the panel, so chart remounts share data without caching across accounts. */
export function useActivityResource<T>(load: (options: TeamActivityRequestOptions) => Promise<ApiResponse<T>>, enabled = true): ActivityResource<T> {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    load: typeof load;
    revision: number;
    data: T | null;
    error: string | null;
    loading: boolean;
  } | null>(null);
  const latest = useRef(state);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    const previous = latest.current;
    if (previous?.load === load && previous.revision === revision && !previous.loading && !previous.error) return;
    const controller = new AbortController();
    const publish = (next: NonNullable<typeof state>) => { latest.current = next; setState(next); };
    publish({ load, revision, data: null, error: null, loading: true });
    void load({ signal: controller.signal, timeoutMs: ACTIVITY_REQUEST_TIMEOUT_MS }).then((response) => {
      if (controller.signal.aborted) return;
      publish({ load, revision, data: response.success ? response.data : null,
        error: response.success ? null : response.error?.message ?? '加载失败，请重试', loading: false });
    }).catch(() => {
      if (!controller.signal.aborted) {
        publish({ load, revision, data: null, error: '加载失败，请重试', loading: false });
      }
    });
    return () => controller.abort();
  }, [load, revision, enabled]);

  // Hide the previous window immediately, before the replacement effect runs.
  const current = state?.load === load && state.revision === revision;
  return { data: current ? state.data : null, error: current ? state.error : null,
    loading: current ? state.loading : true, reload };
}
