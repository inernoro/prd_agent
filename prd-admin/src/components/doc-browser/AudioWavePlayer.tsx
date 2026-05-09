/**
 * AudioWavePlayer — 自定义音频播放器，替换浏览器原生 <audio controls>
 *
 * 设计决策（2026-05-08 第二轮）：
 *   - 用 MediaElement 模式（套 HTMLAudioElement）而不是 WebAudio fetch+decode
 *     原因：CDN 没设 Access-Control-Allow-Origin，跨域 fetch 永远失败
 *     audio src 跨域加载浏览器宽容（不需 CORS），永远能播
 *   - 不主动渲染波形（没有 peaks 就显示进度条），等 CDN 配 CORS 那天再升级波形
 *   - onTimeUpdate 用 ref 隔离，避免父组件重渲染引发 useEffect 重建
 *
 * 行为：
 *   - 跨域音频：播放 OK，无波形
 *   - 同域音频：播放 OK，有波形（wavesurfer 自动 decode）
 *   - 失败：自动 fallback 浏览器原生 <audio controls>
 */
import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause } from 'lucide-react';

interface AudioWavePlayerProps {
  src: string;
  /** 字幕 / 时间戳跟随高亮的回调（Wave 3 字幕跟随高亮使用） */
  onTimeUpdate?: (currentSec: number) => void;
  className?: string;
}

const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AudioWavePlayer({ src, onTimeUpdate, className = '' }: AudioWavePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  // ref 隔离 onTimeUpdate：父组件重渲染传新函数引用不应触发 ws 重建
  const onTimeUpdateRef = useRef(onTimeUpdate);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // useEffect 仅依赖 src — 避免 onTimeUpdate 引用变化导致 ws 反复销毁重建
  useEffect(() => {
    if (!containerRef.current) return;
    setReady(false);
    setError(null);

    // MediaElement 模式：让 wavesurfer 套在 HTMLAudioElement 上，不走 fetch+decode
    // 跨域音频用 audio 元素加载浏览器宽容（不需 CORS），核心目标是"永远能播"
    const audio = new Audio();
    audio.src = src;
    audio.preload = 'metadata';

    const ws = WaveSurfer.create({
      container: containerRef.current,
      height: 56,
      waveColor: 'rgba(168,85,247,0.35)',
      progressColor: 'rgba(216,180,254,0.95)',
      cursorColor: 'rgba(216,180,254,0.8)',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 2,
      barRadius: 1,
      normalize: true,
      media: audio, // ← 关键：套 audio 元素，避开 fetch CORS
    });
    wsRef.current = ws;

    ws.on('ready', () => {
      setReady(true);
      setDuration(ws.getDuration());
    });
    // metadata 加载完也算 ready（即使没解码出 PCM，时长能拿到就够用）
    audio.addEventListener('loadedmetadata', () => {
      setReady(true);
      setDuration(audio.duration || 0);
    });
    ws.on('timeupdate', (t) => {
      setCurrentTime(t);
      onTimeUpdateRef.current?.(t);
    });
    ws.on('play', () => setPlaying(true));
    ws.on('pause', () => setPlaying(false));
    ws.on('finish', () => setPlaying(false));
    audio.addEventListener('error', () => {
      // audio 元素本身加载失败 → 完全 fallback 到原生
      // eslint-disable-next-line no-console
      console.warn('[AudioWavePlayer] audio 加载失败，回退原生:', src);
      setError('audio load failed');
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [src]);

  // 切换倍速时同步到 wavesurfer
  useEffect(() => {
    wsRef.current?.setPlaybackRate(PLAYBACK_RATES[rateIdx], true);
  }, [rateIdx]);

  const togglePlay = () => {
    wsRef.current?.playPause();
  };

  // 加载失败 → 静默回退到浏览器原生 audio
  if (error) {
    return (
      <div className={`flex flex-col items-center gap-2 ${className}`}>
        <audio src={src} controls className="block mx-auto w-[420px] max-w-[90%]" />
      </div>
    );
  }

  return (
    <div
      className={`w-[480px] max-w-[92%] rounded-[14px] p-4 ${className}`}
      style={{
        background: 'linear-gradient(135deg, rgba(168,85,247,0.06), rgba(59,130,246,0.04))',
        border: '1px solid rgba(168,85,247,0.18)',
      }}
    >
      {/* 波形容器 — MediaElement 模式下，跨域音频此处可能空白（仅有进度光标）
          这是预期行为：等 CDN 配 CORS 后会自动有真实波形 */}
      <div className="relative mb-3">
        <div ref={containerRef} className="w-full" />
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex gap-1">
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className="w-1 rounded-full"
                  style={{
                    background: 'rgba(168,85,247,0.5)',
                    height: '24px',
                    animation: `wave-pulse 1.2s ease-in-out ${i * 0.1}s infinite`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 控制条 */}
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          disabled={!ready}
          className="flex h-9 w-9 items-center justify-center rounded-full cursor-pointer transition-all disabled:cursor-not-allowed"
          style={{
            background: ready
              ? 'linear-gradient(135deg, rgba(168,85,247,0.95), rgba(216,180,254,0.95))'
              : 'rgba(168,85,247,0.3)',
            color: '#fff',
            boxShadow: ready ? '0 4px 12px rgba(168,85,247,0.35)' : 'none',
          }}
          title={playing ? '暂停' : '播放'}
        >
          {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" style={{ marginLeft: 1 }} />}
        </button>

        <span className="text-[11px] font-mono tabular-nums" style={{ color: 'var(--text-primary)' }}>
          {formatTime(currentTime)}
        </span>
        <span className="text-[11px] text-token-muted">/</span>
        <span className="text-[11px] font-mono tabular-nums text-token-muted">
          {ready ? formatTime(duration) : '--:--'}
        </span>

        <div className="flex-1" />

        {/* 倍速切换 */}
        <button
          onClick={() => setRateIdx((i) => (i + 1) % PLAYBACK_RATES.length)}
          disabled={!ready}
          className="text-[10px] px-2 py-1 rounded-[6px] cursor-pointer transition-all"
          style={{
            background: 'rgba(168,85,247,0.1)',
            color: 'rgba(216,180,254,0.95)',
            border: '1px solid rgba(168,85,247,0.2)',
            fontFamily: 'ui-monospace, monospace',
          }}
          title="点击切换倍速"
        >
          {PLAYBACK_RATES[rateIdx]}x
        </button>
      </div>

      <style>{`
        @keyframes wave-pulse {
          0%, 100% { transform: scaleY(0.3); opacity: 0.4; }
          50% { transform: scaleY(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
