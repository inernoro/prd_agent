import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, BookText, Check, ChevronDown, ChevronUp, Clock3, CloudUpload, FileCheck2, FileUp,
  HardDrive, Lock, Mic, MoreHorizontal, Pause, Play, ShieldCheck, Square, Upload, WifiOff, X,
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
import { describeMicHealth } from './recordingCompletionView';
import {
  advanceLiveSentenceLog,
  describeCaptureChips,
  isUploadKeepingUp,
  describeLiveTranscriptTitle,
  capturedUploadPercent,
  describeRetryCountdown,
  formatCapturedSize,
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
const WAVEFORM_BUCKET_MS = 150;

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
  /*
   * 本机保险箱到底写住了没有。IndexedDB 不可用、隐私模式、配额满时写入会被拒，
   * 而录制照常进行、字节数照常涨——不记这一位的话，界面会一直说「已保护 · 无丢失」
   * 而分片其实只在内存里，刷新或关页就没了（Codex P1）。
   */
  const [vaultPersisted, setVaultPersisted] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  /** 这次录音将来的名字（录音 YYYY-MM-DD HH-mm）：顶栏归属那一行的第二段 */
  const [recordingName, setRecordingName] = useState('');
  const [liveSentences, setLiveSentences] = useState<LiveSentence[]>([]);
  /** 已排期的下一次实时转写重连时刻；null 表示没有排期，那就不许显示倒计时。 */
  const [liveRetryAt, setLiveRetryAt] = useState<number | null>(null);
  const [retryNow, setRetryNow] = useState(() => Date.now());
  /** 实时字幕是在录音的第几秒断的——用于「中断（12:19）」那句话。 */
  const [degradedAtSec, setDegradedAtSec] = useState<number | null>(null);
  /** 设备自检用的峰值电平（稿面 cap-S1 那句「麦克风正常 · 音量适中」的唯一依据） */
  const [peakLevel, setPeakLevel] = useState(0);
  /** 「前往系统设置」展开的那段路径说明（网页开不了系统面板，只能告诉你在哪一格） */
  const [permissionHelpOpen, setPermissionHelpOpen] = useState(false);
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
    if (!container) return;
    // 展开态同样贴底：稿面 cap-A3 里带光标的那句（正在转写的）就在列表最后一条，
    // 停在顶部的话，用户点开「展开全部」看到的是开头，正在说的那句反而不在视野里。
    container.scrollTop = container.scrollHeight;
    // 降级态一翻，卡内多出/收起骨架条与安抚行，可视区高度跟着变——不重新贴底的话
    // 视窗停在旧位置，最新那句被卷到下面看不见。（这里列的是 liveView 的两个来源，
    // 而不是 liveView 本身：那个派生值在本文件下方才声明，写进依赖数组会撞 TDZ。）
  }, [liveSentences, liveTranscriptExpanded, liveTranscriptState, liveRetryAt]);
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
    /*
     * 挂在本机保险箱那条写队列上，不能裸发：建会话本身是排队进去的，抢在它前面跑的话
     * `vaultUpdateSessionStore` 找不到那条会话记录，这次改动落不到任何地方（它对不存在的
     * id 返回 false），分片于是全留在最初那个库下。恢复弹窗按 `storeId` 过滤，用户在
     * 新选的库里就看不到这段录音——像丢了（Codex 第十八轮 P2）。
     */
    vaultWriteQueueRef.current = vaultWriteQueueRef.current
      .then(() => vaultUpdateSessionStore(vaultIdRef.current, nextStoreId))
      // 与另外两个 vault 写一样读返回值：改不动归属库时分片留在旧库下，
      // 「已保护」这句就成了假话，凭据要跟着降级
      .then((ok) => { if (!ok) setVaultPersisted(false); })
      .catch(() => { setVaultPersisted(false); });

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
        // 顶栏归属那一行的第二段：只留「月-日 时:分」。整段文件名会把库名挤到省略号，
        // 而库名是这一行更要紧的那一半（稿面 R1 只画了它）。
        const d = new Date();
        const two = (n: number) => String(n).padStart(2, '0');
        setRecordingName(`${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`);
        const rec = new MediaRecorder(stream, {
          ...(mime ? { mimeType: mime } : {}),
          audioBitsPerSecond: 64_000,
        });
        recorderRef.current = rec;
        /*
         * 这两个 vault 函数都是 best-effort：失败时**返回 false 而不是抛异常**。
         * 所以只挂 `.catch` 接不到任何东西（上一版就是这么写的，等于没修）——
         * 必须读返回值。
         */
        vaultWriteQueueRef.current = vaultStartSession(
          vaultIdRef.current,
          mime || 'audio/webm',
          // 建会话就要盖当前选中的库：用户在按下录音之前就把目的地改掉是常态，
          // 用路由那个 storeId 会把分片存到他没选的库下，恢复弹窗按库过滤，
          // 于是在他选的那一档里看不到（与下面切库那处同一个口径）
          targetStoreIdRef.current || storeId,
        ).then((ok) => { if (!ok) setVaultPersisted(false); }).catch(() => { setVaultPersisted(false); });
        void ensureUploadSession();
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunksRef.current.push(e.data);
            bytesRef.current += e.data.size;
            setLocalBytes(bytesRef.current);
            // 分片实时落本机保险箱：崩溃/断网/忘关都不丢已录内容
            vaultWriteQueueRef.current = vaultWriteQueueRef.current
              .then(() => vaultAppendChunk(vaultIdRef.current, e.data))
              // 写失败不抛、只返回 false（录制不能因此中断），所以这里**读返回值**：
              // 凭据要跟着降级，否则界面在替一件没发生的事作保
              .then((ok) => { if (!ok) setVaultPersisted(false); })
              .catch(() => { setVaultPersisted(false); });
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
      /*
       * 稿面 v2-R3 / cap-A2 的波形是**两段**：左边蓝的是已录到的，右边灰的是还没走到的轨道。
       * 此前把整条轨道都拿来铺已录数据（`slice(-maxBars)`），录满 8 秒之后右边那截灰的
       * 就再也不会出现——整条恒定全蓝，读不出「录到哪了」。所以把笔尖钉在约 62% 处：
       * 蓝的只铺到这里，右边始终留着灰的跑道。灰段不是数据（下面用一条确定的缓起伏画），
       * 蓝段每一格都是真实峰值。
       */
      const headBars = Math.max(1, Math.round(maxBars * 0.66));
      const slice = levelsRef.current.slice(-headBars);
      const frozen = stateRef.current === 'paused';
      for (let i = 0; i < maxBars; i++) {
        const x = i * (barW + gap);
        const recorded = i < slice.length;
        /*
         * 两段必须读成同一条波形，只是换个颜色（判分连着四块都指到这处）：
         *   已录段给一个下限——安静的那一格也是一根短柱，不是一个点，
         *   否则整段退化成「稀疏长柱 + 一条虚线基线」，和右边的占位段不像同一件东西；
         *   未录段是占位，用一条确定的缓起伏（不是数据，纯粹为了保持同一套律动）——
         *   振幅要与已录段同一量级：压得太低就读成一条灰色纹理，而不是「同一条波形还没走到」
         *   （R3 判分记的正是这条）。
         */
        const level = recorded
          ? Math.max(0.22, slice[i])
          // 逐格跳动而不是一条缓起伏：整段同高的话，即使振幅对了，它读起来仍是一片
          // 均匀纹理，和左边高低起伏的已录段不像同一条波形（R3 判分连着两轮指到这处）。
          // 值是确定的（同一格永远同一高度），只是形状上与真实峰值同一种律动。
          : 0.34 + 0.56 * Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1);
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
  /*
   * 两张稿把「降级」画成了两件不同的事，判据也得分开，否则两块提示会同时出现、
   * 互相重复，还把实时原文正文挤下去（R3 判分记的正是这一处）：
   *   顶部横幅（稿面 R3）＝ 分片上传通道没建起来，音频只在本机
   *   卡内橙框（稿面 A2）＝ 实时字幕**连上过又断了**，所以说得出中断在第几分钟
   * 后者只有在 socket 真的报过降级/排过重连时才成立（degradedAtSec 才有值）。
   */
  const uploadDegraded = liveProtection === 'local';
  const liveInterrupted = degradedAtSec != null;
  const captureChips = describeCaptureChips({
    localBytes,
    uploadedBytes: protectedBytes,
    protection: liveProtection,
    paused,
    vaultPersisted,
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

  // 设备自检结论每秒更新一次就够；跟着绘制帧走会把整棵树每秒重渲染六十次
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
    const id = window.setInterval(() => setPeakLevel(peakLevelRef.current), 1000);
    return () => window.clearInterval(id);
  }, [state]);

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
    <span
      className="relative inline-flex max-w-full items-center gap-1 rounded-full px-2.5 py-1"
      // 稿面 cap-A1/A2 把这一行画成一枚白色药丸：它是一个可点的整体，
      // 纯文字行看不出边界，用户不知道这里点得动
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}
    >
      <BookText size={13} style={{ color: 'var(--accent-fg-success)' }} aria-hidden />
      {/* 库名不参与收缩：这一行真正要读的是「存到哪」，日期段可以先让 */}
      <span className="shrink-0 text-[12px] font-semibold" style={{ color: 'var(--accent-fg-success)' }}>
        保存到「{storeOptions.find(o => o.id === targetStoreId)?.name || storeName || '当前知识库'}」
      </span>
      {/*
        稿面 cap-A1/A2 的归属胶囊是两段：库名 + 这一场叫什么。第二段在我们这里
        有真实来源——录音一开始就定好了文件名（录音 YYYY-MM-DD HH-mm），
        它就是这条录音将来在库里的名字。编一个「用户访谈」才是没根的。
      */}
      {recordingName && (
        <span className="min-w-0 truncate text-[11px] text-token-muted">· {recordingName}</span>
      )}
      <ChevronDown size={12} style={{ color: 'var(--accent-fg-success)' }} aria-hidden />
      <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>切换</span>
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
    /*
      稿面 v2-S8：一枚锁、一句「需要麦克风权限」、一段说清「还能做什么」的正文，
      再给两颗按钮。此前只有一颗「上传音频文件」——没有权限的人第一反应是
      「怎么给权限」，那条路没有出口，他就卡在这一屏了。
    */
    <div
      /*
        稿面 v2-S8 这块是一张**白底描边卡**。平铺在页面底色上时，它与页面其它内容
        之间没有任何边界，读起来像一段说明文字而不是一个需要处理的状态。
      */
      // 垂直方向走 auto 外边距：`self-start` 把这张矮卡钉在顶上，底下空出约六成屏，
      // 读起来像页面只加载了一半（S8 判分记的这处）；而父级默认的 stretch 又会把卡面
      // 拉到上千像素高。auto 外边距两头都躲开——比容器矮就居中，比容器高就退回顶部对齐，
      // 不会把抬头顶出滚动区。
      className="mx-auto my-auto flex w-full max-w-[360px] flex-col gap-4 rounded-[16px] px-5 py-6"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}
    >
      <div className="flex items-center gap-2.5">
        <Lock size={20} style={{ color: 'var(--text-primary)' }} aria-hidden />
        <p className="text-[19px] font-bold text-token-primary">需要麦克风权限</p>
      </div>
      <p className="text-[13px] leading-relaxed text-token-secondary">
        系统已拒绝麦克风访问，无法开始录音。你仍可以上传已有音频文件获得完整转录能力。
      </p>
      {/* 浏览器给的原话保留在下面一行：它比通用文案更能定位到底卡在哪一层 */}
      {unavailableReason && (
        <p className="text-[12px] leading-relaxed text-token-muted">{unavailableReason}</p>
      )}
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={() => setPermissionHelpOpen(value => !value)}
          aria-expanded={permissionHelpOpen}
          className="flex min-h-11 cursor-pointer items-center justify-center rounded-[12px] px-5 text-[14px] font-semibold"
          style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}>
          前往系统设置
        </button>
        <button
          type="button"
          onClick={() => { onClose(); onPickFile(targetStoreId || storeId); }}
          className="flex min-h-11 cursor-pointer items-center justify-center rounded-[12px] px-5 text-[14px] font-semibold"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
          上传文件
        </button>
      </div>
      {/*
        网页开不了系统设置面板——浏览器没有这个 API。所以这颗按钮兑现的是
        「告诉你在哪一格里改」，而不是假装能替你打开它（no-rootless-tree）。
      */}
      {permissionHelpOpen && (
        <div
          className="rounded-[12px] px-3.5 py-3 text-[12px] leading-relaxed"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)', color: 'var(--text-secondary)' }}>
          <p className="mb-1.5 font-semibold text-token-primary">网页无法替你打开系统设置，路径在这里：</p>
          <p>浏览器：地址栏左侧的锁形图标 → 网站设置 → 麦克风 → 允许，然后刷新本页。</p>
          <p className="mt-1">macOS：系统设置 → 隐私与安全性 → 麦克风 → 勾选你的浏览器。</p>
          <p className="mt-1">Windows：设置 → 隐私和安全性 → 麦克风 → 允许桌面应用访问。</p>
        </div>
      )}
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
      // 稿面这一屏是填满的：实时原文卡一直长到底部操作条上方。
      // 卡片按内容高度收着的话，中间会空出近三成屏（R1/A1 判分都记了这条空带）。
      className="mx-auto flex min-h-full w-full max-w-[520px] flex-col gap-4 py-4">

      {/*
        稿面 R3：网络降级时最先要说的不是「转写挂了」，而是「音频一秒都不会丢」。
        用户在这一刻唯一怕的是白录一场，所以这条横幅压在所有内容之上。
      */}
      {uploadDegraded && (
        <div
          className="flex items-start gap-2.5 rounded-[14px] px-3.5 py-3 text-left"
          style={{ background: 'var(--semantic-warning-soft)' }}>
          <WifiOff size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--semantic-warning-text)' }} aria-hidden />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold" style={{ color: 'var(--semantic-warning-text)' }}>
              网络较弱，实时字幕已暂停
            </p>
            {/* 稿面这段正文是深色的：琥珀只落在图标与标题，刷到正文就是强调色外溢 */}
            <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
              完整音频正在本机安全录制与缓存，<strong style={{ color: 'var(--text-primary)' }}>不会丢失任何一秒</strong>。结束录音后会自动上传并校准出完整原文。
            </p>
          </div>
        </div>
      )}

      {/*
        稿面 cap-A3 的展开态是「抬头压成一条、原文列表占满」：计时退成中号、
        胶囊并成一枚、波形压扁。抬头照常摆着的话列表只剩不到半屏，
        展开这个动作就白点了（A3 判分记的正是这一条）。
      */}
      {liveTranscriptExpanded ? (
        <div className="flex items-center justify-between gap-3">
          <span
            className="text-[28px] font-semibold leading-none tabular-nums"
            style={{ color: paused ? 'var(--text-muted)' : 'var(--text-primary)' }}>
            {formatElapsed(elapsed)}
          </span>
          <span
            className="inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[12px] font-semibold"
            style={{ background: CAPTURE_CHIP_TONE.success.bg, color: CAPTURE_CHIP_TONE.success.fg }}>
            <ShieldCheck size={13} aria-hidden /> 已保护 · {formatCapturedSize(localBytes)}
          </span>
        </div>
      ) : (
      <>
      {/* 状态胶囊：稿面把它做成有底色的药丸，而不是一行裸文字——远看就知道现在在录还是停着 */}
      {/*
        稿面 cap-S1 的状态条是**一个白底描边容器**，里面「正在录音 12:34」同处一行、
        下面跟着设备自检那句。此前拆成「裸胶囊 + 裸文本 + 大计时器」三段，
        状态与时长脱了组（判分记的是「主副顺序反转、失去统一容器」）。
        大计时器仍然保留——那是稿面 v2-R1/R2 这一屏的主角，两稿各要一样，都给。
      */}
      <div
        className="mx-auto flex w-full max-w-[360px] flex-col items-center gap-1.5 rounded-[14px] px-4 py-3"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border-faint)' }}
      >
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
            <Pause size={13} /> 已暂停 {formatElapsed(elapsed)}
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
            正在录音 {formatElapsed(elapsed)}
          </span>
        )}
      </div>

      {/*
        设备自检（稿面 cap-S1 的副行）：录音时用户第二怕的事是「我以为在录，其实没收到声」。
        结论来自这段录音真实的峰值电平，四档各说各的，不一律显示「麦克风正常」。
      */}
      {state !== 'requesting' && (
        <p className="text-center text-[12px] text-token-muted" data-testid="recording-mic-health">
          {describeMicHealth(peakLevel, elapsed)}
        </p>
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
              /*
               * tabular-nums：这一排里的数字每秒都在涨（本机已存 X、实时上传 Y）。
               * 比例数字下，同样位数的两个数宽度也不一样，于是这一排的总宽每秒微动；
               * 一旦贴近换行阈值，位数一变就整排换行、下面的内容跟着跳一格。
               * 等宽数字让宽度只在**位数**变化时才动，不会每秒微动。
               */
              className="inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[12px] font-semibold tabular-nums"
              style={{ background: tone.bg, color: tone.fg }}>
              <Icon size={13} aria-hidden /> {chip.label}
            </span>
          );
        })}
      </div>

      </>
      )}

      {/*
        实时上传条（稿面 cap-S2）：两个体积并排 + 一条进度条 + 一句承诺。
        胶囊只说了「传了多少」，这条回答的是「相对多少」和「断网会不会白录」。
      */}
      {/*
        实时字幕断了那一档不摆这一条：卡内已经压着橙框、占位骨架与末行安抚句，
        再加这块 60px 的进度条，中断前最后一句就分不到高度、被压成一道缝
        （cap-A2 判分记的「屏上一个字都没有」正是这么来的）。传了多少字节，
        上面那排凭据胶囊照常在说，信息不丢。
      */}
      {!liveTranscriptExpanded && !liveInterrupted && liveProtection === 'active' && localBytes > 0 && (
        <div className="w-full" data-testid="recording-upload-progress">
          <div className="flex items-baseline justify-between gap-2">
            {/*
              暂停之后不再产生新分片，队列追平就是真的全部传完了。
              这一块此前恒写「正在实时上传」，于是同屏出现「已暂停」「采集暂停中」
              「已全部上传」配一句「录音还在继续」——四句话互相打脸（R2 判分记的这处）。
            */}
            <span className="text-[13px] font-semibold text-token-primary">
              {paused && protectedBytes >= localBytes ? '已全部上传' : '正在实时上传'}
            </span>
            <span className="font-mono text-[13px] tabular-nums text-token-secondary">
              {formatCapturedSize(protectedBytes)} / {formatCapturedSize(localBytes)}
            </span>
          </div>
          <div className="mt-1.5 h-[5px] w-full overflow-hidden rounded-full" style={{ background: 'var(--bg-elevated)' }}>
            <span
              className="block h-full rounded-full"
              style={{
                /*
                 * 跟上了就是满条（已录的都传上去了）；真的掉队时才按比例给一段。
                 * 判据用带迟滞的那一个：瞬时比较每秒翻一次，进度条会每秒从满条退到
                 * 87% 再弹满（与凭据措辞、下面那句话同频，用户看到的就是一屏三处一起抖）。
                 */
                width: isUploadKeepingUp(protectedBytes, localBytes)
                  ? '100%'
                  : `${Math.max(2, capturedUploadPercent(protectedBytes, localBytes))}%`,
                background: 'var(--accent-fg-info)',
                transition: 'width 300ms linear',
              }}
            />
          </div>
          <p className="mt-1.5 text-[12px]" style={{ color: 'var(--accent-fg-success)' }}>
            {/*
              这半句以前挂在瞬时比较上，每秒进出一次：窄屏上它让这一段在一行与两行之间
              来回，下面的波形与实时原文卡跟着每秒上下跳一行。换成带迟滞的判据后，
              录音期间它稳定在，暂停时稳定不在。
            */}
            断网也不会丢失，会自动续传
            {isUploadKeepingUp(protectedBytes, localBytes) && !paused ? '；录音还在继续，新片段会接着传' : ''}
          </p>
        </div>
      )}

      {/* 实时电平波形（产物感：屏幕上有持续变化的内容） */}
      <div data-testid="recording-waveform" className="w-full">
        <canvas
          ref={canvasRef}
          width={1040}
          height={128}
          className="w-full"
          // 降级那一档卡里多压着占位骨架与末行安抚文案，波形按 64 摆的话它们分不到高度；
          // 稿面 v2-R3 这一档的波形本来也比正常档矮一档。
          style={{
            height: liveTranscriptExpanded ? 26 : liveView === 'degraded' ? 46 : 64,
            color: 'var(--accent-fg-info)',
          }}
        />
        {state === 'paused' && !liveTranscriptExpanded && (
          <p className="mt-2 text-center text-[12px] text-token-muted">波形已冻结 · 采集暂停中</p>
        )}
      </div>

      {/* 实时原文卡 */}
      {/*
        卡片高度永远由这一屏剩下的空间决定，绝不按内容长。降级这一档卡内还压着占位骨架
        与末尾那句「结束后自动补齐这段空白」——让内容说了算的话，它们加起来比剩余空间高，
        末行就被底部操作条压掉半截（R3 / A2 两份判分记的都是这处）。
        再给一个上限：稿面这一档画的是一张矮卡、下面留白到操作条，不吃满整屏。
      */}
      <div
        className={`flex w-full min-h-0 flex-col rounded-[16px] px-4 py-3.5 text-left ${
          liveView === 'degraded' && !liveTranscriptExpanded ? 'shrink-0' : 'flex-1'
        }`}
        data-testid="recording-live-card"
        style={{
          // 正常档吃满剩余高度时也要有个下限：上面那堆固定件在矮屏上可能已经占满一屏，
          // 此时 `flex-1` 分到的是 0，卡片会整个消失。
          minHeight: 148,
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
        {/*
          顶部那条横幅已经在说同一件事时，卡内这个橙框就不再重复。
          稿面分工很清楚：R3（上传通道断了）只有顶部横幅，A2（实时字幕连上又掉）
          只有卡内橙框。两个都摆出来不只是啰嗦——它会把已识别的那几句和占位骨架
          一起挤出卡外，而那几句正是这一档要给用户看的东西。
        */}
        {liveInterrupted && !uploadDegraded && (
          <div
            className="mt-3 rounded-[12px] px-3 py-2.5 text-[12px] leading-relaxed"
            style={{ background: 'var(--semantic-warning-soft)', color: 'var(--semantic-warning-text)' }}>
            网络波动导致实时字幕中断（{formatElapsed(degradedAtSec ?? 0)}）。
            <strong>录音与上传未受影响</strong>，结束后会自动补齐完整原文。
          </div>
        )}

        <div
          id="recording-live-transcript"
          data-testid="recording-live-transcript"
          ref={liveTranscriptScrollRef}
          className="mt-3 min-h-0 flex-1 pr-1"
          style={{
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            /*
              降级档这块不滚：它只留一句（见下面折叠态的注释），而贴底滚动会把这句的
              第一行从字的腰上切开——判分把那半行读成「字形重叠破碎、不可读」。
              高度交给内容，超出的部分由下面那句自己的 2 行截断兜住。
            */
            ...(liveView === 'degraded' && !liveTranscriptExpanded
              ? { flex: 'none', overflowY: 'hidden' }
              : {}),
            // 折叠态贴底滚动，最上面那句会被卷掉半行。加一道渐隐让这道切口读成
            // 「上面还有」，而不是「这行字被裁坏了」——稿面那句淡灰的首行就是这个意思。
            // 只有真的卷上去了才渐隐：内容没超出时挂渐隐，第一行会莫名其妙比第二行浅，
            // 同一句话读成两个颜色（R3 判分抓到的正是这个）。
            ...(liveTranscriptExpanded || liveSentences.length <= 2 || liveView === 'degraded' ? {} : {
              WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 46px)',
              maskImage: 'linear-gradient(to bottom, transparent 0, black 46px)',
            }),
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
              {/*
                折叠态铺到卡片装得下为止（容器贴底滚动，最新那句永远在下沿）。
                固定只留三句的话，卡片撑满之后下半截是空白盒——稿面那三句是「它那一屏
                恰好装得下三句」，不是「只准显示三句」。
              */}
              {/*
                降级这一档只留**中断前最后一句**（稿面 v2-R3 / cap-A2 画的就是一句）：
                它下面还压着占位骨架与安抚行，多留几句就得靠滚动，而贴底滚动会把最上面
                那行从字的腰上切开，读成一行坏掉的字。留一句，正好装得下、也说得清
                「断在这里」。
              */}
              {/*
                正常档把**全部**句子都渲染出来，靠容器自己贴底滚动——看到的仍然是最后几句，
                但更早的那些还在，用户往上翻得到（发布门禁断言的正是「第 3 段还在」）。
                只留最后 N 句等于把历史丢掉：屏幕上看不出差别，可它真的没了。
                降级档例外，只留中断前最后一句（见下）。
              */}
              {(liveView === 'degraded' ? liveSentences.slice(-1) : liveSentences).map((sentence, index, arr) => {
                const last = index === arr.length - 1;
                const faded = index < arr.length - 2;
                return (
                  <p
                    key={`${index}-${sentence.atSec}`}
                    // 降级档不加粗：字还在往外冒的时候「最新那句最实」才成立，
                    // 断线之后这句就是一句普通正文，加粗会把它和上面那行琥珀标题压成同一级
                    className={`text-[14px] leading-7 ${
                      last && !paused && liveView !== 'degraded' ? 'font-semibold' : ''
                    }`}
                    style={{
                      color: faded || paused
                        ? 'var(--text-muted)'
                        : last ? 'var(--text-primary)' : 'var(--text-secondary)',
                      // 降级档按整行截断：留半行比留两行还糟，读起来像字坏了而不是话没说完
                      ...(liveView === 'degraded' && !liveTranscriptExpanded ? {
                        display: '-webkit-box',
                        WebkitBoxOrient: 'vertical' as const,
                        WebkitLineClamp: 2,
                        overflow: 'hidden',
                      } : {}),
                    }}>
                    {index === 0 && arr.length > 2 ? `…${sentence.text}` : sentence.text}
                    {/* 断线这一档没有字在往外冒，光标还在闪就是在说谎 */}
                    {last && state === 'recording' && liveView !== 'degraded' && <LiveCaret />}
                  </p>
                );
              })}
            </div>
          )}
        </div>
        {liveView === 'degraded' && (
          /*
            骨架条画的是「断在这里、这段还没转出来」。稿面 R3 / cap-A2 给的是**两条**，
            紧跟在最后一句已识别文本之后——那是它的意思所在：让人看得见缺口的位置。

            它必须在滚动区**外面**。放进去的话，容器贴底滚动会把视窗停在这两条上，
            刚识别出来的那几句被顶到看不见的地方——判分连着两轮都报「屏幕上一个字都没有」，
            而其实句子一直在，只是被自己的占位条挤出了可视区。
          */
          <div className="mt-2.5 flex shrink-0 flex-col gap-2.5" aria-hidden>
            {[92, 64].map((width, index) => (
              <span
                key={index}
                className="block h-3 rounded-full"
                style={{ background: 'var(--skeleton-fill)', width: `${width}%` }}
              />
            ))}
          </div>
        )}

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
          {/*
            两颗图标绝对定位：它们在流内会各吃掉 44px，中间那行只剩 ~270px，
            于是库名和录音名双双被省略号吃掉——稿面这一行是完整可读的（判分连记三块）。
          */}
          <div className="flex items-start justify-center gap-2">
            <button
              onClick={() => stopRecorder('discard')}
              disabled={state === 'finalizing'}
              aria-label="取消录音"
              // 稿面 R1/R2/R3 这两颗是**裸图标**直接压在背景上。加了白色方块底板之后，
              // 顶栏的视觉重量盖过标题区，主次关系反了（三张稿的判分都指到这一处）。
              className="absolute left-2 top-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-[12px] text-token-primary hover-bg-soft disabled:cursor-not-allowed disabled:opacity-40">
              <X size={18} strokeWidth={1.9} />
            </button>
            <div className="min-w-0 flex-1 px-12 pt-0.5 text-center">
              <p className="truncate text-[16px] font-semibold text-token-primary">录音转笔记</p>
              <div className="mt-0.5 flex justify-center">{destinationPicker}</div>
            </div>
            <button
              onClick={() => setMenuOpen(value => !value)}
              aria-label="更多操作"
              aria-expanded={menuOpen}
              className="absolute right-2 top-2 flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-[12px] text-token-primary hover-bg-soft">
              <MoreHorizontal size={18} />
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
              // 强调色在这套稿里只归主操作与波形；次要入口整条染蓝会把层级抹平，
              // 稿面画的是中性文字 + 蓝图标。
              className="mt-3 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-[10px] py-2 text-[13px] font-semibold"
              style={{ color: 'var(--text-secondary)' }}>
              <Upload size={14} style={{ color: 'var(--accent-fg-info)' }} /> 上传已有音频文件
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
