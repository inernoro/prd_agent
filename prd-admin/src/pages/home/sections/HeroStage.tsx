import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowRight, BookOpen, Image as ImageIcon, Play, Volume2 } from 'lucide-react';

import { useLanguage } from '../contexts/LanguageContext';
import { requestFilmPlay } from '../film/filmEvents';
import { FILM } from '../film/filmPalette';
import { HERO_LOOP_DURATION, HERO_LOOP_ENTRY, HERO_LOOP_START, HeroLoop, heroLoopBeat } from '../film/HeroLoop';
import { FILM_DURATION, formatClock } from '../film/filmTimeline';

/**
 * 首屏：满屏无字循环 + 压在上面的一句标题、一个输入框、一个「观看完整片花」。
 *
 * 结构借可灵首屏：背景就是作品本身；输入框里写着生成背后这幅画面的那句话（这一处最值钱）；
 * 声音交给用户开，所以循环本身是静音的，完整片花在下面那一节。
 *
 * 版式按屏幕分两套：
 *   · 宽屏：标题、输入框居中偏上，作品铺满、压在字后面；
 *   · 手机：标题在上、作品在正中、输入框贴底（拇指够得着），从上往下读是「标题 → 作品 → 那句话」。
 *
 * t 不传就自己播（看不见时暂停，系统开了「减少动态」就停在一帧）；传了就按传入的时刻画，
 * 逐帧导出样片时用这个。
 */
const AGENT_ICONS = [BookOpen, ImageIcon] as const;
const NAV_H = 72;

/**
 * 第一次进来时的入场：标题从失焦里聚出来，副标题与输入框跟半拍。
 * 与背景循环同一个时钟起点（第 0 秒），所以字聚好、那句话打完、按下去，星系正好炸开。
 * 只在自己播时挂上；导出样片与「减少动态」都不挂。
 */
const INTRO_CSS = `
@keyframes map-hero-focus {
  0% { opacity: 0; filter: blur(22px); transform: translateY(18px) scale(1.06); }
  60% { opacity: 1; }
  100% { opacity: 1; filter: blur(0); transform: none; }
}
@keyframes map-hero-rise {
  0% { opacity: 0; transform: translateY(14px); }
  100% { opacity: 1; transform: none; }
}
`;

/**
 * 手机上那句话要折成两行时，只许在词与词之间折（「把仓库的 doc/ 目录 / 同步进知识库」），
 * 不许把「知识库」拆成「知识 / 库」、更不许剩一个孤字挂在第二行（2026-09-30 用户截图）。
 * 做法：按词切分，在词的开头插零宽空格作为唯一的换行机会，再配 word-break: keep-all。
 * 返回逐字数组，方便「已打出的前 n 个字」与「还没打的部分」各自拼接。
 */
function phraseChars(text: string): string[] {
  const chars = Array.from(text);
  const Segmenter = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: 'word' }) => { segment: (s: string) => Iterable<{ index: number; segment: string }> } }).Segmenter;
  if (!Segmenter) return chars;
  // 单字词（「库」「会」「进」、标点）粘在前一个词上：词典会把「知识库」切成「知识 | 库」，
  // 照切出来的边界折行，最常见的结果恰好就是一个孤字落在第二行
  const starts = new Set<number>();
  for (const seg of new Segmenter('zh', { granularity: 'word' }).segment(text)) {
    if (Array.from(seg.segment).length > 1) starts.add(seg.index);
  }
  let offset = 0;
  return chars.map((c, i) => {
    const out = i > 0 && starts.has(offset) ? `\u200B${c}` : c;
    offset += c.length;
    return out;
  });
}

