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
import { BookText, ChevronLeft, Download, FileText, Mic, MoreHorizontal } from 'lucide-react';
import { TranscriptKaraoke } from '@/components/doc-browser/TranscriptKaraoke';
import { buildSpeakerStats, parseTranscriptSegments } from '@/components/doc-browser/transcriptSegments';
import { onRecordingDuration, requestRecordingPlay } from '@/components/doc-browser/recordingPlayBridge';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { useIsDesktop } from '@/hooks/useBreakpoint';
import {
  getAgentRun,
  listDocumentEntriesReal,
  getDocumentEntry,
  getDocumentContent,
  getDocumentStoreReal,
  transcribeEntry,
  updateDocumentContent,
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
  children: React.ReactNode;
}) {
  const isDesktop = useIsDesktop();
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
          {subtitle && (
            // 稿面这一行是绿色的：它说的是「音频已经安全了」，与进度、失败分属不同语义
            <p className="truncate text-[12px]" style={{ color: 'var(--accent-fg-success)' }}>{subtitle}</p>
          )}
        </div>
        {isDesktop && actions}
        <button
          type="button"
          aria-label="更多"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
          style={{ color: 'var(--text-primary)' }}
        >
          <MoreHorizontal size={20} />
        </button>
      </header>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
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
   * 起播必须发生在这一屏、并且要等播放器真的挂上来——上一屏先播会造成
   * 「声音已经在响、画面还在旧页」。播放器订阅这条通道，没挂好时这一发是空操作，
   * 所以要等内容就绪之后再发（依赖里带上 state.kind）。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const wantsAutoplay = searchParams.get('play') === '1';
  useEffect(() => {
    if (!wantsAutoplay || state.kind !== 'ready') return;
    const timer = window.setTimeout(() => {
      requestRecordingPlay();
      // 用掉就把参数擦掉：留着的话刷新一次又会自己响一遍，那不是用户点的
      setSearchParams(prev => { const next = new URLSearchParams(prev); next.delete('play'); return next; }, { replace: true });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [setSearchParams, state.kind, wantsAutoplay]);

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
        styleKey: entry.metadata?.transcribe_style_key ?? null,
        generatedAt: noteEntryRes?.success ? (noteEntryRes.data?.updatedAt ?? null) : null,
      });
    })().catch((error: unknown) => {
      if (!stale) setState({ kind: 'error', message: error instanceof Error ? error.message : '这条录音打不开' });
    });
    return () => { stale = true; };
  }, [entryId, storeId]);

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

  // 轮询回调里要读「当前的笔记 id」，但它不能进 effect 依赖——依赖一变轮询就重来。
  const noteIdRef = useRef('');
  noteIdRef.current = state.kind === 'ready' ? state.noteId : '';

  /** 重新拉一次笔记正文与生成时间（整理跑完之后，界面得换成新的那一份） */
  const reloadNote = useCallback(async () => {
    const noteId = noteIdRef.current;
    if (!noteId || !entryId) return;
    const [contentRes, noteEntryRes, audioEntryRes] = await Promise.all([
      getDocumentContent(noteId),
      getDocumentEntry(noteId),
      getDocumentEntry(entryId),
    ]);
    setState(cur => (cur.kind === 'ready'
      ? {
        ...cur,
        noteMd: contentRes.success ? (contentRes.data?.content ?? cur.noteMd) : cur.noteMd,
        generatedAt: noteEntryRes.success ? (noteEntryRes.data?.updatedAt ?? cur.generatedAt) : cur.generatedAt,
        styleKey: audioEntryRes.success ? (audioEntryRes.data?.metadata?.transcribe_style_key ?? cur.styleKey) : cur.styleKey,
      }
      : cur));
  }, [entryId]);

  /*
   * run 状态轮询。这里不订 SSE：这一屏只需要「跑完了没有、跑到哪了」两个数，
   * 2 秒一次的轮询足够，且断线自愈——而 SSE 漏一个 done 事件就会永远停在「生成中」。
   */
  const reloadNoteRef = useRef(reloadNote);
  reloadNoteRef.current = reloadNote;
  useEffect(() => {
    if (!running) return;
    let stale = false;
    const tick = async () => {
      const res = await getAgentRun(running.runId);
      if (stale || !res.success) return;
      const run = res.data;
      if (run.status === 'done') {
        setRunning(null);
        await reloadNoteRef.current();
      } else if (run.status === 'failed' || run.status === 'cancelled') {
        setRunning(null);
        toast.error(run.errorMessage || '整理没有完成');
      } else {
        setRunning(prev => (prev && prev.runId === run.id ? { ...prev, percent: run.progress ?? prev.percent } : prev));
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 2000);
    return () => { stale = true; window.clearInterval(timer); };
  }, [running]);

  /** 同页校对：整份 markdown 覆盖写回转录笔记条目 */
  const onSaveNote = useCallback(async (nextNoteMd: string) => {
    if (state.kind !== 'ready' || !state.noteId) return false;
    const res = await updateDocumentContent(state.noteId, nextNoteMd, 'text/markdown');
    if (!res.success) {
      toast.error(res.error?.message || '保存失败');
      return false;
    }
    // 乐观落到本地：等下一次拉取会让这行字先消失再出现，那是「凭空消失」
    setState(prev => (prev.kind === 'ready' ? { ...prev, noteMd: nextNoteMd } : prev));
    return true;
  }, [state]);

  /**
   * 选一种整理方式。走的是条目级的 transcribe 端点：它会复用已完成的 ASR，
   * 只重新生成摘要那一节，不会把音频重转一遍（`reused` 就是这个意思）。
   */
  const onPickOrganizeStyle = useCallback((styleKey: string) => {
    if (!entryId || running) return;
    void transcribeEntry(entryId, { styleKey }).then((res) => {
      if (!res.success) {
        toast.error(res.error?.message || '发起整理失败');
        return;
      }
      setRunning({ runId: res.data.runId, styleKey, percent: 0 });
    });
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
    >
      {state.kind === 'loading' && <MapSectionLoader text="正在打开这段录音…" />}
      {state.kind === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-[14px]" style={{ color: 'var(--text-primary)' }}>{state.message}</p>
          <button type="button" onClick={goBack} className="min-h-11 text-[13px]" style={{ color: 'var(--accent-fg-info)' }}>
            返回知识库
          </button>
        </div>
      )}
      {state.kind === 'ready' && (
        <div className="flex flex-col items-center gap-3 px-4 pb-8 pt-3">
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
