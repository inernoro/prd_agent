import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Info, MessageSquareText, Search, UserRound, X } from 'lucide-react';
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
} from '@/components/doc-browser/transcriptSegments';
import { streamDirectChat } from '@/services/real/aiToolbox';

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
  const estimatedSegments = useMemo(
    () => synced ? [] : estimateTranscriptSegments(segments, duration),
    [duration, segments, synced],
  );
  const timelineSegments = synced ? segments : estimatedSegments.length > 0 ? estimatedSegments : segments;
  const followEnabled = synced || estimatedSegments.length > 1;
  const estimated = !synced && estimatedSegments.length > 1;
  const wordCloud = useMemo(() => buildTranscriptWordCloud(segments), [segments]);
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
      <AudioWavePlayer
        src={src}
        onTimeUpdate={onTimeUpdate}
        onDurationChange={setDuration}
        onPlaybackChange={setPlaying}
        registerSeek={(seek) => { seekRef.current = seek; }}
      />

      {documentMode && (
        <section className="w-full max-w-[760px] rounded-[14px] p-4" style={{ background: 'var(--bg-nested)', border: '1px solid var(--border-faint)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[13px] font-semibold text-token-primary">录音理解</p>
              <p className="mt-1 text-[11px] text-token-muted">检索整场原文、管理说话人，并从命中位置继续播放</p>
            </div>
            <button type="button" onClick={() => setQaOpen(value => !value)} className="flex min-h-11 items-center gap-1.5 rounded-[9px] px-3 text-[12px] font-semibold" style={{ background: 'var(--selection-bg)', color: 'var(--text-primary)', border: '1px solid var(--selection-border)' }}>
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
              {qaError && <p className="mt-3 text-[12px]" style={{ color: 'var(--semantic-danger)' }}>{qaError}</p>}
              {answer && (
                <div className="mt-3 whitespace-pre-wrap rounded-[9px] p-3 text-[12px] leading-relaxed text-token-secondary" style={{ background: 'var(--bg-nested)' }} aria-live="polite">
                  {parseRecordingAnswerParts(answer).map((part, index) => part.kind === 'text' ? (
                    <span key={index}>{part.text}</span>
                  ) : recordingCitationMatchesTimeline(part.start, timelineSegments) ? (
                    <button key={index} type="button" onClick={() => seekRef.current?.(part.start)} className="mx-0.5 inline-flex min-h-8 items-center rounded-full px-2 font-mono text-[11px] font-semibold" style={{ background: 'rgba(59,130,246,0.14)', color: 'rgba(147,197,253,0.98)' }} title="从引用位置播放">{part.label}</button>
                  ) : <span key={index} className="mx-0.5 font-mono text-[11px] text-token-muted" title="原文时间轴中没有这个位置">{part.label}</span>)}
                </div>
              )}
            </div>
          )}

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

          {wordCloud.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="整场录音词云">
              {wordCloud.map(({ word, count }, index) => (
                <button key={word} type="button" onClick={() => setKeyword(word)} className="min-h-9 rounded-full px-3" style={{ fontSize: `${Math.max(11, 15 - index * 0.2)}px`, background: 'rgba(168,85,247,0.08)', color: 'var(--text-secondary)', border: '1px solid rgba(168,85,247,0.14)' }} title={`出现 ${count} 次，点击检索`}>{word}</button>
              ))}
            </div>
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
                      style={{ background: 'rgba(59,130,246,0.16)', color: 'rgba(147,197,253,0.98)' }}>
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
                  background: active ? 'rgba(168,85,247,0.10)' : 'transparent',
                  border: active ? '1px solid rgba(168,85,247,0.18)' : '1px solid transparent',
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
