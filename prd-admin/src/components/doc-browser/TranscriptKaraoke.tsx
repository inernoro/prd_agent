import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioWavePlayer } from '@/components/doc-browser/AudioWavePlayer';
import {
  parseTranscriptSegments,
  hasUsableTimestamps,
  activeSegmentIndex,
} from '@/components/doc-browser/transcriptSegments';

/**
 * 转录跟读播放器（歌词滚轮）——音频原始内容页的"小巧思"：
 * 播放时当前句居中高亮、上下句渐隐（苹果滚轮 / 音乐歌词心智），说的话和文字对得上；
 * 点任意句跳播到那一秒。录音的和上传的音频走同一个组件（结果页统一）。
 *
 * 数据源：该音频已生成的转录笔记 markdown（**[mm:ss - mm:ss]** 行）。
 * chat-audio 转写路径无时间戳 → 退化为静态全文（不假装同步，见 no-rootless-tree）。
 * 用户手动滚动歌词区后，暂停自动跟随 3 秒再恢复（不跟用户抢滚动条）。
 */
export function TranscriptKaraoke({
  src,
  noteMd,
  documentMode = false,
}: {
  src: string;
  noteMd: string;
  /** 同一文档模式：原文随页面自然展开，不制造内层滚动，也不自动挪动页面位置。 */
  documentMode?: boolean;
}) {
  const segments = useMemo(() => parseTranscriptSegments(noteMd), [noteMd]);
  const synced = useMemo(() => hasUsableTimestamps(segments), [segments]);

  const [activeIdx, setActiveIdx] = useState(0);
  const seekRef = useRef<((sec: number) => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // 用户手动滚动 → 3s 内不自动跟随（不抢滚动条）
  const manualUntilRef = useRef(0);

  const onTimeUpdate = useCallback((t: number) => {
    if (!synced) return;
    const idx = activeSegmentIndex(segments, t);
    setActiveIdx(prev => (prev === idx ? prev : idx));
  }, [segments, synced]);

  // 当前句滚到滚轮中心
  useEffect(() => {
    if (!synced || documentMode) return;
    if (Date.now() < manualUntilRef.current) return;
    lineRefs.current[activeIdx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx, synced, documentMode]);

  const markManualScroll = () => { manualUntilRef.current = Date.now() + 3000; };

  if (segments.length === 0) return <AudioWavePlayer src={src} />;

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {documentMode && (
        <div className="w-full max-w-[760px]">
          <p className="mb-2 text-[12px] font-semibold text-token-muted">录音</p>
        </div>
      )}
      <AudioWavePlayer
        src={src}
        onTimeUpdate={onTimeUpdate}
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
          height: !documentMode && synced ? 240 : 'auto',
          maxHeight: documentMode ? undefined : synced ? 240 : 320,
          overscrollBehavior: documentMode ? undefined : 'contain',
          WebkitMaskImage: !documentMode && synced
            ? 'linear-gradient(to bottom, transparent 0, black 18%, black 82%, transparent 100%)'
            : undefined,
          maskImage: !documentMode && synced
            ? 'linear-gradient(to bottom, transparent 0, black 18%, black 82%, transparent 100%)'
            : undefined,
        }}
      >
        {/* 首末句也能滚到中心：上下各留半屏 padding */}
        <div
          className="flex flex-col items-center gap-1"
          style={!documentMode && synced ? { padding: '104px 8px' } : { padding: '4px 0' }}>
          {segments.map((s, i) => {
            const active = synced && i === activeIdx;
            const dist = Math.abs(i - activeIdx);
            return (
              <button
                key={i}
                ref={(el) => { lineRefs.current[i] = el; }}
                onClick={() => { if (synced && s.start >= 0) seekRef.current?.(s.start); }}
                className={`w-full rounded-[10px] px-3 py-1.5 leading-relaxed transition-all duration-300 ${documentMode ? 'text-left' : 'text-center'} ${synced ? 'cursor-pointer' : 'cursor-default'}`}
                style={{
                  fontSize: active ? 15 : 13,
                  fontWeight: active ? 600 : 400,
                  color: active
                    ? 'var(--text-primary)'
                    : synced
                      ? `rgba(148,163,184,${Math.max(0.35, 0.8 - dist * 0.15)})`
                      : 'var(--text-secondary)',
                  transform: active ? 'scale(1.02)' : 'scale(1)',
                  background: active ? 'rgba(168,85,247,0.10)' : 'transparent',
                }}
                title={synced && s.start >= 0 ? '点击跳到这一句' : undefined}
              >
                {s.text}
              </button>
            );
          })}
        </div>
      </div>

      {!synced && (
        <p className="text-[11px] text-token-muted">
          本次转录没有逐句时间戳（转写模型不支持对齐），以上为全文，无法跟随播放高亮
        </p>
      )}
    </div>
  );
}
