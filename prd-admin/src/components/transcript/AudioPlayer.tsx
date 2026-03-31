import { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause } from 'lucide-react';

interface AudioPlayerProps {
  src: string;
  className?: string;
  onTimeUpdate?: (currentTime: number) => void;
  seekTo?: number;
}

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

export function AudioPlayer({ src, className, onTimeUpdate, seekTo }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rateIndex, setRateIndex] = useState(2); // default 1x

  // Seek when seekTo prop changes
  useEffect(() => {
    if (seekTo !== undefined && audioRef.current) {
      audioRef.current.currentTime = seekTo;
    }
  }, [seekTo]);

  // Reset state when src changes
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setRateIndex(2);
  }, [src]);

  const handleTimeUpdate = useCallback(() => {
    if (!audioRef.current) return;
    const t = audioRef.current.currentTime;
    setCurrentTime(t);
    onTimeUpdate?.(t);
  }, [onTimeUpdate]);

  const handleLoadedMetadata = useCallback(() => {
    if (!audioRef.current) return;
    setDuration(audioRef.current.duration);
  }, []);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  }, [isPlaying]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!audioRef.current) return;
    const t = parseFloat(e.target.value);
    audioRef.current.currentTime = t;
    setCurrentTime(t);
  }, []);

  const cycleRate = useCallback(() => {
    const nextIndex = (rateIndex + 1) % PLAYBACK_RATES.length;
    setRateIndex(nextIndex);
    if (audioRef.current) {
      audioRef.current.playbackRate = PLAYBACK_RATES[nextIndex];
    }
  }, [rateIndex]);

  const rate = PLAYBACK_RATES[rateIndex];
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className={`border-b border-border/50 px-4 py-2.5 flex items-center gap-3 ${className ?? ''}`}>
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        preload="metadata"
      />

      {/* Play/Pause */}
      <button
        onClick={togglePlay}
        className="hover:bg-muted rounded-lg p-1.5 transition-colors text-muted-foreground hover:text-foreground"
      >
        {isPlaying
          ? <Pause className="w-4 h-4" />
          : <Play className="w-4 h-4" />
        }
      </button>

      {/* Progress bar */}
      <div className="flex-1 relative">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={handleSeek}
          className="audio-progress-slider w-full h-1 cursor-pointer"
          style={{ '--progress': `${progress}%` } as React.CSSProperties}
        />
      </div>

      {/* Time display */}
      <span className="text-xs font-mono text-muted-foreground tabular-nums shrink-0">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>

      {/* Playback rate */}
      <button
        onClick={cycleRate}
        className="text-xs text-muted-foreground hover:text-foreground/80 px-1.5 rounded transition-colors tabular-nums"
      >
        {rate}x
      </button>

      <style>{`
        .audio-progress-slider {
          -webkit-appearance: none;
          appearance: none;
          background: transparent;
          outline: none;
        }
        .audio-progress-slider::-webkit-slider-runnable-track {
          height: 4px;
          border-radius: 2px;
          background: linear-gradient(
            to right,
            hsl(var(--primary) / 0.6) 0%,
            hsl(var(--primary) / 0.6) var(--progress, 0%),
            hsl(var(--muted) / 0.5) var(--progress, 0%),
            hsl(var(--muted) / 0.5) 100%
          );
        }
        .audio-progress-slider::-moz-range-track {
          height: 4px;
          border-radius: 2px;
          background: hsl(var(--muted) / 0.5);
        }
        .audio-progress-slider::-moz-range-progress {
          height: 4px;
          border-radius: 2px;
          background: hsl(var(--primary) / 0.6);
        }
        .audio-progress-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: hsl(var(--primary));
          margin-top: -4px;
          cursor: pointer;
          opacity: 0;
          transition: opacity 0.15s;
        }
        .audio-progress-slider:hover::-webkit-slider-thumb {
          opacity: 1;
        }
        .audio-progress-slider::-moz-range-thumb {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: hsl(var(--primary));
          border: none;
          cursor: pointer;
          opacity: 0;
          transition: opacity 0.15s;
        }
        .audio-progress-slider:hover::-moz-range-thumb {
          opacity: 1;
        }
      `}</style>
    </div>
  );
}
