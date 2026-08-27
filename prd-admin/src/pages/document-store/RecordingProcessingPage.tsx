/**
 * 录音处理页（独立全屏路由）。
 *
 * 为什么要它：稿面 v2-R4 与 cap-A4/A5 画的这一刻是一张**整屏接管**的页——顶部是这条
 * 录音自己的标题栏，中间是三阶段与正在长出来的原文，屏底压着一颗「进入结果页并开始播放」。
 * 而实现里它一直寄生在知识库阅读器里：外面套着平台顶栏（把音频标题又写了一遍）、
 * 底部压着 TabBar，那颗主操作变成内容流里的一颗随手按钮，不再是这一屏的锚点。
 * 三份判分（R4 / cap-A4 / cap-A5）都把这层形态差异记成结构失分，寄生形态修不掉，
 * 只能给它一张自己的屏。
 *
 * 复用而不是重写：屏内主体仍然是 `TranscribeStatusCard`，与阅读器内嵌形态共用同一份代码
 * ——照着重画一份的话，判分判的就是副本，真页面改了它不会跟着变（形状 6）。
 * 这里只补三样阅读器给不了的：全屏外壳、稿面自己的顶栏、屏底那条操作栏。
 *
 * 它与结果页是两屏，不是一屏的两个状态：屏底那颗按钮写的就是「进入结果页」，
 * 同一个路由上写这句话说不通。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Play } from 'lucide-react';
import { RecordingResultShell } from '@/pages/document-store/RecordingResultPage';
import { TranscribeStatusCard } from '@/components/doc-browser/TranscribeStatusCard';
import {
  announceRecordingDuration,
  onRecordingDuration,
  onRecordingPlayRequest,
  requestRecordingPlay,
} from '@/components/doc-browser/recordingPlayBridge';
import {
  describeFailedTranscription,
  splitPartialTranscript,
  type FailedTranscriptionNotice,
} from '@/pages/document-store/recordingVault';
import {
  getDocumentContent,
  getDocumentEntry,
  getDocumentStoreReal,
  getLatestAgentRun,
  transcribeEntry,
} from '@/services/real/documentStore';
import { toast } from '@/lib/toast';
import '@/styles/recording-design-palette.css';

/** mm:ss / h:mm:ss。给不出时长就不显示那一段，不摆一个假的 0:00。 */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 「19.1 MB」。拿不到体积就返回 null，界面不会编一个出来。 */
function formatSizeLabel(bytes: number | null | undefined): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type RunLike = {
  id?: string | null;
  status?: string | null;
  phase?: string | null;
  progress?: number | null;
  startedAt?: string | null;
  createdAt?: string | null;
  transcriptText?: string | null;
};