function introStyle(on: boolean, name: 'focus' | 'rise', delay: number, duration: number): CSSProperties | undefined {
  if (!on) return undefined;
  return { animation: `map-hero-${name} ${duration}s cubic-bezier(.16,1,.3,1) ${delay}s both` };
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/**
 * 首屏的配色：按钮、标题、强调色、星系四处。默认就是现行品牌色；
 * 传别的只为配色对比稿（scripts/film/heroSampleEntry.tsx），拍板后再决定默认值改不改。
 */
export interface HeroSkin {
  cta: string;
  ctaFg: string;
  /** 主标题的填充（渐变或纯色都行，走 background-clip:text） */
  title: string;
  /** 光标、按下时的光、进度点 */
  accent: string;
  /** 输入框里 Agent 小标签的图标色 */
  chipIcon: string;
  /** 两个镜头的进度点（当前那颗） */
  dot: string;
  galaxy?: { hub?: string; leaf?: string; core?: string };
}

export const HERO_SKIN_DEFAULT: HeroSkin = {
  cta: FILM.brandGradient,
  ctaFg: FILM.onBrand,
  title: FILM.titleGradient,
  accent: FILM.clay,
  chipIcon: FILM.sand,
  dot: FILM.sand,
};

export function HeroStage({ t: controlledT, onGetStarted, skin = HERO_SKIN_DEFAULT }: { t?: number; onGetStarted?: () => void; skin?: HeroSkin }) {
  const { t: copy } = useLanguage();
  const hero = copy.hero;
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const reduced = usePrefersReducedMotion();
  // 实时播放从第 0 秒起（看得到星系诞生）；开了「减少动态」就停在长好的那一帧
  const [liveT, setLiveT] = useState(HERO_LOOP_START);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 自己播：约 30 帧/秒（星系转得慢，60 帧是白烧 CPU），滚出视口或切走标签页就不走表
  useEffect(() => {
    if (controlledT !== undefined || reduced) return;
    const el = ref.current;
    let visible = true;
    const io = el ? new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.05 }) : null;
    if (el && io) io.observe(el);
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastPaint = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (visible && !document.hidden) {
        acc += dt;
        if (now - lastPaint > 32) {
          lastPaint = now;
          setLiveT((HERO_LOOP_START + acc) % HERO_LOOP_DURATION);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [controlledT, reduced]);

  const t = controlledT ?? (reduced ? HERO_LOOP_ENTRY : liveT);
  // 入场动画只在第一次自己播时跑：导出样片（受控 t）与「减少动态」都不跑
  const intro = controlledT === undefined && !reduced;
  const { w, h } = box;
  const compact = w > 0 && w < 700;
  const beat = heroLoopBeat(t, hero.loopPrompts);
  const Icon = AGENT_ICONS[beat.shot];
  const pressScale = 1 - 0.06 * Math.sin(Math.PI * beat.press);
  const caretOn = beat.typing && Math.floor(t * 2.2) % 2 === 0;
  // 手机上按整句排好两行再逐字显出来：没打到的字先占着位置（透明），打字过程中行不会跳
  const parts = compact ? phraseChars(hero.loopPrompts[beat.shot]) : null;
  const typedCount = Array.from(beat.shown).length;
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, compact ? 2 : 1.5);

  return (
    <div
      ref={ref}
      data-hero-shot={beat.shot}
      className="relative w-full overflow-hidden"
      style={{ height: '100svh', minHeight: compact ? 620 : 680, maxHeight: 1200, background: FILM.spaceEdge, color: FILM.text, fontFamily: 'var(--font-body)' }}
    >
      {intro && <style>{INTRO_CSS}</style>}
      {w > 0 && <HeroLoop t={t} w={w} h={h} compact={compact} dpr={controlledT === undefined ? dpr : undefined} tint={skin.galaxy} />}

      {/* 标题块：宽屏居中偏上，手机贴顶 */}
      <div
        className="absolute left-0 right-0 text-center"
        style={{ top: compact ? NAV_H + 28 : Math.max(NAV_H + 60, h * 0.25), padding: '0 20px' }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 10,
            fontSize: compact ? 11 : 13,
            letterSpacing: '0.22em',
            color: FILM.gray,
            marginBottom: compact ? 14 : 22,
            ...introStyle(intro, 'rise', 0.05, 0.9),
          }}
        >
          <span style={{ width: compact ? 18 : 28, height: 1, background: FILM.lineStrong }} />
          {hero.brand}
          <span style={{ width: compact ? 18 : 28, height: 1, background: FILM.lineStrong }} />
        </div>
        <div style={introStyle(intro, 'focus', 0.15, 1.5)}>
          <h1
            style={{
              margin: 0,
              fontFamily: 'var(--font-display)',
              fontSize: compact ? 'clamp(2.3rem, 11vw, 2.9rem)' : 'clamp(3.4rem, 5.6vw, 6.6rem)',
              fontWeight: 700,
              lineHeight: 1.04,
              letterSpacing: '-0.04em',
              background: skin.title,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
              filter: `drop-shadow(0 6px 40px ${FILM.spaceEdge})`,
            }}
          >
            {hero.title}
          </h1>
        </div>
        <p
          style={{
            margin: compact ? '14px auto 0' : '22px auto 0',
            maxWidth: compact ? 300 : 640,
            textWrap: 'balance',
            fontSize: compact ? 14 : 'clamp(1rem, 1.25vw, 1.35rem)',
            lineHeight: 1.6,
            color: FILM.textDim,
            textShadow: `0 2px 18px ${FILM.spaceEdge}`,
            ...introStyle(intro, 'rise', 0.7, 1.0),
          }}
        >
          {hero.tagline}
        </p>
      </div>

      {/* 输入框：写着背后这幅画面的那句话。宽屏跟在标题下，手机贴底 */}
      <div
        className="absolute left-1/2"
        style={{
          transform: 'translateX(-50%)',
          width: compact ? w - 32 : Math.min(880, w - 80),
          ...(compact ? { bottom: 92 } : { top: Math.max(NAV_H + 60, h * 0.25) + (w > 1400 ? 250 : 220) }),
        }}
      >
        <div style={introStyle(intro, 'rise', 0.0, 0.6)}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: compact ? 8 : 14,
              minHeight: compact ? 58 : 74,
              padding: compact ? '6px 6px 6px 8px' : '0 8px 0 10px',
              borderRadius: compact ? 22 : 999,
              background: `${FILM.panel}C7`,
              border: `1px solid ${FILM.lineStrong}`,
              boxShadow: `${FILM.shadow}, inset 0 1px 0 ${FILM.line}`,
              backdropFilter: 'blur(18px) saturate(140%)',
              WebkitBackdropFilter: 'blur(18px) saturate(140%)',
            }}
          >
            <span
              className="shrink-0 inline-flex items-center"
              style={{ gap: 6, padding: compact ? '6px 10px' : '9px 15px', borderRadius: 999, background: FILM.panelRaised, fontSize: compact ? 12 : 14, color: FILM.text, whiteSpace: 'nowrap' }}
            >
              <Icon size={compact ? 13 : 16} color={skin.chipIcon} />
              {hero.loopAgents[beat.shot]}
            </span>
            <span
              className="flex-1 min-w-0"
              style={{
                fontSize: compact ? 14 : 19,
                lineHeight: 1.4,
                color: FILM.text,
                whiteSpace: compact ? 'normal' : 'nowrap',
                wordBreak: compact ? 'keep-all' : undefined,
                // 两行尽量等长：否则浏览器会先把第一行塞满，第二行只剩「知识库」三个字
                textWrap: compact ? 'balance' : undefined,
                overflowWrap: compact ? 'anywhere' : undefined,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {parts ? parts.slice(0, typedCount).join('') : beat.shown}
              {/* 光标不占宽度，免得它自己挤出一个换行点 */}
              <span aria-hidden style={{ position: 'relative', display: 'inline-block', width: 0, height: '1em', verticalAlign: 'middle' }}>
                <span
                  style={{ position: 'absolute', left: 2, top: '50%', width: 2, height: compact ? 15 : 20, transform: 'translateY(-50%)', background: skin.accent, opacity: caretOn ? 1 : 0 }}
                />
              </span>
              {parts && beat.shown && (
                <span aria-hidden style={{ color: 'transparent' }}>
                  {parts.slice(typedCount).join('')}
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={onGetStarted}
              className="shrink-0 inline-flex items-center transition-transform duration-200 hover:scale-[1.03] active:scale-[0.98]"
              style={{
                gap: 8,
                padding: compact ? '11px 14px' : '14px 26px',
                borderRadius: 999,
                background: skin.cta,
                color: skin.ctaFg,
                fontSize: compact ? 13 : 16,
                fontWeight: 700,
                fontFamily: 'var(--font-display)',
                whiteSpace: 'nowrap',
                transform: `scale(${pressScale})`,
                boxShadow: beat.press > 0 && beat.press < 1 ? `0 0 30px ${skin.accent}` : `0 8px 26px ${FILM.spaceEdge}`,
              }}
            >
              {hero.primaryCta}
              {!compact && <ArrowRight size={16} />}
            </button>
          </div>
          {/* 两个镜头的进度：哪一句正在「生成」背后的画面 */}
          <div className="flex justify-center" style={{ gap: 6, marginTop: compact ? 10 : 16 }}>
            {[0, 1].map((i) => (
              <span
                key={i}
                style={{
                  width: beat.shot === i ? 18 : 6,
                  height: 4,
                  borderRadius: 2,
                  background: beat.shot === i ? skin.dot : FILM.lineStrong,
                  transition: 'width .4s ease, background .4s ease',
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* 右下角：完整片花，声音由用户决定 */}
      <button
        type="button"
        onClick={requestFilmPlay}
        className="absolute inline-flex items-center transition-transform duration-200 hover:scale-[1.03]"
        style={{
          // 手机上居中（底部已经有输入框，右下角再挂一颗会显得歪）
          ...(compact ? { left: '50%', translate: '-50% 0' } : { right: 36 }),
          bottom: compact ? 24 : 32,
          gap: 10,
          padding: compact ? '7px 14px 7px 7px' : '9px 20px 9px 9px',
          borderRadius: 999,
          background: `${FILM.panel}B3`,
          border: `1px solid ${FILM.lineStrong}`,
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          fontSize: compact ? 12 : 14,
          color: FILM.text,
        }}
      >
        <span className="grid place-items-center rounded-full" style={{ width: compact ? 26 : 32, height: compact ? 26 : 32, background: FILM.text, color: FILM.bg }}>
          <Play size={compact ? 12 : 14} style={{ marginLeft: 2 }} />
        </span>
        {hero.watchFilm} · {formatClock(FILM_DURATION)}
        <Volume2 size={compact ? 13 : 15} color={FILM.textDim} />
      </button>
    </div>
  );
}
