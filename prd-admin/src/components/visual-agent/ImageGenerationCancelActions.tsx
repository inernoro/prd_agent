import { useState } from 'react';
import { cancelImageGenRun } from '@/services';
import { toUserReadableErrorMessage } from '@/lib/userReadableError';

type ActiveCanvasItem = { status?: string; runId?: string; prompt?: string };

/** 只发送取消指令；运行终态继续由服务端事件回填画布。 */
export function ImageGenerationCancelActions({ items }: { items: readonly ActiveCanvasItem[] }) {
  const [requestingId, setRequestingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runs = [...new Map(items.filter((item) => item.status === 'running' && item.runId?.trim())
    .map((item) => [item.runId!.trim(), item] as const)).entries()];
  if (runs.length === 0) return null;

  async function cancel(runId: string) {
    setRequestingId(runId);
    setError(null);
    try {
      const result = await cancelImageGenRun({ runId });
      if (!result.success) {
        setError(toUserReadableErrorMessage(result.error, {
          fallbackMessage: '取消请求未完成', recoveryMessage: '请重试；若任务已经结束，请以任务结果为准',
        }));
      }
    } catch (cause) {
      setError(toUserReadableErrorMessage(cause, {
        fallbackMessage: '取消请求未完成', recoveryMessage: '请重试；若持续出现，请联系管理员',
      }));
    } finally {
      setRequestingId(null);
    }
  }

  return (
    <div className="mt-2 shrink-0 space-y-1" role="group" aria-label="正在生成的任务">
      {runs.map(([runId, item], index) => (
        <div key={runId} className="flex min-w-0 items-center gap-2 text-xs text-token-muted">
          <span className="min-w-0 flex-1 truncate" title={item.prompt}>生成任务 {index + 1}：{item.prompt || '图片'}</span>
          <button type="button" className="surface-action shrink-0 rounded-full px-3 py-1 disabled:opacity-50"
            disabled={requestingId !== null} onClick={() => void cancel(runId)}
            aria-label={`取消生成 ${index + 1}`}>
            {requestingId === runId ? '正在取消…' : '取消生成'}
          </button>
        </div>
      ))}
      {error && <p role="alert" className="text-xs text-token-error">{error}</p>}
    </div>
  );
}
