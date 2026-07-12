import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, Check, ChevronRight, X } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { useSseStream } from '@/lib/useSseStream';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { MarkdownViewer } from '@/components/file-preview';
import { api } from '@/services/api';
import { transcribeEntry, getAgentRun, uploadDocumentFileWithProgress, listTranscribeStyles, restyleTranscribeRun } from '@/services';
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
  /** 首次转录的整理方式（音频结果区快捷按钮传入；空 = 智能摘要） */
  initialStyle?: import('@/services/real/documentStore').TranscribeStyleParams;
  /** 「换个整理方式」场景：带已完成的转录 run 直接进入 done 态整理面板（不重跑上传/转录） */
  restyleRun?: { runId: string; outputEntryId: string };
  /** 归档目标：库内文件夹列表（提供时 done 面板显示「归档到文件夹」） */
  folders?: { id: string; title: string }[];
  /** 把转录笔记移动到目标文件夹（null = 库根目录） */
  onMoveNote?: (noteEntryId: string, folderId: string | null) => Promise<void>;
  /** 「编辑笔记」：打开笔记并直接进入编辑态（摘要可改） */
  onEditNote?: (noteEntryId: string) => void;
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
  initialStyle,
  restyleRun,
  folders,
  onMoveNote,
  onEditNote,
  onClose,
  onEntryCreated,
  onDone,
  onOpenEntry,
  onRunTracking,
}: TranscribeFlowDrawerProps) {
  const isMobile = useIsMobile();
  const [entryId, setEntryId] = useState<string | null>(initialEntryId ?? null);
  const [runId, setRunId] = useState<string | null>(restyleRun?.runId ?? null);
  const [phase, setPhase] = useState(restyleRun ? '完成' : '排队中');
  const [status, setStatus] = useState<'uploading' | 'running' | 'done' | 'failed'>(
    file ? 'uploading' : restyleRun ? 'done' : 'running');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [summaryText, setSummaryText] = useState('');
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [outputEntryId, setOutputEntryId] = useState<string | null>(restyleRun?.outputEntryId ?? null);
  // restyle 场景挂载时 run 已是终态：跳过对它的首次 SSE 订阅（换方式后订阅新 run）
  const skipInitialSseRef = useRef(!!restyleRun);
  const hasStartedRef = useRef(false);
  const initialStyleRef = useRef(initialStyle);
  // 整理方式（完成后可换风格重新整理，免重跑 ASR）。列表来自后端 SSOT，禁止前端硬编码。
  const [styles, setStyles] = useState<{ key: string; label: string; description: string }[]>([]);
  const [styleKey, setStyleKey] = useState('general');
  const [styleContext, setStyleContext] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [restyleSubmitting, setRestyleSubmitting] = useState(false);
  // 归档到文件夹（第二波：智能文件夹归档的第一步——手选归档）
  const [archiving, setArchiving] = useState(false);
  const [archivedTo, setArchivedTo] = useState<string | null>(null);
  // 上传进度（大录音文件不再"卡住没反馈"）
  const [uploadPercent, setUploadPercent] = useState(0);

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
    const res = await transcribeEntry(targetEntryId, initialStyleRef.current);
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

  // 启动流程：先上传（如有 file），再发起转录。上传失败可重试（网络断开不丢已录数据）。
  const bootstrap = useCallback(async () => {
    let targetEntryId = initialEntryId ?? entryId ?? null;
    if (file && !targetEntryId) {
      setStatus('uploading');
      setErrorMessage(null);
      setUploadPercent(0);
      const res = await uploadDocumentFileWithProgress(storeId, file, setUploadPercent);
      if (!res.success) {
        setStatus('failed');
        setErrorMessage(res.error?.message ?? '录音上传失败（录音数据仍在本机保留，可点击重试）');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, startTranscribe]);

  // 打开即启动（restyle 场景不启动：run 已完成，等用户选方式）
  useEffect(() => {
    if (hasStartedRef.current || restyleRun) return;
    hasStartedRef.current = true;
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // runId 就绪后订阅 SSE（restyle 挂载时的终态 run 跳过首订阅）
  useEffect(() => {
    if (!runId) return;
    if (skipInitialSseRef.current) { skipInitialSseRef.current = false; return; }
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

  // 完成后拉取整理方式列表（懒加载，进入 done 才需要）
  useEffect(() => {
    if (status !== 'done' || styles.length > 0) return;
    void listTranscribeStyles().then((res) => {
      if (res.success) setStyles(res.data.items);
    });
  }, [status, styles.length]);

  // 换个整理方式：免重跑 ASR，新 run 只重生成摘要并原地更新笔记的「摘要」小节
  const startRestyle = useCallback(async () => {
    if (!runId || restyleSubmitting) return;
    setRestyleSubmitting(true);
    try {
      const res = await restyleTranscribeRun(runId, {
        styleKey,
        styleContext: styleContext.trim() || undefined,
        customPrompt: styleKey === 'custom' ? customPrompt.trim() : undefined,
      });
      if (!res.success) {
        setErrorMessage(res.error?.message ?? '发起重新整理失败');
        return;
      }
      abort();
      setSummaryText('');
      setSummaryFailed(false);
      setErrorMessage(null);
      setStatus('running');
      setPhase('排队中');
      onRunTracking?.(res.data.runId);
      setRunId(res.data.runId); // runId 变化触发 SSE 重订阅
    } finally {
      setRestyleSubmitting(false);
    }
  }, [runId, restyleSubmitting, styleKey, styleContext, customPrompt, abort, onRunTracking]);

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

  // ── 流式贴底滚动（业界标准 stick-to-bottom：贴底才自动滚，上滑即打断，回到底部恢复） ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [detached, setDetached] = useState(false);
  const handleBodyScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stickRef.current = nearBottom;
    setDetached(!nearBottom);
  }, []);
  useEffect(() => {
    if (!running || !stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [summaryText, phase, running]);
  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    stickRef.current = true;
    setDetached(false);
  }, []);

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

      {/* 上传进度条：仅上传阶段显示 */}
      {status === 'uploading' && (
        <div>
          <div className="mb-1 flex items-center justify-between text-[11px] text-token-muted">
            <span>正在上传录音</span>
            <span className="tabular-nums">{uploadPercent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{ width: `${uploadPercent}%`, background: 'linear-gradient(90deg, rgba(59,130,246,0.95), rgba(99,102,241,0.95))' }}
            />
          </div>
        </div>
      )}

      {/* 摘要流式生长区（产物即体验：等待期主视觉是摘要本身在长）。
          完成后不在这里展示——完成态的摘要在下方操作区之后以 markdown 渲染（限高内滚），
          保证「查看/换方式/归档」操作不被长摘要顶出屏幕（2026-07-13 用户反馈按钮太靠下）。 */}
      {summaryText && status !== 'done' && (
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

      {/* 换个整理方式：默认智能摘要已生成，这里可换预设风格或自定义要求重新整理（不重跑转录） */}
      {status === 'done' && outputEntryId && styles.length > 0 && (
        <div className="surface-inset rounded-[12px] p-3.5">
          <p className="mb-1 text-[12px] font-semibold text-token-primary">换个整理方式</p>
          <p className="mb-2.5 text-[11px] text-token-muted">
            只重新整理摘要，转录全文保持不动；原摘要可在文档「历史版本」中找回。
          </p>
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {styles.map((s) => {
              const active = s.key === styleKey;
              return (
                <button
                  key={s.key}
                  onClick={() => setStyleKey(s.key)}
                  title={s.description}
                  className="cursor-pointer rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors"
                  style={active
                    ? { background: 'rgba(59,130,246,0.18)', color: 'rgba(147,197,253,0.98)', boxShadow: 'inset 0 0 0 1px rgba(59,130,246,0.45)' }
                    : { background: 'var(--bg-elevated, rgba(255,255,255,0.06))', color: 'var(--text-muted)' }}>
                  {s.label}
                </button>
              );
            })}
          </div>
          {styleKey === 'custom' && (
            <textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={3}
              placeholder="描述你想要的整理方式，例如：按时间线整理成流水记录，标注每件事的相关人。"
              className="mb-2 w-full resize-none rounded-[10px] px-3 py-2 text-[12px] text-token-primary outline-none"
              style={{ background: 'var(--bg-input, rgba(255,255,255,0.05))', border: '1px solid var(--border-faint)' }}
            />
          )}
          <input
            value={styleContext}
            onChange={(e) => setStyleContext(e.target.value)}
            placeholder="补充背景（可选），例如：参会人：张三、李四；主题：季度复盘"
            className="mb-2.5 w-full rounded-[10px] px-3 py-2 text-[12px] text-token-primary outline-none"
            style={{ background: 'var(--bg-input, rgba(255,255,255,0.05))', border: '1px solid var(--border-faint)' }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={restyleSubmitting || (styleKey === 'custom' && !customPrompt.trim())}
            onClick={() => { void startRestyle(); }}>
            {restyleSubmitting ? <MapSpinner size={12} /> : null} 按此方式重新整理
          </Button>
        </div>
      )}

      {/* 归档到文件夹：默认跟随源音频位置，可现在归档到指定文件夹 */}
      {status === 'done' && outputEntryId && onMoveNote && (folders?.length ?? 0) > 0 && (
        <div className="surface-inset rounded-[12px] p-3.5">
          <p className="mb-1 text-[12px] font-semibold text-token-primary">归档到文件夹</p>
          <p className="mb-2 text-[11px] text-token-muted">默认跟随源音频所在位置，选择后立即移动转录笔记。</p>
          <div className="flex items-center gap-2">
            <select
              disabled={archiving}
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (!v || !outputEntryId) return;
                setArchiving(true);
                const target = v === '__root__' ? null : v;
                const label = v === '__root__' ? '库根目录' : (folders!.find(f => f.id === v)?.title ?? '目标文件夹');
                void onMoveNote(outputEntryId, target)
                  .then(() => setArchivedTo(label))
                  .catch(() => setArchivedTo(null))
                  .finally(() => setArchiving(false));
              }}
              className="w-full cursor-pointer rounded-[10px] px-3 py-2 text-[12px] text-token-primary outline-none"
              style={{ background: 'var(--bg-input, rgba(255,255,255,0.05))', border: '1px solid var(--border-faint)' }}>
              <option value="">选择文件夹…</option>
              <option value="__root__">库根目录</option>
              {folders!.map(f => <option key={f.id} value={f.id}>{f.title}</option>)}
            </select>
            {archiving && <MapSpinner size={13} />}
          </div>
          {archivedTo && (
            <p className="mt-1.5 text-[11px]" style={{ color: 'rgba(74,222,128,0.95)' }}>已归档到「{archivedTo}」</p>
          )}
        </div>
      )}

      {/* 完成态摘要预览：markdown 渲染 + 限高内滚（不把上方操作区顶出屏幕）+ 可编辑 */}
      {status === 'done' && summaryText && (
        <div className="surface-inset rounded-[12px] p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-semibold text-token-muted">摘要（已保存到笔记）</p>
            {outputEntryId && onEditNote && (
              <button
                onClick={() => { onEditNote(outputEntryId); onClose(); }}
                className="cursor-pointer rounded-[7px] px-2 py-0.5 text-[11px] font-semibold transition-colors hover:bg-white/8"
                style={{ color: 'var(--accent-primary, rgba(96,165,250,0.95))' }}>
                编辑笔记
              </button>
            )}
          </div>
          <div style={{ maxHeight: 220, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            <MarkdownViewer content={summaryText} />
          </div>
        </div>
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
        {/* 上传阶段失败（网络断开等）：录音 File 还在内存/本机保险箱，直接重试整条链路 */}
        {status === 'failed' && !entryId && file && (
          <Button variant="primary" size="sm" onClick={() => { void bootstrap(); }}>
            重试上传
          </Button>
        )}
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
        <div className="relative flex-1" style={{ minHeight: 0 }}>
          <div
            ref={scrollRef}
            onScroll={handleBodyScroll}
            className={`h-full space-y-4 ${isMobile ? 'px-4 pb-2' : 'px-5 py-5'}`}
            style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {body}
          </div>
          {/* 流式期间用户上滑打断自动跟随 → 浮出「回到底部」，点它恢复跟随（stick-to-bottom 标准交互） */}
          {detached && running && (
            <button
              onClick={jumpToBottom}
              className="absolute bottom-3 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1 rounded-full px-3 py-1.5 text-[11px] font-semibold"
              style={{
                background: 'rgba(59,130,246,0.92)',
                color: '#fff',
                boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
              }}>
              <ChevronRight size={12} style={{ transform: 'rotate(90deg)' }} /> 回到底部
            </button>
          )}
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
