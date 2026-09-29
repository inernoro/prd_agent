import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Clapperboard, Maximize2, Minimize2, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';

import { SectionHeader } from '../components/SectionHeader';
import { Reveal } from '../components/Reveal';
import { useLanguage } from '../contexts/LanguageContext';
import { FILM } from './filmPalette';
import { FilmScorePlayer } from './filmScore';
import { FilmStage, STAGE_H, STAGE_W } from './FilmStage';
import { FILM_DURATION, FILM_SCENES, POSTER_TIME, formatClock } from './filmTimeline';

/**
 * 首页片花 —— 数字条之后、第一幕之前的那块银幕。
 *
 * 它不是一个 <video>：画面是 FilmStage 按时间逐帧算出来的，配乐是 filmScore
 * 用 Web Audio 现场合成的，两者读同一张时间轴。所以：
 *   · 拖进度条，音乐跟着落到同一拍；
 *   · 右上角切中英文，片子里的字当场换语言；
 *   · 仓库里没有一个视频或音频文件。
 * 要一份能发到外面的 MP4，用 `scripts/render-landing-film.mjs` 逐帧导出，
 * 画面与声音都是同一份代码的产物。
 *
 * 时钟以音频为准（AudioContext.currentTime），画面反过来读它——音画不会漂。
 * 浏览器拿不到 Web Audio 时退回 performance.now()，并在控制条上如实写出「只播画面」，
 * 不装作有声（`predicate-and-wiring-discipline` 形状 10：降级要留痕）。
 */

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function FilmSection() {
  const { t: copy } = useLanguage();
  const film = copy.film;
  const roster = useMemo(() => copy.tail.toolbox.groups.flatMap((g) => g.items), [copy]);

  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [audioOk, setAudioOk] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  const frameRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const ctxRef = useRef<AudioContext | null>(null);
  const scoreRef = useRef<FilmScorePlayer | null>(null);
  const rafRef = useRef<number | null>(null);
  /** 无音频时的备用时钟：片内起点 + 墙钟起点 */
  const perfRef = useRef({ from: 0, at: 0 });
  const timeRef = useRef(0);
  timeRef.current = time;

  // ── 等比缩放：1920×1080 的逻辑画布塞进任意宽度 ──
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / STAGE_W));
    ro.observe(el);
    setScale(el.clientWidth / STAGE_W);
    return () => ro.disconnect();
  }, []);

  const ensureScore = useCallback((): FilmScorePlayer | null => {
    if (scoreRef.current) return scoreRef.current;
    const Ctor = audioContextCtor();
    if (!Ctor) {
      setAudioOk(false);
      return null;
    }
    try {
      const ctx = new Ctor();
      ctxRef.current = ctx;
      scoreRef.current = new FilmScorePlayer(ctx);
      return scoreRef.current;
    } catch {
      setAudioOk(false);
      return null;
    }
  }, []);

  const clock = useCallback((): number => {
    const score = scoreRef.current;
    if (score && ctxRef.current?.state === 'running') return score.time;
    const { from, at } = perfRef.current;
    return from + (performance.now() - at) / 1000;
  }, []);

  const stopLoop = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  const pause = useCallback(() => {
    stopLoop();
    scoreRef.current?.stop();
    setPlaying(false);
  }, []);

  const startAt = useCallback(
    (from: number) => {
      const score = ensureScore();
      const ctx = ctxRef.current;
      if (score && ctx) {
        if (ctx.state === 'suspended') void ctx.resume();
        score.setMuted(muted);
        score.start(from);
      }
      perfRef.current = { from, at: performance.now() };
      setStarted(true);
      setPlaying(true);
      setTime(from);
      stopLoop();
      const tick = () => {
        const now = Math.max(from, clock());
        if (now >= FILM_DURATION) {
          scoreRef.current?.stop();
          setTime(FILM_DURATION);
          setPlaying(false);
          rafRef.current = null;
          return;
        }
        setTime(now);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    },
    [clock, ensureScore, muted],
  );

  const toggle = useCallback(() => {
    if (playing) pause();
    else startAt(timeRef.current >= FILM_DURATION - 0.05 ? 0 : timeRef.current);
  }, [pause, playing, startAt]);

  const seek = useCallback(
    (to: number) => {
      const clamped = Math.max(0, Math.min(FILM_DURATION - 0.01, to));
      setStarted(true);
      if (playing) startAt(clamped);
      else setTime(clamped);
    },
    [playing, startAt],
  );

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      scoreRef.current?.setMuted(!m);
      return !m;
    });
  }, []);

  // ── 滚出视口 / 切走标签页：自动暂停，不在看不见的地方放歌 ──
  useEffect(() => {
    const el = frameRef.current;
    if (!el || !playing) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting && !document.fullscreenElement) pause();
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    const onHide = () => {
      if (document.hidden) pause();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [pause, playing]);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(
    () => () => {
      stopLoop();
      scoreRef.current?.stop();
      void ctxRef.current?.close().catch(() => undefined);
    },
    [],
  );

  const toggleFullscreen = () => {
    const el = frameRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen?.().catch(() => undefined);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      seek(timeRef.current + 4);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seek(timeRef.current - 4);
    } else if (e.key === 'm') {
      toggleMute();
    } else if (e.key === 'f') {
      toggleFullscreen();
    }
  };

  // ── 进度条拖动 ──
  const barRef = useRef<HTMLDivElement>(null);
  const seekFromPointer = (clientX: number) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    seek(((clientX - rect.left) / rect.width) * FILM_DURATION);
  };
  const onBarDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromPointer(e.clientX);
  };
  const onBarMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.buttons & 1) seekFromPointer(e.clientX);
  };

  const ended = started && !playing && time >= FILM_DURATION - 0.05;
  const shownTime = started ? time : POSTER_TIME;
  const state = !started ? 'poster' : playing ? 'playing' : ended ? 'ended' : 'paused';

  return (
    <section className="relative px-3 sm:px-6 py-20 lg:py-32">
      <div className="max-w-[1280px] mx-auto">
        <SectionHeader eyebrow={film.eyebrow} Icon={Clapperboard} title={film.title} subtitle={film.subtitle} accent={FILM.clay} />

        <Reveal delay={200} offset={24} duration={2200}>
          <div
            ref={frameRef}
            tabIndex={0}
            role="region"
            aria-label={film.title}
            onKeyDown={onKey}
            data-film-state={state}
            data-film-time={time.toFixed(2)}
            className="group relative mt-14 mx-auto max-w-[1120px] outline-none"
            style={{
              borderRadius: fullscreen ? 0 : 'clamp(12px, 2vw, 24px)',
              overflow: 'hidden',
              background: FILM.bg,
              boxShadow: fullscreen ? 'none' : `${FILM.shadow}, 0 0 0 1px ${FILM.lineStrong}`,
              display: fullscreen ? 'flex' : 'block',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div
              ref={viewportRef}
              className="relative w-full"
              style={{ aspectRatio: `${STAGE_W} / ${STAGE_H}`, maxWidth: fullscreen ? `calc(100vh * ${STAGE_W} / ${STAGE_H})` : undefined }}
              onClick={toggle}
            >
              <div style={{ position: 'absolute', left: 0, top: 0, width: STAGE_W, height: STAGE_H, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
                <FilmStage t={shownTime} copy={film} roster={roster} />
              </div>

              {/* 海报 / 暂停 / 播完：中央大按钮 */}
              {!playing && (
                <div className="absolute inset-0" style={{ background: started ? FILM.glass : 'transparent' }}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle();
                    }}
                    className="absolute flex items-center gap-2 sm:gap-3 rounded-full whitespace-nowrap py-2 pl-2 pr-4 sm:py-4 sm:pl-5 sm:pr-7 text-[13px] sm:text-[16px] transition-transform duration-200 hover:scale-[1.04]"
                    style={{
                      left: '50%',
                      // 海报态：落在片内「进入 MAP」按钮的位置（那颗按钮此刻还没出现，见 POSTER_TIME），不压标语
                      top: started ? '50%' : '79%',
                      transform: 'translate(-50%, -50%)',
                      background: FILM.brandGradient,
                      color: FILM.onBrand,
                      boxShadow: `0 0 40px ${FILM.clay}88`,
                      fontFamily: 'var(--font-display)',
                      fontWeight: 600,
                    }}
                  >
                    <span className="grid place-items-center rounded-full w-7 h-7 sm:w-10 sm:h-10" style={{ background: FILM.onBrand, color: FILM.clay }}>
                      {ended ? <RotateCcw className="w-4 h-4 sm:w-5 sm:h-5" /> : <Play className="w-4 h-4 sm:w-5 sm:h-5" style={{ marginLeft: 2 }} />}
                    </span>
                    {ended ? film.controls.replay : started ? film.controls.play : `${film.controls.play} · ${formatClock(FILM_DURATION)}`}
                    {!started && (
                      <span className="ml-1 hidden sm:inline-flex items-center gap-1 text-[13px] opacity-80">
                        <Volume2 size={14} />
                        {film.controls.soundOn}
                      </span>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* 控制条 */}
            {started && (
              <div
                className={`absolute left-0 right-0 bottom-0 px-2 pb-1 pt-6 sm:px-4 sm:pb-3 sm:pt-10 transition-opacity duration-300 ${playing ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100' : 'opacity-100'}`}
                style={{ background: FILM.scrim }}
              >
                <div
                  ref={barRef}
                  className="relative h-5 cursor-pointer flex items-center"
                  onPointerDown={onBarDown}
                  onPointerMove={onBarMove}
                  role="slider"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(FILM_DURATION)}
                  aria-valuenow={Math.round(time)}
                  aria-label="seek"
                >
                  <div className="relative w-full h-[4px] rounded-full" style={{ background: FILM.lineStrong }}>
                    <div className="absolute left-0 top-0 bottom-0 rounded-full" style={{ width: `${(time / FILM_DURATION) * 100}%`, background: FILM.brandGradient }} />
                    {/* 章节刻度：幕与幕的分界，正好是切镜的鼓点 */}
                    {FILM_SCENES.slice(1).map((s) => (
                      <span key={s.id} className="absolute top-[-2px] w-[2px] h-[8px]" style={{ left: `${(s.from / FILM_DURATION) * 100}%`, background: FILM.textFaint }} />
                    ))}
                    <span
                      className="absolute top-1/2 w-3 h-3 rounded-full -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${(time / FILM_DURATION) * 100}%`, background: FILM.text, boxShadow: `0 0 10px ${FILM.clay}` }}
                    />
                  </div>
                </div>
                <div className="mt-0.5 sm:mt-1 flex items-center gap-1.5 sm:gap-3 text-[11px] sm:text-[13px]" style={{ color: FILM.textDim, fontFamily: 'var(--font-terminal)' }}>
                  <ControlButton label={playing ? film.controls.pause : film.controls.play} onClick={toggle}>
                    {playing ? <Pause className="w-4 h-4 sm:w-[18px] sm:h-[18px]" /> : ended ? <RotateCcw className="w-4 h-4 sm:w-[18px] sm:h-[18px]" /> : <Play className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />}
                  </ControlButton>
                  <span>
                    {formatClock(time)} / {formatClock(FILM_DURATION)}
                  </span>
                  {!audioOk && <span style={{ color: FILM.sand }}>{film.controls.noAudio}</span>}
                  <span className="flex-1" />
                  {audioOk && (
                    <ControlButton label={muted ? film.controls.unmute : film.controls.mute} onClick={toggleMute}>
                      {muted ? <VolumeX className="w-4 h-4 sm:w-[18px] sm:h-[18px]" /> : <Volume2 className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />}
                    </ControlButton>
                  )}
                  <ControlButton label={film.controls.fullscreen} onClick={toggleFullscreen}>
                    {fullscreen ? <Minimize2 className="w-4 h-4 sm:w-[18px] sm:h-[18px]" /> : <Maximize2 className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />}
                  </ControlButton>
                </div>
              </div>
            )}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function ControlButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid place-items-center w-7 h-7 sm:w-9 sm:h-9 rounded-lg transition-colors"
      style={{ color: FILM.text }}
    >
      {children}
    </button>
  );
}
