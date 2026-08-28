/**
 * 录音交付页（独立全屏路由）。
 *
 * 为什么要它：设计稿 B1/B2/B3/B4、D1/D2 这批「整屏」画板画的是一张自带顶部栏
 * （返回 / 标题 / 副标题 / 更多）的独立页，主操作直接收在屏底。而当前实现寄生在
 * 知识库的文档阅读器里，外面套着平台的顶栏、侧栏与底部导航——这些外壳会占掉稿面
 * 留给内容的位置，并且把「返回哪里」变成平台的语义而不是这条链路的语义。
 * 判分里结构与版式的失分大半出在这一层，寄生形态修不掉，只能给它一张自己的屏。
 *
 * 复用而不是重写：这一屏的主体（播放器、跟读、词云、纪要、待办、问答）仍然是
 * `TranscriptKaraoke` 那一份，与阅读器内嵌形态共用同一份代码。这里只补三样
 * 阅读器给不了的：全屏外壳、稿面自己的顶部栏、以及作用域皮肤。
 *
 * 数据取法与阅读器一致，不新开一条：音频条目的 `metadata.transcribe_entry_id`
 * 指向转录笔记，笔记正文就是跟读组件吃的 markdown。两处读同一个字段，
 * 阅读器改了取法这里不会静默走旧路。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BookText, Check, ChevronLeft, Download, FileText, Mic, MoreHorizontal, WifiOff } from 'lucide-react';
import { TranscriptKaraoke } from '@/components/doc-browser/TranscriptKaraoke';
import { buildSpeakerStats, parseTranscriptSegments } from '@/components/doc-browser/transcriptSegments';
import { onRecordingDuration, requestRecordingPlay } from '@/components/doc-browser/recordingPlayBridge';
import { useIsDesktop } from '@/hooks/useBreakpoint';
import {
  getAgentRun,
  getLatestAgentRun,
  listDocumentEntriesReal,
  getDocumentEntry,
  getDocumentContent,
  getDocumentStoreReal,
  restyleTranscribeRun,
  transcribeEntry,
  updateDocumentContent,
} from '@/services/real/documentStore';
import {
  clearOfflineEdit,
  hasRemoteChangedSince,
  isFlushable,
  loadOfflineEdit,
  saveOfflineEdit,
  type QueuedOfflineEdit,
} from '@/pages/document-store/recordingOfflineQueue';
import { isTranscriptionInflight } from '@/pages/document-store/recordingVault';
import { useAuthStore } from '@/stores/authStore';
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

type DocumentEntryLike = {
  id: string;
  title?: string;
  contentType?: string;
  metadata?: Record<string, unknown> & { source_entry_id?: string };
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready';
      title: string;
      storeName: string;
      audioUrl: string;
      noteMd: string;
      /** 转录笔记条目 id：校对保存写的是它，不是音频条目 */
      noteId: string;
      /** 这份摘要用的整理方式 + 生成时间——「一键整理」四张卡的状态全靠这两个值 */
      styleKey: string | null;
      generatedAt: string | null;
    };

/**
 * 结果页外壳（纯展示）。
 *
 * 抽出来是为了让**对照台**能用同一份 chrome 出图：在 mock 里照着重写一遍顶部栏，
 * 判分判的就是那一份副本，真页面改了它不会跟着变——判据读到的不是真正生效的值
 * （形状 6）。所以外壳只有这一份，两边都用它。
 */
export function RecordingResultShell({
  title,
  subtitle,
  onBack,
  sidebar,
  actions,
  banner,
  children,
}: {
  title: string;
  /** 稿面那行绿色副标题：「已保存到「X」· 24:18」。给不出就不显示，不编。 */
  subtitle?: string;
  onBack: () => void;
  /** 稿面 D1/D2 的左栏（知识库导航）。只在 ≥1024px 挂出来，手机上这一栏是上一屏。 */
  sidebar?: React.ReactNode;
  /** 顶栏右侧的动作（稿面 D1 的「导出」）。窄屏不挂：那一档稿面把它收进「更多」。 */
  actions?: React.ReactNode;
  /**
   * 顶栏与内容之间的通栏告知（稿面 v2-S7 的离线卡）。
   * 它必须在**滚动容器之外**：放进内容流里，跟读一把当前句滚进视野，
   * 它就被吸顶播放条压掉，只剩屏幕上一条 18px 的色边（S7 判分 48 分的根因）。
   */
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  const isDesktop = useIsDesktop();
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <div
      // 作用域皮肤：这一屏整棵子树读设计稿自己那组 token，不影响全站
      className="recording-design-palette flex h-full min-h-0 w-full"
      style={{ background: 'var(--bg-primary)' }}
    >
      {/* 左栏：宽屏才有。窄屏下「回到知识库」是顶栏那颗返回，不是一条常驻的栏 */}
      {isDesktop && sidebar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/*
        稿面的顶部栏：返回 / 标题 + 副标题 / 更多。它吸顶且始终占一行，
        不随内容滚动——B1 到 B4 每一屏都画着它，是这条链路的身份标识。
      */}
      <header
        className="flex shrink-0 items-center gap-3 px-4 py-3"
        style={{ background: 'var(--bg-primary)', borderBottom: '1px solid var(--border-faint)' }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="返回"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
          style={{ color: 'var(--text-primary)' }}
        >
          {/* 稿面用的是细 chevron「‹」，不是实心箭头 */}
          <ChevronLeft size={22} strokeWidth={1.75} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h1>
          {/*
            稿面 D1/D2 把这行元信息放在标题**同一行**、贴着导出按钮；
            窄屏地方不够才落到标题下面。绿色说的是「音频已经安全了」，
            与进度、失败分属不同语义，前面那枚对勾是稿面画的。
          */}
          {subtitle && !isDesktop && (
            /*
              `truncate` 挂在 flex 容器上是无效的：那三条属性（nowrap/overflow/ellipsis）
              管的是**文本**，flex 子项不会继承。此前这一行既不省略也不收缩，
              直接被视口切在「2 位说话」处（B1/B2/P1 三份判分各记了一次）。
              真正要收的是里面那段文字，所以 truncate 得挂在它自己身上。
            */
            <p className="flex min-w-0 items-center gap-1 text-[12px]" style={{ color: 'var(--accent-fg-success)' }}>
              <Check size={13} className="shrink-0" aria-hidden />
              <span className="min-w-0 truncate">{subtitle}</span>
            </p>
          )}
        </div>
        {subtitle && isDesktop && (
          <p className="flex shrink-0 items-center gap-1.5 text-[13px]" style={{ color: 'var(--accent-fg-success)' }}>
            <Check size={15} aria-hidden /> {subtitle}
          </p>
        )}
        {isDesktop && actions}
        {/*
          「更多」必须真的能点开。窄屏下 `actions`（导出）根本不渲染，这颗又没有
          任何 handler——于是手机上导出无路可达，而这颗按钮在所有视口都是个假控件
          （Codex P2 抓到）。让它收纳同一批 actions：窄屏是它们唯一的出口，
          宽屏是重复入口（「更多」菜单重复陈列主操作是常见做法，不构成歧义）。
          没有任何 action 可放时（加载中/出错）就不摆这颗——按钮存在但点了没反应，
          比没有按钮更糟。
        */}
        {actions && (
          <div className="relative shrink-0">
            <button
              type="button"
              aria-label="更多"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(v => !v)}
              className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full"
              style={{ color: 'var(--text-primary)' }}
            >
              <MoreHorizontal size={20} />
            </button>
            {moreOpen && (
              <>
                {/* 点空白处收起：菜单自己不接管整屏，只借一层透明遮罩接这一下 */}
                <div className="fixed inset-0 z-[60]" onClick={() => setMoreOpen(false)} />
                <div
                  className="absolute right-0 top-full z-[61] mt-1 flex min-w-[160px] flex-col gap-1 rounded-[12px] p-1.5"
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-subtle)',
                    boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
                  }}
                  onClick={() => setMoreOpen(false)}
                >
                  {actions}
                </div>
              </>
            )}
          </div>
        )}
      </header>

      {banner && <div className="shrink-0 px-4 pt-3">{banner}</div>}

      <main
        className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden"
        style={{ overscrollBehavior: 'contain' }}>
        {children}
      </main>
      </div>
    </div>
  );
}

