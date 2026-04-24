import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useSseStream } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { generateSubtitle, getAgentRun } from '@/services';
import type { DocumentStoreAgentRun } from '@/services/contracts/documentStore';
import { toast } from '@/lib/toast';

const PHASES = ['排队中', '准备中', '下载素材', '提取音轨', '解析音频', '视觉识别中', '识别中', '写入中', '完成'];

export type SubtitleGenerationDrawerProps = {
  entryId: string;
  entryTitle: string;
  onClose: () => void;
  /** 完成后回调，用于父页面刷新 entries 列表 */
  onDone?: (outputEntryId: string) => void;
};

export function SubtitleGenerationDrawer({
  entryId,
  entryTitle,
  onClose,
  onDone,
}: SubtitleGenerationDrawerProps) {
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<DocumentStoreAgentRun | null>(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState('排队中');
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const hasStartedRef = useRef(false);

  // SSE 流（runId 决定 URL）
  const streamUrl = useMemo(
    () => (runId ? `${api.documentStore.stores.agentRunStream(runId)}?afterSeq=0` : ''),
    [runId],
  );

  const { start, abort } = useSseStream({
    url: streamUrl,
    onEvent: {
      progress: (data) => {
        const d = data as { progress?: number; phase?: string };
        if (typeof d.progress === 'number') setProgress(d.progress);
        if (d.phase) setPhase(d.phase);
      },
      done: (data) => {
        setProgress(100);
        setPhase('完成');
        setStatus('done');
        const d = data as { outputEntryId?: string };
        if (d.outputEntryId) {
          onDone?.(d.outputEntryId);
          toast.success('字幕生成完成', '已保存为新文档');
        }
      },
      error: (data) => {
        const d = data as { message?: string };
        setStatus('failed');
        setErrorMessage(d.message ?? '未知错误');
      },
    },
    onError: (msg) => {
      setStatus('failed');
      setErrorMessage(msg);
    },
  });

  // 轮询一次 run 当前状态（避免 SSE 漏掉已完成的任务）
  const refreshRun = useCallback(async (rid: string) => {
    const res = await getAgentRun(rid);
    if (res.success) {
      setRun(res.data);
      setProgress(res.data.progress ?? 0);
      if (res.data.phase) setPhase(res.data.phase);
      if (res.data.status === 'done') {
        setStatus('done');
        if (res.data.outputEntryId) onDone?.(res.data.outputEntryId);
      } else if (res.data.status === 'failed') {
        setStatus('failed');
        setErrorMessage(res.data.errorMessage ?? '任务失败');
      } else if (res.data.status === 'running') {
        setStatus('running');
      }
    }
  }, [onDone]);

  // Drawer 打开时自动启动任务
  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;
    (async () => {
      setStarting(true);
      const res = await generateSubtitle(entryId);
      setStarting(false);
      if (!res.success) {
        setStatus('failed');
        setErrorMessage(res.error?.message ?? '启动任务失败');
        return;
      }
      setRunId(res.data.runId);
      setStatus('running');
      // 先拉一次当前状态（万一任务已经跑完）
      void refreshRun(res.data.runId);
    })();
  }, [entryId, refreshRun]);

  // runId 就绪后订阅 SSE
  useEffect(() => {
    if (!runId) return;
    void start();
    return () => abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const phaseIndex = useMemo(() => {
    const idx = PHASES.findIndex((p) => p === phase);
    return idx >= 0 ? idx : 0;
  }, [phase]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end"
      style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[440px] max-w-[92vw] h-full flex flex-col"
        style={{
          background: 'linear-gradient(180deg, var(--glass-bg-start) 0%, var(--glass-bg-end) 100%)',
          borderLeft: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(40px) saturate(180%)',
          boxShadow: '-24px 0 48px -12px rgba(0,0,0,0.5)',
        }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.18)' }}>
              <Sparkles size={15} style={{ color: 'rgba(216,180,254,0.9)' }} />
            </div>
            <div className="min-w-0">
              <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                生成字幕
              </p>
              <p className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                {entryTitle}
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-[8px] flex items-center justify-center cursor-pointer hover:bg-white/6"
            style={{ color: 'var(--text-muted)' }}>
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          {/* 状态卡 */}
          <div className="p-4 rounded-[12px]"
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.06)',
            }}>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>当前状态</span>
              {status === 'done' ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(74,222,128,0.95)', border: '1px solid rgba(34,197,94,0.25)' }}>
                  <CheckCircle2 size={10} /> 已完成
                </span>
              ) : status === 'failed' ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(239,68,68,0.12)', color: 'rgba(248,113,113,0.95)', border: '1px solid rgba(239,68,68,0.25)' }}>
                  <AlertCircle size={10} /> 失败
                </span>
              ) : starting ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(148,163,184,0.12)', color: 'rgba(148,163,184,0.95)', border: '1px solid rgba(148,163,184,0.2)' }}>
                  <MapSpinner size={10} /> 启动中
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(59,130,246,0.12)', color: 'rgba(96,165,250,0.95)', border: '1px solid rgba(59,130,246,0.25)' }}>
                  <MapSpinner size={10} /> 处理中
                </span>
              )}
            </div>

            {/* 进度条 */}
            <div className="mb-2">
              <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                <div
                  className="h-full transition-all duration-500"
                  style={{
                    width: `${progress}%`,
                    background: status === 'failed'
                      ? 'linear-gradient(90deg, rgba(239,68,68,0.6), rgba(248,113,113,0.9))'
                      : 'linear-gradient(90deg, rgba(168,85,247,0.6), rgba(216,180,254,0.9))',
                  }}
                />
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>{phase}</span>
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{progress}%</span>
              </div>
            </div>
          </div>

          {/* 阶段指示 */}
          <div>
            <p className="text-[11px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>处理阶段</p>
            <ol className="space-y-1">
              {PHASES.slice(0, PHASES.length - 1).map((p, i) => {
                const active = i === phaseIndex;
                const passed = i < phaseIndex;
                return (
                  <li key={p} className="flex items-center gap-2 text-[11px]"
                    style={{
                      color: active ? 'rgba(216,180,254,0.95)' : passed ? 'rgba(255,255,255,0.5)' : 'var(--text-muted)',
                      fontWeight: active ? 600 : 400,
                    }}>
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{
                        background: active ? 'rgba(216,180,254,0.9)'
                          : passed ? 'rgba(34,197,94,0.6)'
                          : 'rgba(255,255,255,0.15)',
                      }}/>
                    {p}
                  </li>
                );
              })}
            </ol>
          </div>

          {/* 失败时显示错误 */}
          {status === 'failed' && errorMessage && (
            <div className="p-3 rounded-[10px] text-[11px] break-all"
              style={{
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
                color: 'rgba(248,113,113,0.95)',
              }}>
              {errorMessage}
            </div>
          )}

          {/* 完成后的操作 */}
          {status === 'done' && run?.outputEntryId && (
            <div className="p-3 rounded-[10px]"
              style={{
                background: 'rgba(34,197,94,0.06)',
                border: '1px solid rgba(34,197,94,0.15)',
              }}>
              <p className="text-[11px]" style={{ color: 'rgba(74,222,128,0.95)' }}>
                字幕已生成并保存为新文档，你可以在文件树中找到它。
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 flex justify-end gap-2"
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <Button variant="ghost" size="xs" onClick={onClose}>
            {status === 'done' || status === 'failed' ? '关闭' : '后台运行'}
          </Button>
        </div>
      </div>
    </div>
  );
}
