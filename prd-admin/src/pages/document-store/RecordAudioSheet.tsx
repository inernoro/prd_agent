import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileUp, Mic, MicOff, Pause, Play, Square, X } from 'lucide-react';
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
import { vaultStartSession, vaultAppendChunk, vaultDeleteSession, vaultUpdateSessionStore } from './recordingVault';
import { recordingExtension, selectRecordingMimeType } from './recordingMedia';

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
  onUploaded: (entry: DocumentEntry, vaultSessionId: string, targetStoreId?: string) => void;
  /** 「上传音频文件」兜底：打开既有的 audio file input */
  onPickFile: (targetStoreId?: string) => void;
};

type RecState = 'requesting' | 'recording' | 'paused' | 'finalizing' | 'unavailable';

/** 后端单文件上限 20MB；录到接近上限时自动收尾，避免上传被拒 */
const MAX_BYTES = 19 * 1024 * 1024;
const TRANSPORT_CHUNK_BYTES = 512 * 1024;

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

export function RecordAudioSheet({ storeId, storeName, onClose, onComplete, onUploaded, onPickFile }: RecordAudioSheetProps) {
  const isMobile = useIsMobile();
  const [state, setState] = useState<RecState>('requesting');
  const [unavailableReason, setUnavailableReason] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [targetStoreId, setTargetStoreId] = useState(storeId ?? '');
  const [protectedBytes, setProtectedBytes] = useState(0);
  const [liveProtection, setLiveProtection] = useState<'pending' | 'active' | 'local'>('pending');
  const [changingDestination, setChangingDestination] = useState(false);
  const [storeOptions, setStoreOptions] = useState<{ id: string; name: string }[]>(
    storeId ? [{ id: storeId, name: storeName || '当前知识库' }] : [],
  );
  const targetStoreIdRef = useRef(targetStoreId);
  targetStoreIdRef.current = targetStoreId;
  // 静音守卫：整段峰值电平过低时，完成前先确认（避免上传一段空录音）
  const [confirmSilent, setConfirmSilent] = useState(false);
  const peakLevelRef = useRef(0);
  // 本机保险箱会话：分片实时落 IndexedDB，上传成功前不删（断网/崩溃可恢复）
  const vaultIdRef = useRef(`rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const mimeRef = useRef('audio/webm');
  const fileNameRef = useRef('');
  const uploadSessionIdRef = useRef<string | null>(null);
  const uploadSessionPromiseRef = useRef<Promise<string | null> | null>(null);
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const uploadChunkIndexRef = useRef(0);
  const liveUploadFailedRef = useRef(false);
  // 完成/取消/组件卸载 的意图标记：onstop 回调按它决定产出 File / 删保险箱 / 保留保险箱。
  // abandon = 录音中组件被卸载（如 SPA 路由跳走）：保留保险箱数据，下次进页可恢复。
  const finishModeRef = useRef<'complete' | 'discard' | 'abandon'>('discard');
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

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
          return null;
        }
        uploadSessionIdRef.current = res.data.sessionId;
        setLiveProtection('active');
        return res.data.sessionId;
      })
      .catch(() => {
        liveUploadFailedRef.current = true;
        setLiveProtection('local');
        return null;
      });
    return await uploadSessionPromiseRef.current;
  }, [storeId]);

  const queueLiveChunk = useCallback((blob: Blob) => {
    uploadQueueRef.current = uploadQueueRef.current.then(async () => {
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
    }).catch(() => {
      liveUploadFailedRef.current = true;
      setLiveProtection('local');
    });
  }, [ensureUploadSession]);

  const changeDestination = useCallback(async (nextStoreId: string) => {
    if (changingDestination) return;
    setChangingDestination(true);
    setTargetStoreId(nextStoreId);
    targetStoreIdRef.current = nextStoreId;
    void vaultUpdateSessionStore(vaultIdRef.current, nextStoreId);

    // 已开始实时保护时，切库会重新建立会话，并把内存中的既有分片顺序补传到新库。
    // 这样用户不必在录音前做选择，也不会出现 UI 显示新库而文件实际留在旧库。
    try {
      if (!uploadSessionIdRef.current && !uploadSessionPromiseRef.current && !liveUploadFailedRef.current) return;
      await uploadQueueRef.current;
      const previousSessionId = uploadSessionIdRef.current;
      if (previousSessionId) await cancelRecordingUpload(previousSessionId).catch(() => null);
      uploadSessionIdRef.current = null;
      uploadSessionPromiseRef.current = null;
      uploadChunkIndexRef.current = 0;
      liveUploadFailedRef.current = false;
      uploadQueueRef.current = Promise.resolve();
      setProtectedBytes(0);
      setLiveProtection('pending');
      for (const chunk of chunksRef.current) queueLiveChunk(chunk);
    } finally {
      setChangingDestination(false);
    }
  }, [changingDestination, queueLiveChunk]);

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
    finishModeRef.current = mode;
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
        void vaultStartSession(vaultIdRef.current, mime || 'audio/webm', storeId);
        rec.ondataavailable = (e) => {
          if (e.data.size > 0) {
            chunksRef.current.push(e.data);
            bytesRef.current += e.data.size;
            // 分片实时落本机保险箱：崩溃/断网/忘关都不丢已录内容
            void vaultAppendChunk(vaultIdRef.current, e.data);
            queueLiveChunk(e.data);
            // 接近后端 20MB 上限：自动收尾并直接进转录，不让录音白费
            if (bytesRef.current >= MAX_BYTES && rec.state !== 'inactive') {
              finishModeRef.current = 'complete';
              rec.stop();
            }
          }
        };
        rec.onstop = async () => {
          if (finishModeRef.current === 'complete' && chunksRef.current.length > 0) {
            setState('finalizing');
            await uploadQueueRef.current;
            const sessionId = uploadSessionIdRef.current;
            if (sessionId && !liveUploadFailedRef.current) {
              let completed = await completeRecordingUpload(sessionId).catch(() => null);
              // 弱网下 /complete 的响应可能丢失，而服务端其实已创建条目。直接回退整文件
              // 上传会造成重复录音，所以先回读会话状态并幂等重试 /complete：服务端对已完成
              // 会话会返回同一条目（reused），不会重复创建。
              for (let attempt = 0; !completed?.success && attempt < 4; attempt++) {
                await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
                const status = await getRecordingUpload(sessionId).catch(() => null);
                // 会话已被取消/清理：服务端不存在也不会创建条目，走整文件兜底。
                if (status?.success && status.data.status === 'cancelled') break;
                // uploading / completing / completed 均可安全重试（幂等），completed 直接回条目。
                completed = await completeRecordingUpload(sessionId).catch(() => null);
              }
              if (completed?.success) {
                onUploadedRef.current(completed.data.entry, vaultIdRef.current, targetStoreIdRef.current || storeId);
                onClose();
                return;
              }
              liveUploadFailedRef.current = true;
              setLiveProtection('local');
            }
            const baseMime = (rec.mimeType || mimeRef.current).split(';')[0] || 'audio/webm';
            const blob = new Blob(chunksRef.current, { type: baseMime });
            const file = new File([blob], fileNameRef.current || buildFileName(recordingExtension(baseMime)), { type: baseMime });
            if (sessionId) void cancelRecordingUpload(sessionId);
            onCompleteRef.current(file, vaultIdRef.current, targetStoreIdRef.current || storeId);
          } else if (finishModeRef.current === 'discard') {
            // 用户主动放弃：保险箱一并清掉，不留恢复弹窗骚扰
            void vaultDeleteSession(vaultIdRef.current);
            await uploadQueueRef.current;
            const sessionId = uploadSessionIdRef.current;
            if (sessionId) void cancelRecordingUpload(sessionId);
          }
          // abandon（录音中被卸载）：保留保险箱，下次进页提示恢复
          if (finishModeRef.current !== 'abandon') onClose();
        };
        // 1s 一片：既能实时统计体积，又保证中途异常时已录内容不整段丢失
        rec.start(1000);

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
        }
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

  // 滚动波形绘制
  useEffect(() => {
    if (state !== 'recording' && state !== 'paused') return;
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
        levelsRef.current.push(level);
        peakLevelRef.current = Math.max(peakLevelRef.current, level);
        if (levelsRef.current.length > 240) levelsRef.current.shift();
      }
      const g = canvas.getContext('2d');
      if (!g) return;
      const { width, height } = canvas;
      g.clearRect(0, 0, width, height);
      const levels = levelsRef.current;
      const barW = 3;
      const gap = 2;
      const maxBars = Math.floor(width / (barW + gap));
      const slice = levels.slice(-maxBars);
      g.fillStyle = stateRef.current === 'paused' ? 'rgba(148,163,184,0.55)' : 'rgba(74,222,128,0.9)';
      slice.forEach((lv, i) => {
        const h = Math.max(2, lv * height);
        // 靠右滚动：最新电平贴右边
        const x = width - (slice.length - i) * (barW + gap);
        g.fillRect(x, (height - h) / 2, barW, h);
      });
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
    if (rec.state === 'recording') { rec.pause(); setState('paused'); }
    else if (rec.state === 'paused') { rec.resume(); setState('recording'); }
  };

  const destinationPicker = storeOptions.length > 0 ? (
    <label
      className="flex w-full items-center justify-between gap-3 rounded-[12px] px-3 py-2 text-left"
      style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}>
      <span className="shrink-0 text-[12px] font-semibold text-token-secondary">保存到</span>
      <select
        value={targetStoreId}
        onChange={(event) => { void changeDestination(event.target.value); }}
        disabled={state === 'finalizing' || changingDestination}
        className="min-h-11 min-w-0 flex-1 cursor-pointer rounded-[9px] px-3 text-[12px] text-token-primary outline-none"
        style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}>
        {storeOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    </label>
  ) : null;

  const body = state === 'unavailable' ? (
    <div className="mx-auto flex min-h-full w-full max-w-[360px] flex-col items-center justify-center gap-4 py-8 text-center">
      {destinationPicker}
      <span
        className="flex h-14 w-14 items-center justify-center rounded-full"
        style={{ background: 'rgba(239,68,68,0.12)', color: 'rgba(248,113,113,0.95)' }}>
        <MicOff size={24} />
      </span>
      <p className="max-w-[300px] text-[13px] leading-relaxed text-token-secondary">{unavailableReason}</p>
      <Button variant="primary" size="sm" onClick={() => { onClose(); onPickFile(targetStoreId || storeId); }}>
        <FileUp size={14} /> 上传音频文件
      </Button>
    </div>
  ) : (
    <div
      aria-live="polite"
      className="mx-auto flex min-h-full w-full max-w-[560px] flex-col items-center justify-center gap-5 py-8 text-center">
      {/* 状态行：录音中红点脉冲 / 已暂停 */}
      <div className="flex items-center gap-2 text-[12px] font-semibold">
        {state === 'requesting' ? (
          <><MapSpinner size={12} /><span className="text-token-muted">正在请求麦克风权限…</span></>
        ) : state === 'finalizing' ? (
          <><MapSpinner size={12} /><span className="text-token-muted">正在完成保存…</span></>
        ) : state === 'paused' ? (
          <span className="text-token-muted">已暂停</span>
        ) : (
          <>
            <motion.span
              className="h-2 w-2 rounded-full"
              style={{ background: 'rgba(248,113,113,0.95)' }}
              animate={{ opacity: [1, 0.25, 1] }}
              transition={{ duration: 1.4, repeat: Infinity }}
            />
            <span style={{ color: 'rgba(248,113,113,0.95)' }}>录音中</span>
          </>
        )}
      </div>

      {destinationPicker}

      {/* 计时大字 */}
      <p className="text-[40px] font-semibold tabular-nums leading-none text-token-primary">
        {formatElapsed(elapsed)}
      </p>

      <div
        className="flex min-h-11 w-full items-center justify-between rounded-[12px] px-3 text-left"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}>
        <span>
          <span className="block text-[12px] font-semibold text-token-primary">
            {liveProtection === 'active' ? '录音正在实时保护' : liveProtection === 'local' ? '录音已保存在本机' : '正在建立实时保护'}
          </span>
          <span className="mt-0.5 block text-[11px] text-token-muted">
            {liveProtection === 'active'
              ? '录音分片已持续传到服务端，手机中断时可减少丢失'
              : liveProtection === 'local'
                ? '网络恢复后仍可用本机保险箱整段上传'
                : '录音已同步写入本机保险箱'}
          </span>
        </span>
        {protectedBytes > 0 && (
          <span className="shrink-0 pl-3 text-[11px] tabular-nums text-token-muted">
            {(protectedBytes / 1024).toFixed(0)} KB
          </span>
        )}
      </div>

      {/* 实时电平滚动波形（产物感：屏幕上有持续变化的内容） */}
      <div
        className="w-full rounded-[16px] px-3 py-4"
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}>
        <canvas ref={canvasRef} width={560} height={64} className="w-full" style={{ height: 64 }} />
      </div>

      {/* 静音确认：整段峰值电平过低 → 上传前拦一道 */}
      {confirmSilent && (
        <div
          className="w-full rounded-[10px] p-3 text-[12px]"
          style={{
            background: 'rgba(245,158,11,0.1)',
            border: '1px solid rgba(245,158,11,0.3)',
            color: 'rgba(252,211,77,0.98)',
          }}>
          <p className="mb-2">整段录音几乎没有检测到声音，转录很可能失败。请确认麦克风没有静音。</p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="xs" onClick={() => stopRecorder('complete')}>仍要转成文字</Button>
            <Button variant="ghost" size="xs" onClick={() => stopRecorder('discard')}>放弃本次录音</Button>
            <Button variant="ghost" size="xs" onClick={() => setConfirmSilent(false)}>继续录</Button>
          </div>
        </div>
      )}

      {/* 控制区：暂停/继续 + 完成 */}
      <div className="flex items-center gap-3">
        <button
          onClick={togglePause}
          disabled={state === 'requesting' || state === 'finalizing'}
          aria-label={state === 'paused' ? '继续录音' : '暂停录音'}
          className="flex h-12 w-12 cursor-pointer items-center justify-center rounded-full transition-colors disabled:opacity-40"
          style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>
          {state === 'paused' ? <Play size={18} /> : <Pause size={18} />}
        </button>
        <button
          onClick={requestComplete}
          disabled={state === 'requesting' || state === 'finalizing'}
          aria-label="结束录音并转成文字"
          className="flex h-16 w-16 cursor-pointer items-center justify-center rounded-full transition-transform active:scale-95 disabled:opacity-40"
          style={{
            background: 'rgba(34,197,94,0.95)',
            color: '#fff',
            border: '1px solid rgba(134,239,172,0.45)',
          }}>
          <Square size={20} fill="currentColor" />
        </button>
        <span className="w-12" />
      </div>
      <p className="text-[11px] text-token-muted">
        {state === 'finalizing' ? '正在核对已上传分片，完成后开始生成原文' : '结束后先生成可编辑原文，是否整理由你决定'}
      </p>
    </div>
  );

  const overlay = (
    <motion.div
      className={`surface-backdrop fixed inset-0 z-[100] flex ${isMobile ? 'items-end' : 'justify-end'}`}
      initial={{ backgroundColor: 'rgba(0,0,0,0)' }}
      animate={{ backgroundColor: 'rgba(0,0,0,0.4)' }}
      exit={{ backgroundColor: 'rgba(0,0,0,0)' }}
      transition={{ duration: 0.2 }}
      onClick={(e) => { if (e.target === e.currentTarget) stopRecorder('discard'); }}>
      <motion.div
        className={`surface-popover flex flex-col ${isMobile ? 'w-full' : 'h-full w-[440px] max-w-[92vw] border-l border-token-subtle'}`}
        style={isMobile ? {
          height: '100dvh',
          maxHeight: '100dvh',
          paddingBottom: 'env(safe-area-inset-bottom)',
          background: 'var(--bg-primary)',
        } : undefined}
        initial={isMobile ? { y: '100%' } : { x: '100%' }}
        animate={isMobile ? { y: 0 } : { x: 0 }}
        exit={isMobile ? { y: '100%' } : { x: '100%' }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        onClick={(e) => e.stopPropagation()}>
        <div className={`shrink-0 ${isMobile ? 'px-4 py-3' : 'surface-panel-header px-5 py-4'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="surface-action-accent flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px]">
                <Mic size={15} />
              </div>
              <div>
                <p className="text-[14px] font-semibold text-token-primary">快捷录音</p>
                <p className="text-[11px] text-token-muted">录完先生成可编辑原文</p>
              </div>
            </div>
            <button
              onClick={() => stopRecorder('discard')}
              aria-label="取消录音"
              className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-[10px] text-token-muted hover:bg-white/6">
              <X size={15} />
            </button>
          </div>
        </div>
        <div
          className={`flex flex-1 ${isMobile ? 'px-4' : 'px-5 py-6'}`}
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {body}
        </div>
        {state !== 'unavailable' && (
          <div
            className={`shrink-0 ${isMobile ? 'px-4 pb-4 pt-3' : 'px-5 py-4'}`}
            style={{ borderTop: '1px solid var(--border-faint)' }}>
            <button
              onClick={() => { stopRecorder('discard'); onPickFile(targetStoreId || storeId); }}
              className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-[10px] py-2 text-[12px] font-semibold text-token-muted transition-colors hover:bg-white/6">
              <FileUp size={13} /> 已有录音文件？上传音频文件
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );

  return createPortal(overlay, document.body);
}
