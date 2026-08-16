import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Info, MessageSquareText, Pencil, Search, UserRound, X } from 'lucide-react';
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
  splitTranscriptPlaybackCues,
} from '@/components/doc-browser/transcriptSegments';
import { streamDirectChat } from '@/services/real/aiToolbox';
import { getTranscriptLexicon, updateSystemTranscriptLexicon, updateTranscriptLexicon } from '@/services/real/userPreferences';

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
  const [qaOpen, setQaOpen] = useState(false);
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
  const followResumeTimerRef = useRef<number | null>(null);
  const [followPaused, setFollowPaused] = useState(false);
  const estimatedSegments = useMemo(
    () => synced ? [] : estimateTranscriptSegments(segments, duration),
    [duration, segments, synced],
  );
  const previewSegments = useMemo(() => {
    if (synced) return [];
    return splitTranscriptPlaybackCues(segments.map(segment => segment.text).join('\n'))
      .map(text => ({ start: -1, end: -1, text, speaker: undefined }));
  }, [segments, synced]);
  const timelineSegments = synced
    ? segments
    : estimatedSegments.length > 0
      ? estimatedSegments
      : previewSegments.length > 1
        ? previewSegments
        : segments;
  const followEnabled = synced || timelineSegments.length > 1;
  const estimated = !synced && estimatedSegments.length > 1;
  const displayActiveIdx = Math.min(activeIdx, Math.max(0, timelineSegments.length - 1));
  const activeSegment = timelineSegments[displayActiveIdx];
  const nextSegment = timelineSegments[displayActiveIdx + 1];
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

  // 同一个详情组件切换到另一条录音时，不沿用上一条录音的高亮位置。
  // 音频时长尚未就绪时也从第一句开始，时长就绪后的 timeupdate 再推进。
  useEffect(() => {
    setActiveIdx(0);
  }, [noteMd, src]);

  // 当前句滚到可视区中部。结果页播放器吸顶，正文跟随不会把播放器带走；
  // 用户主动滚动后暂停跟随，避免页面与用户抢控制权。
  useEffect(() => {
    if (!followEnabled || followPaused) return;
    if (documentMode && !playing) return;
    if (Date.now() < manualUntilRef.current) return;
    lineRefs.current[activeIdx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx, documentMode, followEnabled, followPaused, playing]);

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

  const markManualScroll = () => {
    if (!documentMode || !playing) return;
    manualUntilRef.current = Date.now() + 3000;
    setFollowPaused(true);
    if (followResumeTimerRef.current !== null) window.clearTimeout(followResumeTimerRef.current);
    followResumeTimerRef.current = window.setTimeout(() => {
      manualUntilRef.current = 0;
      setFollowPaused(false);
      followResumeTimerRef.current = null;
    }, 3000);
  };

  const resumeFollowing = () => {
    manualUntilRef.current = 0;
    setFollowPaused(false);
    if (followResumeTimerRef.current !== null) window.clearTimeout(followResumeTimerRef.current);
    followResumeTimerRef.current = null;
    lineRefs.current[displayActiveIdx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  useEffect(() => () => {
    if (followResumeTimerRef.current !== null) window.clearTimeout(followResumeTimerRef.current);
  }, []);

  if (segments.length === 0) return <AudioWavePlayer src={src} />;

  return (
    <div className={documentMode
      ? 'grid w-full max-w-[1180px] grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start'
      : 'flex w-full flex-col items-center gap-4'}>
      <div
        data-testid={documentMode ? 'recording-sticky-playback' : undefined}
        className={documentMode
          ? 'sticky top-0 z-20 flex w-full max-w-[760px] flex-col gap-3 rounded-[18px] p-3 backdrop-blur-xl lg:col-start-1 lg:row-start-1 lg:max-w-none'
          : 'contents'}
        style={documentMode ? {
          background: 'color-mix(in srgb, var(--bg-primary) 92%, transparent)',
          border: '1px solid var(--border-faint)',
          boxShadow: '0 10px 28px rgba(15,23,42,0.10)',
        } : undefined}
      >
        {documentMode && (
          <div className="flex w-full flex-wrap items-center justify-between gap-2 px-1">
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
        <AudioWavePlayer
          src={src}
          onTimeUpdate={onTimeUpdate}
          onDurationChange={setDuration}
          onPlaybackChange={setPlaying}
          registerSeek={(seek) => { seekRef.current = seek; }}
        />

        {documentMode && followEnabled && activeSegment && (
          <section
            data-testid="recording-karaoke-now-playing"
            className="w-full overflow-hidden rounded-[14px] px-4 py-3"
            style={{
              minHeight: 112,
              background: 'var(--semantic-info-soft)',
              border: '1px solid var(--semantic-info-border)',
            }}
            aria-label="播放台词"
          >
            <style>{`
              @keyframes recording-karaoke-cue-enter {
                from { opacity: 0.35; transform: translateY(6px); }
                to { opacity: 1; transform: translateY(0); }
              }
              @media (prefers-reduced-motion: reduce) {
                .recording-karaoke-cue { animation: none !important; }
              }
            `}</style>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[12px] font-semibold text-token-secondary">当前台词</p>
              <p className="text-[11px] tabular-nums text-token-muted">
                {playing ? '正在跟随' : '播放后逐句跟随'} · {displayActiveIdx + 1}/{timelineSegments.length}
              </p>
            </div>
            <button
              key={`active-${displayActiveIdx}`}
              type="button"
              data-testid="recording-karaoke-active-cue"
              onClick={() => activeSegment.start >= 0 && seekRef.current?.(activeSegment.start)}
              className="recording-karaoke-cue mt-2 min-h-11 w-full text-left text-[18px] font-semibold leading-[1.65] text-token-primary"
              style={{ animation: playing ? 'recording-karaoke-cue-enter 260ms ease-out' : undefined }}
              aria-live="polite"
              aria-atomic="true"
              title="从当前句开头播放"
            >
              {activeSegment.start >= 0 && (
                <span className="mr-2 font-mono text-[11px] font-normal tabular-nums text-token-muted">
                  {formatQuestionTime(activeSegment.start)}
                </span>
              )}
              {activeSegment.speaker && (
                <span className="mr-2 inline-block rounded-full px-2 py-0.5 align-middle text-[10px] font-semibold" style={{ background: 'rgba(59,130,246,0.12)', color: 'var(--text-secondary)' }}>
                  {activeSegment.speaker}
                </span>
              )}
              {activeSegment.text}
            </button>
            {nextSegment && (
              <button
                type="button"
                data-testid="recording-karaoke-next-cue"
                onClick={() => nextSegment.start >= 0 && seekRef.current?.(nextSegment.start)}
                className="mt-1 min-h-10 w-full border-t pt-2 text-left text-[13px] leading-relaxed text-token-muted"
                style={{ borderColor: 'var(--border-faint)' }}
                title="跳到下一句"
              >
                <span className="mr-2 text-[10px] font-semibold">下一句</span>
                {nextSegment.text}
              </button>
            )}
          </section>
        )}
      </div>

      {documentMode && (
        <section
          className="order-1 w-full max-w-[760px] rounded-[16px] p-3 lg:col-start-1 lg:row-start-2 lg:max-w-none"
          style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-faint)' }}
          aria-label="搜索转录原文"
        >
          <label className="flex min-h-11 items-center gap-2 rounded-[10px] px-3" style={{ background: 'var(--bg-input)', border: '1px solid var(--border-faint)' }}>
            <Search size={15} className="shrink-0 text-token-muted" />
            <input
              value={keyword}
              onChange={event => setKeyword(event.target.value)}
              placeholder="搜索录音里的关键词"
              className="min-w-0 flex-1 bg-transparent text-[16px] text-token-primary outline-none placeholder:text-token-muted"
              aria-label="搜索录音里的关键词"
            />
            {keyword && <span className="text-[11px] tabular-nums text-token-muted">{searchMatches.length} 处</span>}
          </label>

          {keyword && searchMatches.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {searchMatches.slice(0, 6).map(({ segment, index }) => (
                <button
                  key={`${index}-${segment.start}`}
                  type="button"
                  onClick={() => segment.start >= 0 && seekRef.current?.(segment.start)}
                  className="min-h-11 rounded-[9px] px-3 py-2 text-left text-[13px] leading-relaxed text-token-secondary"
                  style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }}>
                  <span className="mr-2 font-mono text-[10px] text-token-muted">{segment.start >= 0 ? formatQuestionTime(segment.start) : '原文'}</span>
                  {segment.speaker && <span className="mr-2 font-semibold text-token-primary">{segment.speaker}</span>}
                  {segment.text}
                </button>
              ))}
              {searchMatches.length > 6 && (
                <p className="px-3 py-1 text-[11px] text-token-muted">
                  还有 {searchMatches.length - 6} 处命中，继续输入可以缩小范围
                </p>
              )}
            </div>
          )}
          {keyword && searchMatches.length === 0 && <p className="mt-2 text-[11px] text-token-muted">没有找到这个词，原文仍可继续校对。</p>}
        </section>
      )}

      {documentMode && (
        <section className="order-4 w-full max-w-[760px] rounded-[16px] p-4 lg:sticky lg:top-3 lg:col-start-2 lg:row-start-1 lg:row-span-5 lg:max-w-none" style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-faint)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[13px] font-semibold text-token-primary">录音理解</p>
              <p className="mt-1 text-[11px] text-token-muted">分析主题、管理说话人，并根据原文回答问题</p>
            </div>
            <button type="button" onClick={() => setQaOpen(value => !value)} className="flex min-h-11 items-center gap-1.5 rounded-[9px] px-3 text-[12px] font-semibold" style={{ background: 'var(--semantic-info-soft)', color: 'var(--text-primary)', border: '1px solid var(--semantic-info-border)' }}>
                <MessageSquareText size={14} /> 问这场录音
            </button>
          </div>

          {qaOpen && (
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
              {qaError && <p className="mt-3 text-[12px]" style={{ color: 'var(--semantic-danger-text)' }}>{qaError}</p>}
              {answer && (
                <div className="mt-3 whitespace-pre-wrap rounded-[9px] p-3 text-[12px] leading-relaxed text-token-secondary" style={{ background: 'var(--bg-nested)' }} aria-live="polite">
                  {parseRecordingAnswerParts(answer).map((part, index) => part.kind === 'text' ? (
                    <span key={index}>{part.text}</span>
                  ) : recordingCitationMatchesTimeline(part.start, timelineSegments) ? (
                    <button key={index} type="button" onClick={() => seekRef.current?.(part.start)} className="mx-0.5 inline-flex min-h-8 items-center rounded-full px-2 font-mono text-[11px] font-semibold" style={{ background: 'var(--semantic-info-soft)', color: 'var(--semantic-info-text)' }} title="从引用位置播放">{part.label}</button>
                  ) : <span key={index} className="mx-0.5 font-mono text-[11px] text-token-muted" title="原文时间轴中没有这个位置">{part.label}</span>)}
                </div>
              )}
            </div>
          )}

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
                <button key={speaker} type="button" onClick={() => { setRenamingSpeaker(speaker); setSpeakerDraft(speaker); }} className="min-h-9 rounded-full px-3 text-[11px] text-token-secondary" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-faint)' }} title="修改这个说话人的名称">{speaker}</button>
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
                        background: `rgba(59,130,246,${(0.06 + weight * 0.16).toFixed(3)})`,
                        color: weight >= 0.45 ? 'var(--text-primary)' : 'var(--text-secondary)',
                        border: `1px solid rgba(59,130,246,${(0.12 + weight * 0.26).toFixed(3)})`,
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
                        style={{ background: 'var(--semantic-info-soft)', color: 'var(--text-primary)' }}
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
        </section>
      )}

      {documentMode && (
        <div className="order-2 mt-1 flex w-full max-w-[760px] items-end justify-between gap-3 px-1 lg:col-start-1 lg:row-start-3 lg:max-w-none">
          <div>
            <p className="text-[14px] font-semibold text-token-primary">转录原文</p>
            <p className="mt-1 text-[11px] text-token-muted">播放时当前句同步高亮；点台词跳播，点编辑按钮校对</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {followPaused && playing && (
              <button
                type="button"
                onClick={resumeFollowing}
                className="min-h-11 rounded-[9px] px-3 text-[11px] font-semibold"
                style={{ background: 'var(--semantic-info-soft)', color: 'var(--text-primary)', border: '1px solid var(--semantic-info-border)' }}
              >
                继续跟随
              </button>
            )}
            <span className="text-[11px] tabular-nums text-token-muted">{timelineSegments.length} 句</span>
          </div>
        </div>
      )}
      {/* 歌词滚轮：普通模式为上下渐隐滚轮；同一文档模式随外层页面自然展开。 */}
      <div
        ref={listRef}
        onWheel={markManualScroll}
        onTouchMove={markManualScroll}
        className={documentMode ? 'order-3 w-full max-w-[760px] lg:col-start-1 lg:row-start-4 lg:max-w-none' : 'order-3 w-[480px] max-w-[92%] overflow-y-auto'}
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
          className="flex flex-col items-center gap-1.5"
          style={!documentMode && followEnabled ? { padding: '104px 8px' } : { padding: '4px 0' }}>
          {timelineSegments.map((s, i) => {
            const active = followEnabled && i === displayActiveIdx;
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
                      style={{ background: 'var(--semantic-info-soft)', color: 'var(--semantic-info-text)' }}>
                      <Check size={12} /> 保存
                    </button>
                  </div>
                </div>
              );
            }
            const lineContent = (
              <>
                {documentMode && s.start >= 0 && (
                  <span className="mr-2 inline-block font-mono text-[11px] font-normal tabular-nums text-token-muted">
                    {formatQuestionTime(s.start)}
                  </span>
                )}
                {s.speaker && <span className="mr-2 inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: 'rgba(59,130,246,0.10)', color: 'var(--text-secondary)' }}>{s.speaker}</span>}
                <span className="min-w-0 break-words">{s.text}</span>
              </>
            );
            const lineStyle = {
              fontSize: documentMode ? 16 : active ? 15 : 13,
              fontWeight: active ? 600 : 400,
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: active ? 'var(--semantic-info-soft)' : 'transparent',
              border: active ? '1px solid var(--semantic-info-border)' : '1px solid transparent',
            };
            if (documentMode) {
              return (
                <div key={i} className="group flex w-full items-start gap-1">
                  <button
                    ref={(el) => { lineRefs.current[i] = el; }}
                    type="button"
                    onClick={() => followEnabled && s.start >= 0 && seekRef.current?.(s.start)}
                    className={`min-h-11 min-w-0 flex-1 overflow-hidden rounded-[11px] px-3 py-2.5 text-left leading-relaxed transition-colors duration-200 motion-reduce:transition-none ${followEnabled && s.start >= 0 ? 'cursor-pointer' : 'cursor-default'}`}
                    style={lineStyle}
                    title={followEnabled && s.start >= 0 ? '从这一句开始播放' : undefined}
                  >
                    {lineContent}
                  </button>
                  {onSaveNote && (
                    <button
                      type="button"
                      aria-label={`编辑第 ${i + 1} 句原文`}
                      onClick={() => {
                        setEditingIndex(i);
                        setEditDraft(s.text);
                      }}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[9px] text-token-muted opacity-70 transition-opacity hover:opacity-100 focus:opacity-100"
                      title="编辑这句原文"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                </div>
              );
            }
            return (
              <button
                key={i}
                ref={(el) => { lineRefs.current[i] = el; }}
                onClick={() => followEnabled && s.start >= 0 && seekRef.current?.(s.start)}
                className={`min-h-11 w-full overflow-hidden rounded-[11px] px-3 py-2.5 text-center leading-relaxed transition-colors duration-200 motion-reduce:transition-none ${followEnabled ? 'cursor-pointer' : 'cursor-default'}`}
                style={lineStyle}
                title={followEnabled && s.start >= 0 ? '点击跳到这一句' : undefined}
              >
                {lineContent}
              </button>
            );
          })}
        </div>
      </div>

      {estimated && (
        <p className="order-5 text-[11px] text-token-muted lg:col-start-1 lg:row-start-5">
          当前跟随位置按语速智能估算，不会重复转录；
          {documentMode && onSaveNote ? '可直接播放、点句跳转或单独编辑原文' : '可直接播放或点句跳转'}
        </p>
      )}
    </div>
  );
}
