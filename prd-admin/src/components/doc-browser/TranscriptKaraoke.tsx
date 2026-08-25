import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Info, ListChecks, MessageSquareText, ScrollText, Search, Sparkles, UserRound, X } from 'lucide-react';
import { AudioWavePlayer } from '@/components/doc-browser/AudioWavePlayer';
import {
  parseTranscriptSegments,
  hasUsableTimestamps,
  activeSegmentIndex,
  estimateTranscriptSegments,
  replaceEstimatedTranscriptSentenceText,
  replaceTranscriptSegmentText,
  renameTranscriptSpeaker,
  buildTranscriptWordCloud,
  parseRecordingAnswerParts,
  parseSpeakerSourceNote,
  extractTranscriptSummary,
  parseSummaryModules,
  extractTranscriptTodos,
  buildSpeakerStats,
} from '@/components/doc-browser/transcriptSegments';
import { MarkdownViewer } from '@/components/file-preview/MarkdownViewer';
import { streamDirectChat } from '@/services/real/aiToolbox';
import { getTranscriptLexicon, updateSystemTranscriptLexicon, updateTranscriptLexicon } from '@/services/real/userPreferences';

/** mm:ss；无时间戳的行不显示时钟而不是显示一个假的 0:00。 */
function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

export function buildRecordingQuestionPrompt(noteMd: string, question: string): string {
  return [
    '你是会议录音问答助手。只能依据下方带时间轴的录音原文回答。',
    '先给简明结论，再列依据。每条依据必须使用原文已有时间，格式严格为 [mm:ss-mm:ss]。',
    '如果原文不足以回答，明确说无法从录音确认，不得补造事实。',
    `[录音原文]\n${noteMd}`,
    `[问题]\n${question}`,
  ].join('\n\n');
}

function formatQuestionTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function buildRecordingQuestionTranscript(
  segments: Array<{ start: number; end: number; text: string; speaker?: string }>,
  fallbackMd: string,
): string {
  if (segments.length === 0 || segments.some(segment => segment.start < 0 || segment.end < 0))
    return fallbackMd;
  return segments.map(segment => (
    `**[${formatQuestionTime(segment.start)} - ${formatQuestionTime(segment.end)}]**${segment.speaker ? ` [${segment.speaker}]` : ''} ${segment.text}`
  )).join('\n\n');
}

export function recordingCitationMatchesTimeline(
  start: number,
  segments: Array<{ start: number; end: number }>,
): boolean {
  return Number.isFinite(start) && segments.some(segment => (
    segment.start >= 0 && start >= segment.start && start <= Math.max(segment.start, segment.end)
  ));
}

export interface TranscriptLexiconState {
  terms: string[];
  system: string[];
  mine: string[];
  muted: string[];
  canManageSystem: boolean;
}

/**
 * 添加一个词条之后，本地这张词典表应该长成什么样。
 *
 * 词典的写端点是**整表替换**：提交什么就是什么，服务端不做合并。所以下一次提交的
 * 入参必须从「上一次已经写成功的那一版」算起。如果本地表还停在写前的旧版
 * （比如刷新用的 GET 慢了或失败了），第二次添加就会拿旧表整表覆盖，把刚存进去的词
 * 静默抹掉——系统级抹的是所有人共用的那张表。
 *
 * 提出来单独放的原因：这段是数据丢失的那一半，可以脱离组件直接断言。
 */
export function advanceTranscriptLexicon(
  prev: TranscriptLexiconState,
  term: string,
  scope: 'mine' | 'system',
): TranscriptLexiconState {
  return {
    ...prev,
    terms: [...new Set([...prev.terms, term])],
    system: scope === 'system' ? [...new Set([...prev.system, term])] : prev.system,
    mine: scope === 'system' ? prev.mine : [...new Set([...prev.mine, term])],
  };
}

/**
 * 转录跟读播放器（歌词滚轮）——音频原始内容页的"小巧思"：
 * 播放时当前句居中高亮、上下句渐隐（苹果滚轮 / 音乐歌词心智），说的话和文字对得上；
 * 点任意句跳播到那一秒。录音的和上传的音频走同一个组件（结果页统一）。
 *
 * 数据源：该音频已生成的转录笔记 markdown（**[mm:ss - mm:ss]** 行）。
 * chat-audio 转写路径无时间戳 → 音频时长就绪后按语速估算逐句位置，并明确标注估算。
 * 用户手动滚动歌词区后，暂停自动跟随 3 秒再恢复（不跟用户抢滚动条）。
 */
