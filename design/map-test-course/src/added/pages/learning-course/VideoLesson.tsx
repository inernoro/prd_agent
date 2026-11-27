import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { formatClock } from './registry';
import type { VideoMedia } from './types';

/* 视频：原生播放器 + 章节 + 逐字稿。逐字稿随播放高亮，点任一行跳到那一秒。
 * 位置每 10 秒和暂停时保存；看到 90% 记为看完（由服务端判定本课是否学完）。 */
export function VideoLesson({ video, onProgress }: {
  video: VideoMedia;
  onProgress: (positionSec: number, completed: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [resumed, setResumed] = useState<number | null>(null);
  const lastSaved = useRef(0);
  const completedSent = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  const activeLine = useMemo(() => {
    let idx = 0;
    video.transcript.forEach((l, i) => { if (l.atSec <= now + 0.05) idx = i; });
    return idx;
  }, [now, video.transcript]);
  const activeChapter = useMemo(() => {
    let idx = 0;
    video.chapters.forEach((c, i) => { if (c.atSec <= now + 0.05) idx = i; });
    return idx;
  }, [now, video.chapters]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-line="${activeLine}"]`);
    const box = listRef.current;
    if (row && box) box.scrollTo({ top: Math.max(0, row.offsetTop - box.clientHeight / 3), behavior: 'smooth' });
  }, [activeLine]);

  const seek = (sec: number) => {
    const el = ref.current;
    if (!el) return;
    el.currentTime = sec;
    setNow(sec);
    void el.play().catch(() => undefined);
  };

  const save = (completed = false) => {
    const el = ref.current;
    if (!el) return;
    lastSaved.current = el.currentTime;
    onProgress(el.currentTime, completed);
  };

  return (
    <div className="lc-video-layout h-full min-h-0" data-lc-ready="video">
      <div className="flex flex-col gap-3 min-w-0">
        <div className="lc-video-frame">
          <video
            ref={ref}
            src={video.url}
            poster={video.posterUrl}
            controls
            playsInline
            preload="metadata"
            data-lc="video"
            onLoadedMetadata={() => {
              const at = video.resumeAtSec ?? 0;
              if (at > 1 && at < video.durationSec - 2 && ref.current) { ref.current.currentTime = at; setNow(at); setResumed(at); }
            }}
            onTimeUpdate={e => {
              const t = e.currentTarget.currentTime;
              setNow(t);
              if (Math.abs(t - lastSaved.current) >= 10) save();
              if (!completedSent.current && t >= video.durationSec * 0.9) { completedSent.current = true; save(true); }
            }}
            onPause={() => save()}
          />
        </div>

        {resumed != null && (
          <div className="flex items-center gap-3 text-[12.5px] lc-secondary" data-lc="resume-note">
            <span>已从上次看到的 {formatClock(resumed)} 继续</span>
            <button type="button" className="inline-flex items-center gap-1.5 min-h-[44px] px-2 rounded-[9px] font-semibold" style={{ color: 'var(--text-primary)' }} onClick={() => { setResumed(null); seek(0); }}>
              <RotateCcw size={13} />从头看
            </button>
          </div>
        )}

      </div>

      <aside className="lc-surface flex flex-col min-h-0" aria-label="逐字稿">
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="text-[13px] font-semibold">章节与逐字稿 · {video.chapters.length} 节</span>
          <span className="text-[11.5px] lc-muted">点一行跳到那里</span>
        </div>
        <div ref={listRef} className="lc-scroll flex-1 px-1.5 pb-2 relative" data-lc="transcript">
          {video.transcript.map((line, i) => {
            const chapterIdx = video.chapters.findIndex(c => c.atSec === line.atSec);
            return (
              <div key={line.atSec}>
                {chapterIdx >= 0 && (
                  <div className="text-[12px] font-semibold px-2.5 pt-3 pb-1" style={{ color: chapterIdx === activeChapter ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {chapterIdx + 1}. {video.chapters[chapterIdx].title}
                  </div>
                )}
                <button type="button" className="lc-line" data-line={i} aria-current={i === activeLine} onClick={() => seek(line.atSec)}>
                  <span className="lc-line-time lc-mono text-[11.5px] lc-muted shrink-0 pt-px">{formatClock(line.atSec)}</span>
                  <span>{line.text}</span>
                </button>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
