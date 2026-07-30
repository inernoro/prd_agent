import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { AudioWavePlayer } from '@/components/doc-browser/AudioWavePlayer';
import {
  parseTranscriptSegments,
  hasUsableTimestamps,
  activeSegmentIndex,
  estimateTranscriptSegments,
  replaceEstimatedTranscriptSentenceText,
  replaceTranscriptSegmentText,
} from '@/components/doc-browser/transcriptSegments';

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
}: {
  src: string;
  noteMd: string;
  /** 同一文档模式：原文随页面自然展开，播放时在当前页面跟随高亮，不制造第二层滚动。 */
  documentMode?: boolean;
  /** 同页校对：保存修改后的整份转录 markdown。 */
  onSaveNote?: (nextNoteMd: string) => Promise<boolean | void>;
}) {
  const segments = useMemo(() => parseTranscriptSegments(noteMd), [noteMd]);
  const synced = useMemo(() => hasUsableTimestamps(segments), [segments]);

  const [activeIdx, setActiveIdx] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
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
                <span className="block min-w-0 break-words">{s.text}</span>
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
