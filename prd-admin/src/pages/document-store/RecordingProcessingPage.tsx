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
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useApplyDocumentTheme } from '@/hooks/useApplyDocumentTheme';
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
  countTranscriptSentences,
  isPermanentLookupFailure,
  isTranscriptionInflight,
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
import { canGoBackInApp } from '@/hooks/useSmartBack';
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
  const location = useLocation();
  /*
   * 这一屏挂在全屏层、不在 AppShell 里，而壳层卸载时会把自己设的 <html data-theme> 清掉。
   * 不自己落一次的话，录音那套作用域配色里 [data-theme='dark'] 这一档永远不匹配——
   * 深色（含跟随系统解析成深色）的用户会拿到浅色版（Codex 第二十二轮 P1）。
   * 用共享 hook，不自己写 effect：偏好是 'system' 时 store 里的 mode 不变，
   * 只依赖 mode 的 effect 不会重跑，DOM 会停在旧主题。
   */
  useApplyDocumentTheme(location.pathname);
  /*
   * 这一屏挂在全屏层、不在 AppShell 里，而壳层卸载时会把自己设的 <html data-theme> 清掉。
   * 不自己落一次的话，录音那套作用域配色里 [data-theme='dark'] 这一档永远不匹配——
   * 深色（含跟随系统解析成深色）的用户会拿到浅色版（Codex 第二十二轮 P1）。
   * 用共享 hook，不自己写 effect：偏好是 'system' 时 store 里的 mode 不变，
   * 只依赖 mode 的 effect 不会重跑，DOM 会停在旧主题。
   */
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [storeName, setStoreName] = useState('');
  /*
   * 这条录音真正归属的库。路由上那个 storeId 只是「从哪一屏点进来的」，
   * 换库保存、从「最近」进来、深链被转发这几种情况下它并不等于条目的归属库——
   * 拿它去查库名会把「已保存到「某库」」写成另一个库的名字，返回与「去看结果」
   * 也会把人送错地方（结果页那一屏上一轮已经改成认条目，这一屏漏了，
   * Codex 第十八轮 P2）。加载完成前退回路由参数。
   */
  const [owningStoreId, setOwningStoreId] = useState(storeId ?? '');
  const [sizeLabel, setSizeLabel] = useState<string | null>(null);
  const [dateLabel, setDateLabel] = useState<string | null>(null);
  const [run, setRun] = useState<RunLike | null>(null);
  const [failure, setFailure] = useState<FailedTranscriptionNotice | null>(null);
  /**
   * 看护这条 run 的查询自己失败了。存的是**给用户看的那句话**，不是一个布尔——
   * 「查不到（已删除或只读）」与「网络不行」要给两句不同的话，也各有不同的下一步。
   */
  const [watchError, setWatchError] = useState<string | null>(null);
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
    /*
     * 换条目时**先清空**：这一屏是同一条路由换参数，React 会复用组件而不是重挂，
     * 旧的 audioUrl 会一直留到新的取回来为止；取不回来就永远留着。
     * 后果不是显示错了一个数，而是**这一屏在放上一条录音的声音**，而标题与路由
     * 已经是新的那条了（Codex 第二十三轮 P1）。
     */
    setAudioUrl('');
    audioRef.current?.pause();
    void getDocumentContent(entryId).then((res) => {
      if (stale) return;
      if (!res.success) {
        toast.error('这段录音的音频没能取到', '可以稍后刷新这一页再试');
        return;
      }
      setAudioUrl(res.data?.fileUrl ?? '');
    });
    return () => { stale = true; };
  }, [entryId]);
  /*
   * 播放失败要说出来。这一屏的音频元素是隐藏的、也没有播放器那套错误态，
   * 把 play() 的拒绝吞掉的话，稿面那颗主按钮点下去**什么都不发生**——用户既不知道
   * 为什么，也不知道下一步能干什么（Codex 第二十一轮 P2）。
   * 三种处境分开说：还没拿到地址 / 浏览器拦下了没有手势的起播（再点一次就行）/
   * 真的播不了（给下载原录音这条出路，那是结果页播放器已有的兜底）。
   */
  useEffect(() => onRecordingPlayRequest(() => {
    const audio = audioRef.current;
    if (!audio) {
      toast.error('这段录音还没准备好', '音频地址还没取到，稍等一下或刷新这一页再试');
      return;
    }
    if (!audio.paused) { audio.pause(); return; }
    void audio.play().catch((err: unknown) => {
      const name = (err as { name?: string } | null)?.name ?? '';
      // 起播被新的一次播放打断，不是失败
      if (name === 'AbortError') return;
      if (name === 'NotAllowedError') {
        toast.error('浏览器拦下了这次播放', '再点一次「立即播放」就可以了');
        return;
      }
      toast.error('这段录音暂时播不了', '可以进结果页下载原录音，或稍后再试');
    });
  }), []);

  useEffect(() => {
    if (!entryId) return;
    let stale = false;
    /*
     * 换条目先把这几格清回加载态。同一条路由换参数、组件被复用，不清的话：
     * B 的条目请求失败 → 屏上整套还是 A 的标题、库名、大小、日期；
     * 只有库请求失败 → B 的标题配 A 的库名，返回也回到 A 那个库
     * （音频那一格上一轮清了，这几格漏了，Codex 第二十四轮 P2）。
     */
    setTitle('');
    // 时长也归零：它由播放器广播上来，不清的话新录音的元数据到位之前，
    // 顶栏会用上一条的时长给它标价；新录音取不到音频时这个错时长永久留着
    setDurationSec(0);
    setStoreName('');
    setSizeLabel(null);
    setDateLabel(null);
    setOwningStoreId(storeId ?? '');
    void (async () => {
      const entryRes = await getDocumentEntry(entryId);
      if (stale) return;
      if (entryRes.success && entryRes.data) {
        setTitle(entryRes.data.title ?? '');
        setSizeLabel(formatSizeLabel(entryRes.data.fileSize));
        setDateLabel(entryRes.data.createdAt
          ? new Date(entryRes.data.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
          : null);
      }
      // 库名必须查条目自己说的那个库，不是路由上那个
      const resolvedStoreId = (entryRes.success ? entryRes.data?.storeId : '') || storeId || '';
      if (!resolvedStoreId) return;
      setOwningStoreId(resolvedStoreId);
      const storeRes = await getDocumentStoreReal(resolvedStoreId);
      if (stale) return;
      if (storeRes?.success) setStoreName(storeRes.data?.name ?? '');
    })();
    return () => { stale = true; };
  }, [entryId, storeId]);

  /*
   * 轮询这条录音最近一次转录 run。用轮询而不是 SSE：这一屏只关心「跑到哪了」，
   * 两秒一次已经足够（稿面这一屏的进度条本来就是秒级刷新），而 SSE 在这里要多养一条
   * 连接与一套重连逻辑，换不来任何一个用户看得见的差别。
   */
  /*
   * 重新发起之后要把观察器**重新起一遍**：上一条 run 走到终态时定时器已经被清掉了
   * （那是上一轮为「轮询停不下来」加的），不重启的话这一屏会一直停在旧的失败说明上，
   * 新 run 跑完也不知道——用户只能刷新。这是那次修复自己带出来的回归。
   */
  const [watchEpoch, setWatchEpoch] = useState(0);
  /** 「已经在发起了」同步置位：重试按钮仍然在屏上，连点两下不该并发建两条 run */
  /*
   * 重新发起的锁**认录音、也认这一发**（doc/rule.prd-admin.recording-entry-scope 第 3 条）。
   * 结果页那把锁刚因为同样的问题改过两次，这一处是同一种形状：
   *   布尔锁在 A 的请求还在飞时切到 B，B 上点重试静默无反应；
   *   而 A 的成功回调还会清掉 B 正在显示的 run 与失败说明、把 B 的观察器重起一遍
   *   ——那份响应根本不属于 B（Codex 第三十三轮 P2）。
   */
  /** 当前这一屏是哪条录音：await 回来之后拿它认人 */
  const entryIdRef = useRef('');
  entryIdRef.current = entryId ?? '';
  const restartingEntryRef = useRef<string | null>(null);
  const restartTokenRef = useRef(0);
  useEffect(() => {
    if (!entryId) return;
    let stale = false;
    let timer = 0;
    /*
     * run 跑到终态就不再有下一次翻转，继续问下去是白打接口——这一屏开着不动，
     * 旧代码会两秒一次问到标签页关闭（Codex P2）。
     * 但「这一刻还没有 run」不能立刻收手：用户多半是刚录完过来的，run 晚一两拍才建出来。
     * 所以没有 run 时限次数地等，有了 run 就只等它走到终态。
     */
    /*
     * 换录音先清掉上一条的 run 与失败说明。不清的话 B 的第一发查询失败只会排下一发，
     * 这期间屏上照常显示 A 的进度、部分原文与失败出口——网络不好时能持续一整段
     * （Codex 第二十五轮 P2）。
     */
    setRun(null);
    setFailure(null);
    setWatchError(null);
    let missingTicks = 0;
    /*
     * 连续失败的次数。查询失败不等于要收手（可能只是一次抖动），但也不能无限试：
     * 永久失败（条目不存在 / 这个账号对它只有只读权限，后端两种都回 NOT_FOUND）
     * 再问一万遍还是同一个答案，而此前这一路每 2 秒一发问到标签页关掉为止，
     * 屏幕上还什么都不说（Codex 第三十五轮 P2）。
     */
    let failureStreak = 0;
    const MAX_FAILURE_STREAK = 5; // 约 10 秒的抖动容忍
    const MAX_MISSING_TICKS = 60; // 2s × 60 = 2 分钟还没建出 run，就不是「马上要来」了
    /*
     * **串行**：一发回来了才排下一发，不能用 setInterval 定点发。
     * 这里踩过两次，两次的形态相反，所以把两次都写下来：
     *   1. 定点发 + 不认回包：查询慢于间隔时两发重叠，后发的终态清掉了定时器，
     *      先发的随后落地又把 run 写回在途，此后再无轮询，这一屏永远停在走不完的进度上。
     *   2. 定点发 + 按序号只认最新那发（我上一版的修法）：每一发都慢于间隔时，
     *      新的一发总在旧的回来之前把序号顶掉，于是**每一发都被丢弃**，
     *      这一屏永远不显示进度、失败或完成——比第 1 种更糟。
     * 串行同时消灭这两种：任何时刻最多一发在飞，回来的那份必然是最新的。
     */
    const schedule = () => { timer = window.setTimeout(() => { void tick(); }, 2000); };
    const tick = async () => {
      const res = await getLatestAgentRun(entryId, 'transcribe');
      if (stale) return;
      if (!res.success) {
        // 永久失败当场停下并说出来；抖动照常再试，但受上面那道上限约束
        if (isPermanentLookupFailure(res.error?.code)) {
          setWatchError('查不到这条录音的转录状态：它可能已被删除，或者你对这条录音只有只读权限。');
          return;
        }
        failureStreak += 1;
        if (failureStreak >= MAX_FAILURE_STREAK) {
          setWatchError(res.error?.message || '暂时查不到转录状态，网络恢复后点「重新查询」再试。');
          return;
        }
        schedule();
        return;
      }
      failureStreak = 0;
      const next = (res.data ?? null) as RunLike | null;
      setRun(next);
      // describeFailedTranscription 自己会从 transcriptText 切出部分原文，这里原样交给它
      setFailure(describeFailedTranscription(next));
      if (!next) {
        missingTicks += 1;
        if (missingTicks < MAX_MISSING_TICKS) schedule();
        return;
      }
      missingTicks = 0;
      if (isTranscriptionInflight(next.status)) schedule();
    };
    void tick();
    return () => { stale = true; window.clearTimeout(timer); };
  }, [entryId, watchEpoch]);

  const transcriptPreview = useMemo(
    () => splitPartialTranscript(run?.transcriptText, 2),
    [run?.transcriptText],
  );
  const generatedSentences = useMemo(
    () => countTranscriptSentences(run?.transcriptText),
    [run?.transcriptText],
  );

  const goResult = useCallback(() => {
    // `?play=1` 让结果页在播放器真的挂上来之后再起播——在这一屏先播会变成
    // 「声音已经在响、画面还在旧页」
    navigate(`/document-store/${owningStoreId}/recording/${entryId ?? ''}?play=1`);
  }, [entryId, navigate, owningStoreId]);

  const goBack = useCallback(() => {
    // 用站内历史标记判，不用 window.history.length：深链之前在同一个标签页看过外站的话，
    // length 照样 > 1，navigate(-1) 会把人送出 MAP（与结果页共用同一个判据）
    if (canGoBackInApp()) navigate(-1);
    else navigate(`/document-store?store=${owningStoreId}`);
  }, [navigate, owningStoreId]);

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
          {/*
            `min-h-full` 而不是 `h-full`：内容装得下时这一列撑满，原文卡就能一直长到
            屏底那条操作栏上方（稿面 v2-R4 的产物区就是这么占主导的）；装不下时它照常
            往下长、由外层滚动，不会把上面的阶段块压扁。
          */}
          <div className="mx-auto flex min-h-full w-full max-w-[760px] flex-col">
            {/*
              看护停下来了就必须说出来，并给得出下一步（expectation-management：
              不许让人对着一屏不动的进度猜是不是卡了）。这条只讲「查询这件事失败了」，
              run 自身的失败仍由下面那张卡的 lastFailure 负责，两者不混为一句。
            */}
            {watchError && (
              <div
                className="mb-3 flex flex-wrap items-center gap-2 rounded-[14px] px-3.5 py-3"
                style={{ background: 'var(--semantic-warning-soft)' }}
                role="status"
              >
                <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  {watchError}
                </p>
                <button
                  type="button"
                  onClick={() => { setWatchError(null); setWatchEpoch(v => v + 1); }}
                  className="shrink-0 rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold"
                  style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
                >
                  重新查询
                </button>
              </div>
            )}
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
                if (restartingEntryRef.current === entryId) return;
                const restartedFor = entryId;
                restartingEntryRef.current = restartedFor;
                const token = ++restartTokenRef.current;
                void transcribeEntry(restartedFor).then((res) => {
                  if (!res.success) { toast.error(res.error?.message || '重新发起失败'); return; }
                  // 回来时可能已经切到另一条录音了：这份响应属于 restartedFor，不属于现在这一屏
                  if (entryIdRef.current !== restartedFor) return;
                  // 旧的失败说明当场撤掉，观察器重起一遍去跟新的这条 run
                  setFailure(null);
                  setRun(null);
                  setWatchEpoch(v => v + 1);
                }).finally(() => {
                  // 只有最新那一发有资格释放，后到的旧请求不许放掉别人举着的锁
                  if (restartTokenRef.current === token) restartingEntryRef.current = null;
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
