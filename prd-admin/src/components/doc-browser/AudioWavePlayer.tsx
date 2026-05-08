/**
 * AudioWavePlayer — 自定义音频播放器，替换浏览器原生 <audio controls>
 *
 * 视觉：
 * - 波形可视化（wavesurfer.js）
 * - 紫色主题（与知识库 Surface System 一致）
 * - 当前时间 / 总时长 + 播放/暂停按钮 + 倍速切换
 *
 * 行为：
 * - 加载完成前显示骨架占位
 * - 加载失败回退到浏览器原生 controls
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
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    setReady(false);
    setError(null);

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
      url: src,
    });
    wsRef.current = ws;

    ws.on('ready', () => {
      setReady(true);
      setDuration(ws.getDuration());
    });
    ws.on('timeupdate', (t) => {
      setCurrentTime(t);
      onTimeUpdate?.(t);
    });
    ws.on('play', () => setPlaying(true));
    ws.on('pause', () => setPlaying(false));
    ws.on('finish', () => setPlaying(false));
    ws.on('error', (err) => {
      // 静默 fallback：跨域 decode 失败 / 文件后缀错（CDN 按 png 处理 audio）
      // 都走原生 <audio>，console 留诊断信息
      const msg = typeof err === 'string' ? err : (err as Error)?.message ?? '加载失败';
      // eslint-disable-next-line no-console
      console.warn('[AudioWavePlayer] 波形 decode 失败，回退原生 audio:', msg, 'src=', src);
      setError(msg);
    });

    return () => {
      ws.destroy();
      wsRef.current = null;
    };
  }, [src, onTimeUpdate]);

  // 切换倍速时同步到 wavesurfer
  useEffect(() => {
    wsRef.current?.setPlaybackRate(PLAYBACK_RATES[rateIdx], true);
  }, [rateIdx]);

  const togglePlay = () => {
    wsRef.current?.playPause();
  };

  // 加载失败 → 静默回退到浏览器原生 audio（不展示红字，行为跟以前一致）
  // 失败原因（跨域 decode / mime 错误）已 console.warn，保留诊断
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
      {/* 波形容器 */}
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
