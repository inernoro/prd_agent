import type { CSSProperties, ReactNode } from 'react';
import { BarChart3, Check, Clock, FileText, GitBranch, Search, Send, Sparkles, Terminal } from 'lucide-react';

import type { FilmTranslation, RosterItem } from '../i18n/landing';
import { toolboxIconPath } from '../scenes/ToolboxScene';
import { ACCENT_CYCLE, FILM, MONTAGE_COLORS, POSTER_ART } from './filmPalette';
import { SCORE_CUES } from './filmScore';
import {
  BAR,
  BEAT,
  FILM_DURATION,
  FILM_SCENES,
  FINALE_CTA_AT,
  beatPulse,
  easeInOutCubic,
  easeOutBack,
  easeOutCubic,
  formatClock,
  lerp,
  sceneAt,
  sceneStart,
  seeded,
  span,
  typed,
  type FilmScene,
  type FilmSceneId,
} from './filmTimeline';

/**
 * 片花的银幕。输入只有一个时间 t（秒），输出这一刻的整幅画面。
 *
 * 画布固定 1920×1080 的逻辑坐标，外层按容器宽度等比缩放（FilmViewport）。
 * 所有元素都绝对定位在这一套坐标里——演示指针与它要按的按钮共用同一组常量
 * （见 SEND_BUTTON），不存在「两套坐标系差一个侧栏宽」的漂移
 * （`demo-causality-contract` 契约 3 的形状在这里退化成一张常量表）。
 *
 * 因果契约：片子里只有两处「人的动作」——在输入框里打字（指针停在输入框上，
 * 不按下去），以及按发送键（先走到、再按下、然后请求才发出去）。其余幕是系统
 * 在干活（生成、流转、切换、部署），不配手。
 */

export const STAGE_W = 1920;
export const STAGE_H = 1080;

const FONT_DISPLAY = 'var(--font-display)';
const FONT_BODY = 'var(--font-body)';
const FONT_MONO = 'var(--font-terminal)';

interface StageProps {
  t: number;
  copy: FilmTranslation;
  roster: RosterItem[];
  /** 海报态关掉片内计时条：停着的画面上挂一个「0:47 / 0:52」只会让人以为卡住了 */
  hud?: boolean;
}

export function FilmStage({ t, copy, roster, hud = true }: StageProps) {
  const scene = sceneAt(t);
  const lt = t - scene.from;
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        width: STAGE_W,
        height: STAGE_H,
        overflow: 'hidden',
        background: FILM.bg,
        color: FILM.text,
        fontFamily: FONT_BODY,
      }}
    >
      <div style={{ ...fill, background: FILM.ambient }} />
      <SceneSwitch scene={scene} lt={lt} t={t} copy={copy} roster={roster} />
      <Caption t={t} copy={copy} />
      {hud && <Hud t={t} />}
      <CutFlash t={t} />
      <div style={{ ...fill, background: FILM.vignette, pointerEvents: 'none' }} />
      <Grain t={t} />
    </div>
  );
}

const fill: CSSProperties = { position: 'absolute', inset: 0 };

function SceneSwitch({ scene, lt, t, copy, roster }: { scene: FilmScene; lt: number; t: number; copy: FilmTranslation; roster: RosterItem[] }) {
  const d = scene.to - scene.from;
  switch (scene.id) {
    case 'open':
      return <OpenScene lt={lt} d={d} copy={copy} />;
    case 'visual':
      return <VisualScene lt={lt} d={d} t={t} copy={copy} />;
    case 'writing':
      return <WritingScene lt={lt} d={d} copy={copy} />;
    case 'toolbox':
      return <ToolboxFilmScene lt={lt} d={d} copy={copy} roster={roster} />;
    case 'workflow':
      return <WorkflowFilmScene lt={lt} d={d} copy={copy} />;
    case 'models':
      return <ModelsFilmScene lt={lt} d={d} t={t} copy={copy} />;
    case 'cds':
      return <CdsFilmScene lt={lt} d={d} t={t} copy={copy} />;
    case 'montage':
      return <MontageScene lt={lt} copy={copy} />;
    case 'finale':
      return <FinaleScene lt={lt} d={d} t={t} copy={copy} />;
  }
}

// ═══════════════════════ 全片叠加层 ═══════════════════════

/** 切镜闪白：落在鼓点上的那几刀，强拍（CDS 落地、收口）更亮。 */
const STRONG_CUTS: FilmSceneId[] = ['cds', 'finale'];
function CutFlash({ t }: { t: number }) {
  let alpha = 0;
  for (const s of FILM_SCENES) {
    if (s.id === 'open' || s.id === 'visual') continue;
    const dt = t - s.from;
    if (dt < 0 || dt > 0.4) continue;
    const peak = STRONG_CUTS.includes(s.id) ? 0.55 : 0.14;
    alpha = Math.max(alpha, peak * Math.exp(-dt * 11));
  }
  if (alpha < 0.005) return null;
  return <div style={{ ...fill, background: FILM.flash, opacity: alpha, mixBlendMode: 'screen' }} />;
}

function Grain({ t }: { t: number }) {
  const frame = Math.floor(t * 24);
  const r = seeded(frame + 1);
  return (
    <div
      style={{
        ...fill,
        backgroundImage: 'url(/textures/noise.png)',
        backgroundPosition: `${Math.floor(r() * 256)}px ${Math.floor(r() * 256)}px`,
        opacity: 0.07,
        mixBlendMode: 'overlay',
        pointerEvents: 'none',
      }}
    />
  );
}

function Hud({ t }: { t: number }) {
  const visible = 1 - span(t, FILM_DURATION - 1.6, FILM_DURATION - 0.6);
  return (
    <div
      style={{
        position: 'absolute',
        left: 56,
        right: 56,
        top: 30,
        display: 'flex',
        justifyContent: 'space-between',
        fontFamily: FONT_MONO,
        fontSize: 22,
        letterSpacing: '0.2em',
        color: FILM.textFaint,
        opacity: visible,
      }}
    >
      <span>MAP / FILM</span>
      <span>
        {formatClock(t)} / {formatClock(FILM_DURATION)}
      </span>
    </div>
  );
}

const CHAPTER_SCENES: FilmSceneId[] = ['visual', 'writing', 'toolbox', 'workflow', 'models', 'cds'];

/** 下三分之一字幕：章节号 + 标题 + 一句话。 */
function Caption({ t, copy }: { t: number; copy: FilmTranslation }) {
  const scene = sceneAt(t);
  const idx = CHAPTER_SCENES.indexOf(scene.id);
  if (idx < 0) return null;
  const chapter = copy.chapters[idx];
  if (!chapter) return null;
  const inP = easeOutCubic(span(t, scene.from + 0.2, scene.from + 0.75));
  const out = span(t, scene.to - 0.25, scene.to);
  const alpha = inP * (1 - out);
  return (
    <div
      style={{
        position: 'absolute',
        left: 140,
        top: 936,
        display: 'flex',
        alignItems: 'baseline',
        gap: 26,
        opacity: alpha,
        transform: `translateX(${lerp(-24, 0, inP)}px)`,
      }}
    >
      <span style={{ fontFamily: FONT_MONO, fontSize: 30, color: FILM.clay, letterSpacing: '0.12em' }}>
        {String(idx + 1).padStart(2, '0')}
      </span>
      <span
        style={{
          display: 'block',
          width: lerp(0, 64, inP),
          height: 2,
          background: FILM.clay,
          alignSelf: 'center',
        }}
      />
      <span style={{ fontFamily: FONT_DISPLAY, fontSize: 40, fontWeight: 600, letterSpacing: '-0.01em' }}>
        {chapter.title}
      </span>
      <span style={{ fontSize: 30, color: FILM.textDim }}>{chapter.line}</span>
    </div>
  );
}

