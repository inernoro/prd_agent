// Renders the published instructional scenes. MP4 is kept as a separate downloadable deliverable.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pause, Play, RotateCcw } from 'lucide-react';
import './design-acceptance-animation.css';
import { BEAT_SECONDS, beatNames, scenes } from './MethodScenes';

export type VideoChapter = { key: string; name: string; beat: number };

export function videoChapters(methods: { key: string; name: string }[]): VideoChapter[] {
  return methods.filter(method => scenes[method.key]).flatMap(method => [0, 1, 2].map(beat => ({ key: method.key, name: method.name, beat })));
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function DesignAcceptanceAnimation({ title, chapters, compact }: { title: string; chapters: VideoChapter[]; compact?: boolean }) {
  const total = chapters.length * BEAT_SECONDS;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(() => !!compact && !reduced());
  const position = useRef(0);
  const seek = (value: number) => { position.current = value; setT(value); };
  useEffect(() => {
    if (!playing || !total) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = position.current + (now - last) / 1000;
      last = now;
      if (!compact && next >= total) {
        position.current = total - .001;
        setT(position.current);
        setPlaying(false);
        return;
      }
      position.current = next % total;
      setT(position.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, total, compact]);
  const index = Math.min(chapters.length - 1, Math.floor(t / BEAT_SECONDS));
  const current = chapters[index];
  const methods = useMemo(() => [...new Map(chapters.map((chapter, i) => [chapter.key, { name: chapter.name, first: i }])).values()], [chapters]);
  if (!current) return null;
  const scene = scenes[current.key];
  const p = (t - index * BEAT_SECONDS) / BEAT_SECONDS;
  const go = (i: number) => seek(i * BEAT_SECONDS);
  const toggle = () => {
    if (!playing && t >= total - .01) seek(0);
    setPlaying(!playing);
  };
  return <figure className="dw-video dw-mx" data-compact={compact || undefined} aria-label={`动画：${title}`}>
    <div className="dw-mx-stage">
      <svg viewBox="0 0 640 300" role="img" aria-label={`${current.name} · ${beatNames[current.beat]}：${scene.beats[current.beat].line}`}>{scene.draw(current.beat, p)}</svg>
      <figcaption className="dw-mx-caption">
        <span className="dw-mx-chip">{current.name}<b>{beatNames[current.beat]}</b></span>
        <p key={index}>{scene.beats[current.beat].line}</p>
      </figcaption>
      {!playing && !compact && <button type="button" className="dw-video-big" aria-label="播放全部演示" onClick={toggle}><Play /></button>}
    </div>
    <div className="dw-video-bar">
      <button type="button" className="ep-button ep-icon-button" aria-label={playing ? '暂停' : '播放'} data-action="video-toggle" onClick={toggle}>
        {playing ? <Pause /> : <Play />}
      </button>
      <span className="dw-video-track">{chapters.map((chapter, i) => <button key={i} type="button" aria-label={`${chapter.name} · ${beatNames[chapter.beat]}`} onClick={() => go(i)} data-done={i < index || undefined}>
        {i === index && <b style={{ width: `${Math.min(100, p * 100)}%` }} />}</button>)}</span>
      <span className="dw-video-time">{clock(t)} / {clock(total)}</span>
      <button type="button" className="ep-button ep-icon-button" aria-label="从头播放" onClick={() => go(0)}><RotateCcw /></button>
    </div>
    {!compact && methods.length > 1 && <nav className="dw-video-chapters" aria-label="章节">{methods.map(method =>
      <button key={method.first} type="button" aria-current={current.name === method.name || undefined} onClick={() => go(method.first)}>{method.name}<small>{clock(method.first * BEAT_SECONDS)}</small></button>)}</nav>}
  </figure>;
}
