import { useEffect, useState } from 'react';

import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { ClusterStatus, LoadState, MeResponse, StorageModeResponse } from '../types';

interface OverviewData {
  me: MeResponse;
  cluster: ClusterStatus;
  storage: StorageModeResponse;
}

export function OverviewTab(): JSX.Element {
  const [state, setState] = useState<LoadState<OverviewData>>({ status: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([
      apiRequest<MeResponse>('/api/me', { signal: ctrl.signal }),
      apiRequest<ClusterStatus>('/api/cluster/status', { signal: ctrl.signal }),
      apiRequest<StorageModeResponse>('/api/storage-mode', { signal: ctrl.signal }),
    ])
      .then(([me, cluster, storage]) => setState({ status: 'ok', data: { me, cluster, storage } }))
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, []);

  if (state.status === 'loading') return <LoadingBlock />;
  if (state.status === 'error') return <ErrorBlock message={state.message} />;

  const { me, cluster, storage } = state.data;
  const storageReady = (storage.kind === 'mongo-split' || storage.mode === 'mongo-split') && storage.mongoHealthy !== false;
  return (
    <Section title="概览" description="本 CDS 实例的运行状态。">
      <div className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="登录用户">{me.username || me.login || me.user || '未登录'}</Field>
          <Field label="运行模式">
            <CodePill>{cluster.effectiveRole || cluster.mode || 'standalone'}</CodePill>
          </Field>
          <Field label="主节点 URL">{cluster.masterUrl || '本机即主节点'}</Field>
          <Field label="远端 executor">{cluster.remoteExecutorCount || 0} 个</Field>
        </div>

        <div
          className={
            storageReady
              ? 'rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-4'
              : 'rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-4'
          }
        >
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="初始化状态">
              {storageReady ? 'Mongo split 已就绪' : '需要检查 Mongo 初始化'}
            </Field>
            <Field label="存储模式">
              <CodePill>{storage.mode || storage.kind || 'unknown'}</CodePill>
            </Field>
            <Field label="Mongo DB">
              <CodePill>{storage.mongoDb || storage.startupEnv?.processEnvMongoDb || '-'}</CodePill>
            </Field>
          </div>
        </div>
      </div>
    </Section>
  );
}
