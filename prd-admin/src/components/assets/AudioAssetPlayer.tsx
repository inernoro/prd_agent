import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import { Download, Music, Pause, Play } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { apiDownload } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';

type AudioMetadata = { sizeBytes?: number; duration?: number };

/** 私有音频仅在用户点击后经鉴权取同一 Blob；凭据不进入媒体或下载 URL。 */
export function AudioAssetPlayer({ url, title, variant = 'native', actions, onMetadata }: {
  url: string;
  title: string;
  variant?: 'native' | 'studio';
  actions?: ReactNode;
  onMetadata?: (metadata: AudioMetadata) => void;
}) {
  // 刷新 access token 不改变登录会话；切换用户或重新登录仍立即释放音频。
  const session = useAuthStore((state) => `${state.user?.userId ?? ''}:${state.sessionKey || state.token || ''}`);
  const [source, setSource] = useState<{ url: string; original: string; session: string; fileName: string; sizeBytes: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const objectUrl = useRef<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  const privateApi = url.startsWith('/api/');
  const studio = variant === 'studio';

  useEffect(() => {
    generation.current += 1;
    setSource(null);
    setLoading(false);
    setError(null);
    setPlaying(false);
    setPosition(0);
    setDuration(0);
    return () => {
      generation.current += 1;
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    };
  }, [url, session]);

  const load = async () => {
    const current = generation.current;
    setLoading(true);
    setError(null);
    try {
      const file = await apiDownload(url, title);
      if (generation.current !== current) return;
      const blobUrl = URL.createObjectURL(file.blob);
      objectUrl.current = blobUrl;
      setSource({ url: blobUrl, original: url, session, fileName: file.fileName, sizeBytes: file.blob.size });
    } catch (cause) {
      if (generation.current === current)
        setError(cause instanceof Error ? cause.message : '音频加载失败，请重试。');
    } finally {
      if (generation.current === current) setLoading(false);
    }
  };

  const loaded = source?.original === url && source.session === session ? source : null;
  const playableUrl = privateApi ? loaded?.url : url;
  const togglePlay = async () => {
    const element = audio.current;
    if (!element) return;
    if (!element.paused) { element.pause(); return; }
    try { await element.play(); setError(null); }
    catch { setError('音频暂时未能播放，请重试或下载后播放。'); }
  };

  return (
    <div className={studio ? 'audio-asset-player audio-asset-player--studio' : 'flex w-full min-w-0 flex-col gap-2'}>
      {playableUrl ? (
        <>
          <audio ref={audio} key={playableUrl} src={playableUrl} controls preload={studio ? 'metadata' : 'none'} aria-label={`播放${title}`} className={studio ? 'sr-only' : undefined}
            onLoadedMetadata={event => { const value = event.currentTarget.duration; const valid = Number.isFinite(value) && value > 0 ? value : 0; setDuration(valid); onMetadata?.({ sizeBytes: loaded?.sizeBytes, duration: valid || undefined }); }}
            onDurationChange={event => { const value = event.currentTarget.duration; if (Number.isFinite(value) && value > 0) setDuration(value); }}
            onTimeUpdate={event => setPosition(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
            onError={() => setError('当前浏览器未能播放音频，可下载后使用支持该格式的播放器。')} style={studio ? undefined : { width: '100%', height: 36 }} />
          {studio && <div className="speech-audio-transport"><button type="button" className="speech-audio-play" aria-label={playing ? `暂停${title}` : `播放${title}`} onClick={() => void togglePlay()}>{playing ? <Pause size={18} /> : <Play size={18} />}</button><div className="speech-audio-timeline"><input className="speech-range" aria-label={`播放进度：${title}`} style={{ '--speech-progress': `${duration ? Math.min(100, Math.max(0, position / duration * 100)) : 0}%` } as CSSProperties} type="range" min={0} max={duration || 1} step={0.01} value={Math.min(position, duration || 1)} disabled={!duration} onChange={event => { const value = event.target.valueAsNumber; if (audio.current && Number.isFinite(value)) { audio.current.currentTime = value; setPosition(value); } }} /><div><span>{audioTime(position)}</span><span>{duration ? audioTime(duration) : '--:--'}</span></div></div></div>}
          <div className={studio ? 'speech-audio-actions' : undefined}>
            <a href={playableUrl} download={loaded?.fileName ?? title} className={studio ? 'speech-audio-download' : 'inline-flex items-center justify-center gap-1.5 text-xs'} style={studio ? undefined : { color: 'var(--text-secondary)' }}>
              <Download size={studio ? 16 : 13} aria-hidden />下载音频
            </a>
            {actions}
          </div>
        </>
      ) : (
        <>
          <button type="button" disabled={loading} onClick={() => void load()} className={studio ? 'speech-audio-load' : 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-xs'} style={studio ? undefined : { background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
            {loading ? <MapSpinner size={14} /> : <Music size={14} aria-hidden />}
            {loading ? '正在加载音频' : error ? '重新加载音频' : '加载音频'}
          </button>
          {actions}
        </>
      )}
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--semantic-danger-text)' }}>{error}</p>}
    </div>
  );
}

function audioTime(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
