import { useRef, useState, type SyntheticEvent } from 'react';
import type { DesignMethodId } from '../../../../src/shared/design-methods';
import type { DesignVideo } from '../../../../src/shared/design-workspace';
import { designArtifact } from './design-ui';

const videoTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function DesignAcceptanceVideo({ projectId, video, method }: { projectId: string; video: DesignVideo; method?: DesignMethodId }) {
  const player = useRef<HTMLVideoElement>(null);
  const clipIndex = video.chapters.findIndex(chapter => chapter.method === method);
  const clip = video.chapters[clipIndex];
  const clipEnd = clip ? video.chapters[clipIndex + 1]?.start : undefined;
  const [chapterIndex, setChapterIndex] = useState(Math.max(0, clipIndex));
  const [failure, setFailure] = useState(false);
  const pendingTime = useRef(clip?.start ?? 0);
  if (method && !clip) return null;

  const seek = (index: number) => {
    const time = video.chapters[index].start;
    pendingTime.current = time;
    setChapterIndex(index);
    if (player.current?.readyState && time < player.current.duration) player.current.currentTime = time;
  };
  const loaded = (event: SyntheticEvent<HTMLVideoElement>) => {
    const element = event.currentTarget;
    if (pendingTime.current >= element.duration) setFailure(true);
    else element.currentTime = pendingTime.current;
  };
  const update = (event: SyntheticEvent<HTMLVideoElement>) => {
    const element = event.currentTarget;
    const time = element.currentTime;
    if (clip) {
      if (time + 0.05 < clip.start) element.currentTime = clip.start;
      if (clipEnd !== undefined && time >= clipEnd) {
        element.pause();
        if (time > clipEnd + 0.05) element.currentTime = clipEnd;
      }
      return;
    }
    let selected = 0;
    for (const [index, chapter] of video.chapters.entries()) {
      if (chapter.start <= time) selected = index;
    }
    setChapterIndex(selected);
  };
  const title = clip?.title ?? video.title;
  return <figure className="dw-video" aria-label={title}>
    <figcaption>{title}</figcaption>
    <video ref={player} src={designArtifact(projectId, video.artifactId)} controls playsInline preload="metadata"
      aria-label={title} onLoadedMetadata={loaded} onTimeUpdate={update} onSeeking={update}
      onPlay={event => {
        const element = event.currentTarget;
        if (clip && clipEnd !== undefined && element.currentTime >= clipEnd) element.currentTime = clip.start;
      }} onError={() => setFailure(true)} />
    {failure && <p role="status" className="dw-dl-missing">视频无法打开。
      <button type="button" className="ep-text-button" onClick={() => { setFailure(false); player.current?.load(); }}>重试</button>
    </p>}
    {!clip && <nav className="dw-video-chapters" aria-label="视频章节">
      {video.chapters.map((chapter, index) => <button key={chapter.method} className="ep-button" type="button"
        aria-current={index === chapterIndex ? 'true' : undefined} onClick={() => seek(index)}>
        {chapter.title}<small>{videoTime(chapter.start)}</small>
      </button>)}
    </nav>}
  </figure>;
}
