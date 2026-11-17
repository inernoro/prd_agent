import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { ClusterStatus, LoadState, MeResponse, StorageModeResponse } from '../types';

interface OverviewData {
  me: MeResponse;
  cluster: ClusterStatus;
  storage: StorageModeResponse;
}

export function OverviewTab(): JSX.Element {
  const [attempt, setAttempt] = useState(0);
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
  }, [attempt]);

  if (state.status === 'loading') return <LoadingBlock />;
  if (state.status === 'error') return <div className="space-y-3"><ErrorBlock message={state.message} /><Button onClick={() => setAttempt(value => value + 1)}>重试</Button></div>;

  const { me, cluster, storage } = state.data;
  const isTargetMode = storage.kind === 'mongo-split' || storage.mode === 'mongo-split';
  const clusterMode = cluster.effectiveRole || cluster.mode || '未知';
  const storageMode = storage.mode || storage.kind;
  const storageReady = isTargetMode && storage.mongoHealthy === true;
  const userName = me.username || me.login || (typeof me.user === 'object' ? me.user?.username || me.user?.githubLogin || me.user?.name : me.user) || '用户身份未确认';
  return (
    <Section title="概览" description="本 CDS 实例的运行状态。" actions={<Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}><RefreshCw />重新读取</Button>}>
      <div className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="登录用户">{userName}</Field>
          <Field label="运行模式">
            <CodePill>{clusterMode}</CodePill>
          </Field>
          <Field label="主节点 URL">{cluster.masterUrl || (['master', 'standalone', 'hybrid'].includes(clusterMode) ? '本机即主节点' : '未确认主节点地址')}</Field>
          <Field label="远端 executor">{typeof cluster.remoteExecutorCount === 'number' ? `${cluster.remoteExecutorCount} 个` : '未确认'}</Field>
        </div>

        <div
          className={
            storageReady
              ? 'rounded-md border border-ok/30 bg-ok-soft px-4 py-4'
              : 'rounded-md border border-warn/40 bg-warn-soft px-4 py-4'
          }
        >
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="存储状态">
              {storageReady ? 'Mongo split 已就绪' : !storageMode ? '存储模式未确认' : !isTargetMode ? '当前未使用 Mongo split' : storage.mongoHealthy === false ? 'Mongo 连接异常，请检查存储后端' : 'Mongo 健康状态未确认'}
            </Field>
            <Field label="存储模式">
              <CodePill>{storageMode || '未确认'}</CodePill>
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
