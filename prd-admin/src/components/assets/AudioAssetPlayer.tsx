import { useEffect, useRef, useState } from 'react';
import { Download, Music } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { apiDownload } from '@/services/real/apiClient';
import { useAuthStore } from '@/stores/authStore';

/**
 * 受控音频先通过现有鉴权下载通道取得 Blob，原生 audio 无法自行附带 Bearer。
 * 点击后才取文件，避免资产列表一次下载所有语音；凭据不放进 URL。
 */
export function AudioAssetPlayer({ url, title }: { url: string; title: string }) {
  const session = useAuthStore((state) => `${state.user?.userId ?? ''}:${state.authSessionEpoch}`);
  const [source, setSource] = useState<{ url: string; original: string; session: string; fileName: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const objectUrl = useRef<string | null>(null);
  const generation = useRef(0);
  const privateApi = url.startsWith('/api/');

  useEffect(() => {
    generation.current += 1;
    setSource(null);
    setLoading(false);
    setError(null);
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
      setSource({ url: blobUrl, original: url, session, fileName: file.fileName });
    } catch (cause) {
      if (generation.current === current)
        setError(cause instanceof Error ? cause.message : '音频加载失败，请重试。');
    } finally {
      if (generation.current === current) setLoading(false);
    }
  };

  const loaded = source?.original === url && source.session === session ? source : null;
  const playableUrl = privateApi ? loaded?.url : url;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      {playableUrl ? (
        <>
          <audio key={playableUrl} src={playableUrl} controls preload="none" aria-label={`播放${title}`} onError={() => setError('当前浏览器未能播放音频，可下载后使用支持该格式的播放器。')} style={{ width: '100%', height: 36 }} />
          <a href={playableUrl} download={loaded?.fileName ?? title} className="inline-flex items-center justify-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <Download size={13} aria-hidden />下载音频
          </a>
        </>
      ) : (
        <button type="button" disabled={loading} onClick={() => void load()} className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-3 text-xs" style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
          {loading ? <MapSpinner size={14} /> : <Music size={14} aria-hidden />}
          {loading ? '正在加载音频' : error ? '重新加载音频' : '加载音频'}
        </button>
      )}
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--semantic-danger-text)' }}>{error}</p>}
    </div>
  );
}