// ═══════════════════════ 公共小件 ═══════════════════════

/** 一个应用窗口的外壳：标题栏三点 + 标题。 */
function Window({
  x,
  y,
  w,
  h,
  title,
  alpha = 1,
  lift = 0,
  children,
  glow,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  alpha?: number;
  lift?: number;
  children: ReactNode;
  glow?: string;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: 22,
        background: FILM.panel,
        border: `1px solid ${glow ?? FILM.lineStrong}`,
        boxShadow: glow ? `${FILM.shadow}, 0 0 60px ${glow}55` : FILM.shadow,
        opacity: alpha,
        transform: `translateY(${lift}px)`,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: 50,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '0 22px',
          borderBottom: `1px solid ${FILM.line}`,
          background: FILM.panelRaised,
        }}
      >
        {[FILM.danger, FILM.sand, FILM.pine].map((c) => (
          <span key={c} style={{ width: 13, height: 13, borderRadius: 7, background: c, opacity: 0.85 }} />
        ))}
        <span style={{ marginLeft: 14, fontSize: 20, color: FILM.textDim, fontFamily: FONT_DISPLAY }}>{title}</span>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 50, bottom: 0 }}>{children}</div>
    </div>
  );
}

/** 演示指针：箭头 + 按下时的一圈涟漪。press ∈ [0,1] 是这次按下手势走到了几成。 */
function FilmCursor({ x, y, alpha, press }: { x: number; y: number; alpha: number; press: number }) {
  if (alpha <= 0.01) return null;
  const pressing = press > 0 && press < 1;
  const squash = pressing ? 1 - Math.sin(press * Math.PI) * 0.14 : 1;
  return (
    <div style={{ position: 'absolute', left: x, top: y, opacity: alpha, pointerEvents: 'none' }} data-film-press={pressing ? 'down' : 'up'}>
      {pressing && (
        <span
          style={{
            position: 'absolute',
            left: -34,
            top: -34,
            width: 68,
            height: 68,
            borderRadius: 34,
            border: `3px solid ${FILM.clay}`,
            transform: `scale(${lerp(0.3, 1.5, press)})`,
            opacity: 1 - press,
          }}
        />
      )}
      <svg width={40} height={40} viewBox="0 0 24 24" style={{ transform: `scale(${squash})`, transformOrigin: '4px 3px', filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.5))' }}>
        <path d="M4 3l15 7-6.5 2L10 19z" fill={FILM.text} stroke={FILM.bg} strokeWidth={1.4} strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Caret({ t, color = FILM.clay, height = 34 }: { t: number; color?: string; height?: number }) {
  const on = Math.floor(t * 2.4) % 2 === 0;
  return <span style={{ display: 'inline-block', width: 3, height, marginLeft: 4, background: color, opacity: on ? 1 : 0, verticalAlign: 'middle' }} />;
}

/** 一张生成海报。develop ∈ [0,1]：0 是还没显影，1 是清晰落定。 */
function PosterArt({ variant, develop, drift, label }: { variant: number; develop: number; drift: number; label?: ReactNode }) {
  const art = POSTER_ART[variant % POSTER_ART.length];
  const blur = lerp(26, 0, easeOutCubic(develop));
  const scale = lerp(1.12, 1, easeOutCubic(develop)) * (1 + drift * 0.05);
  return (
    <div style={{ ...fill, overflow: 'hidden', borderRadius: 16 }}>
      <div style={{ ...fill, transform: `scale(${scale})`, filter: `blur(${blur}px) saturate(${lerp(0.4, 1, develop)})` }}>
        <div style={{ ...fill, background: art.sky }} />
        {variant === 0 && (
          <>
            <div style={{ position: 'absolute', left: '28%', top: '32%', width: '44%', aspectRatio: '1', background: art.sun, transform: `translateY(${drift * 14}px)` }} />
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '40%', background: art.hills, clipPath: 'polygon(0 45%, 18% 20%, 34% 50%, 52% 12%, 70% 44%, 86% 26%, 100% 40%, 100% 100%, 0 100%)' }} />
            <div style={{ position: 'absolute', left: '8%', top: '8%', fontFamily: FONT_DISPLAY, fontSize: 30, fontWeight: 700, color: art.accent, letterSpacing: '0.3em' }}>LAUNCH</div>
            <div style={{ position: 'absolute', left: '8%', top: 'calc(8% + 42px)', fontFamily: FONT_MONO, fontSize: 18, color: art.accent, letterSpacing: '0.2em', opacity: 0.8 }}>2026 · 10 · 01</div>
          </>
        )}
        {variant === 1 && (
          <>
            <div style={{ position: 'absolute', left: '18%', top: '10%', width: '64%', aspectRatio: '1', background: art.sun, transform: `rotate(${drift * 30}deg)` }} />
            <div style={{ position: 'absolute', left: '-10%', right: '-10%', bottom: '-6%', height: '38%', background: art.hills, transform: 'rotate(-12deg)', transformOrigin: 'left bottom' }} />
            <div style={{ position: 'absolute', right: '8%', top: '8%', fontFamily: FONT_DISPLAY, fontSize: 44, fontWeight: 800, color: art.accent, lineHeight: 0.9, textAlign: 'right' }}>
              NEW
              <br />
              FORM
            </div>
          </>
        )}
        {variant === 2 && (
          <>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: '-5%',
                  right: '-5%',
                  bottom: `${-4 + i * 12}%`,
                  height: `${46 - i * 8}%`,
                  background: art.hills,
                  opacity: 0.35 + i * 0.25,
                  filter: `blur(${(2 - i) * 1.5}px)`,
                  clipPath: i === 0 ? 'polygon(0 60%, 20% 30%, 40% 55%, 62% 18%, 82% 50%, 100% 32%, 100% 100%, 0 100%)' : i === 1 ? 'polygon(0 50%, 26% 22%, 48% 60%, 70% 28%, 100% 58%, 100% 100%, 0 100%)' : 'polygon(0 70%, 30% 40%, 58% 72%, 80% 44%, 100% 66%, 100% 100%, 0 100%)',
                  transform: `translateX(${drift * (i + 1) * -8}px)`,
                }}
              />
            ))}
            <div style={{ position: 'absolute', right: '12%', top: '14%', width: '14%', aspectRatio: '1', background: art.sun }} />
            <div style={{ position: 'absolute', left: '10%', top: '10%', width: 30, height: 30, background: art.accent, borderRadius: 3 }} />
          </>
        )}
        {variant === 3 && (
          <>
            <div style={{ position: 'absolute', right: '14%', top: '10%', width: '22%', aspectRatio: '1', background: art.sun }} />
            {Array.from({ length: 9 }, (_, i) => {
              const r = seeded(40 + i);
              const h = 30 + r() * 42;
              return (
                <div key={i} style={{ position: 'absolute', bottom: 0, left: `${i * 11.5}%`, width: '10%', height: `${h}%`, background: art.hills, borderTop: `2px solid ${art.accent}55` }}>
                  {Array.from({ length: 6 }, (_, j) => (
                    <span key={j} style={{ position: 'absolute', left: '25%', top: `${12 + j * 14}%`, width: '50%', height: 4, background: art.accent, opacity: r() > 0.45 ? 0.75 : 0.12 }} />
                  ))}
                </div>
              );
            })}
          </>
        )}
      </div>
      {develop < 1 && <div style={{ ...fill, background: FILM.hatch, opacity: 1 - develop }} />}
      {label && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '28px 16px 12px', background: FILM.scrim, fontSize: 17, color: FILM.text, display: 'flex', justifyContent: 'space-between' }}>
          {label}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════ 第一幕 · 开场 ═══════════════════════

