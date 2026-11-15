import { useEffect, useState, type RefObject } from 'react';
import { Maximize2, Minimize2, Pause, Play, Volume2, VolumeX } from 'lucide-react';

const timeLabel = (value: number) => {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
};

export function VideoPlaybackControls({ videoRef, frameRef, playing, currentTime, duration, disabled, onToggle, onSeek, onError }: {
  videoRef: RefObject<HTMLVideoElement>;
  frameRef: RefObject<HTMLDivElement>;
  playing: boolean;
  currentTime: number;
  duration: number;
  disabled: boolean;
  onToggle: () => void;
  onSeek: (time: number) => void;
  onError: (message: string) => void;
}) {
  const [muted, setMuted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const length = Number.isFinite(duration) && duration > 0 ? duration : 0;
  useEffect(() => {
    const video = videoRef.current;
    const syncMuted = () => setMuted(video?.muted ?? false);
    syncMuted();
    video?.addEventListener('volumechange', syncMuted);
    return () => video?.removeEventListener('volumechange', syncMuted);
  }, [videoRef, disabled]);
  useEffect(() => {
    const onFullscreen = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => document.removeEventListener('fullscreenchange', onFullscreen);
  }, [frameRef]);

  const toggleMuted = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === frameRef.current) await document.exitFullscreen();
      else if (frameRef.current?.requestFullscreen) await frameRef.current.requestFullscreen();
      else {
        const video = videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
        if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else onError('当前浏览器不支持全屏，请使用页面预览或打开原始视频。');
      }
    } catch {
      onError('暂时无法进入全屏，请重试或使用页面预览。');
    }
  };

  return <div className="video-workbench__transport" role="group" aria-label="视频播放控制">
    <button type="button" onClick={onToggle} disabled={disabled} aria-label={playing ? '暂停' : '播放'}>
      {playing ? <Pause size={16} /> : <Play size={16} />}
    </button>
    <span>{timeLabel(currentTime)}</span>
    <input type="range" aria-label="播放进度" aria-valuetext={`${timeLabel(currentTime)} / ${timeLabel(length)}`}
      min={0} max={length || 1} step={0.1} value={Math.min(Math.max(0, currentTime), length)}
      disabled={disabled || !length} onChange={event => onSeek(Number(event.target.value))} />
    <span>{timeLabel(length)}</span>
    <button type="button" onClick={toggleMuted} disabled={disabled} aria-label={muted ? '取消静音' : '静音'} aria-pressed={muted}>
      {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
    </button>
    <button type="button" onClick={() => void toggleFullscreen()} disabled={disabled} aria-label={fullscreen ? '退出全屏' : '全屏'}>
      {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </button>
  </div>;
}
