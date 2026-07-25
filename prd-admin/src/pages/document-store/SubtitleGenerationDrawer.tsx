import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X, CheckCircle2, AlertCircle, Copy, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import CountUp from '@/components/reactbits/CountUp';
import SplitText from '@/components/reactbits/SplitText';
import BlurText from '@/components/reactbits/BlurText';
import { useSseStream } from '@/lib/useSseStream';
import { api } from '@/services/api';
import { generateSubtitle, getAgentRun } from '@/services';
import type { DocumentStoreAgentRun } from '@/services/contracts/documentStore';
import { toast } from '@/lib/toast';

/** ASR 调用诊断信息（DoubaoStreamAsrService.AsrDiagnostic 镜像） */
type AsrDiagnostic = {
  stage?: string;
  model?: string;
  platformId?: string;
  platformName?: string;
  exchangeName?: string;
  exchangeTransformerType?: string;
  wsUrl?: string;
  resourceId?: string;
  requestId?: string;
  appKeyPreview?: string;
  accessKeyPreview?: string;
  authMode?: string;
  audio?: { channels?: number; bitsPerSample?: number; sampleRate?: number; pcmBytes?: number; segmentCount?: number };
  handshakeStatusCode?: number | null;
  rawErrorChain?: string;
  friendlyError?: string;
  wscatCommand?: string;
  endpoint?: string;
  baseUrl?: string;
  multipartFields?: Record<string, unknown>;
  statusCode?: number;
  error?: string;
  responseSnippet?: string;
  hint?: string;
};

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
  const [diagnostic, setDiagnostic] = useState<AsrDiagnostic | null>(null);
  const [diagExpanded, setDiagExpanded] = useState(true);
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
        const d = data as { message?: string; diagnostic?: AsrDiagnostic };
        setStatus('failed');
        setErrorMessage(d.message ?? '未知错误');
        if (d.diagnostic) setDiagnostic(d.diagnostic);
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
        // run.errorMessage 后端格式: "<人话>\n\n[diagnostic]\n<json>"
        const fullErr = res.data.errorMessage ?? '任务失败';
        const diagMarker = '\n\n[diagnostic]\n';
        const diagIdx = fullErr.indexOf(diagMarker);
        if (diagIdx >= 0) {
          setErrorMessage(fullErr.slice(0, diagIdx));
          try {
            const parsed = JSON.parse(fullErr.slice(diagIdx + diagMarker.length)) as AsrDiagnostic;
            setDiagnostic(parsed);
          } catch { /* parse error: ignore */ }
        } else {
          setErrorMessage(fullErr);
        }
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
    <motion.div
      className="surface-backdrop fixed inset-0 z-50 flex justify-end"
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      exit={{ backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.2 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <motion.div
        className="surface-popover flex h-full w-[440px] max-w-[92vw] flex-col border-l border-token-subtle"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}>

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
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-[8px] text-token-muted hover-bg-soft">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          {/* 状态卡 */}
          <div className="surface-inset rounded-[12px] p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-semibold text-token-muted">当前状态</span>
              <AnimatePresence mode="wait">
                {status === 'done' ? (
                  <motion.span
                    key="done"
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: 'spring', stiffness: 360, damping: 18 }}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(34,197,94,0.12)', color: 'rgba(74,222,128,0.95)', border: '1px solid rgba(34,197,94,0.25)' }}>
                    <CheckCircle2 size={10} />
                    <SplitText text="已完成" tag="span" delay={40} duration={0.4} from={{ opacity: 0, y: 8 }} to={{ opacity: 1, y: 0 }} />
                  </motion.span>
                ) : status === 'failed' ? (
                  <motion.span
                    key="failed"
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(239,68,68,0.12)', color: 'rgba(248,113,113,0.95)', border: '1px solid rgba(239,68,68,0.25)' }}>
                    <AlertCircle size={10} /> 失败
                  </motion.span>
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
              </AnimatePresence>
            </div>

            {/* 进度条 — done 时短暂流光（克制版，不加礼花） */}
            <div className="mb-2">
              <div className="bg-token-nested h-2 overflow-hidden rounded-full relative">
                <motion.div
                  className="h-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${progress}%` }}
                  transition={{ type: 'spring', stiffness: 80, damping: 20 }}
                  style={{
                    background: status === 'failed'
                      ? 'linear-gradient(90deg, rgba(239,68,68,0.6), rgba(248,113,113,0.9))'
                      : 'linear-gradient(90deg, rgba(168,85,247,0.6), rgba(216,180,254,0.9))',
                  }}
                />
                {/* 完成时进度条上的短暂光泽扫过 */}
                {status === 'done' && (
                  <motion.div
                    className="absolute inset-y-0 w-12 pointer-events-none"
                    initial={{ x: '-100%' }}
                    animate={{ x: '450%' }}
                    transition={{ duration: 1.2, ease: 'easeInOut' }}
                    style={{
                      background: 'linear-gradient(90deg, transparent, var(--nested-block-bg), transparent)',
                      mixBlendMode: 'overlay',
                    }} />
                )}
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <BlurText
                  key={phase}
                  text={phase}
                  className="text-[11px] font-semibold text-token-primary"
                  delay={20}
                />
                <span className="text-[10px] text-token-muted tabular-nums">
                  <CountUp to={progress} from={0} duration={0.8} suffix="%" />
                </span>
              </div>
            </div>
          </div>

          {/* 处理阶段时间线 — 横向圆点连线（取代纵向 bullet 清单） */}
          <div>
            <p className="text-[11px] font-semibold mb-3" style={{ color: 'var(--text-muted)' }}>处理阶段</p>
            <PhaseTimeline phases={PHASES.slice(0, PHASES.length - 1)} currentIndex={phaseIndex} failed={status === 'failed'} />
          </div>

          {/* 失败时显示错误 + 诊断信息 */}
          {status === 'failed' && errorMessage && (
            <div className="p-3 rounded-[10px] text-[11px] space-y-2"
              style={{
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
                color: 'rgba(248,113,113,0.95)',
              }}>
              <div className="break-all whitespace-pre-wrap">{errorMessage}</div>
              {diagnostic && (
                <DiagnosticBlock diagnostic={diagnostic} expanded={diagExpanded} onToggle={() => setDiagExpanded(v => !v)} />
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

        {/* Footer
            paddingBottom 加大到 80px 避开屏幕右下角的全局通知/帮助气泡，避免遮挡按钮
        */}
        <div className="px-5 pt-4 pb-20 flex items-center justify-between gap-2 border-t border-t-token-subtle"
          >
          <span className="text-[11px] text-token-muted">
            {status === 'running' || status === 'idle' ? '可关闭抽屉后台继续运行' : ''}
          </span>
          <Button variant={status === 'done' ? 'primary' : 'ghost'} size="sm" onClick={onClose}>
            {status === 'done' || status === 'failed' ? '关闭' : '后台运行'}
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// 处理阶段横向时间线 — 取代纵向 bullet 清单
// 当前阶段紫色脉冲、已完成绿色实心、未达到灰色虚线
// ─────────────────────────────────────────────────────────────

function PhaseTimeline({ phases, currentIndex, failed }: { phases: string[]; currentIndex: number; failed: boolean }) {
  return (
    <div className="relative">
      {/* 连线背景 */}
      <div className="absolute top-[7px] left-2 right-2 h-px bg-token-nested" />
      {/* 已完成连线（紫色到当前位置） */}
      {currentIndex > 0 && (
        <motion.div
          className="absolute top-[7px] left-2 h-px"
          initial={{ width: 0 }}
          animate={{ width: `calc(${(currentIndex / Math.max(phases.length - 1, 1)) * 100}% - ${currentIndex === phases.length - 1 ? 1 : 0}rem)` }}
          transition={{ type: 'spring', stiffness: 80, damping: 20 }}
          style={{ background: failed ? 'rgba(239,68,68,0.55)' : 'linear-gradient(90deg, rgba(34,197,94,0.55), rgba(216,180,254,0.85))' }}
        />
      )}
      <div className="grid grid-flow-col auto-cols-fr gap-1">
        {phases.map((p, i) => {
          const active = i === currentIndex;
          const passed = i < currentIndex;
          const isLast = i === phases.length - 1;
          const dotColor = failed && active
            ? 'rgba(248,113,113,0.95)'
            : active
              ? 'rgba(216,180,254,0.95)'
              : passed
                ? 'rgba(74,222,128,0.85)'
                : 'rgba(255,255,255,0.18)';
          return (
            <div key={p} className="flex flex-col items-center gap-1.5 relative">
              <div className="relative flex items-center justify-center">
                {active && !failed && (
                  <span
                    className="absolute inline-flex h-3.5 w-3.5 rounded-full"
                    style={{ background: 'rgba(216,180,254,0.4)', animation: 'ping 1.4s cubic-bezier(0,0,0.2,1) infinite' }}
                  />
                )}
                <motion.span
                  className="relative inline-flex h-3.5 w-3.5 rounded-full items-center justify-center"
                  initial={false}
                  animate={{ scale: active ? 1.1 : 1, background: dotColor }}
                  transition={{ duration: 0.25 }}
                  style={{ background: dotColor }}>
                  {passed && (
                    <svg width="7" height="7" viewBox="0 0 7 7" fill="none">
                      <path d="M1.5 3.5L3 5L5.5 2" stroke="rgba(0,0,0,0.6)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </motion.span>
              </div>
              <span
                className="text-[9px] text-center leading-tight whitespace-nowrap overflow-hidden text-ellipsis"
                style={{
                  color: active ? 'rgba(216,180,254,0.95)' : passed ? 'var(--text-secondary)' : 'var(--text-muted)',
                  fontWeight: active ? 600 : 400,
                  maxWidth: isLast ? '4.5em' : '4em',
                }}
                title={p}>
                {p}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 诊断信息展示组件 — 把后端透传的 diagnostic 一字段不漏地呈现给用户
// ─────────────────────────────────────────────────────────────

function DiagnosticBlock({
  diagnostic,
  expanded,
  onToggle,
}: {
  diagnostic: AsrDiagnostic;
  expanded: boolean;
  onToggle: () => void;
}) {
  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} 已复制`),
      () => toast.error('复制失败'),
    );
  };

  const fullJson = useMemo(() => JSON.stringify(diagnostic, null, 2), [diagnostic]);

  return (
    <div className="mt-2 rounded-[8px] border border-token-subtle"
      style={{ background: 'var(--nested-block-bg)' }}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px]"
        style={{ color: 'var(--text-secondary)' }}
      >
        <span className="flex items-center gap-1.5 font-semibold">
          <ChevronDown size={11} style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s' }} />
          调试诊断信息（点击{expanded ? '收起' : '展开'}）
        </span>
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {diagnostic.stage ?? ''}
        </span>
      </button>
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5 text-[11px]" style={{ color: 'var(--text-primary)' }}>
          {/* 按重要度分组展示关键字段 */}
          <KV label="模型" value={diagnostic.model} />
          <KV label="平台" value={diagnostic.platformName ? `${diagnostic.platformName} (${diagnostic.platformId ?? '?'})` : diagnostic.platformId} />
          <KV label="Exchange" value={diagnostic.exchangeName ? `${diagnostic.exchangeName} / ${diagnostic.exchangeTransformerType ?? '?'}` : diagnostic.exchangeTransformerType} />
          <KV label="WebSocket URL" value={diagnostic.wsUrl} mono />
          <KV label="HTTP baseUrl" value={diagnostic.baseUrl} mono />
          <KV label="HTTP 端点" value={diagnostic.endpoint} mono />
          <KV label="握手状态码" value={diagnostic.handshakeStatusCode != null ? String(diagnostic.handshakeStatusCode) : undefined} />
          <KV label="HTTP 状态码" value={diagnostic.statusCode != null ? String(diagnostic.statusCode) : undefined} />
          <KV label="ResourceId" value={diagnostic.resourceId} mono />
          <KV label="RequestId" value={diagnostic.requestId} mono />
          <KV label="鉴权模式" value={diagnostic.authMode} />
          <KV label="appKey 预览" value={diagnostic.appKeyPreview} mono />
          <KV label="accessKey 预览" value={diagnostic.accessKeyPreview} mono />
          {diagnostic.audio && (
            <KV
              label="音频参数"
              value={`${diagnostic.audio.channels}ch / ${diagnostic.audio.sampleRate}Hz / ${diagnostic.audio.bitsPerSample}bit · ${diagnostic.audio.pcmBytes} bytes / ${diagnostic.audio.segmentCount} 片`}
            />
          )}
          {diagnostic.responseSnippet && <KV label="响应片段" value={diagnostic.responseSnippet} mono />}
          {diagnostic.rawErrorChain && <KV label="异常链" value={diagnostic.rawErrorChain} mono />}

          {/* 人话翻译 + checklist */}
          {diagnostic.friendlyError && (
            <div className="mt-2 p-2 rounded text-[11px] whitespace-pre-wrap break-all bg-token-nested"
              style={{ color: 'var(--text-primary)' }}>
              {diagnostic.friendlyError}
            </div>
          )}

          {/* HTTP 路径的 hint（baseUrl 配置提示） */}
          {diagnostic.hint && (
            <div className="mt-2 p-2 rounded text-[11px] whitespace-pre-wrap break-all"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', color: 'rgba(252,211,77,0.95)' }}>
              {diagnostic.hint}
            </div>
          )}

          {/* 复制按钮组 */}
          <div className="flex flex-wrap gap-1.5 pt-1.5">
            {diagnostic.wscatCommand && (
              <button
                type="button"
                onClick={() => copy(diagnostic.wscatCommand!, 'wscat 命令')}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-token-nested"
                style={{ color: 'var(--text-primary)' }}
              >
                <Copy size={10} /> 复制 wscat 命令
              </button>
            )}
            <button
              type="button"
              onClick={() => copy(fullJson, '完整 diagnostic JSON')}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-token-nested"
              style={{ color: 'var(--text-primary)' }}
            >
              <Copy size={10} /> 复制完整诊断 JSON
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 leading-tight">
      <span className="shrink-0 w-[88px] text-[10px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className={`flex-1 break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
