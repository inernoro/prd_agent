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
import { transcribeEntry, getAgentRun, uploadDocumentFileWithProgress, listTranscribeStyles, restyleTranscribeRun, updateTranscribeTranscript } from '@/services';
import type { DocumentEntry } from '@/services/contracts/documentStore';
import { deriveTranscribeSteps, type TranscribeStepState } from './transcribeFlowSteps';
import { parseMeetingContext } from './transcribeStyleContext';

/**
 * 录音转录全链路：上传音频 → 生成可编辑原文 → 保存；整理是用户主动选择的下一步。
 * 一张卡承载录音、原文校对和可选整理，阶段清单逐项点亮，关闭默认保留结果。
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
  /** 首次转录的整理方式；空 = 只生成原文，不调用整理模型。 */
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
  /** 新录音完成后允许明确取消并删除；普通关闭始终保留。 */
  onDiscardEntry?: (entryId: string) => Promise<void>;
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
  onDiscardEntry,
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
  const [styles, setStyles] = useState<{
    key: string;
    label: string;
    description: string;
    contextInput?: { label: string; description: string; placeholder: string; example?: string | null } | null;
  }[]>([]);
  const [styleKey, setStyleKey] = useState(initialStyle?.styleKey || 'general');
  const [styleContext, setStyleContext] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [restyleSubmitting, setRestyleSubmitting] = useState(false);
  // 归档到文件夹（第二波：智能文件夹归档的第一步——手选归档）
  const [archiving, setArchiving] = useState(false);
  const [archivedTo, setArchivedTo] = useState<string | null>(null);
  // 上传进度（大录音文件不再"卡住没反馈"）
  const [uploadPercent, setUploadPercent] = useState(0);
  const [runningSeconds, setRunningSeconds] = useState(0);
  // 结果区默认原文；用户主动整理后才出现以所选类型命名的第二个页签。
  const [summaryView, setSummaryView] = useState<'summary' | 'raw'>(initialStyle?.styleKey ? 'summary' : 'raw');
  const [rawTranscript, setRawTranscript] = useState<string | null>(null);
  const [rawDraft, setRawDraft] = useState('');
  const [editingRaw, setEditingRaw] = useState(false);
  const [savingRaw, setSavingRaw] = useState(false);
  const [showOrganize, setShowOrganize] = useState(!!restyleRun);
  const [includeSummary, setIncludeSummary] = useState(!!initialStyle?.styleKey || !!restyleRun);
  const [discarding, setDiscarding] = useState(false);
  const rawFetchedRef = useRef(false);
  const completedRunRef = useRef<string | null>(restyleRun?.runId ?? null);

  // 完成后取转录原文（run 上带 transcriptText；老 run 没存则显示指引）
  useEffect(() => {
    if (status !== 'done' || !runId || rawFetchedRef.current) return;
    rawFetchedRef.current = true;
    void getAgentRun(runId).then((res) => {
      if (res.success) {
        const text = res.data?.transcriptText ?? '';
        setRawTranscript(text);
        setRawDraft(text);
        if (res.data?.generatedText) setSummaryText(res.data.generatedText);
        if (res.data?.templateKey) {
          setStyleKey(res.data.templateKey);
          setIncludeSummary(true);
        }
      }
    });
  }, [status, runId]);

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
          if (!runId || completedRunRef.current !== runId) {
            completedRunRef.current = runId;
            onDone?.(d.outputEntryId);
          }
        }
      },
      error: (data) => {
        const d = data as { message?: string };
        setStatus('failed');
        setErrorMessage(d.message ?? '未知错误');
      },
    },
    onError: () => {
      // 流连接在移动网络切换时可能中断；run 状态由下面的轮询继续确认，
      // 不能仅凭 SSE 断线把一个实际已完成的任务判成失败。
      setPhase('正在重新确认任务状态');
      setErrorMessage(null);
    },
  });

  // 兜底拉一次 run 状态（SSE 漏事件 / 任务已完成的场景）
  const refreshRun = useCallback(async (rid: string) => {
    const res = await getAgentRun(rid);
    if (!res.success) return;
    const r = res.data;
    if (r.phase) setPhase(r.phase);
    if (r.status === 'done') {
      setPhase('完成');
      setStatus('done');
      setErrorMessage(null);
      if (r.generatedText) setSummaryText(r.generatedText);
      if (r.outputEntryId) {
        setOutputEntryId(r.outputEntryId);
        if (completedRunRef.current !== rid) {
          completedRunRef.current = rid;
          onDone?.(r.outputEntryId);
        }
      }
    } else if (r.status === 'failed') {
      setStatus('failed');
      const fullErr = r.errorMessage ?? '任务失败';
      const diagIdx = fullErr.indexOf('\n\n[diagnostic]\n');
      setErrorMessage(diagIdx >= 0 ? fullErr.slice(0, diagIdx) : fullErr);
    }
  }, [onDone]);

  // SSE 是即时体验，轮询是正确性兜底。只要 run 未终态，每 2 秒查询一次；
  // 即便 done 事件在 Safari 后台切换时丢失，也会在下一轮自动收敛。
  useEffect(() => {
    if (!runId || status !== 'running') return;
    void refreshRun(runId);
    const timer = window.setInterval(() => { void refreshRun(runId); }, 2000);
    return () => window.clearInterval(timer);
  }, [runId, status, refreshRun]);

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
      setIncludeSummary(true);
      setSummaryView('summary');
      setShowOrganize(false);
      setStatus('running');
      setPhase('排队中');
      onRunTracking?.(res.data.runId);
      setRunId(res.data.runId); // runId 变化触发 SSE 重订阅
      void refreshRun(res.data.runId);
    } finally {
      setRestyleSubmitting(false);
    }
  }, [runId, restyleSubmitting, styleKey, styleContext, customPrompt, abort, onRunTracking, refreshRun]);

  const saveRawTranscript = useCallback(async () => {
    if (!runId || !rawDraft.trim() || savingRaw) return;
    setSavingRaw(true);
    setErrorMessage(null);
    try {
      const res = await updateTranscribeTranscript(runId, rawDraft);
      if (!res.success) {
        setErrorMessage(res.error?.message ?? '保存原文失败');
        return;
      }
      setRawTranscript(res.data.transcriptText);
      setRawDraft(res.data.transcriptText);
      setEditingRaw(false);
    } finally {
      setSavingRaw(false);
    }
  }, [rawDraft, runId, savingRaw]);

  // ── 阶段清单状态推导（默认三步；主动整理时四步，纯函数与单测覆盖） ──
  const steps = useMemo(
    () => deriveTranscribeSteps({
      status,
      phase,
      hasFile: !!file,
      hasEntry: !!entryId,
      summaryFailed,
      includeSummary,
    }),
    [status, phase, entryId, file, summaryFailed, includeSummary],
  );

  const running = status === 'uploading' || status === 'running';
  const inPlace = !!entryId && outputEntryId === entryId;
  const activeStep = steps.find(step => step.state === 'active');
  const selectedStyle = styles.find(style => style.key === styleKey);
  const meetingContextFields = useMemo(
    () => selectedStyle?.contextInput ? parseMeetingContext(styleContext) : [],
    [selectedStyle?.contextInput, styleContext],
  );
  const runningDescription = status === 'uploading'
    ? '录音正在安全保存，随后只生成可编辑原文'
    : phase.includes('写入')
      ? 'AI 整理已经返回，正在把录音、原文和整理结果写入同一文档'
      : runningSeconds >= 20
        ? '任务仍在后台执行，系统每 2 秒确认一次状态；关闭面板也不会中断'
        : (activeStep?.sub || (includeSummary
          ? '正在按你选择的方式整理，完成后保存到同一录音文档'
          : '正在把录音转成文字，完成后自动保存'));

  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    setRunningSeconds(0);
    const timer = window.setInterval(() => {
      setRunningSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, runId]);

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
    <div className={running ? 'flex min-h-full flex-col justify-center gap-5 py-6' : 'space-y-4 py-4'}>
      {running && (
        <div className="mx-auto flex w-full max-w-[340px] flex-col items-center text-center" aria-live="polite">
          <motion.div
            className="mb-4 flex h-20 w-20 items-center justify-center rounded-[24px]"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}
            animate={{ borderColor: ['var(--border-faint)', 'rgba(96,165,250,0.55)', 'var(--border-faint)'] }}
            transition={{ duration: 2.4, repeat: Infinity }}>
            <MapSpinner size={28} />
          </motion.div>
          <p className="text-[18px] font-semibold text-token-primary">
            {status === 'uploading' ? '正在保存录音' : (activeStep?.label ?? phase)}
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-token-muted">
            {runningDescription}
          </p>
          <p className="mt-3 text-[11px] tabular-nums text-token-muted">
            已进行 {formatProcessDuration(runningSeconds)}
          </p>
        </div>
      )}

      {/* 阶段清单（Notion 式逐项点亮） */}
      <div
        className={`space-y-2.5 ${running ? 'mx-auto w-full max-w-[340px] rounded-[16px] p-4' : ''}`}
        style={running ? { background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' } : undefined}>
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
        <div className="mx-auto w-full max-w-[340px]">
          <div className="mb-1 flex items-center justify-between text-[11px] text-token-muted">
            <span>正在上传录音</span>
            <span className="tabular-nums">{uploadPercent}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{ width: `${uploadPercent}%`, background: 'linear-gradient(90deg, rgba(59,130,246,0.95), rgba(99,102,241,0.95))' }}
            />
          </div>
        </div>
      )}

      {/* 用户主动整理后才展示流式结果；默认转原文不生成摘要。
          完成后不在这里展示——完成态的摘要在下方操作区之后以 markdown 渲染（限高内滚），
          保证「查看/换方式/归档」操作不被长摘要顶出屏幕（2026-07-13 用户反馈按钮太靠下）。 */}
      {includeSummary && summaryText && status !== 'done' && (
        <div className="surface-inset mx-auto w-full max-w-[380px] rounded-[12px] p-3.5">
          <p className="mb-2 text-[11px] font-semibold text-token-muted">整理结果</p>
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
      {/* 失败信息：不限定 status —— restyle 请求失败时 status 仍是 done，
          只设 errorMessage；若只在 failed 态渲染，用户会看到按钮停转却无任何解释（Codex P2） */}
      {errorMessage && (
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
      {status === 'done' && outputEntryId && !inPlace && (
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

      {status === 'done' && inPlace && (
        <div
          className="rounded-[12px] px-4 py-3"
          style={{
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.2)',
          }}>
          <p className="text-[13px] font-semibold" style={{ color: 'rgba(74,222,128,0.95)' }}>
            录音和原文已保存
          </p>
          <p className="mt-1 text-[11px] text-token-muted">
            {includeSummary ? '录音、原文和整理结果都在本页，位置没有改变。' : '现在关闭也会保留；需要时再点一键整理。'}
          </p>
        </div>
      )}

      {status === 'done' && outputEntryId && styles.length > 0 && !showOrganize && (
        <button
          type="button"
          onClick={() => setShowOrganize(true)}
          className="flex min-h-11 w-full cursor-pointer items-center justify-between rounded-[12px] px-4 py-3 text-left transition-colors"
          style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}>
          <span>
            <span className="block text-[13px] font-semibold text-token-primary">一键整理</span>
            <span className="mt-0.5 block text-[11px] text-token-muted">可选下一步，不会改动录音和原文</span>
          </span>
          <ChevronRight size={15} className="text-token-muted" />
        </button>
      )}

      {/* 整理完全由用户主动展开和选择，不在原文完成后强制执行。 */}
      {status === 'done' && outputEntryId && styles.length > 0 && showOrganize && (
        <div className="surface-inset rounded-[12px] p-3.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[12px] font-semibold text-token-primary">选择整理方式</p>
            <button type="button" onClick={() => setShowOrganize(false)} className="min-h-11 px-2 text-[11px] text-token-muted">收起</button>
          </div>
          <p className="mb-2.5 text-[11px] text-token-muted">
            只新增或更新所选类型的整理结果，录音和原文保持不动。
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
                    : { background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
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
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
            />
          )}
          {selectedStyle?.contextInput ? (
            <div className="mb-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label className="text-[11px] font-semibold text-token-secondary">{selectedStyle.contextInput.label}</label>
                {selectedStyle.contextInput.example && !styleContext.trim() && (
                  <button
                    type="button"
                    onClick={() => setStyleContext(selectedStyle.contextInput?.example || '')}
                    className="min-h-11 px-2 text-[11px] font-semibold"
                    style={{ color: 'var(--accent-primary, rgba(96,165,250,0.95))' }}>
                    填入示例
                  </button>
                )}
              </div>
              <p className="mb-2 text-[11px] leading-relaxed text-token-muted">{selectedStyle.contextInput.description}</p>
              <textarea
                value={styleContext}
                onChange={(e) => setStyleContext(e.target.value)}
                rows={6}
                placeholder={selectedStyle.contextInput.placeholder}
                className="w-full resize-y rounded-[10px] px-3 py-2 text-[12px] leading-relaxed text-token-primary outline-none"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
              />
              {meetingContextFields.length > 0 && (
                <div className="mt-2 rounded-[9px] px-3 py-2" style={{ background: 'var(--bg-elevated)' }}>
                  <p className="mb-1.5 text-[10px] font-semibold text-token-muted">已识别字段</p>
                  <div className="space-y-1">
                    {meetingContextFields.map(field => (
                      <p key={field.label} className="text-[11px] leading-relaxed text-token-secondary">
                        <span className="font-semibold">{field.label}：</span>{field.value}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <input
              value={styleContext}
              onChange={(e) => setStyleContext(e.target.value)}
              placeholder="补充背景（可选），例如：参会人：张三、李四；主题：季度复盘"
              className="mb-2.5 w-full rounded-[10px] px-3 py-2 text-[12px] text-token-primary outline-none"
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
            />
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={restyleSubmitting || (styleKey === 'custom' && !customPrompt.trim())}
            onClick={() => { void startRestyle(); }}>
            {restyleSubmitting ? <MapSpinner size={12} /> : null} 生成{styles.find(style => style.key === styleKey)?.label || '整理结果'}
          </Button>
        </div>
      )}

      {/* 归档到文件夹：默认跟随源音频位置，可现在归档到指定文件夹 */}
      {status === 'done' && outputEntryId && !inPlace && onMoveNote && (folders?.length ?? 0) > 0 && (
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
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}>
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

      {/* 原文是默认产物且可直接校对；用户主动整理后，第二个页签用所选类型命名。 */}
      {status === 'done' && outputEntryId && (
        <div className="surface-inset rounded-[12px] p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1">
              {([
                ['raw', '原文'],
                ...(includeSummary && summaryText
                  ? [['summary', styles.find(style => style.key === styleKey)?.label || '整理结果']]
                  : []),
              ] as ['raw' | 'summary', string][]).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setSummaryView(key)}
                  className="cursor-pointer rounded-[7px] px-2 py-0.5 text-[11px] font-semibold transition-colors"
                  style={summaryView === key
                    ? { background: 'rgba(59,130,246,0.16)', color: 'rgba(147,197,253,0.98)' }
                    : { color: 'var(--text-muted)' }}>
                  {label}
                </button>
              ))}
            </div>
            {summaryView === 'raw' && rawTranscript !== null && !editingRaw ? (
              <button
                type="button"
                onClick={() => { setRawDraft(rawTranscript || ''); setEditingRaw(true); }}
                className="min-h-11 cursor-pointer rounded-[7px] px-2 text-[11px] font-semibold"
                style={{ color: 'var(--accent-primary, rgba(96,165,250,0.95))' }}>
                编辑原文
              </button>
            ) : outputEntryId && onEditNote && !inPlace && (
              <button
                onClick={() => { onEditNote(outputEntryId); onClose(); }}
                className="cursor-pointer rounded-[7px] px-2 py-0.5 text-[11px] font-semibold transition-colors hover:bg-white/8"
                style={{ color: 'var(--accent-primary, rgba(96,165,250,0.95))' }}>
                编辑笔记
              </button>
            )}
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {summaryView === 'summary' ? (
              <MarkdownViewer content={summaryText} />
            ) : rawTranscript === null ? (
              <div className="flex items-center gap-2 py-3 text-[12px] text-token-muted"><MapSpinner size={12} /> 正在读取转录原文…</div>
            ) : editingRaw ? (
              <div>
                <textarea
                  autoFocus
                  value={rawDraft}
                  onChange={(event) => setRawDraft(event.target.value)}
                  rows={8}
                  className="w-full resize-y rounded-[10px] px-3 py-2 text-[13px] leading-relaxed text-token-primary outline-none"
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
                />
                <div className="mt-2 flex justify-end gap-2">
                  <Button variant="ghost" size="xs" disabled={savingRaw} onClick={() => { setRawDraft(rawTranscript || ''); setEditingRaw(false); }}>取消修改</Button>
                  <Button variant="primary" size="xs" disabled={savingRaw || !rawDraft.trim()} onClick={() => { void saveRawTranscript(); }}>
                    {savingRaw ? <MapSpinner size={12} /> : null} 保存原文
                  </Button>
                </div>
              </div>
            ) : rawTranscript ? (
              <button
                type="button"
                onClick={() => { setRawDraft(rawTranscript); setEditingRaw(true); }}
                className="min-h-11 w-full cursor-text whitespace-pre-wrap rounded-[8px] px-2 py-2 text-left text-[13px] leading-relaxed text-token-primary hover:bg-white/4"
                title="点击修改原文">
                {rawTranscript}
              </button>
            ) : (
              <p className="py-2 text-[12px] text-token-muted">
                本次任务未单独保存转录原文（旧版本生成）。完整原文在转录笔记的「转录全文」小节，点上方「查看转录笔记」查看。
              </p>
            )}
          </div>
        </div>
      )}
    </div>
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
        aria-label="关闭录音转录"
        className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-[10px] text-token-muted hover:bg-white/6">
        <X size={15} />
      </button>
    </div>
  );

  const footer = (
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 flex-1 text-[11px] text-token-muted">
        {running ? '可关闭面板，任务在后台继续' : status === 'done' ? '关闭会保留录音和原文' : ''}
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
        {status === 'done' && entryId && onDiscardEntry && (
          <Button
            variant="ghost"
            size="sm"
            disabled={discarding}
            onClick={() => {
              setDiscarding(true);
              void onDiscardEntry(entryId)
                .then(onClose)
                .catch((error: unknown) => setErrorMessage(error instanceof Error ? error.message : '取消失败'))
                .finally(() => setDiscarding(false));
            }}>
            {discarding ? <MapSpinner size={12} /> : null} 取消本次录音
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
        className={`surface-popover flex flex-col ${isMobile ? 'w-full' : 'h-full w-[440px] max-w-[92vw] border-l border-token-subtle'}`}
        style={isMobile ? {
          height: '100dvh',
          maxHeight: '100dvh',
          background: 'var(--bg-primary)',
        } : undefined}
        initial={isMobile ? { y: '100%' } : { x: '100%' }}
        animate={isMobile ? { y: 0 } : { x: 0 }}
        exit={isMobile ? { y: '100%' } : { x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        onClick={(e) => e.stopPropagation()}>
        <div className={`shrink-0 ${isMobile ? 'px-4 py-3' : 'surface-panel-header px-5 py-4'}`}>{header}</div>
        <div className="relative flex-1" style={{ minHeight: 0 }}>
          <div
            ref={scrollRef}
            onScroll={handleBodyScroll}
            className={`h-full ${isMobile ? 'px-4' : 'px-5'}`}
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
          className={`shrink-0 px-4 pt-3 ${isMobile ? '' : 'px-5 pb-5 pt-4'}`}
          style={{
            borderTop: '1px solid var(--border-faint)',
            paddingBottom: isMobile ? 'calc(env(safe-area-inset-bottom, 0px) + 12px)' : undefined,
            background: 'var(--bg-primary)',
          }}>
          {footer}
        </div>
      </motion.div>
    </motion.div>
  );

  return createPortal(overlay, document.body);
}

function formatProcessDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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