export function RecordingResultPage() {
  const { storeId, entryId } = useParams<{ storeId: string; entryId: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  // 时长只有加载完音频的播放器知道，条目元数据里没有这个字段。
  // 与其为了顶部栏那一行去后端加字段，不如听已经知道它的那一端说
  // （recordingPlayBridge 的既有通道，处理中那一屏也用它）。
  const [durationSec, setDurationSec] = useState(0);
  useEffect(() => onRecordingDuration(setDurationSec), []);

  /*
   * `?play=1` 是「进入结果页并开始播放」那一下的后半段。
   * 起播必须发生在这一屏——上一屏先播会造成「声音已经在响、画面还在旧页」。
   *
   * 这里**不再 setTimeout 等播放器挂载**：那 120ms 把用户手势的活跃期一起等没了，
   * 移动端 Safari 于是拒掉 play()，好好的录音被显示成「无法播放」。窄通道自己带闩
   * （挂载前发的请求会在播放器订阅时补发），所以这一发同步发出即可。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const wantsAutoplay = searchParams.get('play') === '1';
  useEffect(() => {
    if (!wantsAutoplay || state.kind !== 'ready') return;
    requestRecordingPlay();
    // 用掉就把参数擦掉：留着的话刷新一次又会自己响一遍，那不是用户点的
    setSearchParams(prev => { const next = new URLSearchParams(prev); next.delete('play'); return next; }, { replace: true });
  }, [setSearchParams, state.kind, wantsAutoplay]);

  /*
   * 处理页那颗「进入结果页并开始播放」是**一直可点**的（稿面就是这么画的：不必等转录跑完
   * 就能先去听）。于是用户可能在 `transcribe_entry_id` 还没落到音频条目上时就进到这一屏。
   * 只加载一次的话，这一屏会永远停在空原文——转录几秒后完成了它也不知道，
   * 直到用户手动刷新（Codex P1 抓到的正是这条）。
   * 所以：笔记还没有、但确实有一条在途的转录 run 时，继续等它，等到就重新加载。
   */
  const [awaitNoteTick, setAwaitNoteTick] = useState(0);
  const noteMissing = state.kind === 'ready' && !state.noteId;
  useEffect(() => {
    if (!entryId || !noteMissing) return;
    let stale = false;
    let timer = 0;
    /*
     * 只在**真的有一条在途转录**时才等。从没转过、或者已经彻底失败的音频，
     * 笔记永远不会出现——不判这一下的话，这个定时器会陪着标签页一直转下去，
     * 每三秒打一次接口（Codex P2 抓到的正是这条）。
     * 再加一道上限：即使 run 一直挂着，也不无限等下去。
     */
    let attempts = 0;
    const MAX_ATTEMPTS = 100; // 3s × 100 ≈ 5 分钟
    const tick = async () => {
      if (stale) return;
      attempts += 1;
      const runRes = await getLatestAgentRun(entryId, 'transcribe');
      if (stale) return;
      const inflight = runRes.success && isTranscriptionInflight(runRes.data?.status);
      if (!inflight || attempts >= MAX_ATTEMPTS) { window.clearInterval(timer); return; }
      const entryRes = await getDocumentEntry(entryId);
      if (stale || !entryRes.success) return;
      // 只认「笔记真的出现了」这一个信号：run 跑完但还没发布时重载没有意义
      if (entryRes.data?.metadata?.transcribe_entry_id) {
        window.clearInterval(timer);
        setAwaitNoteTick(v => v + 1);
      }
    };
    void tick();
    timer = window.setInterval(() => { void tick(); }, 3000);
    return () => { stale = true; window.clearInterval(timer); };
  }, [entryId, noteMissing]);

  useEffect(() => {
    if (!entryId || !storeId) {
      setState({ kind: 'error', message: '缺少录音标识，无法打开这一屏' });
      return;
    }
    let stale = false;
    setState({ kind: 'loading' });
    (async () => {
      const entryRes = await getDocumentEntry(entryId);
      if (stale) return;
      if (!entryRes.success || !entryRes.data) {
        setState({ kind: 'error', message: entryRes.error?.message || '这条录音打不开，可能已被删除' });
        return;
      }
      const entry = entryRes.data;
      const noteId = entry.metadata?.transcribe_entry_id;
      // 音频本体与转录笔记是两条内容：音频给播放器，笔记给跟读。
      // 笔记还没生成时不是错误——那是「还在处理」，交给下面的空态说清楚。
      // 笔记**条目**也要拉：它的 updatedAt 就是「这份整理是什么时候生成的」，
      // 「一键整理」那张已生成卡上的「12 秒前」读的正是它。
      const [audioRes, noteRes, noteEntryRes, storeRes] = await Promise.all([
        getDocumentContent(entry.id),
        noteId ? getDocumentContent(noteId) : Promise.resolve(null),
        noteId ? getDocumentEntry(noteId) : Promise.resolve(null),
        getDocumentStoreReal(storeId),
      ]);
      if (stale) return;
      const audioUrl = audioRes.success ? (audioRes.data?.fileUrl ?? '') : '';
      if (!audioUrl) {
        setState({ kind: 'error', message: '这条录音的音频文件不可用' });
        return;
      }
      setState({
        kind: 'ready',
        title: entry.title,
        storeName: storeRes?.success ? (storeRes.data?.name ?? '') : '',
        audioUrl,
        noteMd: noteRes?.success ? (noteRes.data?.content ?? '') : '',
        noteId: noteId ?? '',
        // 整理方式盖在音频条目上（与阅读器读同一个字段，不新开一条取法）
        // 同上：笔记条目上的那份才是 restyle 之后的真值
        styleKey: (noteEntryRes?.success ? noteEntryRes.data?.metadata?.transcribe_style_key : null)
          ?? entry.metadata?.transcribe_style_key
          ?? null,
        generatedAt: noteEntryRes?.success ? (noteEntryRes.data?.updatedAt ?? null) : null,
      });
      noteRevisionRef.current = noteEntryRes?.success ? (noteEntryRes.data?.updatedAt ?? null) : null;
    })().catch((error: unknown) => {
      if (!stale) setState({ kind: 'error', message: error instanceof Error ? error.message : '这条录音打不开' });
    });
    return () => { stale = true; };
    // awaitNoteTick：上面那个等待器发现笔记发布了，就靠它把这次加载再跑一遍
  }, [awaitNoteTick, entryId, storeId]);

  const goBack = useCallback(() => {
    // 优先退回来路（多半是知识库里那条录音），没有来路才落到知识库首页——
    // 独立全屏页最容易出的问题就是「进得来出不去」。
    if (window.history.length > 1) navigate(-1);
    else navigate(`/document-store?store=${storeId ?? ''}`);
  }, [navigate, storeId]);

  /*
   * 左栏那份文档清单（设计稿 D1/D2）。只在宽屏挂出来，所以也只在宽屏拉——
   * 手机上多打一次列表请求，换不来任何一个像素。
   *
   * 转录笔记（带 source_entry_id 的那些）不进清单：它们是音频条目的产出，
   * 列进去会让同一段录音在栏里出现两次，用户点第二条会落到一个没有播放器的纯文本页。
   */
  /** 离线告知（稿面 v2-S7）：只告知，不建离线编辑队列 */
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  useEffect(() => {
    const online = () => setOffline(false);
    const down = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', down); };
  }, []);

  const isDesktop = useIsDesktop();
  const [siblings, setSiblings] = useState<{ id: string; title: string; isAudio: boolean }[]>([]);
  useEffect(() => {
    if (!isDesktop || !storeId) return;
    let alive = true;
    void listDocumentEntriesReal(storeId).then((res) => {
      if (!alive || !res.success) return;
      const items = (res.data as { items?: DocumentEntryLike[] } | null)?.items ?? [];
      setSiblings(items
        .filter(item => !item.metadata?.source_entry_id)
        .map(item => ({
          id: item.id,
          title: item.title ?? '未命名',
          isAudio: (item.contentType ?? '').toLowerCase().startsWith('audio/'),
        })));
    });
    return () => { alive = false; };
  }, [isDesktop, storeId]);

  const openSibling = useCallback((item: { id: string; isAudio: boolean }) => {
    if (item.id === entryId) return;
    if (item.isAudio) navigate(`/document-store/${storeId}/recording/${item.id}`);
    else navigate(`/document-store?store=${storeId}&entry=${item.id}`);
  }, [entryId, navigate, storeId]);

  const sidebar = state.kind === 'ready' ? (
    <nav
      className="flex h-full w-[300px] shrink-0 flex-col gap-4 overflow-y-auto px-4 py-4"
      style={{ background: 'var(--bg-base)', borderRight: '1px solid var(--border-faint)' }}
      aria-label="知识库导航"
    >
      <div className="flex items-center gap-2.5 px-1">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-[9px]"
          style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
          aria-hidden
        >
          <BookText size={16} />
        </span>
        <span className="text-[16px] font-semibold" style={{ color: 'var(--text-primary)' }}>MAP 知识库</span>
      </div>
      <button
        type="button"
        onClick={() => navigate(`/document-store?store=${storeId}&record=1`)}
        className="flex min-h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-[12px] text-[14px] font-semibold"
        style={{ background: 'var(--recording-cta-bg)', color: 'var(--recording-cta-fg)' }}
      >
        <Mic size={15} /> 新录音
      </button>
      <div className="flex flex-col gap-1">
        <p className="px-2 pb-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>{state.storeName || '知识库'}</p>
        {siblings.map(item => {
          const current = item.id === entryId;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => openSibling(item)}
              aria-current={current ? 'page' : undefined}
              className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-[10px] px-2 text-left text-[14px]"
              style={{
                background: current ? 'var(--bg-elevated)' : 'transparent',
                color: current ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: current ? 600 : 400,
              }}
            >
              <FileText size={15} className="shrink-0" style={{ color: 'var(--text-muted)' }} aria-hidden />
              <span className="truncate">{item.title}</span>
            </button>
          );
        })}
      </div>
    </nav>
  ) : null;

  /** 说话人数：从原文里数出来的，数不出来（没有说话人标签）就不说这一句 */
  const speakerCount = useMemo(() => {
    if (state.kind !== 'ready') return 0;
    return buildSpeakerStats(parseTranscriptSegments(state.noteMd)).length;
  }, [state]);

  const subtitle = useMemo(() => {
    if (state.kind !== 'ready') return '';
    const parts: string[] = [];
    if (state.storeName) parts.push(`已保存到「${state.storeName}」`);
    const duration = formatDuration(durationSec);
    if (duration) parts.push(duration);
    if (speakerCount > 0) parts.push(`${speakerCount} 位说话人`);
    return parts.join(' · ');
  }, [durationSec, speakerCount, state]);

  /**
   * 导出（稿面 D1 顶栏那颗）：把这份转录原文存成本地 .md。
   * 不做「导出为 PDF/Word」那一摊——稿面只画了一个按钮，多出来的格式没有依据。
   */
  const exportNote = useCallback(() => {
    if (state.kind !== 'ready') return;
    const blob = new Blob([state.noteMd], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.title || '录音转录'}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 立刻回收会让部分浏览器来不及取数据，留一帧再释放
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [state]);

  const headerActions = state.kind === 'ready' ? (
    <button
      type="button"
      onClick={exportNote}
      className="flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-[12px] px-3.5 text-[14px] font-semibold"
      style={{ background: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
    >
      <Download size={15} /> 导出
    </button>
  ) : null;

  /*
   * 下面这几条回调是这一屏的**接线**。它们缺席时组件不会报错，只是把
   * 一键整理 / 逐句校对 / 词典 / 改说话人 / 重新生成整块静默藏起来——
   * 编译过、路由能进、测试也绿，只有真的打开这一屏才看得出少了半个页面
   * （predicate-and-wiring-discipline 形状 2：建了一半的链路只会静默退化）。
   * 阅读器内嵌形态早就接好了这几条，独立全屏页此前一条都没传。
   */

  /** 在途的整理 run：选了哪一种、跑到哪了。没有在途就是 null。 */
  const [running, setRunning] = useState<{ runId: string; styleKey: string; percent: number } | null>(null);
  /*
   * 换录音就把在途整理摘掉。同一条路由只换 params 时组件不重挂，`running` 会跟着
   * 留在下一条录音上——那一条于是显示着别人的进度条，而且因为 `running` 非空，
   * 它自己的整理点了没反应；A 跑完时轮询回调还会拿 B 的 id 去 reload（Codex P2）。
   */
  useEffect(() => { setRunning(null); }, [entryId]);

  // 轮询回调里要读「当前的笔记 id」，但它不能进 effect 依赖——依赖一变轮询就重来。
  const noteIdRef = useRef('');
  noteIdRef.current = state.kind === 'ready' ? state.noteId : '';
  /** 当前这一屏是哪条录音。异步回调回来时拿它认人，别把结果落到已经切走的那条上 */
  const entryIdRef = useRef('');
  entryIdRef.current = entryId ?? '';

  /**
   * 重新拉一次笔记正文与生成时间（整理跑完之后，界面得换成新的那一份）。
   *
   * 返回「**远端正文有没有真的装上**」：丢弃离线草稿那条路要拿它当前提——
   * 装不上就不能清掉草稿，否则屏幕上留着的还是那份草稿，而本机唯一的副本已经删了
   * （Codex 第十五轮 P1）。
   */
  const reloadNote = useCallback(async (): Promise<boolean> => {
    const noteId = noteIdRef.current;
    if (!noteId || !entryId) return false;
    const [contentRes, noteEntryRes, audioEntryRes] = await Promise.all([
      getDocumentContent(noteId),
      getDocumentEntry(noteId),
      getDocumentEntry(entryId),
    ]);
    /*
     * 这一发回来时用户可能已经从侧栏切到另一条录音了（同一条路由只换 params，
     * 组件不重挂）。只判 `cur.kind === 'ready'` 拦不住这种情况——那样 A 的正文会
     * 落到 B 的屏幕上，B 随后一次编辑就把它存成 B 的内容（Codex 第十二轮 P1）。
     * 所以完成时先认一遍「我是不是还在当初那条笔记上」，不是就整段丢弃。
     */
    if (noteIdRef.current !== noteId) return false;
    setState(cur => (cur.kind === 'ready' && cur.noteId === noteId
      ? {
        ...cur,
        noteMd: contentRes.success ? (contentRes.data?.content ?? cur.noteMd) : cur.noteMd,
        generatedAt: noteEntryRes.success ? (noteEntryRes.data?.updatedAt ?? cur.generatedAt) : cur.generatedAt,
        /*
         * 整理方式**先读笔记条目**：restyle 处理器把 `transcribe_style_key` 写在
         * 输出笔记上（`SubtitleGenerationProcessor` 的 restyle 分支），只有录音与笔记
         * 是同一篇时它才顺带落在音频条目上。旧数据里两者是两篇，光读音频条目就会
         * 一直拿到整理之前的那一种，「重新生成」于是按旧风格再跑一次（Codex P2）。
         */
        styleKey: (noteEntryRes.success ? noteEntryRes.data?.metadata?.transcribe_style_key : null)
          ?? (audioEntryRes.success ? audioEntryRes.data?.metadata?.transcribe_style_key : null)
          ?? cur.styleKey,
      }
      : cur));
    // 正文这一路成功才算「换上了」——条目元数据失败只影响生成时间与整理方式的展示
    return contentRes.success && typeof contentRes.data?.content === 'string';
  }, [entryId]);

  /*
   * run 状态轮询。这里不订 SSE：这一屏只需要「跑完了没有、跑到哪了」两个数，
   * 2 秒一次的轮询足够，且断线自愈——而 SSE 漏一个 done 事件就会永远停在「生成中」。
   */
  const reloadNoteRef = useRef(reloadNote);
  reloadNoteRef.current = reloadNote;
  /*
   * 依赖只能是 runId，不能是 running 这个对象：下面每收到一次进度都会 setRunning
   * 出一个新对象，依赖对象的话这个 effect 每次响应都重建一次——重建时又立刻 tick 一发，
   * 两秒的轮询于是退化成「以网络往返为周期」的连发（Codex 第八轮 P2，
   * 与此前整理清单那次无限拉取是同一种形状）。
   */
  const runningRunId = running?.runId ?? '';
  useEffect(() => {
    if (!runningRunId) return;
    let stale = false;
    const tick = async () => {
      const res = await getAgentRun(runningRunId);
      if (stale || !res.success) return;
      const run = res.data;
      if (run.status === 'done') {
        setRunning(null);
        await reloadNoteRef.current();
      } else if (run.status === 'failed' || run.status === 'cancelled') {
        setRunning(null);
        toast.error(run.errorMessage || '整理没有完成');
      } else {
        // 进度没变就返回同一个对象：没变还换一个新对象，等于让所有读它的地方白重渲染一次
        setRunning((prev) => {
          if (!prev || prev.runId !== run.id) return prev;
          const percent = run.progress ?? prev.percent;
          return percent === prev.percent ? prev : { ...prev, percent };
        });
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 2000);
    return () => { stale = true; window.clearInterval(timer); };
  }, [runningRunId]);

  /*
   * 离线期的校对不该被丢掉。稿面 v2-S7 承诺的是「编辑内容排队等待同步，联网后自动上传，
   * 无需重做」——那句话必须先有一个**真的队列**才配写出来（no-rootless-tree）。
   * 队列很薄：同一条笔记以最后一次内容为准（覆盖写语义本来就是最后一次赢），
   * 但计数记的是**用户改了几次**，因为那才是他关心的「我有多少东西还没上去」。
   */
  const [pendingEdits, setPendingEdits] = useState<QueuedOfflineEdit | null>(null);
  /*
   * 笔记条目的 updatedAt，当**版本令牌**用：离线草稿拿它当基线，补传前比一次。
   * 单独存一份、不借用 state.generatedAt——那个值是展示用的「这份整理生成于」，
   * 用户手改一次正文并不代表摘要是那时生成的，两个含义共用一个字段迟早读错
   * （predicate-and-wiring-discipline 形状 6）。
   * 在线保存成功后要跟着刷新，否则「自己刚存过、随后离线再改」会被误判成别人改过
   * （Codex 第九轮 P2）。
   */
  const noteRevisionRef = useRef<string | null>(null);
  /** 队列没落住本机存储（隐私模式 / 站点数据被禁 / 配额满）：承诺要跟着降级 */
  const [queueVolatile, setQueueVolatile] = useState(false);
  /** 服务端那份笔记在离线期间被改过：不许静默覆盖，交给用户定 */
  const [flushConflict, setFlushConflict] = useState(false);
  const pendingRef = useRef<QueuedOfflineEdit | null>(null);
  pendingRef.current = pendingEdits;
  /** 草稿按账号存：共享浏览器上换个人登录就不该恢复上一位的稿子 */
  const ownerId = useAuthStore(state => state.user?.userId ?? '');
  /** 所有对笔记的写共用一条串行链，避免旧内容后到覆盖新内容 */
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueWrite = useCallback(<T,>(run: () => Promise<T>): Promise<T> => {
    const next = writeChainRef.current.then(run, run);
    writeChainRef.current = next.catch(() => undefined);
    return next;
  }, []);

  /** 同页校对：整份 markdown 覆盖写回转录笔记条目 */
  const onSaveNote = useCallback(async (nextNoteMd: string) => {
    if (state.kind !== 'ready' || !state.noteId) return false;
    // 这次保存写的是哪条笔记：await 回来之后拿它认人，不认就会写到切走后的那一条上
    const savingNoteId = state.noteId;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // 离线：收进队列并乐观落到本地。这不是「假装保存成功」——联网后真的会补传，
      // 而且横幅上明写着还有几处没上去，用户随时看得到自己欠了多少。
      // 队列**认笔记**并落本机存储：不认的话从侧栏切到另一条录音就会把这一条的内容
      // 写进那一条；不落盘的话刷新一次承诺就落空（两条都是 Codex P1 抓到的）。
      const noteId = state.noteId;
      const queued: QueuedOfflineEdit = {
        ownerId,
        noteId,
        count: (pendingRef.current?.noteId === noteId ? pendingRef.current.count : 0) + 1,
        content: nextNoteMd,
        savedAt: Date.now(),
        /*
         * 基线沿用**第一次**排队时那份，不是每次改都刷新：中间这几次改都是离线发生的，
         * 服务端那份自始至终没动过。generatedAt 就是笔记条目的 updatedAt。
         */
        baseUpdatedAt: pendingRef.current?.noteId === noteId
          ? pendingRef.current.baseUpdatedAt
          : noteRevisionRef.current,
      };
      // 落不住盘就别说「刷新也不会丢」——横幅文案跟着降级（Codex P1）
      setQueueVolatile(!saveOfflineEdit(queued));
      setPendingEdits(queued);
      // 认笔记：这一下是同步的，但保持与下面那处同一口径，别给「切走之后落回来」留门
      setState(prev => (prev.kind === 'ready' && prev.noteId === noteId ? { ...prev, noteMd: nextNoteMd } : prev));
      return true;
    }
    /*
     * 联网保存与「补传离线队列」必须排队，不能同时在飞：两个 PUT 谁先到服务端不确定，
     * 旧的那份后到就会把新的盖掉，而队列随后被清空——用户刚改的那一版无声消失
     * （Codex P1）。所有写都挂在同一条链上，后一个等前一个落地。
     */
    const res = await enqueueWrite(() => updateDocumentContent(state.noteId, nextNoteMd, 'text/markdown'));
    if (!res.success) {
      toast.error(res.error?.message || '保存失败');
      return false;
    }
    // 服务端这一版就是最新版本：版本令牌跟着走，否则「刚存过、随后离线再改」
    // 会拿着加载时那个旧时刻当基线，重连时把自己的上一次保存误判成别人改的
    if (res.data?.updatedAt) noteRevisionRef.current = res.data.updatedAt;
    // online 存成功 = 服务端已经拿到更新的内容，离线队列里那份旧的作废
    clearOfflineEdit(state.noteId, ownerId);
    setPendingEdits(null);
    setQueueVolatile(false);
    setFlushConflict(false);
    /*
     * 乐观落到本地：等下一次拉取会让这行字先消失再出现，那是「凭空消失」。
     * 但要认笔记——这一发是 await 回来的，期间用户可能已经从侧栏切到另一条录音，
     * 不认的话 A 的正文会落到 B 的屏幕上（Codex 第十二轮 P1）。
     */
    setState(prev => (prev.kind === 'ready' && prev.noteId === savingNoteId ? { ...prev, noteMd: nextNoteMd } : prev));
    return true;
  }, [enqueueWrite, ownerId, state]);

  /*
   * 换到另一条笔记时，把这一条本机存着的队列接回来——上一次离线校对可能是在
   * 刷新之前、甚至上一次打开这个标签页时排下的。接不回来的话，横幅不会提，
   * 那几处校对就永远躺在本机没人补传。
   */
  const noteIdForFlush = state.kind === 'ready' ? state.noteId : '';
  useEffect(() => {
    if (!noteIdForFlush || !ownerId) { setPendingEdits(null); return; }
    setFlushConflict(false);
    const restored = loadOfflineEdit(noteIdForFlush, ownerId);
    setPendingEdits(restored);
    /*
     * 队列接回来的同时，**正文也要接回来**。只接元数据的话，屏幕上还是服务端那份旧的，
     * 用户看不见自己上次改过什么；更糟的是他随手再改一句，排进队列的是这份旧正文，
     * 把本机存着的那版校对整个盖掉（Codex 第十二轮 P1）。
     * 只在这条笔记确实还没同步时装回去——`loadOfflineEdit` 已经核过笔记、账号与过期。
     */
    if (restored?.content) {
      setState(prev => (prev.kind === 'ready' && prev.noteId === noteIdForFlush
        ? { ...prev, noteMd: restored.content }
        : prev));
    }
  }, [noteIdForFlush, ownerId]);

  /** 恢复联网就把队列补传上去；失败就留着，横幅继续显示欠了多少 */
  useEffect(() => {
    if (offline || !noteIdForFlush || flushConflict) return;
    const queued = pendingRef.current;
    // 只补传属于**这一条笔记、这个账号**、且还没放过期的内容
    if (!isFlushable(queued, noteIdForFlush, ownerId)) return;
    let alive = true;
    /*
     * 补传是整篇覆盖写，传之前要先确认服务端那份还是不是排队时那份：离线期间别的设备
     * （或同事）改过的话，这一发 PUT 会把他们的新内容整篇盖掉，而两边都没有任何提示。
     * 改过就不传，把决定权交回用户——横幅上给「仍然用我的版本覆盖」与「丢弃」两颗。
     *
     * 「读版本 + 决定写不写」必须**整段**进写链，不能只把 PUT 放进去：读版本这一下是
     * 异步的，期间用户在线存了新的一版，那一版会先进链先落地，而这份旧草稿随后才排进去，
     * 照样把新内容盖掉——后面的 savedAt 判断只能拦住「盖完之后别再清队列」，
     * 拦不住那次覆盖本身（Codex 第七、八两轮各抓到这条链的一段）。
     */
    const skipped = { success: false } as Awaited<ReturnType<typeof updateDocumentContent>>;
    void enqueueWrite(async () => {
      if (!alive) return skipped;
      // 排到队时这份草稿可能已经被一次在线保存作废了（那次保存会清空队列）
      if (pendingRef.current?.savedAt !== queued!.savedAt) return skipped;
      const remote = await getDocumentEntry(noteIdForFlush);
      if (!alive) return skipped;
      /*
       * 版本查不到就**不写**。此前只有「查到了且变过」才拦，于是这条请求偶发失败时
       * 直接落到无条件覆盖上——那正是这道门要防的事（Codex 第十一轮 P1）。
       * 查不到不等于冲突：不弹冲突横幅，草稿原样留在队列里（横幅照常显示欠了几处），
       * 下一次联网翻转或重进这一屏会再试一次。宁可晚传，不可盖掉别人的新版本。
       */
      if (!remote.success) return skipped;
      if (hasRemoteChangedSince(queued, remote.data?.updatedAt)) {
        setFlushConflict(true);
        return skipped;
      }
      return updateDocumentContent(noteIdForFlush, queued!.content, 'text/markdown');
    }).then((res) => {
      if (!alive) return;
      if (!res.success) return;
      // 补传期间用户又在线存了新的一版：那一版已经把队列清了，这里不能再清一次
      // （清了等于承认这份旧内容是最终态），也不再报「已补传」
      if (pendingRef.current?.savedAt !== queued!.savedAt) return;
      clearOfflineEdit(noteIdForFlush, ownerId);
      setPendingEdits(null);
      setQueueVolatile(false);
      toast.success(`已补传 ${queued!.count} 处离线校对`);
    });
    return () => { alive = false; };
    /*
     * 依赖里必须带上 `pendingEdits`：本机存着的队列是上面那个 effect 恢复出来的，
     * 而它比这里晚一拍。只依赖 noteId/offline 的话，这一轮读到的是 null，
     * 恢复之后又不会再跑——那份校对就一直躺着不上去，直到下一次断网重连才被
     * 当成「新的」传上去，可能盖掉更新的内容（Codex P1 抓到的正是这条）。
     */
  }, [enqueueWrite, flushConflict, noteIdForFlush, offline, ownerId, pendingEdits]);

  /** 冲突时用户明说「用我的版本」：这一下才覆盖，覆盖完照常清队列 */
  const overwriteWithOfflineDraft = useCallback(async () => {
    const queued = pendingRef.current;
    if (!noteIdForFlush || !isFlushable(queued, noteIdForFlush, ownerId)) return;
    // 这次覆盖写的是哪条笔记：PUT 回来之后拿它认人（下面每一处状态更新都要过这道门）
    const overwritingNoteId = noteIdForFlush;
    const res = await enqueueWrite(() => updateDocumentContent(overwritingNoteId, queued!.content, 'text/markdown'));
    if (!res.success) { toast.error(res.error?.message || '覆盖失败'); return; }
    /*
     * 排队的 PUT 回来时用户可能已经从侧栏切到另一条录音了。此前这里的几处状态更新都是
     * 无条件的：A 的正文会装进 B 的屏幕，B 刚恢复出来的待同步/冲突提示也被一并清掉，
     * 随后 B 一次编辑就把 A 的原文存成了 B 的内容（Codex P1）。
     * 本机那份草稿仍然按 overwritingNoteId 清——它属于 A，与现在停在哪一屏无关。
     */
    clearOfflineEdit(overwritingNoteId, ownerId);
    if (noteIdRef.current !== overwritingNoteId) return;
    setPendingEdits(null);
    setQueueVolatile(false);
    setFlushConflict(false);
    setState(prev => (prev.kind === 'ready' && prev.noteId === overwritingNoteId
      ? { ...prev, noteMd: queued!.content }
      : prev));
    toast.success(`已用离线版本覆盖，共 ${queued!.count} 处校对`);
  }, [enqueueWrite, noteIdForFlush, ownerId]);

  /**
   * 选一种整理方式。
   *
   * 必须走 **restyle** 端点：只有带 `RestyleOfRunId` 的 run 会命中处理器里那条
   * 跳过 ASR 的分支（`SubtitleGenerationProcessor.ProcessTranscribeAsync` 开头），
   * 拿上一次的转录文本按新风格重生成摘要。条目级的 transcribe 端点建的是一条
   * 普通转录 run——它会把整段音频**重新转一遍**，既慢又会用新一轮 ASR 结果
   * 覆盖用户可能已经校对过的原文。此前这里调的正是后者（Codex P1 抓到）。
   *
   * 拿不到「已完成且有产物」的上一条 run 时（比如这条录音压根没转录成功过），
   * 才退回条目级 transcribe——那种情况下本来就必须跑 ASR。
   */
  /*
   * 「已经在发起了」必须**同步**记下来：`running` 要等 getLatestAgentRun + restyle 两个
   * 请求回来才置上，这中间双击一下、或者先点一种再点另一种，两次都能过这道门，
   * 于是并发建出两条 run——两条都花模型钱，还会抢着覆盖同一篇输出笔记，而界面只跟踪
   * 最后一个回来的那条（Codex 第九轮 P1）。
   */
  const launchingRef = useRef(false);
  const onPickOrganizeStyle = useCallback((styleKey: string, customPrompt?: string) => {
    if (!entryId || running || launchingRef.current) return;
    launchingRef.current = true;
    // 这次发起属于哪条录音：两个请求都回来之后要拿它认人（见下面 setRunning 前那一判）
    const launchedForEntryId = entryId;
    void (async () => {
      try {
        const prior = await getLatestAgentRun(entryId, 'transcribe', { status: 'done', requireOutput: true });
        const priorRunId = prior.success ? (prior.data?.id ?? '') : '';
        // 自定义那一条带着用户写的要求走同一条链路；空要求不当自定义处理
        const style = { styleKey, customPrompt: customPrompt?.trim() || undefined };
        const res = priorRunId
          ? await restyleTranscribeRun(priorRunId, style)
          : await transcribeEntry(entryId, style);
        if (!res.success) {
          toast.error(res.error?.message || '发起整理失败');
          return;
        }
        /*
         * 两个请求回来时用户可能已经切到另一条录音了：换条目的 effect 已经把 running 清掉，
         * 这里再无条件塞进去，B 就会显示 A 的进度条，而且因为 running 非空，
         * B 自己的整理点了没反应（Codex P2）。不是当初那条就丢弃这次结果。
         */
        if (entryIdRef.current !== launchedForEntryId) return;
        setRunning({ runId: res.data.runId, styleKey, percent: 0 });
      } finally {
        launchingRef.current = false;
      }
    })();
  }, [entryId, running]);

  /** 重新生成：就是按当前这一种再整理一次（当前那一种未知时退回默认的智能摘要） */
  const onRestyle = useCallback(() => {
    if (state.kind !== 'ready') return;
    onPickOrganizeStyle(state.styleKey || 'general');
  }, [onPickOrganizeStyle, state]);

  return (
    <RecordingResultShell
      title={state.kind === 'ready' ? state.title : '录音'}
      subtitle={subtitle}
      onBack={goBack}
      sidebar={sidebar}
      actions={headerActions}
      banner={offline ? (
        /*
          稿面 v2-S7 的离线卡。四件事按稿面的次序说：现在是什么状态、我还能做什么、
          我欠了多少没上去、会不会白改。
          「N 处待同步」不是抄稿面的一个数字——它就是本机队列的真实长度，
          没排队时这一行不出现（no-rootless-tree：宁可少说一句，不编一个队列）。
        */
        <div
          className="mx-auto w-full max-w-[760px] rounded-[14px] px-3.5 py-3"
          style={{ background: 'var(--semantic-warning-soft)' }}
          role="status"
        >
          <p className="flex items-center gap-2 text-[14px] font-bold" style={{ color: 'var(--semantic-warning-text)' }}>
            <WifiOff size={16} aria-hidden /> 当前离线
          </p>
          <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>本机音频与已下载原文照常播放、阅读、编辑</strong>
            。
            {pendingEdits
              ? `编辑内容排队等待同步（${pendingEdits.count} 处待同步），联网后自动上传${queueVolatile ? '' : '，无需重做'}。`
              : `这期间的校对会先存在本机，联网后自动上传${queueVolatile ? '' : '，无需重做'}。`}
            {/*
              队列没落住本机存储时，「无需重做」这句就不成立了——刷新或关掉标签页
              这份校对确实会丢。承诺兑现不了就不许写（no-rootless-tree），改成如实相告。
            */}
            {queueVolatile && (
              <strong style={{ color: 'var(--semantic-warning-text)' }}>
                这台设备不允许本页存草稿，刷新或关掉标签页会丢，请先别关。
              </strong>
            )}
          </p>
        </div>
      ) : flushConflict ? (
        /*
          离线校对没能自动补传：服务端那份在离线期间被改过。这里既不静默覆盖
          （会吞掉别人的新内容），也不静默丢弃（会吞掉用户自己的校对），
          把这两条路摆出来让他选（expectation-management：不许让人以为已经同步了）。
        */
        <div
          className="mx-auto flex w-full max-w-[760px] flex-col gap-2 rounded-[14px] px-3.5 py-3"
          style={{ background: 'var(--semantic-warning-soft)' }}
          role="status"
        >
          <p className="flex items-center gap-2 text-[14px] font-bold" style={{ color: 'var(--semantic-warning-text)' }}>
            <WifiOff size={16} aria-hidden /> 离线校对没有自动上传
          </p>
          <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            这份原文在你离线期间被改过（可能是另一台设备或同事）。
            自动覆盖会把那边的新内容整篇盖掉，所以先停在这里：
            你本机还留着 {pendingEdits?.count ?? 0} 处校对，页面上显示的是服务端最新那一版。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => { void overwriteWithOfflineDraft(); }}
              className="rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold"
              style={{ background: 'var(--button-primary-bg)', color: 'var(--button-primary-fg)' }}
            >
              仍然用我的离线版本覆盖
            </button>
            <button
              type="button"
              onClick={() => {
                if (!noteIdForFlush) return;
                /*
                 * 顺序很讲究：**先把远端正文装上，装上了才允许删草稿**。
                 *
                 * 屏幕上此刻还是那份离线草稿（离线保存时乐观落过一次）。只清队列不换正文，
                 * 「已丢弃」就是假话：下一次改一句，写回服务端的仍然是这份草稿，
                 * 把同事的新版本盖掉（第十二轮 P1）。而上一版把 reloadNote 发出去就不管了，
                 * 拉取失败或用户抢在它之前改一句，同样会盖——那时本机唯一的副本已经删掉，
                 * 两头都丢（第十五轮 P1）。所以拉取失败就什么都不动，草稿留着、冲突态留着。
                 */
                void (async () => {
                  const installed = await reloadNote();
                  if (!installed) {
                    toast.error('云端最新版本没能取回来，离线草稿先留着，请稍后再试');
                    return;
                  }
                  clearOfflineEdit(noteIdForFlush, ownerId);
                  setPendingEdits(null);
                  setFlushConflict(false);
                  toast.success('已丢弃这份离线校对，正文已换回云端最新版本');
                })();
              }}
              className="rounded-[10px] px-3 py-1.5 text-[12.5px] font-semibold"
              style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}
            >
              丢弃离线草稿
            </button>
          </div>
        </div>
      ) : undefined}
    >
      {/*
        稿面 v2-S1：打开这一屏的瞬间给的是**和真实布局同形的骨架**，不是一个居中转圈。
        同形是重点——它保证内容到位时不跳动；转圈做不到这件事，还会让人以为页面卡了。
      */}
      {state.kind === 'loading' && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-8 pt-3" data-testid="recording-result-skeleton" aria-busy="true">
          <div className="flex items-center gap-3 rounded-[14px] px-4 py-3.5" style={{ background: 'var(--bg-card)' }}>
            <span className="h-12 w-12 shrink-0 rounded-[14px]" style={{ background: 'var(--skeleton-fill)' }} />
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="block h-3.5 w-3/4 rounded-full" style={{ background: 'var(--skeleton-fill)' }} />
              <span className="block h-3 w-1/2 rounded-full" style={{ background: 'var(--skeleton-fill)' }} />
            </span>
          </div>
          {/*
            第二块对应的是播放区。此前它是一张**空白白卡**——骨架屏里出现一块什么都没有的
            白，读起来是渲染出洞了，不是「这里马上会有东西」（S1 判分记的正是这处）。
            照真实布局给它波形形状的占位：一排竖条 + 一行控件。
          */}
          <div className="flex flex-col gap-3 rounded-[14px] px-4 py-3.5" style={{ background: 'var(--bg-card)' }}>
            <span className="flex h-10 w-full items-end gap-[3px]" aria-hidden>
              {Array.from({ length: 36 }, (_, index) => (
                <span
                  key={index}
                  className="min-w-0 flex-1 rounded-full"
                  style={{
                    // 高度是确定性的（正弦包络），不是每次刷新乱跳的随机条
                    height: `${34 + Math.round(52 * Math.abs(Math.sin(index * 0.42 + 0.7)))}%`,
                    background: 'var(--skeleton-fill)',
                  }}
                />
              ))}
            </span>
            <span className="flex items-center gap-3">
              <span className="h-11 w-11 shrink-0 rounded-full" style={{ background: 'var(--skeleton-fill)' }} />
              <span className="block h-3 w-24 rounded-full" style={{ background: 'var(--skeleton-fill)' }} />
              <span className="flex-1" />
              <span className="block h-8 w-16 rounded-full" style={{ background: 'var(--skeleton-fill)' }} />
            </span>
          </div>
          {/*
            原文列表的骨架：真实布局这一段是最长的一块，它得**吃掉剩下的全部高度**。
            只给固定几行的话，加载态下半屏是空的，而内容一到位就把页面往下顶——
            那正是这一屏自己写的「骨架保持与真实布局一致，避免跳动」要避免的事。
          */}
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden rounded-[14px] px-4 py-3.5" style={{ background: 'var(--bg-card)' }}>
            {[92, 78, 86, 64, 90, 71, 83, 58, 88, 74, 95, 68, 81, 60, 89, 73].map((width, index) => (
              <span key={index} className="block h-3 rounded-full" style={{ width: `${width}%`, background: 'var(--skeleton-fill)' }} />
            ))}
          </div>
          <p className="px-1 text-[12px] text-token-muted">正在打开录音…骨架保持与真实布局一致，避免跳动</p>
        </div>
      )}
      {state.kind === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[14px]" style={{ color: 'var(--text-primary)' }}>{state.message}</p>
          <button type="button" onClick={goBack} className="min-h-11 text-[13px]" style={{ color: 'var(--accent-fg-info)' }}>
            返回知识库
          </button>
        </div>
      )}
      {state.kind === 'ready' && (
        <div className="flex flex-col items-center gap-3 px-4 pb-8 pt-3 lg:h-full lg:min-h-0 lg:pb-0">
          <TranscriptKaraoke
            src={state.audioUrl}
            noteMd={state.noteMd}
            documentMode
            // 没有笔记条目就没有可写回的地方——此时不给编辑入口，而不是给一个点了报错的
            onSaveNote={state.noteId ? onSaveNote : undefined}
            onRestyle={onRestyle}
            organize={{
              currentStyleKey: state.styleKey,
              generatedAt: state.generatedAt,
              runningStyleKey: running?.styleKey ?? null,
              runningPercent: running?.percent ?? null,
            }}
            onPickOrganizeStyle={onPickOrganizeStyle}
          />
        </div>
      )}
    </RecordingResultShell>
  );
}

export default RecordingResultPage;
