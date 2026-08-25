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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { TranscriptKaraoke } from '@/components/doc-browser/TranscriptKaraoke';
import { onRecordingDuration, requestRecordingPlay } from '@/components/doc-browser/recordingPlayBridge';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getDocumentEntry, getDocumentContent, getDocumentStoreReal } from '@/services/real/documentStore';
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

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; title: string; storeName: string; audioUrl: string; noteMd: string };

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
      const [audioRes, noteRes, storeRes] = await Promise.all([
        getDocumentContent(entry.id),
        noteId ? getDocumentContent(noteId) : Promise.resolve(null),
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

  const subtitle = useMemo(() => {
    if (state.kind !== 'ready') return '';
    const parts: string[] = [];
    if (state.storeName) parts.push(`已保存到「${state.storeName}」`);
    const duration = formatDuration(durationSec);
    if (duration) parts.push(duration);
    return parts.join(' · ');
  }, [durationSec, state]);

  return (
    <div
      // 作用域皮肤：这一屏整棵子树读设计稿自己那组 token，不影响全站
      className="recording-design-palette flex h-full min-h-0 w-full flex-col"
      style={{ background: 'var(--bg-primary)' }}
    >
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
          onClick={goBack}
          aria-label="返回"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full"
          style={{ color: 'var(--text-primary)' }}
        >
          <ArrowLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[17px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {state.kind === 'ready' ? state.title : '录音'}
          </h1>
          {subtitle && (
            // 稿面这一行是绿色的：它说的是「音频已经安全了」，与进度、失败分属不同语义
            <p className="truncate text-[12px]" style={{ color: 'var(--accent-fg-success)' }}>{subtitle}</p>
          )}
        </div>
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
            <TranscriptKaraoke src={state.audioUrl} noteMd={state.noteMd} documentMode />
          </div>
        )}
      </main>
    </div>
  );
}

export default RecordingResultPage;
