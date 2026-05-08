import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, X, CheckCircle2, AlertCircle, Copy, ChevronDown } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
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
        <div className="px-5 pt-4 pb-20 flex items-center justify-between gap-2"
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <span className="text-[11px] text-token-muted">
            {status === 'running' || status === 'idle' ? '可关闭抽屉后台继续运行' : ''}
          </span>
          <Button variant={status === 'done' ? 'primary' : 'ghost'} size="sm" onClick={onClose}>
            {status === 'done' || status === 'failed' ? '关闭' : '后台运行'}
          </Button>
        </div>
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
    <div className="mt-2 rounded-[8px]"
      style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11px]"
        style={{ color: 'rgba(255,255,255,0.7)' }}
      >
        <span className="flex items-center gap-1.5 font-semibold">
          <ChevronDown size={11} style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 0.2s' }} />
          调试诊断信息（点击{expanded ? '收起' : '展开'}）
        </span>
        <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.4)' }}>
          {diagnostic.stage ?? ''}
        </span>
      </button>
      {expanded && (
        <div className="px-2.5 pb-2.5 space-y-1.5 text-[11px]" style={{ color: 'rgba(255,255,255,0.85)' }}>
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
            <div className="mt-2 p-2 rounded text-[11px] whitespace-pre-wrap break-all"
              style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.85)' }}>
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
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px]"
                style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)' }}
              >
                <Copy size={10} /> 复制 wscat 命令
              </button>
            )}
            <button
              type="button"
              onClick={() => copy(fullJson, '完整 diagnostic JSON')}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px]"
              style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)' }}
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
      <span className="shrink-0 w-[88px] text-[10px]" style={{ color: 'rgba(255,255,255,0.5)' }}>{label}</span>
      <span className={`flex-1 break-all ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}