/**
 * 四个分区的注册表（frontend-architecture.md：类型→标签/图标的映射走注册表，不写 switch）。
 * 顺序即设计稿 P3/D1 的顺序：先看懂这场讲了什么，再看整理结果，再看要做什么，最后才是追问。
 */
const PANEL_TABS = [
  { key: 'understand', label: '理解', icon: Sparkles },
  { key: 'summary', label: '纪要', icon: ScrollText },
  { key: 'todo', label: '待办', icon: ListChecks },
  { key: 'qa', label: '提问', icon: MessageSquareText },
] as const;

export function TranscriptKaraoke({
  src,
  noteMd,
  documentMode = false,
  onSaveNote,
  onAskRecording,
}: {
  src: string;
  noteMd: string;
  /** 同一文档模式：原文随页面自然展开，播放时在当前页面跟随高亮，不制造第二层滚动。 */
  documentMode?: boolean;
  /** 同页校对：保存修改后的整份转录 markdown。 */
  onSaveNote?: (nextNoteMd: string) => Promise<boolean | void>;
  /** 打开以当前录音原文为上下文的知识库问答。 */
  onAskRecording?: () => void;
}) {
  const segments = useMemo(() => parseTranscriptSegments(noteMd), [noteMd]);
  // 摘要一直存在 noteMd 里，只是此前没有任何界面读它；纪要与待办都从这里长出来
  const summaryMd = useMemo(() => extractTranscriptSummary(noteMd), [noteMd]);
  const summaryModules = useMemo(() => parseSummaryModules(summaryMd), [summaryMd]);
  const todos = useMemo(() => extractTranscriptTodos(summaryMd), [summaryMd]);
  const synced = useMemo(() => hasUsableTimestamps(segments), [segments]);

  const [activeIdx, setActiveIdx] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [renamingSpeaker, setRenamingSpeaker] = useState<string | null>(null);
  const [speakerDraft, setSpeakerDraft] = useState('');
  /**
   * 结果页的四个分区（设计稿 P3 / D1 的「理解 / 纪要 / 待办 / 提问」）。
   * 改之前这四类内容要么挤在同一张卡里往下堆，要么（纪要、待办）根本没有出口——
   * 摘要其实一直存在 noteMd 的「## 摘要」段里，只是没有任何界面读它。
   */
  const [panelTab, setPanelTab] = useState<'understand' | 'summary' | 'todo' | 'qa'>('understand');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const [qaError, setQaError] = useState('');
  const cancelQaRef = useRef<(() => void) | null>(null);
  const seekRef = useRef<((sec: number) => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // 用户手动滚动 → 3s 内不自动跟随（不抢滚动条）
  const manualUntilRef = useRef(0);
  const estimatedSegments = useMemo(
    () => synced ? [] : estimateTranscriptSegments(segments, duration),
    [duration, segments, synced],
  );
  const timelineSegments = synced ? segments : estimatedSegments.length > 0 ? estimatedSegments : segments;
  const followEnabled = synced || estimatedSegments.length > 1;
  const estimated = !synced && estimatedSegments.length > 1;
  // 词典三层，合并后喂给分词：
  //   L0 本篇说话人名 —— 零配置。ICU 词典不收人名，会上被反复叫到的人恰恰是高价值信息，
  //      而这批名字笔记里本来就有（[说话人] 标签），不需要任何人去维护。
  //   L1 系统级 —— 管理员维护的全局表，所有人默认引用。
  //   L2 个人补充 —— 自己加的，可以单独屏蔽系统表里对自己是噪音的词。
  // L1/L2 的合并在后端做，前端只消费结果。
  const [lexicon, setLexicon] = useState<{ terms: string[]; system: string[]; mine: string[]; muted: string[]; canManageSystem: boolean } | null>(null);
  const [lexiconDraft, setLexiconDraft] = useState('');
  const [lexiconOpen, setLexiconOpen] = useState(false);
  const [savingLexicon, setSavingLexicon] = useState(false);
  useEffect(() => {
    let alive = true;
    void getTranscriptLexicon().then((res) => {
      if (!alive || !res.success) return;
      setLexicon({ terms: res.data.terms, system: res.data.system, mine: res.data.mine, muted: res.data.muted, canManageSystem: res.data.canManageSystem });
    });
    return () => { alive = false; };
  }, []);
  const dictionary = useMemo(() => {
    const speakerNames = segments
      .map(segment => segment.speaker?.trim())
      .filter((name): name is string => !!name && name.length >= 2);
    return [...new Set([...speakerNames, ...(lexicon?.terms ?? [])])];
  }, [segments, lexicon]);
  const wordCloud = useMemo(
    () => buildTranscriptWordCloud(segments, 18, dictionary),
    [segments, dictionary],
  );

  const addLexiconTerm = async (scope: 'mine' | 'system') => {
    const term = lexiconDraft.trim();
    if (!term || term.length < 2 || savingLexicon) return;
    // 词典还没读回来就不许提交：写端点是**整表替换**，此时 lexicon 为 null，
    // 拿不到已有词条就只能发一张空表出去——一次添加就抹掉此前存的全部个人词与屏蔽词，
    // 系统级更狠（那是所有人共用的一张表）。这不是保守，是这条链路的写语义决定的。
    if (!lexicon) return;
    setSavingLexicon(true);
    try {
      // 提交什么、本地推进成什么，走同一条判据，避免两处各算一遍再漂移
      const next = advanceTranscriptLexicon(lexicon, term, scope);
      const res = scope === 'system'
        ? await updateSystemTranscriptLexicon(next.system)
        : await updateTranscriptLexicon(next.mine, lexicon.muted);
      if (!res.success) return;
      setLexiconDraft('');
      // 写成功后立刻把本地这张表推进到「刚提交的那一版」，不等刷新回来。
      // 配合下面 finally 里才解锁，慢刷新和刷新失败两种情况都不会留下过期的表。
      setLexicon(prev => (prev ? advanceTranscriptLexicon(prev, term, scope) : prev));
      const refreshed = await getTranscriptLexicon();
      if (refreshed.success) {
        setLexicon({
          terms: refreshed.data.terms,
          system: refreshed.data.system,
          mine: refreshed.data.mine,
          muted: refreshed.data.muted,
          canManageSystem: refreshed.data.canManageSystem,
        });
      }
    } finally {
      setSavingLexicon(false);
    }
  };
  const speakers = useMemo(
    () => [...new Set(segments.map(segment => segment.speaker).filter((value): value is string => Boolean(value)))],
    [segments],
  );
  const speakerStats = useMemo(() => buildSpeakerStats(segments), [segments]);
  // 说话人是原生识别来的还是本地声纹估算来的，可信度差一个量级。
  // 不标出来的话两者在界面上完全一样，用户没有任何线索判断该不该信。
  const speakerSource = useMemo(() => parseSpeakerSourceNote(noteMd), [noteMd]);
  const searchMatches = useMemo(() => {
    const normalized = keyword.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return timelineSegments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => segment.text.toLocaleLowerCase().includes(normalized));
  }, [keyword, timelineSegments]);
  const questionTranscript = useMemo(
    () => buildRecordingQuestionTranscript(timelineSegments, noteMd),
    [noteMd, timelineSegments],
  );

  const onTimeUpdate = useCallback((t: number) => {
    if (!followEnabled) return;
    const idx = activeSegmentIndex(timelineSegments, t);
    setActiveIdx(prev => (prev === idx ? prev : idx));
  }, [followEnabled, timelineSegments]);

  // 当前句滚到滚轮中心
  useEffect(() => {
    if (!followEnabled) return;
    if (Date.now() < manualUntilRef.current) return;
    lineRefs.current[activeIdx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx, followEnabled]);

  useEffect(() => () => cancelQaRef.current?.(), []);

  const askRecording = () => {
    const userQuestion = question.trim();
    if (!userQuestion || asking) return;
    cancelQaRef.current?.();
    setAnswer('');
    setQaError('');
    setAsking(true);
    cancelQaRef.current = streamDirectChat({
      message: buildRecordingQuestionPrompt(questionTranscript, userQuestion),
      onText: chunk => setAnswer(current => current + chunk),
      onError: error => { setQaError(error || '问答失败，请稍后重试'); setAsking(false); },
      onDone: () => setAsking(false),
    });
  };

  const markManualScroll = () => { manualUntilRef.current = Date.now() + 3000; };

  const currentSegment = timelineSegments[activeIdx] ?? null;
  const nextSegment = timelineSegments[activeIdx + 1] ?? null;

  if (segments.length === 0) return <AudioWavePlayer src={src} />;

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {documentMode && (
        <div className="flex w-full max-w-[760px] flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] font-semibold text-token-muted">录音</p>
          <p className="text-[11px] text-token-muted" aria-live="polite">
            {playing && followEnabled
              ? `正在跟随第 ${activeIdx + 1}/${timelineSegments.length} 句`
              : synced
                ? '精准时间轴，播放时逐句高亮'
                : estimated
                  ? documentMode && onSaveNote
                    ? '智能估算逐句跟随，点击可校对'
                    : '智能估算跟随，可点句跳播'
                  : '正在读取音频时长，随后开启原文跟随'}
          </p>
        </div>
      )}
      {/*
        吸顶播放区（设计稿 P1）：原文往下滚的时候，播放器和「现在念到哪一句」必须一直在视野里。
        此前播放器随页面滚走，滚到第 60 句时既看不到进度也不知道正在念哪句，
        想跳播只能先滚回顶部——这也是那一屏「只剩一个播放器和一堆留白」的原因之一。
        只在同文档模式吸顶：另一种形态本身就是固定高度的滚轮，不存在滚走的问题。
      */}
      <div
        className={documentMode ? 'sticky top-0 z-10 flex w-full flex-col items-center gap-2 pb-2' : 'contents'}
        style={documentMode ? { background: 'var(--bg-primary)' } : undefined}
      >
        <AudioWavePlayer
          src={src}
          onTimeUpdate={onTimeUpdate}
          onDurationChange={setDuration}
          onPlaybackChange={setPlaying}
          registerSeek={(seek) => { seekRef.current = seek; }}
        />

        {documentMode && followEnabled && currentSegment && (
          <div
            className="w-full max-w-[760px] rounded-[12px] px-3 py-2.5"
            style={{
              background: 'color-mix(in srgb, var(--accent-fg-info) 10%, var(--bg-nested))',
              border: '1px solid color-mix(in srgb, var(--accent-fg-info) 24%, transparent)',
            }}
            aria-live="polite"
          >
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate" style={{ color: 'var(--text-muted)' }}>
                {currentSegment.speaker ? `${currentSegment.speaker} · ` : ''}{formatClock(currentSegment.start)}
              </span>
              {/* 「第几句 / 共几句」是这一屏唯一能回答「我看到哪了」的东西 */}
              <span className="flex-shrink-0 font-mono tabular-nums" style={{ color: 'var(--text-muted)' }}>
                第 {activeIdx + 1} / {timelineSegments.length} 句
              </span>
            </div>
            <p
              className="mt-1 text-[15px] font-semibold leading-snug text-token-primary"
              style={{
                // 锁两行：句子长短不一时高度恒定，跟读过程中下方原文不会跟着上下跳
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden', minHeight: '2.6em',
              }}
            >
              {currentSegment.text}
            </p>
            {nextSegment && (
              <p className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                下一句 · {nextSegment.text}
              </p>
            )}
          </div>
        )}
      </div>

      {documentMode && (
        <section className="w-full max-w-[760px] rounded-[14px] p-4" style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-faint)' }}>
          {/* 四分区：横滚一条，手机端放不下也不换行（mobile-first-density） */}
          <div
            className="flex items-center gap-1 overflow-x-auto pb-0.5"
            style={{ overscrollBehavior: 'contain', scrollbarWidth: 'none' }}
            role="tablist"
            aria-label="录音理解分区"
          >
            {PANEL_TABS.map(({ key, label, icon: Icon }) => {
              const on = panelTab === key;
              const count = key === 'todo' ? todos.length : key === 'summary' ? summaryModules.length : 0;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setPanelTab(key)}
                  className="flex min-h-9 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 text-[12px] transition-colors"
                  style={on
                    ? { background: 'color-mix(in srgb, var(--accent-fg-info) 16%, transparent)', color: 'var(--text-primary)', border: '1px solid color-mix(in srgb, var(--accent-fg-info) 32%, transparent)', fontWeight: 600 }
                    : { background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border-faint)' }}
                >
                  <Icon size={13} /> {label}
                  {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
                </button>
              );
            })}
          </div>

          {panelTab === 'qa' && (
            <div className="mt-3 rounded-[11px] p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}>
              <textarea
                value={question}
                onChange={event => setQuestion(event.target.value)}
                rows={2}
                placeholder="例如：客户对于报价的态度是什么？"
                className="w-full resize-y rounded-[9px] px-3 py-2 text-[13px] leading-relaxed text-token-primary outline-none"
                style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[10px] text-token-muted">答案会引用时间段；点击时间可从对应录音片段播放</p>
                <div className="flex items-center gap-2">
                  {onAskRecording && <button type="button" onClick={onAskRecording} className="min-h-10 rounded-[8px] px-3 text-[11px] text-token-muted">打开多轮问答</button>}
                  <button type="button" disabled={asking || !question.trim()} onClick={askRecording} className="min-h-10 rounded-[8px] px-3 text-[12px] font-semibold disabled:opacity-50" style={{ background: 'rgba(59,130,246,0.16)', color: 'var(--text-primary)' }}>{asking ? '正在分析整场录音' : '发送问题'}</button>
                </div>
              </div>
              {asking && !answer && <p className="mt-3 animate-pulse text-[12px] text-token-muted motion-reduce:animate-none">正在读取原文并核对时间轴</p>}
              {qaError && <p className="mt-3 text-[12px]" style={{ color: 'var(--semantic-danger)' }}>{qaError}</p>}
              {answer && (
                <div className="mt-3 whitespace-pre-wrap rounded-[9px] p-3 text-[12px] leading-relaxed text-token-secondary" style={{ background: 'var(--bg-nested)' }} aria-live="polite">
                  {parseRecordingAnswerParts(answer).map((part, index) => part.kind === 'text' ? (
                    <span key={index}>{part.text}</span>
                  ) : recordingCitationMatchesTimeline(part.start, timelineSegments) ? (
                    <button key={index} type="button" onClick={() => seekRef.current?.(part.start)} className="mx-0.5 inline-flex min-h-8 items-center rounded-full px-2 font-mono text-[11px] font-semibold" style={{ background: 'rgba(59,130,246,0.14)', color: 'var(--accent-fg-blue)' }} title="从引用位置播放">{part.label}</button>
                  ) : <span key={index} className="mx-0.5 font-mono text-[11px] text-token-muted" title="原文时间轴中没有这个位置">{part.label}</span>)}
                </div>
              )}
            </div>
          )}

          {panelTab === 'understand' && (
            <>
            <label className="mt-3 flex min-h-11 items-center gap-2 rounded-[10px] px-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}>
              <Search size={14} className="shrink-0 text-token-muted" />
              <input
                value={keyword}
                onChange={event => setKeyword(event.target.value)}
                placeholder="搜索录音里的关键词"
                className="min-w-0 flex-1 bg-transparent text-[13px] text-token-primary outline-none"
                aria-label="搜索录音里的关键词"
              />
              {keyword && <span className="text-[11px] tabular-nums text-token-muted">{searchMatches.length} 处</span>}
            </label>

            {keyword && searchMatches.length > 0 && (
              <div className="mt-2 flex max-h-44 flex-col gap-1 overflow-y-auto">
                {searchMatches.map(({ segment, index }) => (
                  <button
                    key={`${index}-${segment.start}`}
                    type="button"
                    onClick={() => segment.start >= 0 && seekRef.current?.(segment.start)}
                    className="min-h-11 rounded-[8px] px-3 py-2 text-left text-[12px] leading-relaxed text-token-secondary"
                    style={{ background: 'var(--bg-elevated)' }}>
                    <span className="mr-2 font-mono text-[10px] text-token-muted">{segment.start >= 0 ? `${Math.floor(segment.start / 60)}:${String(Math.floor(segment.start % 60)).padStart(2, '0')}` : '原文'}</span>
                    {segment.speaker && <span className="mr-2 font-semibold text-token-primary">{segment.speaker}</span>}
                    {segment.text}
                  </button>
                ))}
              </div>
            )}
            {keyword && searchMatches.length === 0 && <p className="mt-2 text-[11px] text-token-muted">没有找到这个词，原文仍可继续校对。</p>}

            {speakers.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1 text-[11px] text-token-muted"><UserRound size={12} /> 说话人</span>
                {speakers.map(speaker => renamingSpeaker === speaker ? (
                  <span key={speaker} className="flex items-center gap-1">
                    <input autoFocus value={speakerDraft} onChange={event => setSpeakerDraft(event.target.value)} className="h-9 w-28 rounded-[8px] px-2 text-[12px] outline-none" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }} />
                    <button type="button" className="min-h-9 rounded-[8px] px-2 text-[11px]" onClick={() => {
                      if (!onSaveNote || !speakerDraft.trim()) return;
                      const next = renameTranscriptSpeaker(noteMd, speaker, speakerDraft);
                      setSavingEdit(true);
                      void onSaveNote(next).then(ok => { if (ok !== false) setRenamingSpeaker(null); }).finally(() => setSavingEdit(false));
                    }} disabled={savingEdit}>保存</button>
                  </span>
                ) : (
                  (() => {
                  // 光有名字看不出这场是谁在说；句数与占比是数得出来的事实（设计稿 P3/D1）
                  const stat = speakerStats.find(item => item.speaker === speaker);
                  return (
                    <button key={speaker} type="button" onClick={() => { setRenamingSpeaker(speaker); setSpeakerDraft(speaker); }} className="flex min-h-9 items-center gap-1.5 rounded-full px-3 text-[11px] text-token-secondary" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }} title="修改这个说话人的名称">
                      <span className="font-semibold text-token-primary">{speaker}</span>
                      {stat && (
                        <span className="tabular-nums text-token-muted">
                          {stat.count} 句 · 占 {stat.percent}%
                        </span>
                      )}
                    </button>
                  );
                })()
                ))}
              </div>
            )}

            {speakerSource && (
              <p
                className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed"
                style={{ color: speakerSource.estimated ? 'var(--semantic-warning-text)' : 'var(--text-muted)' }}
              >
                <Info size={12} className="mt-0.5 shrink-0" />
                <span>{speakerSource.text}</span>
              </p>
            )}

            {/*
              词云的权重必须按「出现几次」映射，不能按排名。旧写法是 15 - index*0.2：
              18 个词从 15px 递减到 11.4px，肉眼分不出；而且排名相邻的两个词就算一个说了 30 次、
              一个说了 3 次也一样大——等于把唯一有信息量的那一维抹平了，剩下一排一模一样的药丸。
              现在字号/底色/边框/字重全部由 count 相对最大值决定，并把次数直接写在词上（不再藏 title），
              开头先给一句结论，让人一眼知道「这场到底在反复讲什么」而不是自己读一排词去数。
            */}
            {(wordCloud.length > 0 || onSaveNote) && (
              <div className="mt-3">
                {wordCloud.length > 0 ? (
                  <p className="text-[11px] leading-relaxed text-token-muted">
                    这场反复提到的是 <strong className="font-semibold text-token-secondary">{wordCloud[0].word}</strong>（{wordCloud[0].count} 次）；点任意一个词看它出现在哪几处
                  </p>
                ) : (
                  // 词云为空恰恰是最需要补词典的时刻：多半是人名/黑话被通用分词器切成了单字。
                  // 把补词入口一起藏起来，用户就没有任何办法让词云长出来（形状 8：写了一个到不了的入口）。
                  <p className="text-[11px] leading-relaxed text-token-muted">
                    没有反复出现的词。人名、产品名、团队黑话通用分词器不认识，会被切成单字丢掉——补进词典后就能统计到。
                  </p>
                )}
                {wordCloud.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="整场录音词云">
                  {wordCloud.map(({ word, count }) => {
                    const weight = count / wordCloud[0].count;
                    return (
                      <button
                        key={word}
                        type="button"
                        onClick={() => setKeyword(word)}
                        className="min-h-9 rounded-full px-3"
                        style={{
                          fontSize: `${Math.round((12 + weight * 7) * 2) / 2}px`,
                          fontWeight: weight >= 0.6 ? 600 : 400,
                          // 无紫色（设计稿硬约束）。权重仍然靠**不透明度**表达，
                          // 只是底色换成主题强调色，浅色档也成立。
                          background: `color-mix(in srgb, var(--accent-fg-info) ${Math.round((0.08 + weight * 0.18) * 100)}%, transparent)`,
                          color: weight >= 0.45 ? 'var(--text-primary)' : 'var(--text-secondary)',
                          border: `1px solid color-mix(in srgb, var(--accent-fg-info) ${Math.round((0.16 + weight * 0.3) * 100)}%, transparent)`,
                        }}
                        title={`出现 ${count} 次，点击检索`}
                      >
                        {word}
                        <span className="ml-1 text-[10px] font-normal tabular-nums opacity-60">{count}</span>
                      </button>
                    );
                  })}
                </div>
                )}
                {/*
                  词典入口就放在词云下面：发现「某个词该在却不在」正是在看这一屏的时候。
                  逼用户跑去设置页再回来是绕路（anti-detour.md）。
                  说话人名不用在这里加——它们已经自动进词典了。
                  **它不跟着词云一起隐藏**：词云为空正是最需要补词的场景。
                */}
                {onSaveNote ? (
                  <div className="mt-2">
                    {lexiconOpen ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          value={lexiconDraft}
                          onChange={event => setLexiconDraft(event.target.value)}
                          onKeyDown={event => { if (event.key === 'Enter') void addLexiconTerm('mine'); }}
                          placeholder="例如：人名、产品名、团队黑话"
                          aria-label="补充词条"
                          className="h-9 min-w-0 flex-1 rounded-[8px] px-2 text-[12px] text-token-primary outline-none"
                          style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
                        />
                        <button
                          type="button"
                          disabled={!lexicon || savingLexicon || lexiconDraft.trim().length < 2}
                          onClick={() => void addLexiconTerm('mine')}
                          className="min-h-9 rounded-[8px] px-3 text-[11px] font-semibold disabled:opacity-50"
                          style={{ background: 'var(--selection-bg)', color: 'var(--text-primary)' }}
                        >
                          {savingLexicon ? '保存中' : '加入我的词典'}
                        </button>
                        {/* 有设置写权限的人才看得到这个：没权限却给入口，点了只会拿到 403 */}
                        {lexicon?.canManageSystem ? (
                          <button
                            type="button"
                            disabled={!lexicon || savingLexicon || lexiconDraft.trim().length < 2}
                            onClick={() => void addLexiconTerm('system')}
                            className="min-h-9 rounded-[8px] px-3 text-[11px] disabled:opacity-50"
                            style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
                            title="加进全局词典，所有人默认引用"
                          >
                            加入系统词典
                          </button>
                        ) : null}
                        <button type="button" onClick={() => setLexiconOpen(false)} className="min-h-9 px-2 text-[11px] text-token-muted">收起</button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => setLexiconOpen(true)} className="min-h-9 text-[11px] text-token-muted">
                        {wordCloud.length > 0
                          ? '少了某个词？通用分词器不认识人名和黑话，可以补进词典'
                          : '补一个词进词典试试'}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>
            )}
            </>
          )}

          {panelTab === 'summary' && (
            summaryModules.length > 0 ? (
              <div className="mt-3 flex flex-col gap-3">
                {summaryModules.map((module, index) => (
                  <article
                    key={`${module.title}-${index}`}
                    className="rounded-[11px] p-3"
                    style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}
                  >
                    <h4 className="text-[12px] font-semibold text-token-primary">{module.title}</h4>
                    <div className="mt-1.5 text-[12px] leading-relaxed text-token-secondary">
                      <MarkdownViewer content={module.markdown} />
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              // 没有整理结果就说没有，并给出**能到达**的下一步；不摆一句「暂无数据」了事
              <div className="mt-3 rounded-[11px] px-3 py-4 text-center" style={{ background: 'var(--bg-elevated)' }}>
                <p className="text-[12px] text-token-secondary">这份录音还没有整理结果</p>
                <p className="mt-1 text-[11px] leading-relaxed text-token-muted">
                  原文已经在下方，可以直接读；需要结论与要点时用上方的「一键整理」，整理完这里就会有内容
                </p>
              </div>
            )
          )}

          {panelTab === 'todo' && (
            todos.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-1.5">
                {todos.map((todo, index) => (
                  <li
                    key={`${todo.text}-${index}`}
                    className="flex items-start gap-2 rounded-[10px] px-3 py-2"
                    style={{ background: 'var(--bg-elevated)' }}
                  >
                    <span
                      className="mt-[2px] flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[5px]"
                      style={{
                        background: todo.done ? 'var(--accent-fg-success)' : 'transparent',
                        border: todo.done ? 'none' : '1px solid var(--border-default)',
                      }}
                      aria-hidden
                    >
                      {todo.done && <Check size={10} style={{ color: 'var(--bg-base)' }} />}
                    </span>
                    <span
                      className="min-w-0 break-words text-[12px] leading-relaxed"
                      style={{
                        color: todo.done ? 'var(--text-muted)' : 'var(--text-secondary)',
                        textDecoration: todo.done ? 'line-through' : undefined,
                      }}
                    >
                      {todo.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-3 rounded-[11px] px-3 py-4 text-center" style={{ background: 'var(--bg-elevated)' }}>
                <p className="text-[12px] text-token-secondary">这次整理没有产出待办</p>
                <p className="mt-1 text-[11px] leading-relaxed text-token-muted">
                  待办来自整理结果里的勾选项；换一个带行动项的整理方式重跑，这里就会列出来
                </p>
              </div>
            )
          )}
        </section>
      )}

      {documentMode && (
        <div className="mt-2 w-full max-w-[760px]">
          <p className="text-[12px] font-semibold text-token-muted">转录原文</p>
        </div>
      )}
      {/* 歌词滚轮：普通模式为上下渐隐滚轮；同一文档模式随外层页面自然展开。 */}
      <div
        ref={listRef}
        onWheel={markManualScroll}
        onTouchMove={markManualScroll}
        className={documentMode ? 'w-full max-w-[760px]' : 'w-[480px] max-w-[92%] overflow-y-auto'}
        style={{
          height: !documentMode && followEnabled ? 240 : 'auto',
          maxHeight: documentMode ? undefined : followEnabled ? 240 : 320,
          overscrollBehavior: documentMode ? undefined : 'contain',
          WebkitMaskImage: !documentMode && followEnabled
            ? 'linear-gradient(to bottom, transparent 0, black 18%, black 82%, transparent 100%)'
            : undefined,
          maskImage: !documentMode && followEnabled
            ? 'linear-gradient(to bottom, transparent 0, black 18%, black 82%, transparent 100%)'
            : undefined,
        }}
      >
        {/* 首末句也能滚到中心：上下各留半屏 padding */}
        <div
          className="flex flex-col items-center gap-1"
          style={!documentMode && followEnabled ? { padding: '104px 8px' } : { padding: '4px 0' }}>
          {timelineSegments.map((s, i) => {
            const active = followEnabled && i === activeIdx;
            const dist = Math.abs(i - activeIdx);
            if (documentMode && editingIndex === i && onSaveNote) {
              return (
                <div key={i} className="w-full rounded-[10px] p-2" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}>
                  <textarea
                    autoFocus
                    value={editDraft}
                    onChange={(event) => setEditDraft(event.target.value)}
                    rows={2}
                    className="w-full resize-y rounded-[8px] px-3 py-2 text-[13px] leading-relaxed text-token-primary outline-none"
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <button type="button" disabled={savingEdit} onClick={() => setEditingIndex(null)} className="flex min-h-11 items-center gap-1 rounded-[8px] px-3 text-[11px] text-token-muted">
                      <X size={12} /> 取消
                    </button>
                    <button
                      type="button"
                      disabled={savingEdit || !editDraft.trim()}
                      onClick={() => {
                        const next = estimated
                          ? replaceEstimatedTranscriptSentenceText(noteMd, i, editDraft)
                          : replaceTranscriptSegmentText(noteMd, i, editDraft);
                        setSavingEdit(true);
                        void onSaveNote(next)
                          .then((ok) => { if (ok !== false) setEditingIndex(null); })
                          .finally(() => setSavingEdit(false));
                      }}
                      className="flex min-h-11 items-center gap-1 rounded-[8px] px-3 text-[11px] font-semibold disabled:opacity-50"
                      style={{ background: 'rgba(59,130,246,0.16)', color: 'var(--accent-fg-blue)' }}>
                      <Check size={12} /> 保存
                    </button>
                  </div>
                </div>
              );
            }
            return (
              <button
                key={i}
                ref={(el) => { lineRefs.current[i] = el; }}
                onClick={() => {
                  if (documentMode && onSaveNote) {
                    setEditingIndex(i);
                    setEditDraft(s.text);
                    return;
                  }
                  if (followEnabled && s.start >= 0) seekRef.current?.(s.start);
                }}
                className={`min-h-11 w-full overflow-hidden rounded-[10px] px-3 py-2 leading-relaxed transition-colors duration-200 motion-reduce:transition-none ${documentMode ? 'text-left' : 'text-center'} ${followEnabled ? 'cursor-pointer' : 'cursor-default'}`}
                style={{
                  fontSize: active ? 15 : 13,
                  fontWeight: active ? 600 : 400,
                  color: active
                    ? 'var(--text-primary)'
                    : followEnabled
                      ? `rgba(148,163,184,${Math.max(0.35, 0.8 - dist * 0.15)})`
                      : 'var(--text-secondary)',
                  // 当前句底色 = 强调色（设计稿允许强调色出现的三处之一）；无紫色
                  background: active
                    ? 'color-mix(in srgb, var(--accent-fg-info) 14%, transparent)'
                    : 'transparent',
                  border: active
                    ? '1px solid color-mix(in srgb, var(--accent-fg-info) 30%, transparent)'
                    : '1px solid transparent',
                }}
                title={documentMode && onSaveNote ? '点击修改这句原文' : followEnabled && s.start >= 0 ? '点击跳到这一句' : undefined}
              >
                {s.speaker && <span className="mr-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: 'rgba(59,130,246,0.10)', color: 'var(--text-secondary)' }}>{s.speaker}</span>}
                <span className="min-w-0 break-words">{s.text}</span>
              </button>
            );
          })}
        </div>
      </div>

      {estimated && (
        <p className="text-[11px] text-token-muted">
          当前跟随位置按语速智能估算，不会重复转录；
          {documentMode && onSaveNote ? '可直接播放或点击句子校对' : '可直接播放或点句跳转'}
        </p>
      )}
    </div>
  );
}
