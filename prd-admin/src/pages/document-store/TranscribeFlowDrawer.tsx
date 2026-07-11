import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, Check, ChevronRight, X } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { useSseStream } from '@/lib/useSseStream';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { api } from '@/services/api';
import { transcribeEntry, getAgentRun, uploadDocumentFile } from '@/services';
import type { DocumentEntry } from '@/services/contracts/documentStore';
import { deriveTranscribeSteps, type TranscribeStepState } from './transcribeFlowSteps';

/**
 * 录音转录全链路（Notion 式）：上传音频 → 转录 → 生成摘要 → 保存笔记。
 * 参照 Notion 移动端会议录音流程：一张卡承载全流程，阶段清单逐项点亮，
 * 摘要流式生长（产物即体验），完成后一键打开转录笔记。
 *
 * 两种进入方式：
 * - 传 file（新上传录音）：卡内先执行上传，再自动发起转录；
 * - 传 entryId（已有音/视频条目）：上传步直接标记完成，从转录开始。
 *
 * 移动端为底部弹层（bottom sheet），桌面端为右侧抽屉。
 */
export type TranscribeFlowDrawerProps = {
  storeId: string;
  /** 新上传录音场景：待上传的音频文件 */
  file?: File | null;
  /** 已有条目场景：源音/视频 entry */
  entryId?: string;
  entryTitle: string;
  onClose: () => void;
  /** 上传成功后回调（新 entry 注入父页面列表） */
  onEntryCreated?: (entry: DocumentEntry) => void;
  /** 完成后回调（父页面刷新列表） */
  onDone?: (outputEntryId: string) => void;
  /** 「查看转录笔记」跳转 */
  onOpenEntry?: (entryId: string) => void;
  /**
   * run 跟踪回调：runId 就绪时上报、run 到达终态（done/failed）时报 null。
   * 父页面据此在「后台运行」关闭抽屉后继续看护该 run（轮询到终态刷新列表），
   * 否则后台完成的转录笔记要手动刷新才出现（Codex P2）。
   */
  onRunTracking?: (runId: string | null) => void;
};

type StepState = TranscribeStepState;

