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
  /** 字幕 / 时间戳跟随高亮的回调（转录跟读滚轮使用） */
  onTimeUpdate?: (currentSec: number) => void;
  /** 注册跳播函数：父组件拿到 seek(sec) 后可实现「点歌词跳播」；跳播后若暂停会自动继续播 */
  registerSeek?: (seek: (sec: number) => void) => void;
  className?: string;
}

const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * 声纹条高度（确定性伪随机，按 src 播种）：跨域音频拿不到真实 PCM 波形时，
 * 渲染语音消息式的声纹条（微信/Telegram 语音条心智），进度按播放比例着色。
 * 同一个文件每次打开形状一致（确定性），不是每帧乱跳的假动画。
 */
function seededBars(src: string, n: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5; h |= 0;
    const r = ((h >>> 0) % 1000) / 1000;
    // 正弦包络 + 随机扰动：形似语音的起伏，不是纯噪声
    out.push(0.22 + 0.78 * (0.55 * Math.abs(Math.sin((i + 1) * 0.62 + r * 2.4)) + 0.45 * r));
  }
  return out;
}

const BAR_COUNT = 48;

export function AudioWavePlayer({ src, onTimeUpdate, registerSeek, className = '' }: AudioWavePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  // ref 隔离 onTimeUpdate：父组件重渲染传新函数引用不应触发 ws 重建
  const onTimeUpdateRef = useRef(onTimeUpdate);
  useEffect(() => { onTimeUpdateRef.current = onTimeUpdate; }, [onTimeUpdate]);
  const registerSeekRef = useRef(registerSeek);
  useEffect(() => { registerSeekRef.current = registerSeek; }, [registerSeek]);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rateIdx, setRateIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // 是否解码出真实波形（同域音频）；跨域拿不到 PCM → 渲染声纹条兜底
  const [decoded, setDecoded] = useState(false);

  // useEffect 仅依赖 src — 避免 onTimeUpdate 引用变化导致 ws 反复销毁重建
  useEffect(() => {
    if (!containerRef.current) return;
    setReady(false);
    setError(null);
    setDecoded(false);

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
    // 只有真实解码出 PCM（同域/CORS 通）才有波形；否则声纹条兜底
    ws.on('decode', () => setDecoded(true));
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
    // 点歌词跳播：seek 到目标秒；暂停态下自动继续播（音乐 App 心智）
    registerSeekRef.current?.((sec) => {
      ws.setTime(sec);
      if (!ws.isPlaying()) void ws.play();
    });
    audio.addEventListener('error', () => {
      // audio 元素本身加载失败 → 完全 fallback 到原生
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
      {/* 可视区：同域音频解码出真实波形走 wavesurfer；跨域拿不到 PCM 时渲染
          语音消息式声纹条（确定性伪随机 + 播放进度着色 + 点按跳播），不再留白 */}
      <div className="relative mb-3">
        <div ref={containerRef} className="w-full" style={decoded ? undefined : { height: 0, overflow: 'hidden' }} />
        {!decoded && (
          <div
            className="flex h-[56px] w-full items-end gap-[2px]"
            style={{ cursor: ready ? 'pointer' : 'default', alignItems: 'center' }}
            onClick={(e) => {
              if (!ready || duration <= 0) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
              wsRef.current?.setTime(ratio * duration);
            }}
            title={ready ? '点击跳到对应位置' : undefined}
          >
            {seededBars(src, BAR_COUNT).map((h, i) => {
              const played = ready && duration > 0 && i / BAR_COUNT <= currentTime / duration;
              return (
                <span
                  key={i}
                  className="min-w-0 flex-1 rounded-full transition-colors duration-150"
                  style={{
                    height: `${Math.round(h * 100)}%`,
                    background: played ? 'rgba(216,180,254,0.95)' : 'rgba(168,85,247,0.30)',
                    ...(ready ? {} : { animation: `wave-pulse 1.2s ease-in-out ${(i % 8) * 0.12}s infinite` }),
                  }}
                />
              );
            })}
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
