/**
 * AudioWavePlayer — 自定义音频播放器，替换浏览器原生 <audio controls>
 *
 * 设计决策（2026-05-08 第二轮）：
 *   - 直接驱动 HTMLAudioElement，不再让 WaveSurfer 二次 fetch / decode 跨域文件
 *   - 声纹使用确定性占位条，播放进度来自原生 audio timeupdate
 *   - 对 MediaRecorder 生成、缺少 duration 的 WebM 做时长探测兜底
 *   - onTimeUpdate 用 ref 隔离，避免父组件重渲染引发 useEffect 重建
 *
 * 行为：
 *   - 跨域音频：播放 OK，无波形
 *   - 同域音频：播放 OK，有波形（wavesurfer 自动 decode）
 *   - 失败：自动 fallback 浏览器原生 <audio controls>
 */
import { useEffect, useRef, useState } from 'react';
import { Download, Play, Pause } from 'lucide-react';

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
  const audioRef = useRef<HTMLAudioElement | null>(null);
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

  // useEffect 仅依赖 src — 避免回调引用变化导致播放器反复销毁重建
  useEffect(() => {
    setReady(false);
    setError(null);
    const audio = new Audio();
    audioRef.current = audio;
    audio.src = src;
    audio.preload = 'metadata';
    audio.setAttribute('playsinline', '');

    let probingDuration = false;
    const syncDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
        if (probingDuration) {
          probingDuration = false;
          audio.currentTime = 0;
        }
      } else if (audio.duration === Infinity && !probingDuration) {
        // MediaRecorder 的 WebM 分片常没有 duration/cues。跳到极远位置可让 Chromium/WebKit
        // 扫到文件尾并触发 durationchange，之后恢复到 0；不会真正开始播放。
        probingDuration = true;
        try {
          audio.currentTime = Number.MAX_SAFE_INTEGER;
        } catch {
          probingDuration = false;
        }
      }
    };
    const markReady = () => {
      setReady(true);
      syncDuration();
    };
    const updateTime = () => {
      setCurrentTime(audio.currentTime);
      onTimeUpdateRef.current?.(audio.currentTime);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    const onError = () => {
      console.warn('[AudioWavePlayer] audio 加载失败:', src);
      setError('当前浏览器无法播放这段录音');
    };
    audio.addEventListener('loadedmetadata', markReady);
    audio.addEventListener('canplay', markReady);
    audio.addEventListener('durationchange', syncDuration);
    audio.addEventListener('timeupdate', updateTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    // 点歌词跳播：seek 到目标秒；暂停态下自动继续播（音乐 App 心智）
    registerSeekRef.current?.((sec) => {
      audio.currentTime = sec;
      if (audio.paused) void audio.play().catch(() => setError('当前浏览器无法播放这段录音'));
    });
    audio.load();

    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
    };
  }, [src]);

  // 切换倍速时同步到原生播放器
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = PLAYBACK_RATES[rateIdx];
  }, [rateIdx]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().catch(() => setError('当前浏览器无法播放这段录音'));
    else audio.pause();
  };

  // 加载失败时给出明确说明与可恢复的下载路径，避免一个无反应的播放按钮。
  if (error) {
    return (
      <div
        className={`flex w-[480px] max-w-[92%] flex-col items-center gap-3 rounded-[14px] p-4 ${className}`}
        style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.18)' }}>
        <p className="text-[12px] text-token-secondary">{error}</p>
        <a
          href={src}
          download
          className="flex items-center gap-1.5 rounded-[8px] px-3 py-2 text-[12px] font-semibold"
          style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}>
          <Download size={13} /> 下载原录音
        </a>
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
      {/* 语音消息式声纹条：不读取跨域 PCM，播放与进度只依赖原生 audio。 */}
      <div className="relative mb-3">
        <div
          className="flex h-[56px] w-full items-end gap-[2px]"
          style={{ cursor: ready && duration > 0 ? 'pointer' : 'default', alignItems: 'center' }}
          onClick={(e) => {
            if (!ready || duration <= 0 || !audioRef.current) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            audioRef.current.currentTime = ratio * duration;
          }}
          title={ready && duration > 0 ? '点击跳到对应位置' : undefined}
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
