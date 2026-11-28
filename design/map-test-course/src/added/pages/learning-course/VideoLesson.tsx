import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { Desk } from './Desk';
import { formatClock } from './registry';
import type { VideoMedia } from './types';

/* 视频：主舞台放播放器与「此刻在讲什么」的大字幕；伴读栏是按章节分组的逐字稿，点一行跳到那一秒。
 * 位置每 10 秒和暂停时保存；看到 90% 记为看完（由服务端判定）。 */
export function VideoLesson({ video, head, keyPoints, ticket, onProgress }: {
  video: VideoMedia; head: ReactNode; keyPoints: string[]; ticket: ReactNode;
  onProgress: (positionSec: number, completed: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(0);
  const [resumed, setResumed] = useState<number | null>(null);
  const saved = useRef(0);
  const doneSent = useRef(false);

  const idxAt = (arr: { atSec: number }[]) => arr.reduce((acc, x, i) => (x.atSec <= now + 0.05 ? i : acc), 0);
  const line = useMemo(() => idxAt(video.transcript), [now, video.transcript]); // eslint-disable-line react-hooks/exhaustive-deps
  const chapter = useMemo(() => idxAt(video.chapters), [now, video.chapters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    if (row && list.current) list.current.scrollTo({ top: Math.max(0, row.offsetTop - list.current.clientHeight / 3), behavior: 'smooth' });
  }, [line]);

  const seek = (sec: number) => { const el = ref.current; if (!el) return; el.currentTime = sec; setNow(sec); void el.play().catch(() => undefined); };
  const save = (completed = false) => { const el = ref.current; if (!el) return; saved.current = el.currentTime; onProgress(el.currentTime, completed); };

  const stage = (
    <div className="h-full min-h-0 flex flex-col gap-4 p-6">
      <div className="lc-screen-wrap flex-1 min-h-0 flex items-center justify-center">
        <div className="lc-screen" style={{ aspectRatio: '16 / 9', height: '100%', maxWidth: '100%' }}>
          <video ref={ref} src={video.url} poster={video.posterUrl} controls playsInline preload="metadata" data-lc="video"
            onLoadedMetadata={() => { const at = video.resumeAtSec ?? 0; if (at > 1 && at < video.durationSec - 2 && ref.current) { ref.current.currentTime = at; setNow(at); setResumed(at); } }}
            onTimeUpdate={e => {
              const t = e.currentTarget.currentTime; setNow(t);
              if (Math.abs(t - saved.current) >= 10) save();
              if (!doneSent.current && t >= video.durationSec * 0.9) { doneSent.current = true; save(true); }
            }}
            onPause={() => save()} />
        </div>
      </div>
      <div className="shrink-0 flex items-start gap-4 flex-wrap">
        <div className="min-w-0 flex-1" style={{ minWidth: 260 }}>
          <div className="t-meta t-mute">第 {chapter + 1} 章 · {video.chapters[chapter]?.title}</div>
          <p className="lc-caption mt-1" key={line} aria-live="polite">{video.transcript[line]?.text}</p>
        </div>
        {resumed != null && (
          <div className="lc-resume" data-lc="resume-note">
            <span>已从上次看到的 {formatClock(resumed)} 继续</span>
            <button type="button" className="lc-tool" onClick={() => { setResumed(null); seek(0); }}><RotateCcw size={13} />从头看</button>
          </div>
        )}
      </div>
    </div>
  );

  const companion = (
    <div ref={list} data-lc="transcript">
      {video.transcript.map((cue, i) => {
        const ch = video.chapters.findIndex(c => c.atSec === cue.atSec);
        return (
          <div key={cue.atSec}>
            {ch >= 0 && <div className="lc-chapter-head" data-active={ch === chapter}>{ch + 1}. {video.chapters[ch].title}</div>}
            <button type="button" className="lc-cue" data-line={i} aria-current={i === line} onClick={() => seek(cue.atSec)}>
              <span className="lc-cue-time lc-num">{formatClock(cue.atSec)}</span><span>{cue.text}</span>
            </button>
          </div>
        );
      })}
    </div>
  );

  return <Desk ready="video" head={head} stage={stage} companionTitle={`逐字稿 · ${video.chapters.length} 章`} companionHint="点一行跳到那里" companion={companion} keyPoints={keyPoints} ticket={ticket} />;
}