export function TranscribeFlowDrawer({
  storeId,
  file,
  entryId: initialEntryId,
  entryTitle,
  onClose,
  onEntryCreated,
  onDone,
  onOpenEntry,
  onRunTracking,
}: TranscribeFlowDrawerProps) {
  const isMobile = useIsMobile();
  const [entryId, setEntryId] = useState<string | null>(initialEntryId ?? null);
  const [runId, setRunId] = useState<string | null>(null);
  const [phase, setPhase] = useState('排队中');
  const [status, setStatus] = useState<'uploading' | 'running' | 'done' | 'failed'>(file ? 'uploading' : 'running');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [summaryText, setSummaryText] = useState('');
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [outputEntryId, setOutputEntryId] = useState<string | null>(null);
  const hasStartedRef = useRef(false);

  const streamUrl = useMemo(
    () => (runId ? `${api.documentStore.stores.agentRunStream(runId)}?afterSeq=0` : ''),
    [runId],
  );

  const { start, abort } = useSseStream({
    url: streamUrl,
    onEvent: {
      progress: (data) => {
        const d = data as { progress?: number; phase?: string };
        if (d.phase) setPhase(d.phase);
      },
      delta: (data) => {
        const d = data as { text?: string };
        if (d.text) setSummaryText(prev => prev + d.text);
      },
      summaryError: () => setSummaryFailed(true),
      done: (data) => {
        const d = data as { outputEntryId?: string; generatedText?: string };
        setPhase('完成');
        setStatus('done');
        if (d.generatedText) setSummaryText(d.generatedText);
        if (d.outputEntryId) {
          setOutputEntryId(d.outputEntryId);
          onDone?.(d.outputEntryId);
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

  // 兜底拉一次 run 状态（SSE 漏事件 / 任务已完成的场景）
  const refreshRun = useCallback(async (rid: string) => {
    const res = await getAgentRun(rid);
    if (!res.success) return;
    const r = res.data;
    if (r.phase) setPhase(r.phase);
    if (r.status === 'done') {
      setStatus('done');
      if (r.generatedText) setSummaryText(r.generatedText);
      if (r.outputEntryId) {
        setOutputEntryId(r.outputEntryId);
        onDone?.(r.outputEntryId);
      }
    } else if (r.status === 'failed') {
      setStatus('failed');
      const fullErr = r.errorMessage ?? '任务失败';
      const diagIdx = fullErr.indexOf('\n\n[diagnostic]\n');
      setErrorMessage(diagIdx >= 0 ? fullErr.slice(0, diagIdx) : fullErr);
    }
  }, [onDone]);

  const startTranscribe = useCallback(async (targetEntryId: string) => {
    setStatus('running');
    setErrorMessage(null);
    const res = await transcribeEntry(targetEntryId);
    if (!res.success) {
      setStatus('failed');
      setErrorMessage(res.error?.message ?? '启动转录失败');
      return;
    }
    // 命令式上报（不依赖 effect）：上传期间用户点「后台运行」关闭抽屉后，
    // 本协程仍会继续到这里，但组件已卸载、effect 不再执行——直接调用回调
    // 让父页面拿到迟到的 runId 接手看护（Codex P2）
    onRunTracking?.(res.data.runId);
    setRunId(res.data.runId);
    void refreshRun(res.data.runId);
  }, [refreshRun, onRunTracking]);

  // 打开即启动：先上传（如有 file），再发起转录
  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;
    (async () => {
      let targetEntryId = initialEntryId ?? null;
      if (file) {
        setStatus('uploading');
        const res = await uploadDocumentFile(storeId, file);
        if (!res.success) {
          setStatus('failed');
          setErrorMessage(res.error?.message ?? '录音上传失败');
          return;
        }
        targetEntryId = res.data.entry.id;
        setEntryId(targetEntryId);
        onEntryCreated?.(res.data.entry);
      }
      if (!targetEntryId) {
        setStatus('failed');
        setErrorMessage('缺少源音频条目');
        return;
      }
      await startTranscribe(targetEntryId);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // runId 就绪后订阅 SSE
  useEffect(() => {
    if (!runId) return;
    void start();
    return () => abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // 向父页面上报 run 跟踪状态：进行中报 runId、终态报 null（幂等，重复调用无副作用）
  useEffect(() => {
    if (!onRunTracking) return;
    const terminal = status === 'done' || status === 'failed';
    onRunTracking(terminal ? null : runId);
  }, [runId, status, onRunTracking]);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── 四步清单的状态推导（纯函数，见 transcribeFlowSteps.ts，单测覆盖） ──
  const steps = useMemo(
    () => deriveTranscribeSteps({
      status,
      phase,
      hasFile: !!file,
      hasEntry: !!entryId,
      summaryFailed,
    }),
    [status, phase, entryId, file, summaryFailed],
  );

  const running = status === 'uploading' || status === 'running';

  const body = (
    <>
      {/* 阶段清单（Notion 式逐项点亮） */}
      <div className="space-y-2.5">
        {steps.map((s) => (
          <div key={s.key} className="flex items-center gap-2.5">
            <StepIcon state={s.state} />
            <div className="min-w-0">
              <span
                className="text-[13px]"
                style={{
                  color: s.state === 'pending'
                    ? 'var(--text-muted)'
                    : s.state === 'failed'
                      ? 'rgba(248,113,113,0.95)'
                      : 'var(--text-primary)',
                  fontWeight: s.state === 'active' ? 600 : 400,
                }}>
                {s.label}
              </span>
              {s.sub && (
                <span className="ml-2 text-[11px] text-token-muted">{s.sub}</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 摘要流式生长区（产物即体验：等待期主视觉是摘要本身在长） */}
      {summaryText && (
        <div className="surface-inset rounded-[12px] p-3.5">
          <p className="mb-2 text-[11px] font-semibold text-token-muted">摘要</p>
          <div className="text-[13px] leading-relaxed text-token-primary">
            <StreamingText
              text={summaryText}
              streaming={running}
              block
              animateTailChars={160}
            />
          </div>
        </div>
      )}

      {/* 失败信息 */}
      {status === 'failed' && errorMessage && (
        <div
          className="rounded-[10px] p-3 text-[12px]"
          style={{
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            color: 'rgba(248,113,113,0.95)',
          }}>
          <div className="whitespace-pre-wrap break-all">{errorMessage}</div>
        </div>
      )}

      {/* 完成后的产物直达 */}
      {status === 'done' && outputEntryId && (
        <button
          onClick={() => {
            onOpenEntry?.(outputEntryId);
            onClose();
          }}
          className="flex w-full cursor-pointer items-center justify-between rounded-[12px] px-4 py-3 transition-colors"
          style={{
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.2)',
          }}>
          <span className="text-[13px] font-semibold" style={{ color: 'rgba(74,222,128,0.95)' }}>
            查看转录笔记
          </span>
          <ChevronRight size={15} style={{ color: 'rgba(74,222,128,0.95)' }} />
        </button>
      )}
    </>
  );

  const header = (
    <div className="flex items-center justify-between">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="surface-action-accent flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]">
          <AudioLines size={15} />
        </div>
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-token-primary">录音转录</p>
          <p className="truncate text-[11px] text-token-muted">{entryTitle}</p>
        </div>
      </div>
      <button
        onClick={onClose}
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted hover:bg-white/6">
        <X size={15} />
      </button>
    </div>
  );

  const footer = (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-token-muted">
        {running ? '可关闭面板，任务在后台继续' : ''}
      </span>
      <div className="flex items-center gap-2">
        {status === 'failed' && entryId && (
          <Button variant="primary" size="sm" onClick={() => { void startTranscribe(entryId); }}>
            重试转录
          </Button>
        )}
        <Button variant={status === 'done' ? 'primary' : 'ghost'} size="sm" onClick={onClose}>
          {running ? '后台运行' : '关闭'}
        </Button>
      </div>
    </div>
  );

  // 移动端底部弹层 / 桌面右侧抽屉。尺寸关键属性走 inline style（frontend-modal 规则）。
  const overlay = (
    <motion.div
      className={`surface-backdrop fixed inset-0 z-[100] flex ${isMobile ? 'items-end' : 'justify-end'}`}
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      exit={{ backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.2 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <motion.div
        className={`surface-popover flex flex-col ${isMobile ? 'w-full rounded-t-[18px]' : 'h-full w-[440px] max-w-[92vw] border-l border-token-subtle'}`}
        style={isMobile ? { maxHeight: '86vh', paddingBottom: 'env(safe-area-inset-bottom)' } : undefined}
        initial={isMobile ? { y: '100%' } : { x: '100%' }}
        animate={isMobile ? { y: 0 } : { x: 0 }}
        exit={isMobile ? { y: '100%' } : { x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        onClick={(e) => e.stopPropagation()}>
        {isMobile && (
          <div className="flex justify-center pt-2.5">
            <div className="h-1 w-9 rounded-full bg-white/15" />
          </div>
        )}
        <div className={`shrink-0 ${isMobile ? 'px-4 py-3' : 'surface-panel-header px-5 py-4'}`}>{header}</div>
        <div
          className={`flex-1 space-y-4 ${isMobile ? 'px-4 pb-2' : 'px-5 py-5'}`}
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {body}
        </div>
        <div
          className={`shrink-0 ${isMobile ? 'px-4 pb-4 pt-3' : 'px-5 pt-4 pb-20'}`}
          style={{ borderTop: '1px solid var(--border-faint)' }}>
          {footer}
        </div>
      </motion.div>
    </motion.div>
  );

  return createPortal(overlay, document.body);
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <span
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full"
        style={{ background: 'rgba(34,197,94,0.15)', color: 'rgba(74,222,128,0.95)' }}>
        <Check size={12} strokeWidth={2.5} />
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
        <MapSpinner size={14} />
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full"
        style={{ background: 'rgba(239,68,68,0.14)', color: 'rgba(248,113,113,0.95)' }}>
        <X size={12} strokeWidth={2.5} />
      </span>
    );
  }
  return (
    <span
      className="h-5 w-5 flex-shrink-0 rounded-full"
      style={{ border: '1.5px dashed var(--border-faint)' }}
    />
  );
}
