import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Clapperboard, Maximize2, Minimize2, Pause, Play, RotateCcw, Smartphone, Volume2, VolumeX } from 'lucide-react';

import { SectionHeader } from '../components/SectionHeader';
import { Reveal } from '../components/Reveal';
import { useLanguage } from '../contexts/LanguageContext';
import { FILM } from './filmPalette';
import { FilmScorePlayer } from './filmScore';
import { FILM_PLAY_EVENT } from './filmEvents';
import { FilmTrackPlayer, loadFilmTrack, type FilmAudio } from './filmTrack';
import { FilmStage, STAGE_H, STAGE_W } from './FilmStage';
import { FILM_DURATION, FILM_SCENES, POSTER_TIME, formatClock } from './filmTimeline';

/** 旋转 / 改窗口宽度之后，这么长时间内不让「滚走就亮灯 / 暂停」生效（毫秒） */
const LAYOUT_SETTLE_MS = 1200;

/**
 * 首页片花 —— 数字条之后、第一幕之前的那块银幕。
 *
 * 它不是一个 <video>：画面是 FilmStage 按时间逐帧算出来的；配乐是从 Suno 原曲按小节剪出的
 * 一段音频（filmTrack，剪法见 scoreEdit.json），时间轴的拍速也读那份剪辑表。所以：
 *   · 拖进度条，音乐跟着落到同一拍；
 *   · 右上角切中英文，片子里的字当场换语言；
 *   · 仓库里没有视频文件，只有一段 57 秒的配乐。
 * 要一份能发到外面的 MP4，用 `scripts/render-landing-film.mjs` 逐帧导出，画面与声音同源。
 *
 * 时钟以音频为准（AudioContext.currentTime），画面反过来读它——音画不会漂。
 * 两级降级，每一级都写在控制条上、并挂在 data-film-audio 上给工具读
 * （`predicate-and-wiring-discipline` 形状 10：降级要留痕）：
 *   · 配乐文件取不回 / 解不开 → 退回 filmScore 现场合成的那一版（track -> synth）；
 *   · 浏览器没有 Web Audio → 退回 performance.now()，只播画面（-> none）。
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
  /** 这一次实际在放哪一版声音；null = 还没点过播放 */
  const [audioSource, setAudioSource] = useState<'track' | 'synth' | 'none' | null>(null);
  /** 点了播放、配乐还在解码的那一小段时间 */
  const [loading, setLoading] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  /**
   * 影院模式：一开播，整页的灯就暗下来——一块纯黑幕布盖住导航、背景纹理和上下两节的字，
   * 只留片子居中。手机上片子只有一掌宽，旁边再露着别的标题与正文，看片很出戏（2026-09-30 用户反馈）。
   * 点暗处、按 Esc、片子播完、或者滚走，灯就亮回来；暂停时灯不亮，和影院一样。
   */
  const [theater, setTheater] = useState(false);

  const frameRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  const ctxRef = useRef<AudioContext | null>(null);
  const audioRef = useRef<FilmAudio | null>(null);
  const audioJobRef = useRef<Promise<FilmAudio | null> | null>(null);
  /** 每次 startAt / pause 递增；异步等配乐期间被新的操作取代，旧的那次就作废 */
  const runRef = useRef(0);
  const mutedRef = useRef(false);
  mutedRef.current = muted;
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

  // 片花快滚进视口时就把配乐取回来解好，点播放那一下不用等
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        io.disconnect();
        loadFilmTrack().catch(() => undefined);
      },
      { rootMargin: '800px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  /**
   * 取得这一次要用的声音。AudioContext 在点击的同一拍里同步创建并 resume（浏览器只认手势里的这一下），
   * 之后才异步等配乐解码；8 秒还没好就不等了，退回合成版。
   */
  const ensureAudio = useCallback((): Promise<FilmAudio | null> => {
    if (audioJobRef.current) return audioJobRef.current;
    const Ctor = audioContextCtor();
    let ctx: AudioContext;
    try {
      if (!Ctor) throw new Error('no Web Audio');
      ctx = new Ctor();
    } catch {
      setAudioSource('none');
      audioJobRef.current = Promise.resolve(null);
      return audioJobRef.current;
    }
    ctxRef.current = ctx;
    if (ctx.state === 'suspended') void ctx.resume();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('配乐解码超过 8 秒')), 8000));
    audioJobRef.current = Promise.race([loadFilmTrack(), timeout]).then(
      (buffer) => {
        audioRef.current = new FilmTrackPlayer(ctx, buffer);
        setAudioSource('track');
        return audioRef.current;
      },
      (err: unknown) => {
        console.warn('[film] 成品配乐不可用，退回合成配乐：', err);
        audioRef.current = new FilmScorePlayer(ctx);
        setAudioSource('synth');
        return audioRef.current;
      },
    );
    return audioJobRef.current;
  }, []);

  const clock = useCallback((): number => {
    const audio = audioRef.current;
    if (audio && ctxRef.current?.state === 'running') return audio.time;
    const { from, at } = perfRef.current;
    return from + (performance.now() - at) / 1000;
  }, []);

  const stopLoop = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  const pause = useCallback(() => {
    runRef.current += 1;
    stopLoop();
    audioRef.current?.stop();
    setLoading(false);
    setPlaying(false);
  }, []);

  const startAt = useCallback(
    async (from: number) => {
      const run = ++runRef.current;
      setStarted(true);
      setTime(from);
      const job = ensureAudio();
      if (!audioRef.current) setLoading(true);
      const audio = await job;
      if (run !== runRef.current) return;
      setLoading(false);
      const ctx = ctxRef.current;
      if (audio && ctx) {
        if (ctx.state === 'suspended') void ctx.resume();
        audio.setMuted(mutedRef.current);
        audio.start(from);
      }
      perfRef.current = { from, at: performance.now() };
      setPlaying(true);
      stopLoop();
      const tick = () => {
        const now = Math.max(from, clock());
        if (now >= FILM_DURATION) {
          audioRef.current?.stop();
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
    [clock, ensureAudio],
  );

  const toggle = useCallback(() => {
    if (playing || loading) pause();
    else void startAt(timeRef.current >= FILM_DURATION - 0.05 ? 0 : timeRef.current);
  }, [loading, pause, playing, startAt]);

  const seek = useCallback(
    (to: number) => {
      const clamped = Math.max(0, Math.min(FILM_DURATION - 0.01, to));
      setStarted(true);
      // 配乐还在加载时（第一次点播放、网慢）也要接管：重新发起一次 startAt，它会让等待中的那次作废，
      // 否则只改了显示的时间，加载完仍从旧位置开播，进度条弹回去（Codex P2，PR #1650）
      if (playing || loading) void startAt(clamped);
      else setTime(clamped);
    },
    [loading, playing, startAt],
  );

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      audioRef.current?.setMuted(!m);
      return !m;
    });
  }, []);

  // ── 首屏「观看完整片花」：同一个手势里建好音频 → 滚过来 → 露出来就从头带声播 ──
  const pendingPlayRef = useRef(false);
  useEffect(() => {
    const onRequest = () => {
      void ensureAudio();
      setMuted(false);
      pendingPlayRef.current = true;
      frameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    window.addEventListener(FILM_PLAY_EVENT, onRequest);
    return () => window.removeEventListener(FILM_PLAY_EVENT, onRequest);
  }, [ensureAudio]);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || !pendingPlayRef.current) return;
        pendingPlayRef.current = false;
        void startAt(0);
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [startAt]);

  // ── 旋转手机 / 改窗口大小：片子不能跟着布局重排被甩出屏幕 ──
  // 旋转时上面几节的高度全变了（首屏是 100svh），浏览器保留的是旧的 scrollY，于是片子被甩到屏外；
  // 紧接着「滚走就亮灯 / 暂停」的判定把它当成用户滚走了——用户看到的就是「视频消失了」
  // （2026-09-30 横过手机后的反馈）。所以：布局变动前片子在看 / 在放，就在布局稳定后把它挪回屏幕正中，
  // 并且在这一小段时间里不让可见性判定亮灯或暂停。
  const layoutShiftAtRef = useRef(0);
  const frameSeenRef = useRef(false);
  const playingRef = useRef(false);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const seen = new IntersectionObserver(([entry]) => {
      if (performance.now() - layoutShiftAtRef.current >= LAYOUT_SETTLE_MS) frameSeenRef.current = entry.isIntersecting;
    }, { threshold: 0.3 });
    seen.observe(el);
    let timer = 0;
    let lastW = window.innerWidth;
    const onResize = () => {
      // 手机上地址栏伸缩也会触发 resize，只认宽度变化（旋转、改窗口宽度）
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      if (!frameSeenRef.current && !playingRef.current) return;
      layoutShiftAtRef.current = performance.now();
      window.clearTimeout(timer);
      // iOS 旋转后要过一会儿才给出最终尺寸：先挪一次，稍后再校正一次
      const recenter = () => {
        layoutShiftAtRef.current = performance.now();
        el.scrollIntoView({ block: 'center', behavior: 'auto' });
      };
      requestAnimationFrame(() => requestAnimationFrame(recenter));
      timer = window.setTimeout(recenter, 450);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      seen.disconnect();
      window.clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  // ── 影院模式：开播即熄灯，播完 / 滚走 / 点暗处 / Esc 亮灯 ──
  const wasPlayingRef = useRef(false);
  useEffect(() => {
    const was = wasPlayingRef.current;
    wasPlayingRef.current = playing;
    if (playing && !was) setTheater(true);
    if (!playing && was && time >= FILM_DURATION - 0.05) setTheater(false);
  }, [playing, time]);
  useEffect(() => {
    const el = frameRef.current;
    if (!el || !theater) return;
    // 片子挪到屏幕正中。要等影院模式的尺寸（按屏高收窄）生效之后再量，
    // 否则横屏手机上先按旧尺寸居中、随后片子变矮，顶上一截就跑出屏幕
    const raf = requestAnimationFrame(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting && performance.now() - layoutShiftAtRef.current >= LAYOUT_SETTLE_MS) setTheater(false);
    }, { threshold: 0.35 });
    io.observe(el);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setTheater(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('keydown', onKey);
    };
  }, [theater]);

  // ── 滚出视口 / 切走标签页：自动暂停，不在看不见的地方放歌 ──
  useEffect(() => {
    const el = frameRef.current;
    if (!el || !playing) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting && !document.fullscreenElement && performance.now() - layoutShiftAtRef.current >= LAYOUT_SETTLE_MS) pause();
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
      audioRef.current?.stop();
      void ctxRef.current?.close().catch(() => undefined);
    },
    [],
  );

  // iPhone 上的 Safari 只给 <video> 全屏，普通元素没有 requestFullscreen：按钮会点了没反应。
  // 不支持就不摆这颗按钮（手机上横屏看片走影院模式），也不响应 f 键（Codex P2，PR #1650）
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled === true;
  const toggleFullscreen = () => {
    const el = frameRef.current;
    if (!el || !canFullscreen) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen?.().catch(() => undefined);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // 焦点在片内的按钮上时，空格是那颗按钮自己的点击：交给浏览器，别在这里再切一次播放——
    // 否则播放键被切两次等于没按，静音键、全屏键按空格还会顺带暂停（Codex P2，PR #1650）
    if (e.key === ' ' && e.target !== e.currentTarget && (e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      seek(timeRef.current + 4);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seek(timeRef.current - 4);
    } else if (e.key === 'Home') {
      e.preventDefault();
      seek(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      seek(FILM_DURATION);
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

  // 标题里的秒数与眉标后的时钟都从时间轴算：换一段配乐片长就会变，写死在文案里必然对不上
  // （换成 29 小节的 Suno 原曲后片长是 57 秒，标题却还写着五十二秒——Codex P2，PR #1650）
  const headerTitle = film.title.replace('{duration}', String(Math.round(FILM_DURATION)));
  const headerEyebrow = `${film.eyebrow} · ${formatClock(FILM_DURATION)}`;
  const ended = started && !playing && time >= FILM_DURATION - 0.05;
  const shownTime = started ? time : POSTER_TIME;
  const state = !started ? 'poster' : loading ? 'loading' : playing ? 'playing' : ended ? 'ended' : 'paused';

  return (
    <section className="relative px-3 sm:px-6 py-20 lg:py-32" data-film-theater={theater ? 'on' : 'off'}
      style={{ zIndex: theater ? 61 : undefined }}
      // 这一节自己压在黑幕之上，片子上下那圈同样是「暗处」，点了也亮灯
      onClick={(e) => {
        if (theater && !frameRef.current?.contains(e.target as Node)) setTheater(false);
      }}
    >
      {typeof document !== 'undefined' &&
        createPortal(
          <div
            aria-hidden={!theater}
            onClick={() => setTheater(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 60,
              background: FILM.bg,
              opacity: theater ? 1 : 0,
              pointerEvents: theater ? 'auto' : 'none',
              transition: 'opacity .7s cubic-bezier(.4,0,.2,1)',
            }}
          />,
          document.body,
        )}
      <div className="max-w-[1280px] mx-auto">
        <div style={{ opacity: theater ? 0 : 1, transition: 'opacity .6s ease', pointerEvents: theater ? 'none' : undefined }}>
          <SectionHeader eyebrow={headerEyebrow} Icon={Clapperboard} title={headerTitle} subtitle={film.subtitle} accent={FILM.clay} />
        </div>

        <Reveal delay={200} offset={24} duration={2200}>
          <div
            ref={frameRef}
            tabIndex={0}
            role="region"
            aria-label={headerTitle}
            onKeyDown={onKey}
            data-film-state={state}
            data-film-time={time.toFixed(2)}
            data-film-audio={audioSource ?? 'idle'}
            className="group relative mt-14 mx-auto max-w-[1120px] outline-none"
            style={{
              // 影院模式按屏高收：手机横过来时片子正好占满一屏，不用再上下滚
              width: theater && !fullscreen ? `min(100%, calc((100svh - 24px) * ${STAGE_W} / ${STAGE_H}))` : undefined,
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
                    {loading ? film.controls.loading : ended ? film.controls.replay : started ? film.controls.play : `${film.controls.play} · ${formatClock(FILM_DURATION)}`}
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
                  // 声明了 slider 就得能被键盘聚焦；方向键 / Home / End 冒泡给播放区的 onKey 处理（Codex P2，PR #1650）
                  tabIndex={0}
                  aria-valuemin={0}
                  aria-valuemax={Math.round(FILM_DURATION)}
                  aria-valuenow={Math.round(time)}
                  aria-valuetext={formatClock(time)}
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
                <div className="mt-0.5 sm:mt-1 flex items-center gap-1.5 sm:gap-3 text-[11px] sm:text-[13px]" style={{ color: FILM.textDim, fontFamily: 'var(--font-body)', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em' }}>
                  <ControlButton label={playing ? film.controls.pause : film.controls.play} onClick={toggle}>
                    {playing ? <Pause className="w-4 h-4 sm:w-[18px] sm:h-[18px]" /> : ended ? <RotateCcw className="w-4 h-4 sm:w-[18px] sm:h-[18px]" /> : <Play className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />}
                  </ControlButton>
                  <span>
                    {formatClock(time)} / {formatClock(FILM_DURATION)}
                  </span>
                  {audioSource === 'none' && <span style={{ color: FILM.sand }}>{film.controls.noAudio}</span>}
                  {audioSource === 'synth' && <span style={{ color: FILM.sand }}>{film.controls.trackFallback}</span>}
                  <span className="flex-1" />
                  {audioSource !== 'none' && (
                    <ControlButton label={muted ? film.controls.unmute : film.controls.mute} onClick={toggleMute}>
                      {muted ? <VolumeX className="w-4 h-4 sm:w-[18px] sm:h-[18px]" /> : <Volume2 className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />}
                    </ControlButton>
                  )}
                  {canFullscreen && (
                    <ControlButton label={film.controls.fullscreen} onClick={toggleFullscreen}>
                      {fullscreen ? <Minimize2 className="w-4 h-4 sm:w-[18px] sm:h-[18px]" /> : <Maximize2 className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />}
                    </ControlButton>
                  )}
                </div>
              </div>
            )}
          </div>
        </Reveal>
        {/* 影院模式的一行小字：手机竖着拿时提示横屏，其它屏幕只说怎么回到页面 */}
        <div
          className="mt-4 flex items-center justify-center gap-2 text-[12px] sm:text-[13px]"
          style={{ color: FILM.gray, opacity: theater ? 1 : 0, transition: 'opacity .6s ease .3s', pointerEvents: 'none' }}
          aria-hidden={!theater}
        >
          <Smartphone size={14} className="film-rotate-hint" />
          <span className="film-rotate-hint">{film.controls.rotateHint}</span>
          <span className="film-rotate-hint" style={{ color: FILM.textFaint }}>·</span>
          <span>{film.controls.exitTheater}</span>
        </div>
        <style>{`.film-rotate-hint{display:none}@media (max-width:700px) and (orientation:portrait){.film-rotate-hint{display:inline}}`}</style>
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