function OpenScene({ lt, d, copy }: { lt: number; d: number; copy: FilmTranslation }) {
  const splash = SCORE_CUES.splash;
  const fall = span(lt, 0.15, splash);
  const dropY = lerp(-60, 540, fall * fall);
  const after = lt - splash;
  const bloom = easeOutCubic(span(lt, splash, 5.2));
  // 收尾：墨团放大穿过镜头，接到下一幕
  const zoom = easeInOutCubic(span(lt, d - 1.6, d));
  const textOut = span(lt, d - 1.8, d - 0.8);

  const [line1, line2] = copy.open;
  const cps1 = Math.max(9, Array.from(line1).length / 0.9);
  const cps2 = Math.max(9, Array.from(line2).length / 1.1);
  const shown1 = typed(line1, lt, 2.0, cps1);
  const shown2 = typed(line2, lt, 3.4, cps2);

  const particles = Array.from({ length: 26 }, (_, i) => {
    const r = seeded(300 + i);
    const ang = -Math.PI * (0.08 + r() * 0.84);
    const speed = 380 + r() * 520;
    const tt = Math.max(0, after);
    return {
      x: 960 + Math.cos(ang) * speed * tt,
      y: 540 + Math.sin(ang) * speed * tt + 900 * tt * tt,
      size: 4 + r() * 9,
      alpha: after > 0 ? Math.max(0, 1 - tt / 1.1) : 0,
      color: ACCENT_CYCLE[i % 3],
    };
  });

  return (
    <div style={fill}>
      {/* 墨团：三支色在水里慢慢化开 */}
      <div style={{ ...fill, transform: `scale(${1 + zoom * 3.2})`, opacity: 1 - zoom * 0.7 }}>
        {[
          { c: FILM.clay, dx: -120, dy: -40, s: 820 },
          { c: FILM.steel, dx: 170, dy: 60, s: 700 },
          { c: FILM.pine, dx: 30, dy: 150, s: 520 },
        ].map((b, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 960 + b.dx * bloom - (b.s * bloom) / 2,
              top: 540 + b.dy * bloom - (b.s * bloom) / 2,
              width: b.s * bloom,
              height: b.s * bloom,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${b.c}66 0%, ${b.c}22 45%, transparent 70%)`,
              filter: 'blur(30px)',
              opacity: bloom > 0 ? 0.9 : 0,
            }}
          />
        ))}
      </div>

      {/* 水面涟漪 */}
      {after > 0 &&
        [0, 1, 2].map((i) => {
          const p = span(after, i * 0.2, i * 0.2 + 1.6);
          if (p <= 0 || p >= 1) return null;
          const r = easeOutCubic(p) * (560 - i * 90);
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: 960 - r,
                top: 540 - r * 0.32,
                width: r * 2,
                height: r * 0.64,
                borderRadius: '50%',
                border: `2px solid ${FILM.clay}`,
                opacity: (1 - p) * 0.8,
              }}
            />
          );
        })}

      {/* 飞溅 */}
      {particles.map((p, i) =>
        p.alpha > 0 ? (
          <span
            key={i}
            style={{ position: 'absolute', left: p.x, top: p.y, width: p.size, height: p.size, borderRadius: '50%', background: p.color, opacity: p.alpha }}
          />
        ) : null,
      )}

      {/* 墨滴 */}
      {fall < 1 && lt > 0.15 && (
        <div
          style={{
            position: 'absolute',
            left: 960 - 14,
            top: dropY - 14,
            width: 28,
            height: 28 + fall * 26,
            borderRadius: '50% 50% 50% 50% / 60% 60% 40% 40%',
            background: FILM.clay,
            boxShadow: `0 0 40px ${FILM.clay}`,
          }}
        />
      )}

      {/* 两行字 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 380,
          textAlign: 'center',
          fontFamily: FONT_DISPLAY,
          opacity: 1 - textOut,
          filter: `blur(${textOut * 14}px)`,
          transform: `translateY(${-textOut * 40}px)`,
        }}
      >
        <div style={{ fontSize: 108, fontWeight: 600, letterSpacing: '-0.03em', minHeight: 132 }}>
          {shown1}
          {lt >= 2.0 && lt < 3.4 && <Caret t={lt} height={90} />}
        </div>
        <div
          style={{
            marginTop: 18,
            fontSize: 108,
            fontWeight: 600,
            letterSpacing: '-0.03em',
            minHeight: 132,
            background: FILM.brandGradient,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}
        >
          {shown2}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════ 第二幕 · 视觉创作 ═══════════════════════

const VISUAL_WIN = { x: 140, y: 80, w: 1640, h: 820 };
/** 输入框与发送键：指针落点与按钮本体共用这组常量。 */
const INPUT_BOX = { x: 24, y: 660, w: 420, h: 96 };
const SEND_BUTTON = { x: INPUT_BOX.x + INPUT_BOX.w - 64, y: INPUT_BOX.y + 24, size: 48 };
const TILE = { w: 470, h: 330, gap: 32, left: 520, top: 58 };

function VisualScene({ lt, d, t, copy }: { lt: number; d: number; t: number; copy: FilmTranslation }) {
  const from = sceneStart('visual');
  const enter = easeOutCubic(span(lt, 0, 0.7));
  const exit = span(lt, d - 0.3, d);
  const press = SCORE_CUES.sendPress - from;
  const typeStart = 1.0;
  const promptChars = Array.from(copy.visual.prompt).length;
  const cps = promptChars / 2.3;
  const shownPrompt = lt < press ? typed(copy.visual.prompt, lt, typeStart, cps) : '';
  const sent = lt >= press + 0.05;

  // 指针：进场停到输入框（打字时停着不按）→ 走到发送键 → 按下 → 离开
  const inputAim = { x: VISUAL_WIN.x + INPUT_BOX.x + 120, y: VISUAL_WIN.y + 50 + INPUT_BOX.y + 58 };
  const sendAim = { x: VISUAL_WIN.x + SEND_BUTTON.x + SEND_BUTTON.size / 2 - 4, y: VISUAL_WIN.y + 50 + SEND_BUTTON.y + SEND_BUTTON.size / 2 - 3 };
  const restAim = { x: 1380, y: 620 };
  const toInput = easeInOutCubic(span(lt, 0.5, 0.95));
  const toSend = easeInOutCubic(span(lt, press - 0.6, press - 0.12));
  const away = easeInOutCubic(span(lt, press + 0.5, press + 1.4));
  const cx = lerp(lerp(lerp(1500, inputAim.x, toInput), sendAim.x, toSend), restAim.x, away);
  const cy = lerp(lerp(lerp(980, inputAim.y, toInput), sendAim.y, toSend), restAim.y, away);
  const cursorAlpha = span(lt, 0.4, 0.7) * (1 - span(lt, press + 2.2, press + 2.8));
  const pressP = span(lt, press, press + 0.26);

  const tiles = [0, 1, 2, 3].map((i) => {
    const dev = SCORE_CUES.tilesDevelop[i] - from;
    return {
      working: lt >= press + 0.2,
      develop: span(lt, dev, dev + 0.7),
      drift: Math.max(0, lt - dev) / 4,
    };
  });

  return (
    <div style={{ ...fill, opacity: 1 - exit }}>
      <Window {...VISUAL_WIN} title={`${copy.chapters[0]?.title ?? ''} · Canvas`} alpha={enter} lift={lerp(40, 0, enter)}>
        {/* 左：对话列 */}
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 468, borderRight: `1px solid ${FILM.line}`, background: FILM.panelInset }}>
          {sent && (
            <div
              style={{
                position: 'absolute',
                right: 24,
                top: 40,
                maxWidth: 380,
                padding: '16px 20px',
                borderRadius: '18px 18px 4px 18px',
                background: FILM.clay,
                color: FILM.onBrand,
                fontSize: 22,
                lineHeight: 1.45,
                opacity: easeOutCubic(span(lt, press + 0.05, press + 0.35)),
                transform: `translateY(${lerp(16, 0, easeOutCubic(span(lt, press + 0.05, press + 0.35)))}px)`,
              }}
            >
              {copy.visual.prompt}
            </div>
          )}
          {lt >= press + 0.4 && (
            <div style={{ position: 'absolute', left: 24, top: 190, display: 'flex', alignItems: 'center', gap: 12, fontSize: 20, color: FILM.textDim, opacity: easeOutCubic(span(lt, press + 0.4, press + 0.7)) }}>
              <Sparkles size={22} color={FILM.sand} style={{ transform: `rotate(${lt * 90}deg)` }} />
              <span>
                {tiles.filter((x) => x.develop >= 1).length} / 4 · {tiles.every((x) => x.develop >= 1) ? copy.visual.tileDone : copy.visual.tileWorking}
              </span>
            </div>
          )}
          {/* 输入框 */}
          <div
            style={{
              position: 'absolute',
              left: INPUT_BOX.x,
              top: INPUT_BOX.y,
              width: INPUT_BOX.w,
              height: INPUT_BOX.h,
              borderRadius: 18,
              background: FILM.panelRaised,
              border: `1.5px solid ${lt > 0.9 && lt < press ? FILM.clay : FILM.lineStrong}`,
              padding: '16px 80px 16px 20px',
              fontSize: 21,
              lineHeight: 1.4,
              color: FILM.text,
            }}
          >
            {shownPrompt}
            {lt > 0.9 && lt < press && <Caret t={lt} height={24} />}
            <div
              style={{
                position: 'absolute',
                left: SEND_BUTTON.x - INPUT_BOX.x,
                top: SEND_BUTTON.y - INPUT_BOX.y,
                width: SEND_BUTTON.size,
                height: SEND_BUTTON.size,
                borderRadius: SEND_BUTTON.size / 2,
                background: FILM.brandGradient,
                display: 'grid',
                placeItems: 'center',
                transform: `scale(${pressP > 0 && pressP < 1 ? 1 - Math.sin(pressP * Math.PI) * 0.12 : 1})`,
                boxShadow: shownPrompt.length > 0 ? `0 0 24px ${FILM.clay}88` : 'none',
              }}
              aria-label={copy.visual.send}
            >
              <Send size={22} style={{ color: FILM.onBrand }} />
            </div>
          </div>
        </div>

        {/* 右：画布 */}
        <div style={{ position: 'absolute', left: 468, right: 0, top: 0, bottom: 0, backgroundImage: FILM.dots, backgroundSize: '28px 28px' }}>
          {tiles.map((tile, i) => {
            const col = i % 2;
            const row = Math.floor(i / 2);
            const x = TILE.left - 468 + col * (TILE.w + TILE.gap) + 60;
            const y = TILE.top + row * (TILE.h + TILE.gap) + 20;
            const pop = easeOutBack(span(tile.develop, 0, 0.6));
            return (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: x,
                  top: y,
                  width: TILE.w,
                  height: TILE.h,
                  borderRadius: 16,
                  border: tile.develop > 0 ? `1px solid ${FILM.lineStrong}` : `2px dashed ${FILM.lineStrong}`,
                  background: FILM.panelInset,
                  transform: `scale(${tile.develop > 0 ? lerp(0.94, 1, pop) : 1})`,
                  boxShadow: tile.develop >= 1 ? '0 20px 50px rgba(0,0,0,0.45)' : 'none',
                  overflow: 'hidden',
                }}
              >
                {tile.working && tile.develop <= 0 && (
                  <div style={{ ...fill, background: FILM.shimmer, backgroundSize: '220% 100%', backgroundPosition: `${(1 - ((t * 0.9 + i * 0.2) % 1)) * 220}% 0` }} />
                )}
                {tile.develop > 0 && (
                  <PosterArt
                    variant={i}
                    develop={tile.develop}
                    drift={tile.drift}
                    label={
                      <>
                        <span style={{ fontFamily: FONT_MONO }}>1024 × 1536</span>
                        <span style={{ color: tile.develop >= 1 ? FILM.pine : FILM.sand }}>
                          {tile.develop >= 1 ? copy.visual.tileDone : copy.visual.tileWorking}
                        </span>
                      </>
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
      </Window>
      <FilmCursor x={cx} y={cy} alpha={cursorAlpha * enter} press={pressP} />
    </div>
  );
}

// ═══════════════════════ 第三幕 · 文学与知识库 ═══════════════════════

const GRAPH_NODES = [
  { x: 360, y: 210 },
  { x: 190, y: 400 },
  { x: 520, y: 420 },
  { x: 330, y: 590 },
  { x: 600, y: 230 },
  { x: 120, y: 190 },
  { x: 560, y: 610 },
];
const GRAPH_EDGES: Array<[number, number]> = [[0, 1], [0, 2], [1, 3], [2, 3], [0, 4], [1, 5], [2, 6], [4, 2]];

function WritingScene({ lt, d, copy }: { lt: number; d: number; copy: FilmTranslation }) {
  const enter = easeOutCubic(span(lt, 0, 0.5));
  const exit = span(lt, d - 0.25, d);
  const paras = copy.writing.paragraphs;
  const totalChars = paras.reduce((n, p) => n + Array.from(p).length, 0);
  const cps = totalChars / 2.6;
  let budget = Math.max(0, (lt - 0.35) * cps);
  const shown = paras.map((p) => {
    const chars = Array.from(p);
    const n = Math.min(chars.length, Math.floor(budget));
    budget -= n;
    return chars.slice(0, n).join('');
  });
  const illo = span(lt, 1.2, 1.9);
  const mark = easeInOutCubic(span(lt, 2.6, 3.1));

  return (
    <div style={{ ...fill, opacity: 1 - exit }}>
      <Window x={140} y={80} w={960} h={820} title={copy.writing.docTitle} alpha={enter} lift={lerp(30, 0, enter)}>
        <div style={{ padding: '44px 64px', fontSize: 25, lineHeight: 1.85, color: FILM.textDim }}>
          <div style={{ fontFamily: FONT_DISPLAY, fontSize: 42, color: FILM.text, fontWeight: 600, marginBottom: 24 }}>{copy.writing.docTitle}</div>
          <p style={{ margin: 0 }}>{shown[0]}</p>
          <div style={{ position: 'relative', height: 190, margin: '18px 0', borderRadius: 16, overflow: 'hidden', opacity: illo > 0 ? 1 : 0.4, border: `1px solid ${FILM.line}` }}>
            {illo > 0 ? <PosterArt variant={2} develop={illo} drift={Math.max(0, lt - 1.9) / 3} /> : <div style={{ ...fill, background: FILM.hatch }} />}
          </div>
          <p style={{ margin: 0 }}>
            {(() => {
              const s = shown[1];
              const cut = Math.min(s.length, 12);
              return (
                <>
                  <span
                    style={{
                      color: mark > 0 ? FILM.text : undefined,
                      backgroundImage: `linear-gradient(${FILM.clay}55, ${FILM.clay}55)`,
                      backgroundSize: `${mark * 100}% 100%`,
                      backgroundRepeat: 'no-repeat',
                    }}
                  >
                    {s.slice(0, cut)}
                  </span>
                  {s.slice(cut)}
                </>
              );
            })()}
          </p>
          <p style={{ margin: '14px 0 0' }}>{shown[2]}</p>
        </div>
      </Window>

      {/* 知识星系 */}
      <Window x={1140} y={80} w={640} h={820} title="Knowledge" alpha={enter} lift={lerp(50, 0, enter)}>
        <svg width={640} height={770} style={{ position: 'absolute', inset: 0 }}>
          {GRAPH_EDGES.map(([a, b], i) => {
            const p = easeInOutCubic(span(lt, 0.6 + i * 0.22, 1.1 + i * 0.22));
            if (p <= 0) return null;
            const A = GRAPH_NODES[a];
            const B = GRAPH_NODES[b];
            const x2 = lerp(A.x, B.x, p);
            const y2 = lerp(A.y, B.y, p);
            const pulse = (lt * 0.8 + i * 0.17) % 1;
            return (
              <g key={i}>
                <line x1={A.x} y1={A.y} x2={x2} y2={y2} stroke={FILM.steel} strokeOpacity={0.45} strokeWidth={2} />
                {p >= 1 && <circle cx={lerp(A.x, B.x, pulse)} cy={lerp(A.y, B.y, pulse)} r={4} fill={FILM.sand} />}
              </g>
            );
          })}
        </svg>
        {GRAPH_NODES.map((n, i) => {
          const at = 0.25 + i * BEAT * 0.5;
          const p = easeOutBack(span(lt, at, at + 0.4));
          if (p <= 0) return null;
          const c = ACCENT_CYCLE[i % ACCENT_CYCLE.length];
          const big = i === 0;
          const r = big ? 30 : 20;
          return (
            <div key={i} style={{ position: 'absolute', left: n.x - r, top: n.y - r, transform: `scale(${p})`, textAlign: 'center' }}>
              <div style={{ width: r * 2, height: r * 2, borderRadius: r, background: `${c}33`, border: `2px solid ${c}`, boxShadow: `0 0 ${24 + beatPulse(lt) * 20}px ${c}88` }} />
              <div style={{ position: 'absolute', left: '50%', top: r * 2 + 8, transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: big ? 24 : 20, color: big ? FILM.text : FILM.textDim }}>
                {copy.writing.nodes[i]}
              </div>
            </div>
          );
        })}
      </Window>
    </div>
  );
}

// ═══════════════════════ 第四幕 · 百宝箱 ═══════════════════════

function ToolboxFilmScene({ lt, d, copy, roster }: { lt: number; d: number; copy: FilmTranslation; roster: RosterItem[] }) {
  const exit = span(lt, d - 0.25, d);
  // 名册取自首页百宝箱那一幕的真实注册表，有几个摆几个，不重复凑数、不虚报总数
  const cols = 8;
  const items = roster.slice(0, cols * 2);
  const count = Math.round(items.length * easeOutCubic(span(lt, 0.2, 1.6)));
  const lit = Math.floor(lt / BEAT);
  const litIdx = Math.floor(seeded(lit + 900)() * items.length);

  return (
    <div style={{ ...fill, opacity: 1 - exit }}>
      <div style={{ position: 'absolute', left: 140, right: 140, top: 96, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, width: 560, height: 64, padding: '0 22px', borderRadius: 16, background: FILM.panel, border: `1px solid ${FILM.lineStrong}`, color: FILM.textFaint, fontSize: 22, opacity: easeOutCubic(span(lt, 0, 0.4)) }}>
          <Search size={24} />
          {copy.toolbox.search}
        </div>
        <div style={{ fontFamily: FONT_DISPLAY, fontSize: 88, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1 }}>
          <span style={{ background: FILM.brandGradient, WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>{count}</span>
          <span style={{ fontSize: 34, color: FILM.textDim, marginLeft: 14, fontWeight: 500 }}>{copy.toolbox.unit}</span>
        </div>
      </div>
      {items.map((item, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const at = 0.25 + (col + row) * 0.09;
        const p = easeOutBack(span(lt, at, at + 0.45));
        const alpha = span(lt, at, at + 0.2);
        const c = ACCENT_CYCLE[(col + row * 2) % ACCENT_CYCLE.length];
        const hot = i === litIdx && lt > 1 ? beatPulse(lt, 5) : 0;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 140 + col * 207,
              top: 230 + row * 330,
              width: 195,
              height: 306,
              borderRadius: 20,
              background: FILM.panel,
              border: `1px solid ${hot > 0.1 ? c : FILM.line}`,
              boxShadow: hot > 0.05 ? `0 0 ${40 * hot}px ${c}88` : 'none',
              padding: 20,
              opacity: alpha,
              transform: `scale(${lerp(0.7, 1, p)}) translateY(${-hot * 6}px)`,
            }}
          >
            <div style={{ width: 60, height: 60, borderRadius: 16, background: `${c}22`, border: `1px solid ${c}66`, display: 'grid', placeItems: 'center' }}>
              <svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <path d={toolboxIconPath(item.icon)} />
              </svg>
            </div>
            <div style={{ marginTop: 26, fontSize: 20, fontWeight: 600, lineHeight: 1.3, height: 58, overflow: 'hidden' }}>{item.name}</div>
            <div style={{ marginTop: 10, fontSize: 17, color: FILM.textFaint, lineHeight: 1.45, height: 100, overflow: 'hidden' }}>{item.desc}</div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════ 第五幕 · 工作流 ═══════════════════════

const FLOW_ICONS = [Clock, FileText, Sparkles, BarChart3, Send];

function WorkflowFilmScene({ lt, d, copy }: { lt: number; d: number; copy: FilmTranslation }) {
  const exit = span(lt, d - 0.25, d);
  const nodes = copy.workflow.nodes;
  const gap = 330;
  const x0 = 960 - ((nodes.length - 1) * gap) / 2;
  const y = 470;
  const runStart = 0.75;
  const step = BEAT;
  const packetPos = (lt - runStart) / step; // 第几个节点之间
  const done = span(lt, runStart + step * (nodes.length - 1) + 0.2, runStart + step * (nodes.length - 1) + 0.6);

  const win = easeOutCubic(span(lt, 0, 0.45));
  return (
    <div style={{ ...fill, opacity: 1 - exit }}>
      <Window x={140} y={210} w={1640} h={640} title={copy.workflow.title} alpha={win} lift={lerp(30, 0, win)}>
        <div style={{ position: 'absolute', left: 40, top: 34, display: 'flex', alignItems: 'center', gap: 14, fontSize: 22, color: FILM.textDim }}>
          <Clock size={22} color={FILM.sand} />
          {copy.workflow.schedule}
        </div>
      </Window>
      <svg width={STAGE_W} height={STAGE_H} style={{ position: 'absolute', inset: 0 }}>
        {nodes.slice(0, -1).map((_, i) => {
          const draw = easeInOutCubic(span(lt, 0.15 + i * 0.1, 0.55 + i * 0.1));
          const lit = span(packetPos, i, i + 1);
          const xa = x0 + i * gap + 120;
          const xb = x0 + (i + 1) * gap - 120;
          return (
            <g key={i}>
              <line x1={xa} y1={y} x2={lerp(xa, xb, draw)} y2={y} stroke={FILM.lineStrong} strokeWidth={3} strokeDasharray="8 10" />
              {lit > 0 && <line x1={xa} y1={y} x2={lerp(xa, xb, lit)} y2={y} stroke={FILM.clay} strokeWidth={4} />}
            </g>
          );
        })}
        {packetPos >= 0 && packetPos < nodes.length - 1 && (() => {
          const i = Math.floor(packetPos);
          const f = easeInOutCubic(packetPos - i);
          const cx = lerp(x0 + i * gap + 120, x0 + (i + 1) * gap - 120, f);
          return <circle cx={cx} cy={y} r={11} fill={FILM.sand} style={{ filter: `drop-shadow(0 0 16px ${FILM.sand})` }} />;
        })()}
      </svg>
      {nodes.map((label, i) => {
        const Icon = FLOW_ICONS[i % FLOW_ICONS.length];
        const appear = easeOutBack(span(lt, i * 0.08, i * 0.08 + 0.45));
        const active = packetPos >= i - 0.02;
        const activeP = span(packetPos, i - 0.02, i + 0.3);
        const c = active ? FILM.clay : FILM.lineStrong;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x0 + i * gap - 120,
              top: y - 70,
              width: 240,
              height: 140,
              borderRadius: 70,
              background: active ? `${FILM.clay}22` : FILM.panel,
              border: `2px solid ${c}`,
              boxShadow: active ? `0 0 ${50 * (1 - activeP * 0.5)}px ${FILM.clay}66` : 'none',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              transform: `scale(${appear * (1 + (active ? (1 - activeP) * 0.08 : 0))})`,
            }}
          >
            {active && activeP >= 1 ? <Check size={34} color={FILM.pine} /> : <Icon size={34} color={active ? FILM.clay : FILM.textDim} />}
            <span style={{ fontSize: 23, color: active ? FILM.text : FILM.textDim }}>{label}</span>
          </div>
        );
      })}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 650,
          textAlign: 'center',
          opacity: done,
          transform: `translateY(${lerp(20, 0, easeOutCubic(done))}px)`,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, padding: '16px 30px', borderRadius: 40, background: `${FILM.pine}1f`, border: `1.5px solid ${FILM.pine}`, fontSize: 26, color: FILM.pine }}>
          <Check size={26} />
          {copy.workflow.done}
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════ 第六幕 · 模型池 ═══════════════════════

function ModelsFilmScene({ lt, d, t, copy }: { lt: number; d: number; t: number; copy: FilmTranslation }) {
  const enter = easeOutCubic(span(lt, 0, 0.45));
  const fail = SCORE_CUES.failover - sceneStart('models');
  const failed = lt >= fail;
  const shift = easeInOutCubic(span(lt, fail + 0.12, fail + 0.5));
  const shake = failed && lt < fail + 0.3 ? Math.sin(lt * 90) * 8 * (1 - span(lt, fail, fail + 0.3)) : 0;
  // 上扬：最后一小节镜头慢慢推近，把人送进 CDS 那一拍
  const push = easeInOutCubic(span(lt, BAR, d));
  const rows = copy.models.rows;
  const rowH = 118;
  const top = 230;

  return (
    <div style={{ ...fill, transform: `scale(${1 + push * 0.12})`, filter: `brightness(${1 + push * 0.35})` }}>
      <Window x={410} y={170} w={1100} h={650} title={copy.models.poolName} alpha={enter} lift={lerp(30, 0, enter)}>
        {/* 流量带：接在当前主力模型那一行 */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: top - 190 + lerp(0, rowH, shift),
            width: 8,
            height: rowH - 18,
            background: FILM.brandGradient,
            boxShadow: `0 0 30px ${FILM.clay}`,
          }}
        />
        {rows.map((name, i) => {
          const isDown = i === 0 && failed;
          const isActive = (i === 0 && !failed) || (i === 1 && shift > 0.5);
          const rowY = top - 190 + i * rowH;
          const r = seeded(i * 17 + Math.floor(t * 8));
          return (
            <div
              key={name}
              style={{
                position: 'absolute',
                left: 36,
                right: 36,
                top: rowY,
                height: rowH - 18,
                borderRadius: 16,
                background: isActive ? `${FILM.clay}14` : FILM.panelInset,
                border: `1.5px solid ${isDown ? FILM.danger : isActive ? `${FILM.clay}99` : FILM.line}`,
                display: 'flex',
                alignItems: 'center',
                padding: '0 30px',
                gap: 22,
                transform: `translateX(${i === 0 ? shake : 0}px)`,
                opacity: span(lt, 0.1 + i * 0.1, 0.4 + i * 0.1),
              }}
            >
              <span style={{ fontFamily: FONT_MONO, fontSize: 22, color: FILM.textFaint, width: 36 }}>{String(i + 1).padStart(2, '0')}</span>
              <span style={{ width: 14, height: 14, borderRadius: 7, background: isDown ? FILM.danger : FILM.pine, boxShadow: `0 0 12px ${isDown ? FILM.danger : FILM.pine}` }} />
              <span style={{ fontSize: 30, fontWeight: 600, width: 250 }}>{name}</span>
              {/* 延迟柱：活着的在跳，倒下的归零 */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 52, flex: 1 }}>
                {Array.from({ length: 22 }, (_, k) => {
                  const h = isDown ? 4 : 10 + r() * (isActive ? 40 : 22);
                  return <span key={k} style={{ width: 9, height: h, borderRadius: 2, background: isDown ? FILM.danger : isActive ? FILM.sand : FILM.lineStrong, opacity: isDown ? 0.5 : 0.9 }} />;
                })}
              </div>
              <span
                style={{
                  minWidth: 200,
                  textAlign: 'right',
                  fontSize: 22,
                  color: isDown ? FILM.danger : isActive ? FILM.pine : FILM.textFaint,
                  fontFamily: isDown ? FONT_MONO : FONT_BODY,
                }}
              >
                {isDown ? copy.models.rateLimited : i === 1 && shift > 0.5 ? copy.models.switched : isActive ? 'primary' : 'standby'}
              </span>
            </div>
          );
        })}
        <div
          style={{
            position: 'absolute',
            left: 36,
            bottom: 34,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 26,
            color: FILM.pine,
            opacity: span(lt, fail + 0.7, fail + 1.1),
          }}
        >
          <Check size={26} />
          {copy.models.failures}
        </div>
      </Window>
    </div>
  );
}

// ═══════════════════════ 第七幕 · CDS（高潮）═══════════════════════

function CdsFilmScene({ lt, d, t, copy }: { lt: number; d: number; t: number; copy: FilmTranslation }) {
  const from = sceneStart('cds');
  const exit = span(lt, d - 0.25, d);
  const punch = 1 + (1 - easeOutCubic(span(lt, 0, 0.5))) * 0.06;
  const cmd = typed(copy.cds.command, lt, 0.2, Array.from(copy.cds.command).length / 1.1);
  const typedDone = lt >= 1.35;
  const card = easeOutCubic(span(lt, 1.5, 2.0));
  const stageTimes = SCORE_CUES.cdsStages.map((x) => x - from);
  const ready = SCORE_CUES.cdsReady - from;
  const readyP = easeOutBack(span(lt, ready, ready + 0.5));
  const slogan = easeOutCubic(span(lt, ready + 0.5, ready + 1.1));
  const logLines = ['docker pull ghcr.io/…:sha-2df49f7', 'container api-prd-agent  healthy', 'container prd-admin      healthy', 'routing  feature-film   ok'];

  return (
    <div style={{ ...fill, opacity: 1 - exit, transform: `scale(${punch})` }}>
      <Window x={140} y={130} w={760} h={420} title="Terminal">
        <div style={{ padding: '30px 34px', fontFamily: FONT_MONO, fontSize: 28, lineHeight: 1.7 }}>
          <div>
            <span style={{ color: FILM.pine }}>~/map</span>
            <span style={{ color: FILM.textFaint }}> $ </span>
            <span>{cmd}</span>
            {!typedDone && <Caret t={lt} height={26} color={FILM.text} />}
          </div>
          {typedDone && (
            <>
              <div style={{ color: FILM.textFaint, opacity: span(lt, 1.4, 1.6) }}>Enumerating objects: 42, done.</div>
              <div style={{ color: FILM.textFaint, opacity: span(lt, 1.6, 1.8) }}>To github.com:map/prd_agent</div>
              <div style={{ color: FILM.steel, opacity: span(lt, 1.8, 2.0) }}>→ webhook · CDS</div>
            </>
          )}
        </div>
      </Window>

      <Window
        x={960}
        y={130}
        w={820}
        h={600}
        title="CDS · Branches"
        alpha={card}
        lift={lerp(30, 0, card)}
        glow={lt >= ready ? FILM.pine : undefined}
      >
        <div style={{ padding: '30px 36px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 30, fontWeight: 600 }}>
            <GitBranch size={30} color={FILM.clay} />
            {copy.cds.branch}
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 20,
                padding: '6px 16px',
                borderRadius: 20,
                background: lt >= ready ? `${FILM.pine}22` : `${FILM.sand}22`,
                color: lt >= ready ? FILM.pine : FILM.sand,
                fontFamily: FONT_MONO,
              }}
            >
              {lt >= ready ? 'RUNNING' : 'DEPLOYING'}
            </span>
          </div>
          {/* 四个阶段 */}
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 42 }}>
            {copy.cds.stages.map((label, i) => {
              const at = stageTimes[i];
              const doneP = easeOutBack(span(lt, at, at + 0.35));
              const running = lt >= (i === 0 ? 1.9 : stageTimes[i - 1]) && lt < at;
              const barP = i < copy.cds.stages.length - 1 ? span(lt, at, stageTimes[i + 1] ?? at) : 0;
              return (
                <div key={label} style={{ display: 'flex', alignItems: 'center', flex: i < copy.cds.stages.length - 1 ? 1 : 0 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                    <div
                      style={{
                        width: 64,
                        height: 64,
                        borderRadius: 32,
                        display: 'grid',
                        placeItems: 'center',
                        border: `2px solid ${doneP > 0 ? FILM.pine : running ? FILM.sand : FILM.lineStrong}`,
                        background: doneP > 0 ? `${FILM.pine}22` : 'transparent',
                        boxShadow: running ? `0 0 ${20 + beatPulse(t) * 24}px ${FILM.sand}88` : 'none',
                      }}
                    >
                      {doneP > 0 ? (
                        <Check size={32} color={FILM.pine} style={{ transform: `scale(${doneP})` }} />
                      ) : (
                        <span style={{ fontFamily: FONT_MONO, fontSize: 22, color: running ? FILM.sand : FILM.textFaint }}>{i + 1}</span>
                      )}
                    </div>
                    <span style={{ fontSize: 22, color: doneP > 0 ? FILM.text : FILM.textDim }}>{label}</span>
                  </div>
                  {i < copy.cds.stages.length - 1 && (
                    <div style={{ flex: 1, height: 4, margin: '0 14px 36px', borderRadius: 2, background: FILM.line, overflow: 'hidden' }}>
                      <div style={{ width: `${barP * 100}%`, height: '100%', background: FILM.pine }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {/* 日志 */}
          <div style={{ marginTop: 30, padding: '16px 22px', borderRadius: 14, background: FILM.panelInset, fontFamily: FONT_MONO, fontSize: 20, lineHeight: 1.7, color: FILM.textFaint, height: 172, overflow: 'hidden' }}>
            {logLines.map((line, i) => (
              <div key={line} style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: span(lt, stageTimes[Math.min(i, stageTimes.length - 1)] - 0.3, stageTimes[Math.min(i, stageTimes.length - 1)]) }}>
                <Check size={18} color={FILM.pine} />
                {line}
              </div>
            ))}
          </div>
          {/* 上线 */}
          <div
            style={{
              marginTop: 22,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 14,
              padding: '14px 26px',
              borderRadius: 40,
              background: FILM.brandGradient,
              color: FILM.onBrand,
              fontSize: 26,
              fontWeight: 600,
              opacity: readyP > 0 ? 1 : 0,
              transform: `scale(${readyP})`,
              boxShadow: `0 0 ${30 + beatPulse(t) * 30}px ${FILM.clay}aa`,
            }}
          >
            <Terminal size={26} />
            {copy.cds.ready}
          </div>
        </div>
      </Window>

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 760,
          textAlign: 'center',
          fontFamily: FONT_DISPLAY,
          fontSize: 76,
          fontWeight: 600,
          letterSpacing: '-0.03em',
          opacity: slogan,
          filter: `blur(${(1 - slogan) * 10}px)`,
          background: FILM.titleGradient,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}
      >
        {copy.cds.slogan}
      </div>
    </div>
  );
}

// ═══════════════════════ 第八幕 · 快切 ═══════════════════════

function MontageScene({ lt, copy }: { lt: number; copy: FilmTranslation }) {
  const words = copy.montage;
  const idx = Math.min(words.length - 1, Math.floor(lt / BEAT));
  const inBeat = lt - idx * BEAT;
  const punch = easeOutCubic(span(inBeat, 0, 0.18));
  const color = MONTAGE_COLORS[idx % MONTAGE_COLORS.length];
  const last = idx === words.length - 1;
  // 最后一拍是留白：字退场，把收口那一下让出来
  const fadeLast = last ? span(inBeat, 0.05, BEAT) : 0;
  return (
    <div style={{ ...fill, background: color, opacity: 1 - fadeLast * 0.9 }}>
      <div
        style={{
          ...fill,
          backgroundImage: `repeating-linear-gradient(${idx % 2 ? 120 : 60}deg, ${FILM.stripe} 0 22px, transparent 22px 60px)`,
          backgroundPosition: `${lt * 240}px 0`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          fontFamily: FONT_DISPLAY,
          fontWeight: 800,
          fontSize: Array.from(words[idx]).length > 2 ? 300 : 460,
          letterSpacing: '-0.05em',
          color: FILM.onBrand,
          transform: `scale(${lerp(1.3, 1, punch)})`,
          filter: `blur(${(1 - punch) * 8}px)`,
        }}
      >
        {words[idx]}
      </div>
      <div style={{ position: 'absolute', left: 60, bottom: 50, fontFamily: FONT_MONO, fontSize: 34, color: FILM.onBrand, letterSpacing: '0.2em' }}>
        {String(idx + 1).padStart(2, '0')} / {String(words.length).padStart(2, '0')}
      </div>
    </div>
  );
}

// ═══════════════════════ 第九幕 · 收口 ═══════════════════════

function FinaleScene({ lt, d, t, copy }: { lt: number; d: number; t: number; copy: FilmTranslation }) {
  const logo = easeOutBack(span(lt, 0, 0.75));
  const ring = span(lt, 0, 1.4);
  const brand = easeOutCubic(span(lt, 0.8, 1.4));
  const tag = easeOutCubic(span(lt, 1.3, 2.5));
  const cta = easeOutCubic(span(lt, FINALE_CTA_AT, FINALE_CTA_AT + 0.6));
  const out = span(lt, d - 1.4, d);
  const embers = Array.from({ length: 34 }, (_, i) => {
    const r = seeded(700 + i);
    const x0 = r() * STAGE_W;
    const speed = 30 + r() * 70;
    const y = STAGE_H + 40 - ((lt * speed + r() * STAGE_H) % (STAGE_H + 80));
    return { x: x0 + Math.sin(t * 0.8 + i) * 20, y, s: 3 + r() * 5, a: 0.25 + r() * 0.5, c: ACCENT_CYCLE[i % 3] };
  });

  return (
    <div style={{ ...fill, opacity: 1 - out }}>
      <div style={{ ...fill, background: `radial-gradient(ellipse at 50% 42%, ${FILM.clay}33, transparent 60%)`, opacity: logo }} />
      {embers.map((e, i) => (
        <span key={i} style={{ position: 'absolute', left: e.x, top: e.y, width: e.s, height: e.s, borderRadius: '50%', background: e.c, opacity: e.a * logo, filter: 'blur(0.5px)' }} />
      ))}
      {/* 冲击环 */}
      {ring < 1 && (
        <div
          style={{
            position: 'absolute',
            left: 960 - 700 * easeOutCubic(ring),
            top: 330 - 700 * easeOutCubic(ring),
            width: 1400 * easeOutCubic(ring),
            height: 1400 * easeOutCubic(ring),
            borderRadius: '50%',
            border: `3px solid ${FILM.clay}`,
            opacity: (1 - ring) * 0.8,
          }}
        />
      )}
      {/* 徽标：与首页顶栏同一枚 MAP 方块 */}
      <div
        style={{
          position: 'absolute',
          left: 960 - 110,
          top: 330 - 110,
          width: 220,
          height: 220,
          borderRadius: 48,
          background: FILM.brandGradient,
          display: 'grid',
          placeItems: 'center',
          transform: `scale(${logo}) rotate(${(1 - logo) * -12}deg)`,
          boxShadow: `0 0 ${80 + beatPulse(t, 4) * 30}px ${FILM.clay}88`,
          fontFamily: FONT_DISPLAY,
          fontWeight: 900,
          fontSize: 82,
          letterSpacing: '-0.04em',
          color: FILM.onBrand,
        }}
      >
        MAP
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 486,
          textAlign: 'center',
          fontFamily: FONT_MONO,
          fontSize: 28,
          letterSpacing: '0.28em',
          color: FILM.textDim,
          opacity: brand,
          transform: `translateY(${lerp(16, 0, brand)}px)`,
        }}
      >
        {copy.finale.brand}
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 560,
          textAlign: 'center',
          fontFamily: FONT_DISPLAY,
          fontSize: 124,
          fontWeight: 600,
          letterSpacing: '-0.04em',
          opacity: tag,
          filter: `blur(${(1 - tag) * 16}px) drop-shadow(0 0 40px ${FILM.sand}44)`,
          background: FILM.titleGradient,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}
      >
        {copy.finale.tagline}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 790, textAlign: 'center', opacity: cta, transform: `translateY(${lerp(18, 0, cta)}px)` }}>
        <span style={{ display: 'inline-block', padding: '20px 54px', borderRadius: 50, background: FILM.brandGradient, color: FILM.onBrand, fontSize: 32, fontWeight: 600, boxShadow: `0 0 40px ${FILM.clay}77` }}>
          {copy.finale.cta}
        </span>
      </div>
    </div>
  );
}
