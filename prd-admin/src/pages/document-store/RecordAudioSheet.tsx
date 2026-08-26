import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, BookText, Check, ChevronDown, ChevronUp, Clock3, CloudUpload, FileCheck2, FileUp,
  HardDrive, Mic, MicOff, MoreHorizontal, Pause, Play, ShieldCheck, Square, WifiOff, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useIsMobile } from '@/hooks/useBreakpoint';
import {
  appendRecordingUploadChunk,
  cancelRecordingUpload,
  completeRecordingUpload,
  getRecordingUpload,
  listDocumentStoresWithPreview,
  startRecordingUpload,
} from '@/services';
import type { DocumentEntry } from '@/services/contracts/documentStore';
import {
  vaultStartSession,
  vaultAppendChunk,
  vaultClearServerCompletion,
  vaultDeleteSession,
  vaultMarkServerCompletion,
  vaultUpdateSessionStore,
} from './recordingVault';
import { recordingExtension, selectRecordingMimeType } from './recordingMedia';
import {
  advanceLiveSentenceLog,
  describeCaptureChips,
  describeLiveTranscriptTitle,
  describeRetryCountdown,
  type CaptureChipIcon,
  type CaptureChipTone,
  type LiveSentence,
} from './recordingCaptureView';
import '@/styles/recording-design-palette.css';
import { useAuthStore } from '@/stores/authStore';
import {
  LiveTranscriptionSocket,
  bufferPendingLivePcm,
  reduceLiveTranscriptionView,
  startLivePcmCapture,
  type LivePcmCaptureController,
  type LiveTranscriptionState,
} from './liveTranscription';

/**
 * 录音转笔记的「现场录音」面板：打开即请求麦克风并开始录音（MediaRecorder），
 * 计时 + 实时电平波形 + 暂停/继续，点「完成」产出音频 File 交给父页面走
 * 既有的 TranscribeFlowDrawer 转录链路。
 *
 * 历史背景（2026-07-12 用户反馈）：原「录音转笔记」点击后直接弹文件选择器——
 * 名叫录音、行为却是上传，违反最小惊讶。本面板补上真实录音；没有麦克风权限、
 * 浏览器不支持、或用户手头已有录音文件时，仍保留「上传音频文件」双通道兜底
 * （zero-friction-input：不确定就两个都给）。
 *
 * 移动端为底部弹层，桌面端为右侧抽屉（与 TranscribeFlowDrawer 同一形制）。
 */
export type RecordAudioSheetProps = {
  /** 当前知识库：保险箱会话记录归属库，恢复时只在同库提示（避免笔记落错库） */
  storeId?: string;
  storeName?: string;
  onClose: () => void;
  /**
   * 录音完成：产出音频 File（命名「录音 YYYY-MM-DD HH-mm」+ 按容器定扩展名）。
   * vaultSessionId 是本机保险箱会话 id——调用方必须在【上传成功】后才删除它，
   * 上传失败/断网时保留，下次进页可恢复（不丢数据）。
   */
  onComplete: (file: File, vaultSessionId: string, targetStoreId?: string) => void;
  /** 实时分片已在服务端合并为条目，直接进入转录，避免再次上传整段文件。 */
  onUploaded: (
    entry: DocumentEntry,
    vaultSessionId: string,
    targetStoreId?: string,
    deferredTranscriptionRunId?: string | null,
  ) => void;
  /** 前台有界等待结束、服务端仍持有完成流程时通知父页转入后台。 */
  onServerCompletionDeferred: () => void;
  /** 「上传音频文件」兜底：打开既有的 audio file input */
  onPickFile: (targetStoreId?: string) => void;
};

type RecState = 'requesting' | 'recording' | 'paused' | 'finalizing' | 'unavailable';

/** 后端单文件上限 20MB；录到接近上限时自动收尾，避免上传被拒 */
const MAX_BYTES = 19 * 1024 * 1024;
const TRANSPORT_CHUNK_BYTES = 512 * 1024;
const MAX_UNCERTAIN_COMPLETION_ATTEMPTS = 32;
const MAX_SERVER_OWNED_COMPLETION_ATTEMPTS = 24;
const MAX_FOREGROUND_COMPLETION_WAIT_MS = 45_000;

