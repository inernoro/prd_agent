import { useEffect, useRef } from 'react';
import { useSseStream } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { getAgentRun } from '@/services';
import { useReprocessRunStore } from '@/stores/reprocessRunStore';

/**
 * 无 UI 的「文档再加工」SSE 宿主。
 *
 * 由 DocumentStorePage 为每个 status==='streaming' 的 run 各挂一个，生命周期
 * 与 ReprocessDrawer 完全解耦 —— 关抽屉只是隐藏视图，本宿主仍在订阅，完成后
 * 照样刷新文件树。刷新页面后由 store 从 sessionStorage 恢复 runId，本宿主
 * mount 时先 getAgentRun 判终态，未终态再 afterSeq=0 重连续传。
 */
export function ReprocessRunHost({
  runId,
  onCompleted,
}: {
  runId: string;
  /** 任务到达终态时触发一次（done 带 outputEntryId）。用于刷新文件树 + 选中新文档。 */
  onCompleted: (status: 'done' | 'failed', outputEntryId?: string) => void;
}) {
  const patchRun = useReprocessRunStore((s) => s.patchRun);
  const streamedRef = useRef('');
  const completedRef = useRef(false);

  const finish = (status: 'done' | 'failed', outputEntryId?: string) => {
    if (completedRef.current) return;
    completedRef.current = true;
    onCompleted(status, outputEntryId);
  };

  const { start, abort } = useSseStream({
    url: `${api.documentStore.stores.agentRunStream(runId)}?afterSeq=0`,
    onEvent: {
      chunk: (data) => {
        const d = data as { text?: string };
        if (d.text) {
          streamedRef.current += d.text;
          patchRun(runId, { streamedText: streamedRef.current });
        }
      },
      progress: (data) => {
        const d = data as { progress?: number; phase?: string };
        patchRun(runId, {
          ...(typeof d.progress === 'number' ? { progress: d.progress } : {}),
          ...(d.phase ? { phase: d.phase } : {}),
        });
      },
      done: (data) => {
        const d = data as { outputEntryId?: string; generatedText?: string };
        if (d.generatedText) streamedRef.current = d.generatedText;
        patchRun(runId, {
          status: 'done',
          progress: 100,
          phase: '完成',
          streamedText: streamedRef.current,
          outputEntryId: d.outputEntryId,
        });
        finish('done', d.outputEntryId);
      },
      // 注意：SSE 的 error 事件由 useSseStream 内置分发给 onError（已做 message ||
      // errorMessage || '出错' 提取），这里不再单独挂 onEvent.error，否则会用更弱的
      // 文案二次覆盖 errorMessage（Bugbot 报告）。
    },
    onError: (msg) => {
      patchRun(runId, { status: 'failed', errorMessage: msg });
      finish('failed');
    },
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 先拉当前状态：刷新后判断是否已终态（已完成则无需再连 SSE）
      const res = await getAgentRun(runId);
      if (cancelled) return;
      if (res.success) {
        const run = res.data;
        if (typeof run.progress === 'number') patchRun(runId, { progress: run.progress });
        if (run.phase) patchRun(runId, { phase: run.phase });
        if (run.status === 'done') {
          if (run.generatedText) {
            streamedRef.current = run.generatedText;
            patchRun(runId, { streamedText: run.generatedText });
          }
          patchRun(runId, { status: 'done', progress: 100, phase: '完成', outputEntryId: run.outputEntryId });
          finish('done', run.outputEntryId);
          return;
        }
        if (run.status === 'failed' || run.status === 'cancelled') {
          patchRun(runId, { status: 'failed', errorMessage: run.errorMessage ?? '任务失败' });
          finish('failed');
          return;
        }
      }
      // 仍在进行 → afterSeq=0 重连，回放全部事件重建文本。
      // 回放会把 chunk 从头再追一遍，故清零本地缓冲避免与已有内容叠加重复。
      if (cancelled) return;
      streamedRef.current = '';
      patchRun(runId, { streamedText: '' });
      void start();
    })();
    return () => {
      cancelled = true;
      abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return null;
}
