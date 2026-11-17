import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { LoadState, StorageModeResponse } from '../types';

export function StorageTab(): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState<StorageModeResponse>>({ status: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    apiRequest<StorageModeResponse>('/api/storage-mode', { signal: ctrl.signal })
      .then((data) => setState({ status: 'ok', data }))
      .catch((err: unknown) => {
        if ((err as DOMException)?.name === 'AbortError') return;
        setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
      });
    return () => ctrl.abort();
  }, [attempt]);

  if (state.status === 'loading') return <LoadingBlock />;
  if (state.status === 'error') return <div className="space-y-3"><ErrorBlock message={state.message} /><Button onClick={() => setAttempt(value => value + 1)}>重试</Button></div>;

  const storage = state.data;
  const mode = storage.mode || storage.kind || 'unknown';
  const isMongoMode = mode === 'mongo' || mode === 'mongo-split';
  const isTargetMode = mode === 'mongo-split';
  const startup = storage.startupEnv || {};
  const envFile = storage.envFile || {};
  const splitCollections = storage.splitCollections || [];

  return (
    <Section
      title="存储后端"
      actions={<Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}><RefreshCw />重新读取</Button>}
      description="查看当前实际使用的存储模式、连接健康与状态集合。此页只读；部署配置变更后需重启 CDS。"
    >
      <div className="space-y-5">
        <div
          className={
            isTargetMode && storage.mongoHealthy === true
              ? 'rounded-md border border-ok/30 bg-ok-soft px-4 py-4'
              : 'rounded-md border border-warn/40 bg-warn-soft px-4 py-4'
          }
        >
          <div className="flex items-start gap-3">
            {isTargetMode && storage.mongoHealthy === true ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-ok" />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 text-warn" />
            )}
            <div className="min-w-0">
              <div className="font-medium">
                {mode === 'unknown' ? '存储模式未确认' : isTargetMode ? storage.mongoHealthy === true ? 'Mongo split 连接正常' : storage.mongoHealthy === false ? 'Mongo split 连接异常' : 'Mongo split 健康状态未确认' : '当前存储模式不是 Mongo split'}
              </div>
              <div className="mt-1 text-sm leading-6 text-muted-foreground">
                目标模式 <CodePill>{storage.targetMode || 'mongo-split'}</CodePill>，当前实际模式{' '}
                <CodePill>{mode === 'unknown' ? '未确认' : mode}</CodePill>
                {isMongoMode ? (
                  <>
                    ，Mongo 健康{' '}
                    <CodePill>{storage.mongoHealthy === true ? '正常' : storage.mongoHealthy === false ? '异常' : '未检测'}</CodePill>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Field label="Mongo 连接">
            <div className="space-y-2 text-muted-foreground">
              <div>
                URI：<CodePill>{storage.mongoUri || '未提供连接地址'}</CodePill>
              </div>
              <div>
                DB：<CodePill>{storage.mongoDb || startup.processEnvMongoDb || '-'}</CodePill>
              </div>
            </div>
          </Field>

          <Field label="初始化契约">
            <div className="space-y-2 text-muted-foreground">
              <div>
                <code>./exec_cds.sh init</code> 默认创建并启动 <CodePill>cds-state-mongo</CodePill>
              </div>
              <div>
                启动变量：<CodePill>{startup.processEnvStorageMode || '未设'}</CodePill>
              </div>
            </div>
          </Field>
        </div>

        <div className="rounded-md border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <div className="text-sm font-semibold">Mongo split collection</div>
              <div className="mt-1 text-xs text-muted-foreground">运行态按集合拆分，避免把所有状态塞进单条文档。</div>
            </div>
            <Database className="h-4 w-4 text-muted-foreground" />
          </div>
          {splitCollections.length === 0 ? (
            <div className="px-4 py-6 text-sm leading-6 text-muted-foreground">
              {mode === 'unknown' ? '存储模式尚未确认，暂无法展示状态集合。' : isTargetMode ? Array.isArray(storage.splitCollections) ? '当前返回 0 个状态集合。若预期已有数据，请重新读取并核对连接与数据库；空列表不代表没有业务数据。' : '当前运行在 Mongo split 模式，但服务尚未返回集合信息。请重新读取核对。' : '当前未使用 Mongo split 模式，因此没有拆分集合信息。'}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {splitCollections.map((collection) => (
                <div key={collection.name} className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[13.75rem_10rem_7.5rem_minmax(0,1fr)] md:items-center">
                  <code className="font-mono font-semibold">{collection.name}</code>
                  <span className="text-muted-foreground">{collection.role}</span>
                  <CodePill>{collection.documents} docs</CodePill>
                  <span className="text-muted-foreground">{collection.note || '-'}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <Field label=".cds.env 诊断">
          <div className="grid gap-2 text-muted-foreground md:grid-cols-2">
            <div>
              文件：<CodePill>{envFile.exists === false ? '不存在' : envFile.path || '未检测'}</CodePill>
            </div>
            <div>
              CDS_STORAGE_MODE：<CodePill>{envFile.storageModeValue || '未设'}</CodePill>
            </div>
            <div>
              CDS_MONGO_URI：<CodePill>{envFile.hasMongoUri ? '已配置' : '未配置'}</CodePill>
            </div>
            <div>
              process.env.CDS_MONGO_URI：<CodePill>{startup.processEnvMongoUriSet ? '已注入' : '未注入'}</CodePill>
            </div>
          </div>
        </Field>
      </div>
    </Section>
  );
}
