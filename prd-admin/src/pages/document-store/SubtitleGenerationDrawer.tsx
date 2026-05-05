import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X, CheckCircle2, AlertCircle, Settings2 } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useSseStream } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { generateSubtitle, getAgentRun } from '@/services';
import type { DocumentStoreAgentRun } from '@/services/contracts/documentStore';
import { toast } from '@/lib/toast';
import { AsrSetupDialog } from './AsrSetupDialog';

const PHASES = ['排队中', '准备中', '下载素材', '提取音轨', '音频转码', '解析音频', '视觉识别中', '识别中', '写入中', '完成'];

/** 错误信息含这些关键词时，提示用户去配置 ASR */
const ASR_CONFIG_HINTS = ['ASR 模型调度', 'ASR 模型', 'MODEL_NOT_FOUND', '没有可用的模型', '模型池', 'API Key'];

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
  /** ETA 分级提示（识别中卡住超过若干秒时给出阶梯提示） */
  const [etaTier, setEtaTier] = useState<0 | 1 | 2 | 3>(0);
  const phaseStartedAtRef = useRef<number>(Date.now());
  /** ASR 配置子对话框 */
  const [showAsrSetup, setShowAsrSetup] = useState(false);

  const showAsrConfigHint = useMemo(() => {
    if (!errorMessage) return false;
    return ASR_CONFIG_HINTS.some((kw) => errorMessage.includes(kw));
  }, [errorMessage]);

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
        if (d.phase) {
          setPhase(d.phase);
          phaseStartedAtRef.current = Date.now();
          setEtaTier(0);
        }
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

  // 当前阶段卡住超 15s/40s/90s 时，分级提示用户「正在等大模型，没卡死」
  useEffect(() => {
    if (status !== 'running') return;
    const tick = () => {
      const elapsedSec = (Date.now() - phaseStartedAtRef.current) / 1000;
      if (elapsedSec >= 90) setEtaTier(3);
      else if (elapsedSec >= 40) setEtaTier(2);
      else if (elapsedSec >= 15) setEtaTier(1);
      else setEtaTier(0);
    };
    const id = window.setInterval(tick, 2000);
    return () => window.clearInterval(id);
  }, [status, phase]);

  const etaHint = useMemo(() => {
    if (status !== 'running') return null;
    if (etaTier === 0) return null;
    if (etaTier === 1) return `「${phase}」处理中，长录音通常需要 30~60 秒，请稍候…`;
    if (etaTier === 2) return `仍在「${phase}」，模型正在解析较长音频。后台会持续推进，关闭页面也不会中断。`;
    return `「${phase}」耗时较久（>90s），可能是上游高峰或音频较长。如果长时间无响应，可在后台重试或换一个 ASR 模型。`;
  }, [status, etaTier, phase]);

  const phaseIndex = useMemo(() => {
    const idx = PHASES.findIndex((p) => p === phase);
    return idx >= 0 ? idx : 0;
  }, [phase]);

  return (
    <div className="surface-backdrop fixed inset-0 z-50 flex justify-end"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="surface-popover flex h-full w-[440px] max-w-[92vw] flex-col border-l border-token-subtle">

        {/* Header */}
        <div className="surface-panel-header flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="surface-action-accent flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]">
              <Sparkles size={15} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-token-primary">
                生成字幕
              </p>
              <p className="truncate text-[10px] text-token-muted">
                {entryTitle}
              </p>
            </div>
          </div>
          <button onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted hover:bg-white/6">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          {/* 状态卡 */}
          <div className="surface-inset rounded-[12px] p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold text-token-muted">当前状态</span>
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
              <div className="bg-token-nested h-2 overflow-hidden rounded-full">
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
                <span className="text-[11px] font-semibold text-token-primary">{phase}</span>
                <span className="text-[10px] text-token-muted">{progress}%</span>
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

          {/* ETA 分级提示 */}
          {etaHint && (
            <div className="p-3 rounded-[10px] text-[11px] leading-relaxed"
              style={{
                background: 'rgba(59,130,246,0.06)',
                border: '1px solid rgba(59,130,246,0.18)',
                color: 'rgba(147,197,253,0.95)',
              }}>
              {etaHint}
            </div>
          )}

          {/* 失败时显示错误 */}
          {status === 'failed' && errorMessage && (
            <div className="space-y-2">
              <div className="p-3 rounded-[10px] text-[11px] break-all"
                style={{
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  color: 'rgba(248,113,113,0.95)',
                }}>
                {errorMessage}
              </div>
              {showAsrConfigHint && (
                <button
                  onClick={() => setShowAsrSetup(true)}
                  className="surface-action flex w-full items-center justify-center gap-2 rounded-[10px] py-2 text-[12px] font-semibold text-token-primary transition-colors hover:bg-white/8"
                >
                  <Settings2 size={12} />
                  去配置 OpenRouter ASR
                </button>
              )}
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

      {/* ASR 配置子对话框 */}
      {showAsrSetup && (
        <AsrSetupDialog
          onClose={() => setShowAsrSetup(false)}
          onConfigured={() => {
            // 配置完成后允许用户重新触发
            toast.info('已重新配置 ASR', '你可以关闭本弹窗再次点击"生成字幕"');
          }}
        />
      )}
    </div>
  );
}