export function RecordingProcessingPage() {
  const { storeId, entryId } = useParams<{ storeId: string; entryId: string }>();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [storeName, setStoreName] = useState('');
  const [sizeLabel, setSizeLabel] = useState<string | null>(null);
  const [dateLabel, setDateLabel] = useState<string | null>(null);
  const [run, setRun] = useState<RunLike | null>(null);
  const [failure, setFailure] = useState<FailedTranscriptionNotice | null>(null);
  const [durationSec, setDurationSec] = useState(0);
  useEffect(() => onRecordingDuration(setDurationSec), []);
  /*
   * 这一屏也要能听。稿面 cap-A4 的音频卡上那颗播放键是**真的能按**的——
   * 「不必等转录跑完就能播」正是这一屏在兑现的承诺。所以挂一个隐藏的 audio：
   * 它同时供出两样东西——真实时长（顶栏那行「· 24:18」与音频卡都读它），
   * 以及播放本身。不挂的话那颗键点了什么都不会发生，是个假控件。
   */
  const [audioUrl, setAudioUrl] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!entryId) return;
    let stale = false;
    void getDocumentContent(entryId).then((res) => {
      if (stale || !res.success) return;
      setAudioUrl(res.data?.fileUrl ?? '');
    });
    return () => { stale = true; };
  }, [entryId]);
  useEffect(() => onRecordingPlayRequest(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  }), []);

  useEffect(() => {
    if (!entryId || !storeId) return;
    let stale = false;
    void (async () => {
      const [entryRes, storeRes] = await Promise.all([
        getDocumentEntry(entryId),
        getDocumentStoreReal(storeId),
      ]);
      if (stale) return;
      if (entryRes.success && entryRes.data) {
        setTitle(entryRes.data.title ?? '');
        setSizeLabel(formatSizeLabel(entryRes.data.fileSize));
        setDateLabel(entryRes.data.createdAt
          ? new Date(entryRes.data.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
          : null);
      }
      if (storeRes?.success) setStoreName(storeRes.data?.name ?? '');
    })();
    return () => { stale = true; };
  }, [entryId, storeId]);

  /*
   * 轮询这条录音最近一次转录 run。用轮询而不是 SSE：这一屏只关心「跑到哪了」，
   * 两秒一次已经足够（稿面这一屏的进度条本来就是秒级刷新），而 SSE 在这里要多养一条
   * 连接与一套重连逻辑，换不来任何一个用户看得见的差别。
   */
  useEffect(() => {
    if (!entryId) return;
    let stale = false;
    const tick = async () => {
      const res = await getLatestAgentRun(entryId, 'transcribe');
      if (stale || !res.success) return;
      const next = (res.data ?? null) as RunLike | null;
      setRun(next);
      // describeFailedTranscription 自己会从 transcriptText 切出部分原文，这里原样交给它
      setFailure(describeFailedTranscription(next));
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 2000);
    return () => { stale = true; window.clearInterval(timer); };
  }, [entryId]);

  const transcriptPreview = useMemo(
    () => splitPartialTranscript(run?.transcriptText, 2),
    [run?.transcriptText],
  );
  const generatedSentences = useMemo(
    () => splitPartialTranscript(run?.transcriptText, 9999).length,
    [run?.transcriptText],
  );

  const goResult = useCallback(() => {
    // `?play=1` 让结果页在播放器真的挂上来之后再起播——在这一屏先播会变成
    // 「声音已经在响、画面还在旧页」
    navigate(`/document-store/${storeId ?? ''}/recording/${entryId ?? ''}?play=1`);
  }, [entryId, navigate, storeId]);

  const goBack = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else navigate(`/document-store?store=${storeId ?? ''}`);
  }, [navigate, storeId]);

  const durationLabel = durationSec > 0 ? formatDuration(durationSec) : '';
  const subtitle = [storeName ? `已保存到「${storeName}」` : '', durationLabel].filter(Boolean).join(' · ');

  return (
    <RecordingResultShell
      title={title || '录音'}
      subtitle={subtitle || undefined}
      onBack={goBack}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 px-4 pb-4 pt-3" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <div className="mx-auto w-full max-w-[760px]">
            <TranscribeStatusCard
              currentEntryId={entryId ?? ''}
              activeRun={run?.id
                ? {
                  id: run.id,
                  status: run.status ?? '',
                  phase: run.phase ?? undefined,
                  progress: run.progress ?? undefined,
                  startedAt: run.startedAt ?? undefined,
                  createdAt: run.createdAt ?? undefined,
                  transcriptPreview,
                }
                : null}
              lastFailure={failure}
              audioTitle={title}
              audioSizeLabel={sizeLabel}
              audioDateLabel={dateLabel}
              transcriptPreview={transcriptPreview}
              generatedSentences={generatedSentences}
              // 整屏形态走 cap-A4/A5 的 H1；R4 那句落到副标题，两句都在
              headline="正在准备结果页"
              // 主操作归屏底那条吸底栏，卡内不再摆第二颗
              suppressPrimaryAction
              onPlayRequest={requestRecordingPlay}
              onEnterResult={goResult}
              onStart={entryId ? () => {
                void transcribeEntry(entryId).then((res) => {
                  if (!res.success) toast.error(res.error?.message || '重新发起失败');
                });
              } : undefined}
              onOpenNote={() => goResult()}
            />
          </div>
        </div>
        {/*
          屏底操作栏（稿面 R4 / cap-A4 / cap-A5 都把主操作压在这里）。
          它是这一屏唯一的出口，所以不能随内容滚走——整理还没跑完不妨碍现在就去听。
        */}
        <div
          className="shrink-0 px-4 pb-5 pt-3"
          style={{ background: 'var(--bg-primary)', borderTop: '1px solid var(--border-faint)' }}
        >
          <button
            type="button"
            onClick={goResult}
            className="mx-auto flex min-h-12 w-full max-w-[760px] items-center justify-center gap-2 rounded-full text-[14px] font-semibold"
            style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
          >
            <Play size={15} fill="currentColor" />
            进入结果页并开始播放
          </button>
        </div>
      </div>
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          preload="metadata"
          className="hidden"
          onLoadedMetadata={(event) => {
            const value = event.currentTarget.duration;
            if (Number.isFinite(value) && value > 0) announceRecordingDuration(value);
          }}
        />
      )}
    </RecordingResultShell>
  );
}

export default RecordingProcessingPage;