function buildFileName(ext: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `录音 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}${ext}`;
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function canDiscardRecording(finalizationLocked: boolean): boolean {
  return !finalizationLocked;
}

export function nextRecordingFinalizationLock(
  finalizationLocked: boolean,
  mode: 'complete' | 'discard',
): boolean {
  return finalizationLocked || mode === 'complete';
}

export function shouldForwardLivePcm(
  liveCaptureEnabled: boolean,
  recorderState: 'inactive' | 'recording' | 'paused',
  finalizationLocked: boolean,
): boolean {
  return liveCaptureEnabled
    && (recorderState === 'recording' || finalizationLocked);
}

type RecordingCompletionRetryStatus =
  | { success: true; data: { status: string } }
  | { success: false; error: { code: string } };

type RecordingCompletionAttempt =
  | { success: true }
  | { success: false; error: { code: string } }
  | null;

export function shouldStopRecordingCompletionRetry(
  status: RecordingCompletionRetryStatus | null,
): boolean {
  if (!status) return false;
  if (status.success) return status.data.status === 'cancelled';
  return status.error.code === 'NOT_FOUND'
    || status.error.code === 'SESSION_NOT_FOUND'
    || status.error.code === 'SESSION_EXPIRED';
}

export function nextRecordingCompletionOwnership(
  serverOwnsCompletion: boolean,
  status: RecordingCompletionRetryStatus | null,
): boolean {
  if (!status?.success) return serverOwnsCompletion;
  return status.data.status === 'completing'
    || status.data.status === 'completed';
}

export function shouldFallbackCompletedRecording(
  status: RecordingCompletionRetryStatus | null,
  completion: RecordingCompletionAttempt,
): boolean {
  if (!status?.success || status.data.status !== 'completed' || completion?.success !== false) {
    return false;
  }
  return completion.error.code === 'INVALID_FORMAT'
    || completion.error.code === 'NOT_FOUND'
    || completion.error.code === 'SESSION_NOT_FOUND'
    || completion.error.code === 'SESSION_EXPIRED';
}

export function shouldContinueRecordingCompletionRetry(
  completionSucceeded: boolean,
  uncertainAttempts: number,
  serverOwnedAttempts: number,
  elapsedMs: number,
): boolean {
  return !completionSucceeded
    && uncertainAttempts < MAX_UNCERTAIN_COMPLETION_ATTEMPTS
    && serverOwnedAttempts < MAX_SERVER_OWNED_COMPLETION_ATTEMPTS
    && elapsedMs < MAX_FOREGROUND_COMPLETION_WAIT_MS;
}

export function recordingCompletionOwnershipTransition(
  previous: boolean,
  next: boolean,
): 'acquired' | 'released' | 'unchanged' {
  if (!previous && next) return 'acquired';
  if (previous && !next) return 'released';
  return 'unchanged';
}

/**
 * `/complete` 一旦发出，响应超时就是未知结果而不是失败。直到服务端明确回到可上传态
 * 或明确表示会话不存在，本地整文件都必须保持保护，避免同一录音生成第二条 entry。
 */
export function recordingCompletionOwnershipAfterRequestIssued(): boolean {
  return true;
}

export function enqueueRecordingDestinationChange(
  currentQueue: Promise<void>,
  replayChunks: readonly Blob[],
  switchDestination: () => Promise<void>,
  uploadChunk: (chunk: Blob) => Promise<void>,
): Promise<void> {
  return currentQueue.then(async () => {
    await switchDestination();
    for (const chunk of replayChunks) await uploadChunk(chunk);
  });
}

/** 凭据胶囊的四档色：全部走 token，浅深两档各自成立（admin-dual-theme 那条棘轮）。 */
const CAPTURE_CHIP_TONE: Record<CaptureChipTone, { bg: string; fg: string }> = {
  success: { bg: 'var(--semantic-success-soft)', fg: 'var(--semantic-success-text)' },
  info: { bg: 'var(--semantic-info-soft)', fg: 'var(--semantic-info-text)' },
  warning: { bg: 'var(--semantic-warning-soft)', fg: 'var(--semantic-warning-text)' },
  neutral: { bg: 'var(--bg-elevated)', fg: 'var(--text-muted)' },
};

const CAPTURE_CHIP_ICON: Record<CaptureChipIcon, LucideIcon> = {
  shield: ShieldCheck,
  drive: HardDrive,
  upload: CloudUpload,
  check: Check,
  clock: Clock3,
};

/** 最新那句话尾巴上的光标：稿面用它表示「这句还在长」。 */
function LiveCaret() {
  return (
    <motion.span
      aria-hidden
      className="ml-0.5 inline-block h-[0.95em] w-[2px] translate-y-[2px] rounded-[1px]"
      style={{ background: 'var(--accent-fg-info)' }}
      animate={{ opacity: [1, 0.1, 1] }}
      transition={{ duration: 1.1, repeat: Infinity }}
    />
  );
}

/** 波形按 100ms 一格取峰值：按帧取的话一屏只装得下两秒，看不出「录了多久」。 */
const WAVEFORM_BUCKET_MS = 100;

export function RecordAudioSheet({
  storeId,
  storeName,
  onClose,
  onComplete,
  onUploaded,
  onServerCompletionDeferred,
  onPickFile,
}: RecordAudioSheetProps) {
  const isMobile = useIsMobile();
  const [state, setState] = useState<RecState>('requesting');
  const [unavailableReason, setUnavailableReason] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [finalizingSeconds, setFinalizingSeconds] = useState(0);
  const [finalizationStage, setFinalizationStage] = useState<1 | 2 | 3>(1);
  const [targetStoreId, setTargetStoreId] = useState(storeId ?? '');
  const [protectedBytes, setProtectedBytes] = useState(0);
  const [localBytes, setLocalBytes] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [liveSentences, setLiveSentences] = useState<LiveSentence[]>([]);
  /** 已排期的下一次实时转写重连时刻；null 表示没有排期，那就不许显示倒计时。 */
  const [liveRetryAt, setLiveRetryAt] = useState<number | null>(null);
  const [retryNow, setRetryNow] = useState(() => Date.now());
  /** 实时字幕是在录音的第几秒断的——用于「中断（12:19）」那句话。 */
  const [degradedAtSec, setDegradedAtSec] = useState<number | null>(null);
  const [liveProtection, setLiveProtection] = useState<'pending' | 'active' | 'local'>('pending');
  const [liveTranscript, setLiveTranscript] = useState('');
  const [liveTranscriptExpanded, setLiveTranscriptExpanded] = useState(false);
  const liveTranscriptValueRef = useRef('');
  const liveTranscriptScrollRef = useRef<HTMLParagraphElement | null>(null);
  const [liveTranscriptState, setLiveTranscriptState] = useState<LiveTranscriptionState>('connecting');
  const [liveTranscriptMessage, setLiveTranscriptMessage] = useState('正在连接实时转写');
  const [changingDestination, setChangingDestination] = useState(false);
  const changingDestinationRef = useRef(false);
  const [storeOptions, setStoreOptions] = useState<{ id: string; name: string }[]>(
    storeId ? [{ id: storeId, name: storeName || '当前知识库' }] : [],
  );
  const targetStoreIdRef = useRef(targetStoreId);
  targetStoreIdRef.current = targetStoreId;
  // 静音守卫：整段峰值电平过低时，完成前先确认（避免上传一段空录音）
  const [confirmSilent, setConfirmSilent] = useState(false);
  const peakLevelRef = useRef(0);
  // 本机保险箱会话：分片实时落 IndexedDB，云端归档可用前不删（断网/崩溃可恢复）
  const vaultIdRef = useRef(`rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const elapsedRef = useRef(0);
  elapsedRef.current = elapsed;
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const mimeRef = useRef('audio/webm');
  const fileNameRef = useRef('');
  const uploadSessionIdRef = useRef<string | null>(null);
  const uploadSessionPromiseRef = useRef<Promise<string | null> | null>(null);
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  // IndexedDB 写入也必须串行并在完成录音前收口。否则结果页可能先于最后一个
  // 分片落盘读取保险箱，表现为同一条录音偶发没有播放按钮。
  const vaultWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const uploadChunkIndexRef = useRef(0);
  const liveUploadFailedRef = useRef(false);
  const liveTranscriptionRef = useRef<LiveTranscriptionSocket | null>(null);

  useEffect(() => {
    const container = liveTranscriptScrollRef.current;
    if (!container || liveTranscriptExpanded) return;
    container.scrollTop = container.scrollHeight;
  }, [liveTranscript, liveTranscriptExpanded]);
  const pendingLivePcmRef = useRef<Int16Array[]>([]);
  const livePcmCompleteRef = useRef(true);
  const liveCaptureRef = useRef<LivePcmCaptureController | null>(null);
  const liveCaptureEnabledRef = useRef(true);
  // MediaRecorder.onstop 一旦进入完成链路，就由该链路独占终态。关闭、背景点击、
  // Escape 或上传文件入口都不能再把 complete 改写为 discard。
  const finalizationLockedRef = useRef(false);
  // 完成/取消/组件卸载 的意图标记：onstop 回调按它决定产出 File / 删保险箱 / 保留保险箱。
  // abandon = 录音中组件被卸载（如 SPA 路由跳走）：保留保险箱数据，下次进页可恢复。
  const finishModeRef = useRef<'complete' | 'discard' | 'abandon'>('discard');
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;
  const onServerCompletionDeferredRef = useRef(onServerCompletionDeferred);
  onServerCompletionDeferredRef.current = onServerCompletionDeferred;

  const connectLiveTranscription = useCallback((sessionId: string) => {
    if (liveTranscriptionRef.current) return;
    if (!livePcmCompleteRef.current) {
      setLiveTranscriptState('degraded');
      setLiveTranscriptMessage('实时音频未完整保留，录音结束后将自动完整转写');
      return;
    }
    const token = useAuthStore.getState().token;
    if (!token) {
      setLiveTranscriptState('degraded');
      setLiveTranscriptMessage('登录状态不可用，录音结束后将自动转写');
      return;
    }
    const socket = new LiveTranscriptionSocket(
      sessionId,
      token,
      (event) => {
        const view = reduceLiveTranscriptionView(liveTranscriptValueRef.current, event);
        liveTranscriptValueRef.current = view.text;
        setLiveTranscript(view.text);
        setLiveTranscriptMessage(view.message);
      },
      (nextState) => {
        setLiveTranscriptState(nextState);
        if (nextState === 'degraded') setDegradedAtSec(prev => prev ?? elapsedRef.current);
        if (nextState === 'live') setDegradedAtSec(null);
        if (nextState === 'live') setLiveTranscriptMessage('正在实时转写');
        if (nextState === 'finalizing') setLiveTranscriptMessage('正在确认最后一句');
        if (nextState === 'completed') setLiveTranscriptMessage('实时转写已完成');
        if (nextState === 'degraded') setLiveTranscriptMessage('实时转写已降级，结束后将自动校准');
      },
      (nextRetryAt) => {
        setLiveRetryAt(nextRetryAt);
        if (nextRetryAt != null) setDegradedAtSec(prev => prev ?? elapsedRef.current);
      },
    );
    liveTranscriptionRef.current = socket;
    socket.connect();
    for (const pcm of pendingLivePcmRef.current.splice(0)) socket.send(pcm);
  }, []);

  const ensureUploadSession = useCallback(async (): Promise<string | null> => {
    if (uploadSessionIdRef.current) return uploadSessionIdRef.current;
    if (liveUploadFailedRef.current) return null;
    if (uploadSessionPromiseRef.current) return await uploadSessionPromiseRef.current;
    const destination = targetStoreIdRef.current || storeId;
    if (!destination || !fileNameRef.current) return null;
    uploadSessionPromiseRef.current = startRecordingUpload(destination, fileNameRef.current, mimeRef.current)
      .then((res) => {
        if (!res.success) {
          liveUploadFailedRef.current = true;
          setLiveProtection('local');
          setLiveTranscriptState('degraded');
          setLiveTranscriptMessage('网络不可用，录音结束后将自动转写');
          return null;
        }
        uploadSessionIdRef.current = res.data.sessionId;
        setLiveProtection('active');
        connectLiveTranscription(res.data.sessionId);
        return res.data.sessionId;
      })
      .catch(() => {
        liveUploadFailedRef.current = true;
        setLiveProtection('local');
        setLiveTranscriptState('degraded');
        setLiveTranscriptMessage('网络不可用，录音结束后将自动转写');
        return null;
      });
    return await uploadSessionPromiseRef.current;
  }, [connectLiveTranscription, storeId]);

  const uploadLiveChunk = useCallback(async (blob: Blob) => {
    const sessionId = await ensureUploadSession();
    if (!sessionId || liveUploadFailedRef.current) return;
    for (let offset = 0; offset < blob.size; offset += TRANSPORT_CHUNK_BYTES) {
      const part = blob.slice(offset, Math.min(blob.size, offset + TRANSPORT_CHUNK_BYTES), blob.type);
      const index = uploadChunkIndexRef.current;
      const res = await appendRecordingUploadChunk(sessionId, index, part);
      if (!res.success) {
        liveUploadFailedRef.current = true;
        setLiveProtection('local');
        return;
      }
      uploadChunkIndexRef.current = res.data.nextChunkIndex;
      setProtectedBytes(res.data.uploadedBytes);
    }
  }, [ensureUploadSession]);

  const queueLiveChunk = useCallback((blob: Blob) => {
    uploadQueueRef.current = uploadQueueRef.current.then(
      () => uploadLiveChunk(blob),
    ).catch(() => {
      liveUploadFailedRef.current = true;
      setLiveProtection('local');
    });
  }, [uploadLiveChunk]);

  const changeDestination = useCallback(async (nextStoreId: string) => {
    if (changingDestinationRef.current) return;
    changingDestinationRef.current = true;
    setChangingDestination(true);
    setTargetStoreId(nextStoreId);
    targetStoreIdRef.current = nextStoreId;
    void vaultUpdateSessionStore(vaultIdRef.current, nextStoreId);

    // 已开始实时保护时，切库会重新建立会话，并把内存中的既有分片顺序补传到新库。
    // 这样用户不必在录音前做选择，也不会出现 UI 显示新库而文件实际留在旧库。
    try {
      if (!uploadSessionIdRef.current && !uploadSessionPromiseRef.current && !liveUploadFailedRef.current) return;
      // 同步把切换任务插进分片队列。此刻之后到达的新分片只能排在切换和历史重放之后，
      // 不会继续使用即将取消的旧会话，也不会与新会话的 index=0 竞争。
      const replayChunks = chunksRef.current.slice();
      uploadQueueRef.current = enqueueRecordingDestinationChange(
        uploadQueueRef.current,
        replayChunks,
        async () => {
          const previousSessionId = uploadSessionIdRef.current;
          liveTranscriptionRef.current?.close();
          liveTranscriptionRef.current = null;
          // 已说出的 PCM 无法重放到新会话。新知识库只保留完整的 MediaRecorder 分片，
          // 并在结束后做全文件校准，禁止把切换后的尾段误标为完整实时原文。
          livePcmCompleteRef.current = false;
          pendingLivePcmRef.current = [];
          setLiveTranscript('');
          liveTranscriptValueRef.current = '';
          setLiveTranscriptState('degraded');
          setLiveTranscriptMessage('已切换知识库，录音结束后将自动完整转写');
          if (previousSessionId) await cancelRecordingUpload(previousSessionId).catch(() => null);
          uploadSessionIdRef.current = null;
          uploadSessionPromiseRef.current = null;
          uploadChunkIndexRef.current = 0;
          liveUploadFailedRef.current = false;
          setProtectedBytes(0);
          setLiveProtection('pending');
        },
        uploadLiveChunk,
      ).catch(() => {
        liveUploadFailedRef.current = true;
        setLiveProtection('local');
      });
      await uploadQueueRef.current;
    } finally {
      changingDestinationRef.current = false;
      setChangingDestination(false);
    }
  }, [uploadLiveChunk]);

  useEffect(() => {
    void listDocumentStoresWithPreview(1, 200, { scope: 'mine' }).then((res) => {
      if (!res.success) return;
      const mine = res.data.items.map((item) => ({ id: item.id, name: item.name }));
      if (storeId && !mine.some(item => item.id === storeId)) {
        mine.unshift({ id: storeId, name: storeName || '当前知识库' });
      }
      setStoreOptions(mine);
      if (!targetStoreIdRef.current && mine[0]) setTargetStoreId(mine[0].id);
    });
  }, [storeId, storeName]);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef(0);
  // 电平历史（滚动波形）：ref 存储避免高频 setState
  const levelsRef = useRef<number[]>([]);
  const stateRef = useRef<RecState>('requesting');
  stateRef.current = state;

  const cleanup = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    liveCaptureEnabledRef.current = false;
    liveCaptureRef.current?.stop();
    liveCaptureRef.current = null;
    liveTranscriptionRef.current?.close();
    liveTranscriptionRef.current = null;
    pendingLivePcmRef.current = [];
    // 录音进行中被卸载（SPA 路由跳走等）：标记 abandon —— 停轨会触发 onstop，
    // 不能让默认的 discard 把保险箱数据删掉（那是断网/忘关场景唯一的恢复来源）
    if (finishModeRef.current === 'discard' && recorderRef.current && recorderRef.current.state !== 'inactive') {
      finishModeRef.current = 'abandon';
    }
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  const stopRecorder = useCallback((mode: 'complete' | 'discard') => {
    if (mode === 'discard' && !canDiscardRecording(finalizationLockedRef.current)) return;
    // 完成意图一旦被接受就同步锁定，不能等异步 onstop 才加锁；否则用户在
    // recorder.stop() 与 onstop 之间点击关闭，仍可能把完整录音改写为 discard。
    if (mode === 'complete') {
      finalizationLockedRef.current = nextRecordingFinalizationLock(
        finalizationLockedRef.current,
        mode,
      );
      setFinalizationStage(1);
      setFinalizingSeconds(0);
      setState('finalizing');
    }
    finishModeRef.current = mode;
    if (mode === 'complete') {
      // 先刷新不足 100ms 的最后一帧，再关闭采集开关。
      liveCaptureRef.current?.stop();
      liveCaptureEnabledRef.current = false;
    } else {
      liveCaptureEnabledRef.current = false;
      liveCaptureRef.current?.stop();
    }
    liveCaptureRef.current = null;
    if (mode === 'discard') {
      liveTranscriptionRef.current?.close();
      liveTranscriptionRef.current = null;
    }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
    else if (mode === 'discard') onClose();
  }, [onClose]);

  // 打开即请求麦克风并开始录音（快启动：不让用户再点一次「开始」）
  useEffect(() => {
    let disposed = false;
    (async () => {
      if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setUnavailableReason('当前浏览器不支持录音');
        setState('unavailable');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (disposed) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;

        const mime = selectRecordingMimeType((candidate) => MediaRecorder.isTypeSupported(candidate));
        mimeRef.current = mime || 'audio/webm';
        fileNameRef.current = buildFileName(recordingExtension(mimeRef.current));
        const rec = new MediaRecorder(stream, {
          ...(mime ? { mimeType: mime } : {}),
          audioBitsPerSecond: 64_000,
        });
        recorderRef.current = rec;
        vaultWriteQueueRef.current = vaultStartSession(
          vaultIdRef.current,
          mime || 'audio/webm',
          storeId,
        ).then(() => undefined);
        void ensureUploadSession();
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunksRef.current.push(e.data);
            bytesRef.current += e.data.size;
            setLocalBytes(bytesRef.current);
            // 分片实时落本机保险箱：崩溃/断网/忘关都不丢已录内容
            vaultWriteQueueRef.current = vaultWriteQueueRef.current
              .then(() => vaultAppendChunk(vaultIdRef.current, e.data))
              .then(() => undefined)
              .catch(() => undefined);
            queueLiveChunk(e.data);
            // 接近后端 20MB 上限：自动收尾并直接进转录，不让录音白费
            if (bytesRef.current >= MAX_BYTES && rec.state !== 'inactive') {
              // 与用户点击完成共用同一条收尾路径，先 flush 不足一百毫秒的 PCM
              // 尾帧，再停止 MediaRecorder，禁止实时原文漏掉最后几个字。
              stopRecorder('complete');
            }
          }
        };
        rec.onstop = async () => {
          if (finishModeRef.current === 'complete' && chunksRef.current.length > 0) {
            setFinalizationStage(2);
            await liveTranscriptionRef.current?.finish();
            const liveSessionId = uploadSessionIdRef.current;
            if (liveSessionId) {
              // upstream final 先到浏览器，MAP 随后才把最终原文写入会话。
              // 完成音频条目前短轮询确认持久化，避免极小竞态让已成功实时转写又跑一遍批处理。
              for (let attempt = 0; attempt < 10; attempt++) {
                const liveStatus = await getRecordingUpload(liveSessionId).catch(() => null);
                if (!liveStatus?.success
                    || liveStatus.data.liveTranscriptStatus === 'completed'
                    || liveStatus.data.liveTranscriptStatus === 'degraded') break;
                await new Promise((resolve) => window.setTimeout(resolve, 200));
              }
            }
            await uploadQueueRef.current;
            await vaultWriteQueueRef.current;
            setFinalizationStage(3);
            const sessionId = uploadSessionIdRef.current;
            if (sessionId && !liveUploadFailedRef.current) {
              const completionStartedAt = Date.now();
              let serverOwnsCompletion = recordingCompletionOwnershipAfterRequestIssued();
              await vaultMarkServerCompletion(vaultIdRef.current, sessionId);
              let completed = await completeRecordingUpload(
                sessionId,
                MAX_FOREGROUND_COMPLETION_WAIT_MS,
              ).catch(() => null);
              // 弱网下 /complete 的响应可能丢失，而服务端其实已创建条目。直接回退整文件
              // 上传会造成重复录音，所以先回读会话状态并幂等重试 /complete：服务端对已完成
              // 会话会返回同一条目（reused），不会重复创建。
              // completing / completed 表示服务端已经拥有完成流程。即使对象存储重试超过
              // 普通弱网窗口，也禁止转整文件上传制造第二条记录。前台等待达到硬上限后，
              // 将服务端会话写入本地保险箱并退出抽屉；下次进页先恢复同一幂等会话。
              let uncertainAttempts = 0;
              let serverOwnedAttempts = 0;
              while (shouldContinueRecordingCompletionRetry(
                completed?.success === true,
                uncertainAttempts,
                serverOwnedAttempts,
                Date.now() - completionStartedAt,
              )) {
                const delayMs = serverOwnsCompletion
                  ? 5000
                  : Math.min(5000, 1000 * (uncertainAttempts + 1));
                const remainingBeforeDelay = Math.max(
                  0,
                  MAX_FOREGROUND_COMPLETION_WAIT_MS - (Date.now() - completionStartedAt),
                );
                if (remainingBeforeDelay === 0) break;
                await new Promise((r) => setTimeout(r, Math.min(delayMs, remainingBeforeDelay)));
                const remainingForStatus = Math.max(
                  0,
                  MAX_FOREGROUND_COMPLETION_WAIT_MS - (Date.now() - completionStartedAt),
                );
                if (remainingForStatus === 0) break;
                const status = await getRecordingUpload(sessionId, remainingForStatus).catch(() => null);
                // cancel/过期清理会直接删除会话并返回 NOT_FOUND，不能继续空转重试
                // 两分多钟。仅网络错误保留重试，因为此时无法判断服务端是否已完成。
                if (shouldStopRecordingCompletionRetry(status)) {
                  serverOwnsCompletion = false;
                  await vaultClearServerCompletion(vaultIdRef.current);
                  break;
                }
                const previousOwnership = serverOwnsCompletion;
                serverOwnsCompletion = nextRecordingCompletionOwnership(
                  serverOwnsCompletion,
                  status,
                );
                const ownershipTransition = recordingCompletionOwnershipTransition(
                  previousOwnership,
                  serverOwnsCompletion,
                );
                if (ownershipTransition === 'acquired') {
                  // 首次确认服务端已接管就立即持久化绑定。不等前台轮询耗尽，
                  // 因为移动系统可能在等待期间回收页面。
                  await vaultMarkServerCompletion(vaultIdRef.current, sessionId);
                } else if (ownershipTransition === 'released') {
                  await vaultClearServerCompletion(vaultIdRef.current);
                }
                if (serverOwnsCompletion) {
                  serverOwnedAttempts++;
                } else {
                  uncertainAttempts++;
                }
                // uploading / completing / completed 均可安全重试（幂等），completed 通常直接回条目。
                const remainingForCompletion = Math.max(
                  0,
                  MAX_FOREGROUND_COMPLETION_WAIT_MS - (Date.now() - completionStartedAt),
                );
                if (remainingForCompletion === 0) break;
                if (!serverOwnsCompletion) {
                  serverOwnsCompletion = recordingCompletionOwnershipAfterRequestIssued();
                  await vaultMarkServerCompletion(vaultIdRef.current, sessionId);
                }
                completed = await completeRecordingUpload(
                  sessionId,
                  remainingForCompletion,
                ).catch(() => null);
                // completed 会话的条目若已被另一标签页删除，后端会明确返回不可恢复错误。
                // 此时结束服务端恢复循环，转用本地保险文件；网络空响应和 5xx 仍保留归属。
                if (shouldFallbackCompletedRecording(status, completed)) {
                  serverOwnsCompletion = false;
                  await vaultClearServerCompletion(vaultIdRef.current);
                  break;
                }
              }
              if (completed?.success) {
                if (finishModeRef.current !== 'complete') return;
                onUploadedRef.current(
                  completed.data.entry,
                  vaultIdRef.current,
                  targetStoreIdRef.current || storeId,
                  completed.data.deferredTranscriptionRunId,
                );
                onClose();
                return;
              }
              if (serverOwnsCompletion) {
                await vaultMarkServerCompletion(vaultIdRef.current, sessionId);
                setLiveProtection('local');
                onServerCompletionDeferredRef.current();
                return;
              }
              liveUploadFailedRef.current = true;
              setLiveProtection('local');
            }
            const baseMime = (rec.mimeType || mimeRef.current).split(';')[0] || 'audio/webm';
            const blob = new Blob(chunksRef.current, { type: baseMime });
            const file = new File([blob], fileNameRef.current || buildFileName(recordingExtension(baseMime)), { type: baseMime });
            if (sessionId) void cancelRecordingUpload(sessionId);
            if (finishModeRef.current !== 'complete') return;
            onCompleteRef.current(file, vaultIdRef.current, targetStoreIdRef.current || storeId);
          } else if (finishModeRef.current === 'discard') {
            // 用户主动放弃：保险箱一并清掉，不留恢复弹窗骚扰
            await vaultWriteQueueRef.current;
            void vaultDeleteSession(vaultIdRef.current);
            await uploadQueueRef.current;
            const sessionId = uploadSessionIdRef.current;
            if (sessionId) void cancelRecordingUpload(sessionId);
          }
          // abandon（录音中被卸载）：保留保险箱，下次进页提示恢复
          if (finishModeRef.current !== 'abandon') onClose();
        };
        // 电平波形：AnalyserNode 取 RMS，rAF 滚动绘制
        const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          audioCtxRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          analyserRef.current = analyser;
          try {
            liveCaptureRef.current = await startLivePcmCapture(ctx, source, (pcm) => {
              // liveCapture.stop 会同步冲刷不足 100ms 的尾帧。用户可能在暂停时
              // 点击完成，此时 recorder.state 仍是 paused，但完成锁已取得，尾帧仍须发送。
              if (!shouldForwardLivePcm(
                liveCaptureEnabledRef.current,
                rec.state,
                finalizationLockedRef.current,
              )) return;
              if (liveTranscriptionRef.current) {
                liveTranscriptionRef.current.send(pcm);
                return;
              }
              if (!livePcmCompleteRef.current) return;
              // API 会话建立前只短时保留 PCM。超过上限立即整路降级，禁止静默丢掉
              // 中段后继续发送连续序号并把不完整原文误标为 completed。
              if (!bufferPendingLivePcm(pendingLivePcmRef.current, pcm)) {
                livePcmCompleteRef.current = false;
                setLiveTranscriptState('degraded');
                setLiveTranscriptMessage('连接耗时过长，录音结束后将自动完整转写');
              }
            });
          } catch {
            setLiveTranscriptState('degraded');
            setLiveTranscriptMessage('当前浏览器无法实时取流，录音结束后将自动转写');
          }
        } else {
          setLiveTranscriptState('degraded');
          setLiveTranscriptMessage('当前浏览器无法实时取流，录音结束后将自动转写');
        }
        // PCM 捕获必须先于 MediaRecorder。只有覆盖录音全生命周期的连续 PCM
        // 才允许实时原文标记 completed；捕获初始化失败时则明确走完整文件校准。
        // 1s 一片：既能实时统计体积，又保证中途异常时已录内容不整段丢失。
        if (disposed) {
          liveCaptureRef.current?.stop();
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        rec.start(1000);
        setState('recording');
      } catch {
        if (disposed) return;
        setUnavailableReason('无法访问麦克风：请检查浏览器地址栏的麦克风权限，或改用上传音频文件');
        setState('unavailable');
      }
    })();
    return () => { disposed = true; cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 计时：仅 recording 状态走秒
  useEffect(() => {
    if (state !== 'recording') return;
    const id = window.setInterval(() => setElapsed(v => v + 1), 1000);
    return () => window.clearInterval(id);
  }, [state]);

  // 完成阶段单独计时：用户最容易把这段网络确认误判为卡死。
  useEffect(() => {
    if (state !== 'finalizing') return;
    const id = window.setInterval(() => setFinalizingSeconds(value => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [state]);

  // 滚动波形绘制
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
    // 每 100ms 收一格峰值：按帧收的话一屏只装得下两秒，看不出录了多久
    let bucketPeak = 0;
    let bucketStart = performance.now();
    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const analyser = analyserRef.current;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (analyser && stateRef.current === 'recording') {
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const level = Math.min(1, Math.sqrt(sum / data.length) * 3);
        bucketPeak = Math.max(bucketPeak, level);
        peakLevelRef.current = Math.max(peakLevelRef.current, level);
        const now = performance.now();
        if (now - bucketStart >= WAVEFORM_BUCKET_MS) {
          levelsRef.current.push(bucketPeak);
          bucketPeak = 0;
          bucketStart = now;
          if (levelsRef.current.length > 600) levelsRef.current.shift();
        }
      }
      const g = canvas.getContext('2d');
      if (!g) return;
      const { width, height } = canvas;
      g.clearRect(0, 0, width, height);
      // 颜色从 token 读，浅深两档与作用域皮肤自动一致
      const computed = window.getComputedStyle(canvas);
      const activeColor = computed.color;
      const idleColor = computed.getPropertyValue('--border-subtle').trim() || activeColor;
      const barW = 7;
      const gap = 6;
      const maxBars = Math.floor(width / (barW + gap));
      const slice = levelsRef.current.slice(-maxBars);
      const frozen = stateRef.current === 'paused';
      for (let i = 0; i < maxBars; i++) {
        const x = i * (barW + gap);
        const recorded = i < slice.length;
        // 还没录到的那一段画成浅色底纹：让「录了多少」一眼可量，而不是一条永远满格的带子
        const level = recorded ? slice[i] : 0.3;
        const h = Math.max(4, level * height);
        g.fillStyle = recorded && !frozen ? activeColor : idleColor;
        g.fillRect(x, (height - h) / 2, barW, h);
      }
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [state]);

  // ESC 取消（丢弃录音）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stopRecorder('discard'); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [stopRecorder]);

  // 录音中拦截关闭/刷新：给用户一次反悔机会（即使强关，分片已在保险箱，下次可恢复）
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [state]);

  // 完成录音：整段几乎无声时先确认，避免上传一段空录音（转录必然失败）
  const requestComplete = () => {
    if (peakLevelRef.current < 0.02 && !confirmSilent) {
      setConfirmSilent(true);
      return;
    }
    stopRecorder('complete');
  };

  const togglePause = () => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (rec.state === 'recording') {
      // 先冲刷尾帧再切换 recorder.state；回调门禁仍看到 recording，暂停前的
      // 最后不足一帧样本不会被 shouldForwardLivePcm 当成暂停数据丢弃。
      liveCaptureRef.current?.pause();
      rec.pause();
      setState('paused');
    } else if (rec.state === 'paused') {
      rec.resume();
      liveCaptureRef.current?.resume();
      setState('recording');
    }
  };

  const paused = state === 'paused';
  /*
   * 断线重连的等待期在 socket 内部记作 'connecting'，但用户看到的现实是
   * 「字幕断了、N 秒后再试」——稿面 cap-A2 画的正是这一刻（不可用 + 倒计时同屏）。
   * 只认 'degraded' 的话，这段等待会显示成「连接中」，倒计时也没地方落。
   */
  const liveView = (liveTranscriptState === 'degraded' || liveRetryAt != null)
    ? 'degraded' as const
    : liveTranscriptState;
  /** 网络降级：实时字幕断了，或者分片上传通道压根没建起来 */
  const networkDegraded = liveView === 'degraded' || liveProtection === 'local';
  const captureChips = describeCaptureChips({
    localBytes,
    uploadedBytes: protectedBytes,
    protection: liveProtection,
    paused,
  });
  const liveTranscriptTitle = describeLiveTranscriptTitle({
    state: liveView,
    paused,
    expanded: liveTranscriptExpanded,
    sentenceCount: liveSentences.length,
  });
  const retryCountdown = describeRetryCountdown(liveRetryAt, retryNow);

  // 实时原文是一整段累计文本，「第几句」「这句几点出现的」都要在这里算出来
  useEffect(() => {
    setLiveSentences(prev => advanceLiveSentenceLog(prev, liveTranscript, elapsedRef.current));
  }, [liveTranscript]);

  // 倒计时只在真有一次已排期的重连时才走秒
  useEffect(() => {
    if (liveRetryAt == null) return;
    setRetryNow(Date.now());
    const id = window.setInterval(() => setRetryNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [liveRetryAt]);

  /**
   * 保存目标（稿面 R1/A1 把它放在标题下面那一行，不是正文里的一个表单项）。
   * 文字是给眼睛看的，真正接事件的是盖在上面的原生 select——移动端仍然拉起系统选择器。
   */
  const destinationPicker = storeOptions.length > 0 ? (
    <span className="relative inline-flex max-w-full items-center gap-1 rounded-[8px] px-1.5 py-0.5">
      <BookText size={13} style={{ color: 'var(--accent-fg-success)' }} aria-hidden />
      <span className="truncate text-[12px] font-semibold" style={{ color: 'var(--accent-fg-success)' }}>
        保存到「{storeOptions.find(o => o.id === targetStoreId)?.name || storeName || '当前知识库'}」
      </span>
      <ChevronDown size={12} style={{ color: 'var(--accent-fg-success)' }} aria-hidden />
      <select
        aria-label="选择保存到哪个知识库"
        value={targetStoreId}
        onChange={(event) => { void changeDestination(event.target.value); }}
        disabled={state === 'finalizing' || changingDestination}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {storeOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    </span>
  ) : (
    <span className="text-[12px] font-semibold" style={{ color: 'var(--accent-fg-success)' }}>
      保存到「{storeName || '当前知识库'}」
    </span>
  );

  const body = state === 'unavailable' ? (
    <div className="mx-auto flex min-h-full w-full max-w-[360px] flex-col items-center justify-center gap-4 py-8 text-center">
      {destinationPicker}
      <span
        className="flex h-14 w-14 items-center justify-center rounded-full"
        style={{ background: 'rgba(239,68,68,0.12)', color: 'var(--accent-fg-danger)' }}>
        <MicOff size={24} />
      </span>
      <p className="max-w-[300px] text-[13px] leading-relaxed text-token-secondary">{unavailableReason}</p>
      <Button variant="primary" size="sm" onClick={() => { onClose(); onPickFile(targetStoreId || storeId); }}>
        <FileUp size={14} /> 上传音频文件
      </Button>
    </div>
  ) : state === 'finalizing' ? (
    <div
      data-testid="recording-finalizing-panel"
      aria-live="polite"
      className="mx-auto flex min-h-full w-full max-w-[380px] flex-col items-center justify-center gap-5 py-8 text-center">
      <motion.div
        className="flex h-20 w-20 items-center justify-center rounded-[24px]"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}
        animate={{ borderColor: ['var(--border-faint)', 'rgba(74,222,128,0.58)', 'var(--border-faint)'] }}
        transition={{ duration: 2.2, repeat: Infinity }}>
        <MapSpinner size={28} />
      </motion.div>
      <div>
        <p className="text-[18px] font-semibold text-token-primary">正在创建录音结果</p>
        <p className="mt-2 text-[12px] leading-relaxed text-token-muted">
          {finalizationStage === 1
            ? '正在锁定最后一段声音，避免结束瞬间漏字。'
            : finalizationStage === 2
              ? '正在核对并补传最后的录音分片。'
              : '录音已经安全保存，正在创建可立即播放的结果页。'}
        </p>
        <p className="mt-2 text-[11px] tabular-nums text-token-muted">
          已等待 {formatElapsed(finalizingSeconds)} · 通常几秒，弱网时最多前台等待 45 秒
        </p>
      </div>

      <div
        className="w-full rounded-[16px] p-4"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}
        aria-label="录音完成进度">
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: '锁定录音', stage: 1, icon: Check },
            { label: '完成上传', stage: 2, icon: CloudUpload },
            { label: '创建结果页', stage: 3, icon: FileCheck2 },
          ].map(({ label, stage, icon: Icon }) => {
            const done = finalizationStage > stage;
            const active = finalizationStage === stage;
            return (
              <div key={label} className="flex min-w-0 flex-col items-center">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full"
                  style={{
                    background: done ? 'rgba(34,197,94,0.14)' : 'var(--bg-primary)',
                    color: done ? 'rgba(74,222,128,0.95)' : active ? 'rgba(96,165,250,0.98)' : 'var(--text-muted)',
                    border: '1px solid var(--border-faint)',
                  }}>
                  {active && !done ? <MapSpinner size={13} /> : <Icon size={14} />}
                </span>
                <span className="mt-2 text-[10px] leading-4 text-token-muted">{label}</span>
              </div>
            );
          })}
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--bg-tertiary)' }}>
          <span
            className="block h-full rounded-full transition-all duration-300 motion-reduce:transition-none"
            style={{
              width: `${finalizationStage === 1 ? 20 : finalizationStage === 2 ? 62 : 92}%`,
              background: 'linear-gradient(90deg, rgba(34,197,94,0.75), rgba(96,165,250,0.95))',
            }}
          />
        </div>
      </div>

      <p className="text-[11px] leading-relaxed text-token-muted">
        这里不做 AI 总结；结果页打开后，你可以立即播放，再决定是否一键整理。
      </p>
    </div>
  ) : (
    <div
      aria-live="polite"
      className="mx-auto flex w-full max-w-[520px] flex-col gap-4 py-4">

      {/*
        稿面 R3：网络降级时最先要说的不是「转写挂了」，而是「音频一秒都不会丢」。
        用户在这一刻唯一怕的是白录一场，所以这条横幅压在所有内容之上。
      */}
      {networkDegraded && (
        <div
          className="flex items-start gap-2.5 rounded-[14px] px-3.5 py-3 text-left"
          style={{ background: 'var(--semantic-warning-soft)' }}>
          <WifiOff size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--semantic-warning-text)' }} aria-hidden />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold" style={{ color: 'var(--semantic-warning-text)' }}>
              网络较弱，实时字幕已暂停
            </p>
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--semantic-warning-text)' }}>
              完整音频正在本机安全录制与缓存，<strong>不会丢失任何一秒</strong>。结束录音后会自动上传并校准出完整原文。
            </p>
          </div>
        </div>
      )}

      {/* 状态胶囊：稿面把它做成有底色的药丸，而不是一行裸文字——远看就知道现在在录还是停着 */}
      <div className="flex justify-center">
        {state === 'requesting' ? (
          <span
            className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-semibold"
            style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
            <MapSpinner size={12} /> 正在请求麦克风权限…
          </span>
        ) : state === 'paused' ? (
          <span
            className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-semibold"
            style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}>
            <Pause size={13} /> 已暂停
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-semibold"
            style={{ background: 'var(--semantic-danger-soft)', color: 'var(--semantic-danger)' }}>
            <motion.span
              className="h-2 w-2 rounded-full"
              style={{ background: 'var(--semantic-danger)' }}
              animate={{ opacity: [1, 0.25, 1] }}
              transition={{ duration: 1.4, repeat: Infinity }}
            />
            正在录音
          </span>
        )}
      </div>

      {/* 计时大字：这一屏唯一的主角，稿面给了近 60px */}
      <p
        data-testid="recording-elapsed"
        className="text-center text-[56px] font-semibold leading-none tracking-tight tabular-nums"
        style={{ color: state === 'paused' ? 'var(--text-muted)' : 'var(--text-primary)' }}>
        {formatElapsed(elapsed)}
      </p>

      {/* 三块凭据：已保护 / 本机存了多少 / 传了多少。数字全部来自真实计数，不是占位 */}
      <div className="flex flex-wrap items-center justify-center gap-2" data-testid="recording-guard-chips">
        {captureChips.map(chip => {
          const tone = CAPTURE_CHIP_TONE[chip.tone];
          const Icon = CAPTURE_CHIP_ICON[chip.icon];
          return (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[12px] font-semibold"
              style={{ background: tone.bg, color: tone.fg }}>
              <Icon size={13} aria-hidden /> {chip.label}
            </span>
          );
        })}
      </div>

      {/* 实时电平波形（产物感：屏幕上有持续变化的内容） */}
      <div data-testid="recording-waveform" className="w-full">
        <canvas
          ref={canvasRef}
          width={1040}
          height={128}
          className="w-full"
          style={{ height: 64, color: 'var(--accent-fg-info)' }}
        />
        {state === 'paused' && (
          <p className="mt-2 text-center text-[12px] text-token-muted">波形已冻结 · 采集暂停中</p>
        )}
      </div>

      {/* 实时原文卡 */}
      <div
        className="w-full rounded-[16px] px-4 py-3.5 text-left"
        data-testid="recording-live-card"
        style={{
          background: 'var(--bg-card)',
          border: liveView === 'degraded'
            ? '1px solid var(--semantic-warning-soft)'
            : '1px solid var(--border-faint)',
        }}>
        <div className="flex items-center justify-between gap-3">
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
            {liveView === 'degraded' ? (
              <>
                <AlertTriangle size={14} className="shrink-0" style={{ color: 'var(--semantic-warning-text)' }} aria-hidden />
                <span className="truncate" style={{ color: 'var(--semantic-warning-text)' }}>{liveTranscriptTitle}</span>
              </>
            ) : (
              <>
                <Mic size={14} className="shrink-0" style={{ color: 'var(--accent-fg-info)' }} aria-hidden />
                <span className="truncate text-token-primary">{liveTranscriptTitle}</span>
              </>
            )}
          </span>
          {liveView === 'degraded' ? (
            retryCountdown && (
              <span className="shrink-0 text-[12px] tabular-nums" style={{ color: 'var(--semantic-warning-text)' }}>
                {retryCountdown}
              </span>
            )
          ) : liveSentences.length > 3 ? (
            <button
              type="button"
              onClick={() => setLiveTranscriptExpanded(value => !value)}
              className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-[8px] text-[13px] font-semibold"
              style={{ color: 'var(--accent-fg-info)' }}
              aria-expanded={liveTranscriptExpanded}
              aria-controls="recording-live-transcript">
              {liveTranscriptExpanded ? '收起' : `展开全部 ${liveSentences.length} 句`}
              {liveTranscriptExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          ) : null}
        </div>
        {/* 连接状态的细节（重连第几次、正在确认最后一句）不占版面，但读屏要听得到 */}
        <p className="sr-only" aria-live="polite">{liveTranscriptMessage}</p>

        {/*
          稿面 R3 / cap-A2：断线这段不是「什么都没有」，而是「这一段稍后会补上」。
          所以先说清中断在第几分钟、录音没受影响，再用骨架条把那段空白**画出来**，
          让用户看得见它的位置，而不是以为原文到此为止。
        */}
        {liveView === 'degraded' && (
          <div
            className="mt-3 rounded-[12px] px-3 py-2.5 text-[12px] leading-relaxed"
            style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}>
            网络波动导致实时字幕中断{degradedAtSec != null ? `（${formatElapsed(degradedAtSec)}）` : ''}。
            <strong>录音与上传未受影响</strong>，结束后会自动补齐完整原文。
          </div>
        )}

        <div
          id="recording-live-transcript"
          data-testid="recording-live-transcript"
          ref={liveTranscriptScrollRef}
          className="mt-3 pr-1"
          style={{
            maxHeight: liveTranscriptExpanded ? 'min(42dvh, 360px)' : 168,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
          }}>
          {liveSentences.length === 0 ? (
            <p className="text-[14px] leading-7 text-token-muted">
              {liveView === 'degraded'
                ? '录音仍在本机和服务端持续保存，结束后会自动生成原文。'
                : '开始说话后，识别文字会显示在这里。'}
            </p>
          ) : liveTranscriptExpanded ? (
            // 展开态（稿面 cap-A3）：逐句带上它第一次出现的录音时刻
            <ol className="flex flex-col gap-3">
              {liveSentences.map((sentence, index) => {
                const last = index === liveSentences.length - 1;
                return (
                  <li key={`${index}-${sentence.atSec}`} className="flex items-start gap-3">
                    <span
                      className="mt-[3px] shrink-0 font-mono text-[12px] tabular-nums"
                      style={{ color: last ? 'var(--accent-fg-info)' : 'var(--text-muted)' }}>
                      {formatElapsed(sentence.atSec)}
                    </span>
                    <span
                      className="min-w-0 text-[14px] leading-7"
                      style={{ color: last ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                      {sentence.text}
                      {last && state === 'recording' && <LiveCaret />}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            // 折叠态（稿面 R1/A1）：只留最后三句，越新越实——最新那句是黑体，还带着光标
            <div className="flex flex-col gap-2.5">
              {liveSentences.slice(-3).map((sentence, index, arr) => {
                const last = index === arr.length - 1;
                const faded = index === 0 && arr.length === 3;
                return (
                  <p
                    key={`${index}-${sentence.atSec}`}
                    className={`text-[14px] leading-7 ${last && !paused ? 'font-semibold' : ''}`}
                    style={{
                      color: faded || paused
                        ? 'var(--text-muted)'
                        : last ? 'var(--text-primary)' : 'var(--text-secondary)',
                    }}>
                    {faded ? `…${sentence.text}` : sentence.text}
                    {last && state === 'recording' && <LiveCaret />}
                  </p>
                );
              })}
            </div>
          )}
          {liveView === 'degraded' && (
            <div className="mt-3 flex flex-col gap-2" aria-hidden>
              <span className="block h-3 w-3/4 rounded-full" style={{ background: 'var(--bg-elevated)' }} />
              <span className="block h-3 w-1/2 rounded-full" style={{ background: 'var(--bg-elevated)' }} />
            </div>
          )}
        </div>

        {liveView === 'degraded' && (
          <p className="mt-3 text-[12px] leading-relaxed text-token-muted">
            结束后自动补齐这段空白，无需手动操作。
          </p>
        )}
      </div>

      {/* 静音确认：整段峰值电平过低 → 上传前拦一道 */}
      {confirmSilent && (
        <div
          className="w-full rounded-[12px] p-3 text-left text-[12px]"
          style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}>
          <p className="mb-2">整段录音几乎没有检测到声音，转录很可能失败。请确认麦克风没有静音。</p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="xs" onClick={() => stopRecorder('complete')}>仍要转成文字</Button>
            <Button variant="ghost" size="xs" onClick={() => stopRecorder('discard')}>放弃本次录音</Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirmSilent(false)}>继续录</Button>
          </div>
        </div>
      )}
    </div>
  );

  const capturing = state === 'recording' || state === 'paused' || state === 'requesting';

  const overlay = (
    <motion.div
      className={`surface-backdrop fixed inset-0 z-[100] flex ${isMobile ? 'items-end' : 'justify-end'}`}
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      exit={{ backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.2 }}
      onClick={(e) => { if (e.target === e.currentTarget) stopRecorder('discard'); }}>
      <motion.div
        // 采集屏走稿面那套配色（作用域皮肤，不动全站主色）
        className={`recording-design-palette flex flex-col ${isMobile ? 'w-full' : 'h-full w-[440px] max-w-[92vw]'}`}
        style={{
          background: 'var(--bg-primary)',
          borderLeft: isMobile ? undefined : '1px solid var(--border-faint)',
          ...(isMobile ? {
            height: '100dvh',
            maxHeight: '100dvh',
            paddingBottom: 'env(safe-area-inset-bottom)',
          } : {}),
        }}
        initial={isMobile ? { y: '100%' } : { x: '100%' }}
        animate={isMobile ? { y: 0 } : { x: 0 }}
        exit={isMobile ? { y: '100%' } : { x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        onClick={(e) => e.stopPropagation()}>

        {/* 顶栏（稿面 R1/A1）：左关闭、中间标题 + 保存目标、右更多 */}
        <div className="relative shrink-0 px-4 py-3">
          <div className="flex items-start justify-between gap-2">
            <button
              onClick={() => stopRecorder('discard')}
              disabled={state === 'finalizing'}
              aria-label="取消录音"
              className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-[12px] text-token-primary disabled:cursor-not-allowed disabled:opacity-40"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}>
              <X size={16} />
            </button>
            <div className="min-w-0 flex-1 pt-0.5 text-center">
              <p className="truncate text-[16px] font-semibold text-token-primary">录音转笔记</p>
              <div className="mt-0.5 flex justify-center">{destinationPicker}</div>
            </div>
            <button
              onClick={() => setMenuOpen(value => !value)}
              aria-label="更多操作"
              aria-expanded={menuOpen}
              className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-[12px] text-token-primary"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}>
              <MoreHorizontal size={16} />
            </button>
          </div>
          {menuOpen && (
            <>
              <button
                aria-hidden
                tabIndex={-1}
                onClick={() => setMenuOpen(false)}
                className="fixed inset-0 z-0 cursor-default"
                style={{ background: 'transparent' }}
              />
              <div
                className="absolute right-4 top-[60px] z-10 w-[188px] overflow-hidden rounded-[12px] py-1"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)', boxShadow: '0 12px 32px rgba(15,18,22,0.16)' }}>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    if (!canDiscardRecording(finalizationLockedRef.current)) return;
                    stopRecorder('discard');
                    onPickFile(targetStoreId || storeId);
                  }}
                  disabled={state === 'finalizing'}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[13px] text-token-primary hover-bg-soft disabled:opacity-40">
                  <FileUp size={14} /> 上传已有音频文件
                </button>
                <button
                  onClick={() => { setMenuOpen(false); stopRecorder('discard'); }}
                  disabled={state === 'finalizing'}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-[13px] hover-bg-soft disabled:opacity-40"
                  style={{ color: 'var(--semantic-danger)' }}>
                  <X size={14} /> 放弃本次录音
                </button>
              </div>
            </>
          )}
        </div>

        <div
          className="flex flex-1 px-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {body}
        </div>

        {/*
          底部操作条（稿面 R1/R2/A1）：录音时是「暂停 + 结束录音」，暂停时主按钮翻成
          「继续录音」、结束退成右边那颗方钮——主按钮永远是此刻最该点的那一个。
        */}
        {capturing && (
          <div
            className="shrink-0 px-4 pb-4 pt-3"
            style={{ borderTop: '1px solid var(--border-faint)' }}>
            {state === 'paused' ? (
              <div className="flex items-center gap-3">
                <button
                  onClick={togglePause}
                  data-testid="recording-resume"
                  aria-label="继续录音"
                  className="flex h-14 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full text-[16px] font-semibold transition-transform active:scale-[0.99]"
                  style={{ background: 'var(--accent-fg-info)', color: 'var(--bg-card)' }}>
                  <Play size={18} fill="currentColor" /> 继续录音
                </button>
                <button
                  onClick={requestComplete}
                  data-testid="recording-finish"
                  aria-label="结束录音并转成文字"
                  className="flex h-14 w-14 shrink-0 cursor-pointer items-center justify-center rounded-[18px] transition-transform active:scale-95"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}>
                  <Square size={18} fill="var(--semantic-danger)" stroke="none" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  onClick={togglePause}
                  disabled={state === 'requesting'}
                  aria-label="暂停录音"
                  className="flex h-14 w-14 shrink-0 cursor-pointer items-center justify-center rounded-[18px] transition-transform active:scale-95 disabled:opacity-40"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)', color: 'var(--text-primary)' }}>
                  <Pause size={18} />
                </button>
                <button
                  onClick={requestComplete}
                  data-testid="recording-finish"
                  disabled={state === 'requesting'}
                  aria-label="结束录音并转成文字"
                  className="flex h-14 flex-1 cursor-pointer items-center justify-center gap-2.5 rounded-full text-[16px] font-semibold transition-transform active:scale-[0.99] disabled:opacity-40"
                  style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}>
                  <span className="h-3.5 w-3.5 rounded-[4px]" style={{ background: 'var(--semantic-danger)' }} aria-hidden />
                  结束录音
                </button>
              </div>
            )}
            <button
              onClick={() => {
                if (!canDiscardRecording(finalizationLockedRef.current)) return;
                stopRecorder('discard');
                onPickFile(targetStoreId || storeId);
              }}
              className="mt-3 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-[10px] py-2 text-[13px] font-semibold"
              style={{ color: 'var(--accent-fg-info)' }}>
              <FileUp size={14} /> 上传已有音频文件
            </button>
          </div>
        )}

        {state === 'finalizing' && (
          <div className="shrink-0 px-4 pb-4 pt-3" style={{ borderTop: '1px solid var(--border-faint)' }}>
            <p className="text-center text-[12px] text-token-muted">录音已锁定，这一步不需要操作</p>
          </div>
        )}
      </motion.div>
    </motion.div>
  );

  return createPortal(overlay, document.body);
}
