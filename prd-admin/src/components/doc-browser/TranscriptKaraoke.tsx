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
export function TranscriptKaraoke({ src, noteMd }: { src: string; noteMd: string }) {
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
    if (!synced) return;
    if (Date.now() < manualUntilRef.current) return;
    lineRefs.current[activeIdx]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx, synced]);

  const markManualScroll = () => { manualUntilRef.current = Date.now() + 3000; };

  if (segments.length === 0) return <AudioWavePlayer src={src} />;

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <AudioWavePlayer
        src={src}
        onTimeUpdate={onTimeUpdate}
        registerSeek={(seek) => { seekRef.current = seek; }}
      />

      {/* 歌词滚轮：上下渐隐蒙版 + 当前句居中放大 */}
      <div
        ref={listRef}
        onWheel={markManualScroll}
        onTouchMove={markManualScroll}
        className="w-[480px] max-w-[92%] overflow-y-auto"
        style={{
          height: synced ? 240 : 'auto',
          maxHeight: synced ? 240 : 320,
          overscrollBehavior: 'contain',
          WebkitMaskImage: synced
            ? 'linear-gradient(to bottom, transparent 0, black 18%, black 82%, transparent 100%)'
            : undefined,
          maskImage: synced
            ? 'linear-gradient(to bottom, transparent 0, black 18%, black 82%, transparent 100%)'
            : undefined,
        }}
      >
        {/* 首末句也能滚到中心：上下各留半屏 padding */}
        <div className="flex flex-col items-center gap-1" style={synced ? { padding: '104px 8px' } : { padding: '4px 8px' }}>
          {segments.map((s, i) => {
            const active = synced && i === activeIdx;
            const dist = Math.abs(i - activeIdx);
            return (
              <button
                key={i}
                ref={(el) => { lineRefs.current[i] = el; }}
                onClick={() => { if (synced && s.start >= 0) seekRef.current?.(s.start); }}
                className={`w-full rounded-[10px] px-3 py-1.5 text-center leading-relaxed transition-all duration-300 ${synced ? 'cursor-pointer' : 'cursor-default'}`}
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
