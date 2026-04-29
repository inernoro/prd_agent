import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database } from 'lucide-react';

import { apiRequest, ApiError } from '@/lib/api';
import { CodePill, ErrorBlock, Field, LoadingBlock, Section } from '../components';
import type { LoadState, StorageModeResponse } from '../types';

export function StorageTab(): JSX.Element {
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
  }, []);

  if (state.status === 'loading') return <LoadingBlock />;
  if (state.status === 'error') return <ErrorBlock message={state.message} />;

  const storage = state.data;
  const mode = storage.mode || storage.kind || 'json';
  const isMongoMode = storage.kind === 'mongo' || storage.kind === 'mongo-split';
  const isTargetMode = storage.kind === 'mongo-split' || storage.mode === 'mongo-split';
  const startup = storage.startupEnv || {};
  const envFile = storage.envFile || {};
  const splitCollections = storage.splitCollections || [];

  return (
    <Section
      title="存储后端"
      description="CDS 默认使用 MongoDB split collection 存储项目、分支与全局状态；新初始化不再把 state.json 当作正常业务路径。"
    >
      <div className="space-y-5">
        <div
          className={
            isTargetMode && storage.mongoHealthy !== false
              ? 'rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-4'
              : 'rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-4'
          }
        >
          <div className="flex items-start gap-3">
            {isTargetMode && storage.mongoHealthy !== false ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-500" />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-500" />
            )}
            <div className="min-w-0">
              <div className="font-medium">
                {isTargetMode ? '当前运行在 Mongo split 模式' : '当前存储模式不是目标模式'}
              </div>
              <div className="mt-1 text-sm leading-6 text-muted-foreground">
                目标模式 <CodePill>{storage.targetMode || 'mongo-split'}</CodePill>，当前实际模式{' '}
                <CodePill>{mode}</CodePill>
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
                URI：<CodePill>{storage.mongoUri || '未连接'}</CodePill>
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
              当前不是 mongo-split，因此没有集合拆分信息。请先按初始化契约启动 Mongo 并重启 CDS。
            </div>
          ) : (
            <div className="divide-y divide-border">
              {splitCollections.map((collection) => (
                <div key={collection.name} className="grid gap-3 px-4 py-3 text-sm md:grid-cols-[220px_160px_120px_minmax(0,1fr)] md:items-center">
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
