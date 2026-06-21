/*
 * useMonitoringData — shared fetching hook for the tabbed MonitoringDialog.
 *
 * Pulls host stats + executors + cluster status (system/host level) every ~15s
 * while `enabled` is true, plus optional project-scoped activity logs when a
 * projectId is supplied. Polling stops when `enabled` flips false (dialog
 * closed). Mirrors ClusterTab's GET /api/host-stats + GET /api/executors
 * patterns; transient (Cloudflare-edge) errors are swallowed to keep the last
 * known good snapshot.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiRequest, ApiError } from '@/lib/api';
import { normalizeHostStats, type NormalizedHostStats } from '@/lib/host-stats';
import type { ClusterStatus, ExecutorNode, ExecutorsResponse } from '@/pages/cds-settings/types';

const POLL_INTERVAL_MS = 15_000;

export interface MonitoringActivityLog {
  id: string;
  at: string;
  type: string;
  branchId?: string;
  branchName?: string;
  actor?: string;
  note?: string;
  resourceId?: string;
  resourceName?: string;
  result?: 'success' | 'failed' | 'pending';
}

export interface MonitoringSnapshot {
  host: NormalizedHostStats;
  executors: ExecutorNode[];
  cluster: ClusterStatus;
  /** Sum of runningContainers across all executor nodes. */
  totalContainers: number;
}

export type MonitoringState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: MonitoringSnapshot };

export type MonitoringActivityState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; logs: MonitoringActivityLog[] };

export function useMonitoringData(enabled: boolean, projectId?: string): {
  state: MonitoringState;
  activity: MonitoringActivityState;
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<MonitoringState>({ status: 'loading' });
  const [activity, setActivity] = useState<MonitoringActivityState>({ status: 'idle' });
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const loadHost = useCallback(async () => {
    try {
      const [clusterRaw, executorsRes, hostRaw] = await Promise.all([
        apiRequest<ClusterStatus>('/api/cluster/status'),
        apiRequest<ExecutorsResponse>('/api/executors'),
        apiRequest<unknown>('/api/host-stats', { headers: { 'X-CDS-Poll': 'true' } }),
      ]);
      const host = normalizeHostStats(hostRaw);
      if (!host) throw new Error('主机状态返回格式异常');
      const executors = executorsRes.executors || [];
      const totalContainers = executors.reduce(
        (sum, node) => sum + (node.runningContainers || 0),
        0,
      );
      setState({ status: 'ok', data: { host, executors, cluster: clusterRaw, totalContainers } });
    } catch (err: unknown) {
      // transient (Cloudflare 边缘抖动) 静默,保留上次 ok 状态。
      if (err instanceof ApiError && err.transient) return;
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, []);

  const loadActivity = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid) {
      setActivity({ status: 'idle' });
      return;
    }
    try {
      const res = await apiRequest<{ logs: MonitoringActivityLog[] }>(
        `/api/projects/${encodeURIComponent(pid)}/activity-logs?limit=50`,
      );
      setActivity({ status: 'ok', logs: res.logs || [] });
    } catch (err: unknown) {
      if (err instanceof ApiError && err.transient) return;
      setActivity({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, []);

  const reload = useCallback(async () => {
    await Promise.all([loadHost(), loadActivity()]);
  }, [loadActivity, loadHost]);

  useEffect(() => {
    if (!enabled) return;
    void loadHost();
    void loadActivity();
    const timer = window.setInterval(() => {
      void loadHost();
      void loadActivity();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, loadActivity, loadHost]);

  return { state, activity, reload };
}
