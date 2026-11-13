import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, FileSearch, LoaderCircle } from 'lucide-react';
import { getKnowledgeIndexStatus } from '@/services/real/documentStore';
import type { KnowledgeIndexStatus as IndexStatus } from '@/services/contracts/documentStore';

const STATUS_ICONS = {
  not_indexed: FileSearch,
  stale: Clock,
  pending: LoaderCircle,
  ready: CheckCircle2,
  failed: AlertCircle,
} as const;

/** 状态只观察服务端结果；切换文档或保存版本后，旧请求不得覆盖当前文章。 */
export function KnowledgeIndexStatus({ entryId, revision }: { entryId?: string; revision?: string }) {
  const [checkVersion, setCheckVersion] = useState(0);
  const [observation, setObservation] = useState<{ key: string; data?: IndexStatus; error?: string }>();
  const key = `${entryId ?? ''}\0${revision ?? ''}\0${checkVersion}`;

  useEffect(() => {
    if (!entryId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const check = async () => {
      try {
        const response = await getKnowledgeIndexStatus(entryId, controller.signal);
        if (disposed) return;
        if (!response.success) {
          setObservation({ key, error: response.error.message });
          return;
        }
        setObservation({ key, data: response.data });
        if (response.data.pollingRecommended) timer = setTimeout(() => { void check(); }, 3000);
      } catch {
        if (!disposed) setObservation({ key, error: '暂时无法读取问答索引状态，请重新查看。' });
      }
    };
    void check();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [entryId, key]);

  if (!entryId) return null;
  const current = observation?.key === key ? observation : undefined;
  const data = current?.data;
  const Icon = data ? (STATUS_ICONS[data.status] ?? AlertCircle) : current?.error ? AlertCircle : LoaderCircle;
  const busy = !current || data?.status === 'pending';

  return (
    <div role="status" aria-live="polite" className="mx-3 mb-3 flex shrink-0 items-center gap-2 rounded-[10px] border border-[var(--border-subtle)] px-3 py-2 text-[12px] text-token-secondary">
      <Icon aria-hidden="true" size={14} className={busy ? 'shrink-0 animate-spin' : 'shrink-0'} />
      <span className="min-w-0 flex-1">
        {current?.error ?? data?.displayMessage ?? '正在读取知识库问答索引状态…'}
        {data?.errorMessage && <span className="ml-1">{data.errorMessage}</span>}
      </span>
      {current?.error && (
        <button type="button" className="shrink-0 underline" onClick={() => setCheckVersion(v => v + 1)}>
          重新查看
        </button>
      )}
    </div>
  );
}
