import type { CSSProperties, ReactNode } from 'react';
import { BarChart3, Check, Clock, FileText, GitBranch, Send, Sparkles } from 'lucide-react';

import type { FilmTranslation, RosterItem } from '../i18n/landing';
import { toolboxIconPath } from '../scenes/ToolboxScene';
import { ACCENT_CYCLE, FILM, MONTAGE_COLORS, POSTER_ART, WORD_GRADIENTS } from './filmPalette';
import { SCORE_CUES } from './filmScore';
import {
  BAR,
  BEAT,
  FILM_SCENES,
  FINALE_CTA_AT,
  beatPulse,
  clamp01,
  easeInOutCubic,
  easeOutCubic,
  lerp,
  sceneAt,
  sceneStart,
  seeded,
  span,
  typed,
  type FilmScene,
} from './filmTimeline';

/**
 * 片花的银幕：输入只有时间 t（秒），输出这一刻的整幅画面。
 *
 * 视觉锚点是 Apple 发布片（度量表见 filmPalette.ts 头注释）。落到画面上是四条纪律：
 *   1. 一帧只讲一件事——每一幕顶上一句大字，下面是一个产品画面，没有字幕条、角标、计时器。
 *   2. 镜头永不静止——产品画面从 3D 倾斜里抬起、持续缓推、最后推进穿越到下一幕。
 *   3. 产品要大——界面占画面宽度 70–85%，宁可出画也不缩成一个小窗。
 *   4. 强拍硬切——切镜点就是乐谱里的强拍（filmTimeline 的小节线），不做花哨转场。
 *
 * 画布固定 1920×1080 逻辑坐标，外层等比缩放。演示指针挂在它所操作的窗口**内部**，
 * 与按钮共用同一组常量、同一个变换——镜头怎么推，手就跟着怎么走
 * （`demo-causality-contract` 契约 3）。
 */

export const STAGE_W = 1920;
export const STAGE_H = 1080;

/** Apple 的中文用苹方；导出 MP4 的无头浏览器里没有苹方，退到 Noto Sans SC（导出页会加载它）。 */
const FONT_SANS = '"Inter", "PingFang SC", "Noto Sans SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const FONT_MONO = '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace';

interface StageProps {
  t: number;
  copy: FilmTranslation;
  roster: RosterItem[];
}

export function FilmStage({ t, copy, roster }: StageProps) {
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
        fontFamily: FONT_SANS,
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      <SceneSwitch scene={scene} lt={lt} t={t} copy={copy} roster={roster} />
      <CutFlash t={t} />
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
      return <FinaleScene lt={lt} d={d} copy={copy} />;
  }
}

// ═══════════════════════ 动效语言 ═══════════════════════

/** Apple 式出场曲线：前 20% 走完大半，尾巴拖得很长（近似 cubic-bezier(0.22, 1, 0.36, 1)）。 */
function easeOutQuart(x: number): number {
  return 1 - Math.pow(1 - clamp01(x), 4);
}

/** 只在两处强拍（CDS 落地、收口）给一记极淡的闪，其余一律硬切。 */
function CutFlash({ t }: { t: number }) {
  let alpha = 0;
  for (const s of FILM_SCENES) {
    if (s.id !== 'cds' && s.id !== 'finale') continue;
    const dt = t - s.from;
    if (dt >= 0 && dt < 0.5) alpha = Math.max(alpha, 0.22 * Math.exp(-dt * 9));
  }
  if (alpha < 0.005) return null;
  return <div style={{ ...fill, background: FILM.flash, opacity: alpha, mixBlendMode: 'screen', pointerEvents: 'none' }} />;
}

/**
 * 大字入场。白字逐字（中文）/ 逐词（英文）上浮 + 去模糊；渐变字整行从左向右擦出
 * （渐变按字拆开会一字一个起点，整行擦出才是一条连续的渐变）。
 */
function Headline({
  text,
  lt,
  at,
  size,
  weight = 700,
  gradient,
  color = FILM.text,
  stagger,
  style,
}: {
  text: string;
  lt: number;
  at: number;
  size: number;
  weight?: number;
  gradient?: string;
  color?: string;
  stagger?: number;
  style?: CSSProperties;
}) {
  const base: CSSProperties = {
    fontSize: size,
    fontWeight: weight,
    letterSpacing: '-0.04em',
    lineHeight: 1.06,
    whiteSpace: 'nowrap',
    ...style,
  };
  if (gradient) {
    const p = easeOutQuart(span(lt, at, at + 1.1));
    const edge = lerp(-15, 115, p);
    // 遮罩只看不透明度，实色取哪个都行；借银幕底色，免得为它再写一个字面色
    const mask = `linear-gradient(90deg, ${FILM.bg} ${edge - 15}%, transparent ${edge}%)`;
    return (
      <div
        style={{
          ...base,
          background: gradient,
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          WebkitMaskImage: mask,
          maskImage: mask,
          transform: `translateY(${(1 - p) * size * 0.18}px)`,
        }}
      >
        {text}
      </div>
    );
  }
  const spaced = /\s/.test(text);
  const units = spaced ? text.split(/(\s+)/) : Array.from(text);
  const step = stagger ?? (spaced ? 0.07 : 0.045);
  let visible = 0;
  return (
    <div style={{ ...base, color }}>
      {units.map((u, i) => {
        if (/^\s+$/.test(u)) return <span key={i}>{u}</span>;
        const p = easeOutQuart(span(lt, at + visible * step, at + visible * step + 0.9));
        visible += 1;
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              whiteSpace: 'pre',
              opacity: p,
              transform: `translateY(${(1 - p) * size * 0.32}px)`,
              filter: p < 1 ? `blur(${(1 - p) * 14}px)` : undefined,
            }}
          >
            {u}
          </span>
        );
      })}
    </div>
  );
}

/** 一幕顶上的「大字 + 灰色副标题」。out ∈ [0,1] 是它被推走了几成。 */
function TitleBlock({ headline, sub, lt, at = 0.1, out = 0, top = 88, size = 112 }: { headline: string; sub?: string; lt: number; at?: number; out?: number; top?: number; size?: number }) {
  const subP = easeOutQuart(span(lt, at + 0.45, at + 1.2));
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        opacity: 1 - out,
        transform: `translateY(${-out * 60}px)`,
        filter: out > 0 ? `blur(${out * 10}px)` : undefined,
      }}
    >
      <Headline text={headline} lt={lt} at={at} size={size} />
      {sub && (
        <div style={{ marginTop: 22, fontSize: 38, fontWeight: 500, color: FILM.gray, letterSpacing: '-0.01em', opacity: subP, transform: `translateY(${(1 - subP) * 16}px)` }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/** 一个应用窗口：标题栏三点 + 标题，Apple 深色材质。 */
function Window({ w, h, title, children, glow }: { w: number; h: number; title: string; children: ReactNode; glow?: string }) {
  return (
    <div
      style={{
        position: 'relative',
        width: w,
        height: h,
        borderRadius: 28,
        background: FILM.panel,
        border: `1px solid ${glow ?? FILM.lineStrong}`,
        boxShadow: glow ? `${FILM.shadow}, 0 0 90px ${glow}55` : FILM.shadow,
        overflow: 'hidden',
      }}
    >
      <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 10, padding: '0 26px', borderBottom: `1px solid ${FILM.line}`, background: FILM.panelRaised }}>
        {[FILM.danger, FILM.sand, FILM.pine].map((c) => (
          <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c }} />
        ))}
        <span style={{ marginLeft: 16, fontSize: 22, color: FILM.textDim, fontWeight: 500 }}>{title}</span>
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 56, bottom: 0 }}>{children}</div>
    </div>
  );
}

/**
 * 产品镜头：窗口从 3D 倾斜里抬起（rotateX 由大到 0、自下而上），之后持续缓推。
 * rise 是抬起进度，push 是额外推近倍数，originX/Y 是推近的焦点（舞台坐标）。
 */
function ProductShot({
  x,
  y,
  rise,
  push = 1,
  lift = 0,
  originX = STAGE_W / 2,
  originY = STAGE_H / 2,
  tiltFrom = 28,
  children,
}: {
  x: number;
  y: number;
  rise: number;
  push?: number;
  lift?: number;
  originX?: number;
  originY?: number;
  tiltFrom?: number;
  children: ReactNode;
}) {
  return (
    <div style={{ ...fill, transform: `scale(${push})`, transformOrigin: `${originX}px ${originY}px` }}>
      <div style={{ ...fill, perspective: 2000, perspectiveOrigin: '50% 30%' }}>
        <div
          style={{
            position: 'absolute',
            left: x,
            top: y,
            opacity: clamp01(rise * 1.6),
            transformOrigin: '50% 0%',
            transform: `translateY(${(1 - rise) * 420 - lift}px) rotateX(${(1 - rise) * tiltFrom}deg) scale(${lerp(0.9, 1, rise)})`,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/** 演示指针：箭头 + 按下时的一圈涟漪。press ∈ [0,1] 是这次按下手势走到了几成。 */
function FilmCursor({ x, y, alpha, press }: { x: number; y: number; alpha: number; press: number }) {
  if (alpha <= 0.01) return null;
  const pressing = press > 0 && press < 1;
  const squash = pressing ? 1 - Math.sin(press * Math.PI) * 0.14 : 1;
  return (
    <div style={{ position: 'absolute', left: x, top: y, opacity: alpha, pointerEvents: 'none', zIndex: 5 }} data-film-press={pressing ? 'down' : 'up'}>
      {pressing && (
        <span
          style={{
            position: 'absolute',
            left: -40,
            top: -40,
            width: 80,
            height: 80,
            borderRadius: 40,
            border: `3px solid ${FILM.text}`,
            transform: `scale(${lerp(0.3, 1.5, press)})`,
            opacity: 1 - press,
          }}
        />
      )}
      <svg width={46} height={46} viewBox="0 0 24 24" style={{ display: 'block', transform: `scale(${squash})`, transformOrigin: '4px 3px', filter: 'drop-shadow(0 6px 14px rgba(0,0,0,0.6))' }}>
        <path d="M4 3l15 7-6.5 2L10 19z" fill={FILM.text} stroke={FILM.bg} strokeWidth={1.3} strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Caret({ t, color = FILM.clay, height = 34 }: { t: number; color?: string; height?: number }) {
  const on = Math.floor(t * 2.4) % 2 === 0;
  return <span style={{ display: 'inline-block', width: 3, height, marginLeft: 4, background: color, opacity: on ? 1 : 0, verticalAlign: 'middle' }} />;
}

/** 柔光：Apple 片子里托在产品背后的那团光，不是描边、不是光晕圈。 */
function Bloom({ x, y, size, color, alpha }: { x: number; y: number; size: number; color: string; alpha: number }) {
  if (alpha <= 0.01) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: '50%',
        background: `radial-gradient(circle, ${color}66 0%, ${color}22 38%, transparent 68%)`,
        opacity: alpha,
        pointerEvents: 'none',
      }}
    />
  );
}

/** 一张生成海报。develop ∈ [0,1]：0 是还没显影，1 是清晰落定。 */
function PosterArt({ variant, develop, drift, label }: { variant: number; develop: number; drift: number; label?: ReactNode }) {
  const art = POSTER_ART[variant % POSTER_ART.length];
  const blur = lerp(26, 0, easeOutCubic(develop));
  const scale = lerp(1.12, 1, easeOutCubic(develop)) * (1 + drift * 0.05);
  return (
    <div style={{ ...fill, overflow: 'hidden', borderRadius: 18 }}>
      <div style={{ ...fill, transform: `scale(${scale})`, filter: `blur(${blur}px) saturate(${lerp(0.4, 1, develop)})` }}>
        <div style={{ ...fill, background: art.sky }} />
        {variant === 0 && (
          <>
            <div style={{ position: 'absolute', left: '28%', top: '32%', width: '44%', aspectRatio: '1', background: art.sun, transform: `translateY(${drift * 14}px)` }} />
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '40%', background: art.hills, clipPath: 'polygon(0 45%, 18% 20%, 34% 50%, 52% 12%, 70% 44%, 86% 26%, 100% 40%, 100% 100%, 0 100%)' }} />
            <div style={{ position: 'absolute', left: '8%', top: '8%', fontSize: 32, fontWeight: 700, color: art.accent, letterSpacing: '0.3em' }}>LAUNCH</div>
            <div style={{ position: 'absolute', left: '8%', top: 'calc(8% + 44px)', fontFamily: FONT_MONO, fontSize: 18, color: art.accent, letterSpacing: '0.2em', opacity: 0.8 }}>2026 · 10 · 01</div>
          </>
        )}
        {variant === 1 && (
          <>
            <div style={{ position: 'absolute', left: '18%', top: '10%', width: '64%', aspectRatio: '1', background: art.sun, transform: `rotate(${drift * 30}deg)` }} />
            <div style={{ position: 'absolute', left: '-10%', right: '-10%', bottom: '-6%', height: '38%', background: art.hills, transform: 'rotate(-12deg)', transformOrigin: 'left bottom' }} />
            <div style={{ position: 'absolute', right: '8%', top: '8%', fontSize: 46, fontWeight: 800, color: art.accent, lineHeight: 0.9, textAlign: 'right' }}>
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
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '34px 18px 14px', background: FILM.scrim, fontSize: 19, color: FILM.text, display: 'flex', justifyContent: 'space-between' }}>
          {label}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════ 开场：一句话 ═══════════════════════

function OpenScene({ lt, d, copy }: { lt: number; d: number; copy: FilmTranslation }) {
  const splash = SCORE_CUES.splash;
  // 一粒光从上方落下，触底时化成一团柔光——对应配乐里那一声「入水」
  const fall = span(lt, 0.2, splash);
  const dotY = lerp(-40, 540, fall * fall);
  const bloom = easeOutQuart(span(lt, splash, splash + 2.4));
  // 收尾：字与光一起向镜头推近、散焦，穿越到下一幕
  const through = easeInOutCubic(span(lt, d - 1.3, d));
  const [line1, line2] = copy.open;
  return (
    <div style={fill}>
      <Bloom x={960} y={560} size={lerp(80, 1500, bloom) * (1 + through * 0.8)} color={FILM.clay} alpha={bloom * 0.9} />
      <Bloom x={1060} y={620} size={lerp(60, 1100, bloom)} color={FILM.steel} alpha={bloom * 0.45} />
      {fall < 1 && lt > 0.2 && (
        <div style={{ position: 'absolute', left: 960 - 7, top: dotY - 7, width: 14, height: 14 + fall * 30, borderRadius: 8, background: FILM.text, boxShadow: `0 0 30px ${FILM.text}, 0 0 80px ${FILM.clay}` }} />
      )}
      <div
        style={{
          ...fill,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 18,
          transform: `scale(${1 + through * 0.9})`,
          opacity: 1 - through,
          filter: through > 0 ? `blur(${through * 24}px)` : undefined,
        }}
      >
        <Headline text={line1} lt={lt} at={1.7} size={150} />
        <Headline text={line2} lt={lt} at={3.6} size={150} gradient={WORD_GRADIENTS[0]} />
      </div>
    </div>
  );
}

// ═══════════════════════ 视觉创作 ═══════════════════════

const VISUAL_WIN = { w: 1560, h: 860 };
/** 输入框与发送键（窗口内容区坐标）：指针落点与按钮本体共用这组常量。 */
const INPUT_BOX = { x: 28, y: 650, w: 444, h: 118 };
const SEND_BUTTON = { x: INPUT_BOX.x + INPUT_BOX.w - 76, y: INPUT_BOX.y + INPUT_BOX.h - 72, size: 56 };
const TILE = { w: 468, h: 330, gap: 30, left: 545, top: 57 };

function VisualScene({ lt, d, t, copy }: { lt: number; d: number; t: number; copy: FilmTranslation }) {
  const from = sceneStart('visual');
  const chapter = copy.chapters[0];
  const press = SCORE_CUES.sendPress - from;
  const rise = easeOutQuart(span(lt, 0.15, 1.6));
  // 标题讲完，窗口抬到画面正中给生成让出舞台
  const raise = easeInOutCubic(span(lt, 2.4, 3.2));
  const titleOut = easeInOutCubic(span(lt, 2.3, 3.0));
  // 四张图都落定后，镜头推进第一张图，穿越进下一幕
  const push = 1 + 0.55 * easeInOutCubic(span(lt, d - 1.5, d));
  const drift = 1 + 0.03 * span(lt, 0, d);

  const promptChars = Array.from(copy.visual.prompt).length;
  const shownPrompt = lt < press ? typed(copy.visual.prompt, lt, 0.9, promptChars / 2.4) : '';
  const sent = lt >= press + 0.05;
  const pressP = span(lt, press, press + 0.26);

  // 指针（窗口内容区坐标）：停在输入框上看着字打进去 → 走到发送键 → 按下 → 移开
  const inputAim = { x: INPUT_BOX.x + 150, y: INPUT_BOX.y + 70 };
  const sendAim = { x: SEND_BUTTON.x + SEND_BUTTON.size / 2 - 4, y: SEND_BUTTON.y + SEND_BUTTON.size / 2 - 3 };
  const restAim = { x: 1180, y: 520 };
  const toInput = easeInOutCubic(span(lt, 0.4, 0.9));
  const toSend = easeInOutCubic(span(lt, press - 0.6, press - 0.12));
  const away = easeInOutCubic(span(lt, press + 0.5, press + 1.4));
  const cx = lerp(lerp(lerp(700, inputAim.x, toInput), sendAim.x, toSend), restAim.x, away);
  const cy = lerp(lerp(lerp(900, inputAim.y, toInput), sendAim.y, toSend), restAim.y, away);
  const cursorAlpha = span(lt, 0.4, 0.7) * (1 - span(lt, press + 2.0, press + 2.6));

  const tiles = SCORE_CUES.tilesDevelop.map((at) => {
    const dev = at - from;
    return { working: lt >= press + 0.2, develop: span(lt, dev, dev + 0.7), drift: Math.max(0, lt - dev) / 4 };
  });
  const winX = (STAGE_W - VISUAL_WIN.w) / 2;
  const winY = 340;
  const lift = raise * 240;
  // 推近焦点：第一张图的中心（舞台坐标）
  const focusX = winX + TILE.left + TILE.w / 2;
  const focusY = winY - lift + 56 + TILE.top + TILE.h / 2;

  return (
    <div style={fill}>
      <Bloom x={960} y={760} size={1600} color={FILM.clay} alpha={0.35 * rise} />
      <div style={{ ...fill, transform: `scale(${drift})` }}>
        <TitleBlock headline={chapter.headline} sub={chapter.line} lt={lt} out={titleOut} />
      </div>
      <ProductShot x={winX} y={winY} rise={rise} lift={lift} push={push * drift} originX={focusX} originY={focusY}>
        <Window w={VISUAL_WIN.w} h={VISUAL_WIN.h} title={`${chapter.title} · Canvas`}>
          {/* 左：对话列 */}
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 500, borderRight: `1px solid ${FILM.line}`, background: FILM.panelInset }}>
            {sent && (
              <div
                style={{
                  position: 'absolute',
                  right: 28,
                  top: 40,
                  maxWidth: 420,
                  padding: '18px 24px',
                  borderRadius: '22px 22px 6px 22px',
                  background: FILM.clay,
                  color: FILM.onBrand,
                  fontSize: 25,
                  fontWeight: 500,
                  lineHeight: 1.45,
                  opacity: easeOutCubic(span(lt, press + 0.05, press + 0.35)),
                  transform: `translateY(${lerp(18, 0, easeOutCubic(span(lt, press + 0.05, press + 0.35)))}px)`,
                }}
              >
                {copy.visual.prompt}
              </div>
            )}
            {lt >= press + 0.4 && (
              <div style={{ position: 'absolute', left: 30, top: 210, display: 'flex', alignItems: 'center', gap: 14, fontSize: 24, color: FILM.textDim, opacity: easeOutCubic(span(lt, press + 0.4, press + 0.7)) }}>
                <Sparkles size={26} color={FILM.sand} style={{ transform: `rotate(${lt * 90}deg)` }} />
                <span>
                  {tiles.filter((x) => x.develop >= 1).length} / 4 · {tiles.every((x) => x.develop >= 1) ? copy.visual.tileDone : copy.visual.tileWorking}
                </span>
              </div>
            )}
            <div
              style={{
                position: 'absolute',
                left: INPUT_BOX.x,
                top: INPUT_BOX.y,
                width: INPUT_BOX.w,
                height: INPUT_BOX.h,
                borderRadius: 22,
                background: FILM.panelRaised,
                border: `2px solid ${lt > 0.8 && lt < press ? FILM.clay : FILM.lineStrong}`,
                padding: '18px 90px 18px 22px',
                fontSize: 24,
                lineHeight: 1.4,
                color: FILM.text,
              }}
            >
              {shownPrompt}
              {lt > 0.8 && lt < press && <Caret t={lt} height={26} />}
              <div
                aria-label={copy.visual.send}
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
                  boxShadow: shownPrompt.length > 0 ? `0 0 30px ${FILM.clay}99` : 'none',
                }}
              >
                <Send size={26} style={{ color: FILM.onBrand }} />
              </div>
            </div>
          </div>
          {/* 右：画布 */}
          <div style={{ position: 'absolute', left: 500, right: 0, top: 0, bottom: 0, backgroundImage: FILM.dots, backgroundSize: '30px 30px' }}>
            {tiles.map((tile, i) => {
              const col = i % 2;
              const row = Math.floor(i / 2);
              const pop = easeOutQuart(span(tile.develop, 0, 0.6));
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: TILE.left - 500 + col * (TILE.w + TILE.gap),
                    top: TILE.top + row * (TILE.h + TILE.gap),
                    width: TILE.w,
                    height: TILE.h,
                    borderRadius: 18,
                    border: tile.develop > 0 ? `1px solid ${FILM.lineStrong}` : `2px dashed ${FILM.lineStrong}`,
                    background: FILM.panelInset,
                    transform: `scale(${tile.develop > 0 ? lerp(0.94, 1, pop) : 1})`,
                    boxShadow: tile.develop >= 1 ? '0 24px 60px rgba(0,0,0,0.5)' : 'none',
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
                          <span style={{ color: tile.develop >= 1 ? FILM.pine : FILM.sand }}>{tile.develop >= 1 ? copy.visual.tileDone : copy.visual.tileWorking}</span>
                        </>
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
          <FilmCursor x={cx} y={cy} alpha={cursorAlpha} press={pressP} />
        </Window>
      </ProductShot>
    </div>
  );
}

// ═══════════════════════ 文学与知识库 ═══════════════════════

const GRAPH_NODES = [
  { x: 270, y: 150 },
  { x: 110, y: 330 },
  { x: 420, y: 330 },
  { x: 250, y: 500 },
  { x: 470, y: 140 },
  { x: 80, y: 130 },
  { x: 450, y: 520 },
];
const GRAPH_EDGES: Array<[number, number]> = [[0, 1], [0, 2], [1, 3], [2, 3], [0, 4], [1, 5], [2, 6], [4, 2]];

function WritingScene({ lt, d, copy }: { lt: number; d: number; copy: FilmTranslation }) {
  const chapter = copy.chapters[1];
  const rise = easeOutQuart(span(lt, 0.05, 1.2));
  const drift = 1 + 0.04 * span(lt, 0, d);
  const paras = copy.writing.paragraphs;
  const totalChars = paras.reduce((n, p) => n + Array.from(p).length, 0);
  let budget = Math.max(0, (lt - 0.4) * (totalChars / 2.3));
  const shown = paras.map((p) => {
    const chars = Array.from(p);
    const n = Math.min(chars.length, Math.floor(budget));
    budget -= n;
    return chars.slice(0, n).join('');
  });
  const illo = span(lt, 0.9, 1.6);
  const mark = easeInOutCubic(span(lt, 2.3, 2.8));
  const graphIn = easeOutQuart(span(lt, 0.3, 1.4));

  return (
    <div style={{ ...fill, transform: `scale(${drift})` }}>
      <Bloom x={1400} y={700} size={1300} color={FILM.pine} alpha={0.3 * rise} />
      <TitleBlock headline={chapter.headline} sub={chapter.line} lt={lt} at={0.05} />
      <ProductShot x={170} y={330} rise={rise} tiltFrom={22}>
        <Window w={1040} h={820} title={copy.writing.docTitle}>
          <div style={{ padding: '40px 64px', fontSize: 28, lineHeight: 1.8, color: FILM.textDim }}>
            <div style={{ fontSize: 46, color: FILM.text, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 20 }}>{copy.writing.docTitle}</div>
            <p style={{ margin: 0 }}>{shown[0]}</p>
            <div style={{ position: 'relative', height: 200, margin: '18px 0', borderRadius: 18, overflow: 'hidden', border: `1px solid ${FILM.line}` }}>
              {illo > 0 ? <PosterArt variant={2} develop={illo} drift={Math.max(0, lt - 1.6) / 3} /> : <div style={{ ...fill, background: FILM.hatch }} />}
            </div>
            <p style={{ margin: 0 }}>
              <span
                style={{
                  color: mark > 0 ? FILM.text : undefined,
                  backgroundImage: `linear-gradient(${FILM.clay}66, ${FILM.clay}66)`,
                  backgroundSize: `${mark * 100}% 100%`,
                  backgroundRepeat: 'no-repeat',
                }}
              >
                {shown[1].slice(0, Math.min(shown[1].length, 12))}
              </span>
              {shown[1].slice(12)}
            </p>
            <p style={{ margin: '12px 0 0' }}>{shown[2]}</p>
          </div>
        </Window>
      </ProductShot>
      {/* 知识星系：斜着浮在文档右侧，给画面一层纵深 */}
      <div style={{ ...fill, perspective: 1600 }}>
        <div
          style={{
            position: 'absolute',
            left: 1250,
            top: 360,
            width: 560,
            height: 640,
            opacity: graphIn,
            transform: `translateX(${(1 - graphIn) * 160}px) rotateY(${lerp(-40, -22, graphIn)}deg)`,
            transformOrigin: '0% 50%',
            borderRadius: 28,
            background: FILM.panel,
            border: `1px solid ${FILM.lineStrong}`,
            boxShadow: FILM.shadow,
          }}
        >
          <div style={{ padding: '22px 28px', fontSize: 22, color: FILM.textDim, fontWeight: 500 }}>Knowledge</div>
          <svg width={560} height={640} style={{ position: 'absolute', inset: 0 }}>
            {GRAPH_EDGES.map(([a, b], i) => {
              const p = easeInOutCubic(span(lt, 0.6 + i * 0.18, 1.0 + i * 0.18));
              if (p <= 0) return null;
              const A = GRAPH_NODES[a];
              const B = GRAPH_NODES[b];
              const pulse = (lt * 0.8 + i * 0.17) % 1;
              return (
                <g key={i}>
                  <line x1={A.x} y1={A.y} x2={lerp(A.x, B.x, p)} y2={lerp(A.y, B.y, p)} stroke={FILM.steel} strokeOpacity={0.55} strokeWidth={2.5} />
                  {p >= 1 && <circle cx={lerp(A.x, B.x, pulse)} cy={lerp(A.y, B.y, pulse)} r={5} fill={FILM.sand} />}
                </g>
              );
            })}
          </svg>
          {GRAPH_NODES.map((n, i) => {
            const p = easeOutQuart(span(lt, 0.3 + i * BEAT * 0.4, 0.7 + i * BEAT * 0.4));
            if (p <= 0) return null;
            const c = ACCENT_CYCLE[i % ACCENT_CYCLE.length];
            const r = i === 0 ? 30 : 20;
            return (
              <div key={i} style={{ position: 'absolute', left: n.x - r, top: n.y - r, transform: `scale(${p})`, textAlign: 'center' }}>
                <div style={{ width: r * 2, height: r * 2, borderRadius: r, background: `${c}33`, border: `2px solid ${c}`, boxShadow: `0 0 ${24 + beatPulse(lt) * 20}px ${c}99` }} />
                <div style={{ position: 'absolute', left: '50%', top: r * 2 + 8, transform: 'translateX(-50%)', whiteSpace: 'nowrap', fontSize: i === 0 ? 24 : 20, color: i === 0 ? FILM.text : FILM.textDim }}>
                  {copy.writing.nodes[i]}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════ 百宝箱 ═══════════════════════

function ToolboxFilmScene({ lt, d, copy, roster }: { lt: number; d: number; copy: FilmTranslation; roster: RosterItem[] }) {
  const chapter = copy.chapters[2];
  // 名册取自首页百宝箱那一幕的真实注册表，有几个摆几个，不重复凑数
  const cols = 8;
  const items = roster.slice(0, cols * 2);
  // 一整面卡片墙像桌面一样平放着，镜头从低角度抬起、同时往前推
  const tilt = lerp(52, 16, easeOutQuart(span(lt, 0.1, 2.2)));
  const dolly = 1 + 0.06 * span(lt, 0, d);
  const lit = Math.floor(lt / BEAT);
  const litIdx = Math.floor(seeded(lit + 900)() * Math.max(1, items.length));
  return (
    <div style={fill}>
      <Bloom x={960} y={820} size={1700} color={FILM.steel} alpha={0.32} />
      <TitleBlock headline={chapter.headline} sub={chapter.line} lt={lt} at={0.05} />
      <div style={{ ...fill, perspective: 1800, perspectiveOrigin: '50% 20%', transform: `scale(${dolly})` }}>
        <div style={{ position: 'absolute', left: 90, top: 380, width: 1740, transform: `rotateX(${tilt}deg)`, transformOrigin: '50% 0%' }}>
          {items.map((item, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const at = 0.25 + Math.abs(col - 3.5) * 0.07 + row * 0.12;
            const p = easeOutQuart(span(lt, at, at + 0.6));
            const c = ACCENT_CYCLE[(col + row * 2) % ACCENT_CYCLE.length];
            const hot = i === litIdx && lt > 1 ? beatPulse(lt, 5) : 0;
            return (
              <div
                key={item.name}
                style={{
                  position: 'absolute',
                  left: col * 220,
                  top: row * 300,
                  width: 200,
                  height: 280,
                  borderRadius: 28,
                  background: FILM.panel,
                  border: `1px solid ${hot > 0.1 ? c : FILM.lineStrong}`,
                  boxShadow: hot > 0.05 ? `0 0 ${60 * hot}px ${c}aa` : FILM.shadow,
                  padding: 22,
                  opacity: p,
                  transform: `translateY(${(1 - p) * 90 - hot * 10}px) scale(${lerp(0.85, 1, p)})`,
                }}
              >
                <div style={{ width: 68, height: 68, borderRadius: 18, background: `${c}26`, display: 'grid', placeItems: 'center' }}>
                  <svg width={36} height={36} viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                    <path d={toolboxIconPath(item.icon)} />
                  </svg>
                </div>
                <div style={{ marginTop: 24, fontSize: 20, fontWeight: 700, lineHeight: 1.3, letterSpacing: '-0.02em', height: 56, overflow: 'hidden' }}>{item.name}</div>
                <div style={{ marginTop: 10, fontSize: 17, color: FILM.gray, lineHeight: 1.45, height: 76, overflow: 'hidden' }}>{item.desc}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════ 工作流 ═══════════════════════

const FLOW_ICONS = [Clock, FileText, Sparkles, BarChart3, Send];

function WorkflowFilmScene({ lt, d, copy }: { lt: number; d: number; copy: FilmTranslation }) {
  const chapter = copy.chapters[3];
  const nodes = copy.workflow.nodes;
  const gap = 390;
  const nodeW = 300;
  const y = 640;
  const runStart = 0.75;
  const packetPos = (lt - runStart) / BEAT;
  const lastAt = runStart + BEAT * (nodes.length - 1);
  const done = easeOutQuart(span(lt, lastAt + 0.2, lastAt + 0.7));
  // 镜头跟着数据包横移：从第一个节点慢慢摇到最后一个
  const track = easeInOutCubic(span(lt, 0.2, lastAt + 0.4));
  const stripW = (nodes.length - 1) * gap;
  const x0 = 960 - stripW / 2 + lerp(stripW * 0.07, -stripW * 0.07, track);
  const appearAll = easeOutQuart(span(lt, 0, 0.8));
  const drift = 1 + 0.04 * span(lt, 0, d);
  return (
    <div style={{ ...fill, transform: `scale(${drift})` }}>
      <Bloom x={960} y={y} size={1500} color={FILM.clay} alpha={0.3 * appearAll} />
      <TitleBlock headline={chapter.headline} sub={chapter.line} lt={lt} at={0.05} />
      <svg width={STAGE_W} height={STAGE_H} style={{ position: 'absolute', inset: 0 }}>
        {nodes.slice(0, -1).map((_, i) => {
          const xa = x0 + i * gap + nodeW / 2;
          const xb = x0 + (i + 1) * gap - nodeW / 2;
          const lit = span(packetPos, i, i + 1);
          return (
            <g key={i} opacity={appearAll}>
              <line x1={xa} y1={y} x2={xb} y2={y} stroke={FILM.lineStrong} strokeWidth={4} strokeLinecap="round" />
              {lit > 0 && <line x1={xa} y1={y} x2={lerp(xa, xb, lit)} y2={y} stroke={FILM.clay} strokeWidth={5} strokeLinecap="round" />}
            </g>
          );
        })}
        {packetPos >= 0 && packetPos < nodes.length - 1 && (() => {
          const i = Math.floor(packetPos);
          const cx = lerp(x0 + i * gap + nodeW / 2, x0 + (i + 1) * gap - nodeW / 2, easeInOutCubic(packetPos - i));
          return <circle cx={cx} cy={y} r={13} fill={FILM.text} style={{ filter: `drop-shadow(0 0 18px ${FILM.sand})` }} />;
        })()}
      </svg>
      {nodes.map((label, i) => {
        const Icon = FLOW_ICONS[i % FLOW_ICONS.length];
        const appear = easeOutQuart(span(lt, i * 0.08, i * 0.08 + 0.6));
        const active = packetPos >= i - 0.02;
        const activeP = span(packetPos, i - 0.02, i + 0.3);
        return (
          <div
            key={label}
            style={{
              position: 'absolute',
              left: x0 + i * gap - nodeW / 2,
              top: y - 90,
              width: nodeW,
              height: 180,
              borderRadius: 40,
              background: active ? FILM.panelRaised : FILM.panel,
              border: `2px solid ${active ? FILM.clay : FILM.lineStrong}`,
              boxShadow: active ? `0 0 ${70 * (1 - activeP * 0.5)}px ${FILM.clay}77` : FILM.shadow,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 14,
              opacity: appear,
              transform: `translateY(${(1 - appear) * 60}px) scale(${1 + (active ? (1 - activeP) * 0.06 : 0)})`,
            }}
          >
            {active && activeP >= 1 ? <Check size={44} color={FILM.pine} /> : <Icon size={44} color={active ? FILM.clay : FILM.gray} />}
            <span style={{ fontSize: 28, fontWeight: 600, color: active ? FILM.text : FILM.gray }}>{label}</span>
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 830, textAlign: 'center', opacity: done, transform: `translateY(${(1 - done) * 20}px)` }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14, fontSize: 34, fontWeight: 600, color: FILM.pine }}>
          <Check size={34} />
          {copy.workflow.done}
        </span>
      </div>
    </div>
  );
}

// ═══════════════════════ 模型池 ═══════════════════════

function ModelsFilmScene({ lt, d, t, copy }: { lt: number; d: number; t: number; copy: FilmTranslation }) {
  const chapter = copy.chapters[4];
  const fail = SCORE_CUES.failover - sceneStart('models');
  const failed = lt >= fail;
  const shift = easeInOutCubic(span(lt, fail + 0.12, fail + 0.5));
  const shake = failed && lt < fail + 0.3 ? Math.sin(lt * 90) * 10 * (1 - span(lt, fail, fail + 0.3)) : 0;
  const stat = easeOutQuart(span(lt, fail + 0.6, fail + 1.4));
  const rise = easeOutQuart(span(lt, 0.1, 1.2));
  // 上扬：整幕镜头一路推近、提亮，把人送进 CDS 那一拍
  const push = 1 + 0.08 * easeInOutCubic(span(lt, 0.5, d));
  const rows = copy.models.rows;
  const rowH = 124;
  return (
    <div style={{ ...fill, transform: `scale(${push})`, filter: `brightness(${1 + 0.3 * span(lt, BAR, d)})` }}>
      <Bloom x={560} y={680} size={1400} color={failed ? FILM.pine : FILM.clay} alpha={0.28} />
      <TitleBlock headline={chapter.headline} sub={chapter.line} lt={lt} at={0.05} />
      <ProductShot x={140} y={360} rise={rise} tiltFrom={20}>
        <div style={{ width: 960, position: 'relative' }}>
          <div
            style={{
              position: 'absolute',
              left: -14,
              top: lerp(0, rowH, shift) + 8,
              width: 6,
              height: rowH - 34,
              borderRadius: 3,
              background: FILM.brandGradient,
              boxShadow: `0 0 30px ${FILM.clay}`,
            }}
          />
          {rows.map((name, i) => {
            const isDown = i === 0 && failed;
            const isActive = (i === 0 && !failed) || (i === 1 && shift > 0.5);
            const r = seeded(i * 17 + Math.floor(t * 8));
            return (
              <div
                key={name}
                style={{
                  height: rowH - 18,
                  marginBottom: 18,
                  borderRadius: 24,
                  background: isActive ? FILM.panelRaised : FILM.panel,
                  border: `2px solid ${isDown ? FILM.danger : isActive ? `${FILM.clay}aa` : FILM.line}`,
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 34px',
                  gap: 24,
                  transform: `translateX(${i === 0 ? shake : 0}px)`,
                  opacity: span(lt, 0.2 + i * 0.1, 0.6 + i * 0.1),
                }}
              >
                <span style={{ width: 16, height: 16, borderRadius: 8, background: isDown ? FILM.danger : FILM.pine, boxShadow: `0 0 14px ${isDown ? FILM.danger : FILM.pine}` }} />
                <span style={{ fontSize: 36, fontWeight: 700, width: 290, letterSpacing: '-0.02em', color: isDown ? FILM.gray : FILM.text }}>{name}</span>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 56, flex: 1 }}>
                  {Array.from({ length: 20 }, (_, k) => {
                    const h = isDown ? 4 : 10 + r() * (isActive ? 44 : 24);
                    return <span key={k} style={{ width: 10, height: h, borderRadius: 3, background: isDown ? FILM.danger : isActive ? FILM.sand : FILM.lineStrong, opacity: isDown ? 0.5 : 0.9 }} />;
                  })}
                </div>
                <span style={{ minWidth: 190, textAlign: 'right', fontSize: 24, fontWeight: 600, color: isDown ? FILM.danger : isActive ? FILM.pine : FILM.textFaint }}>
                  {isDown ? copy.models.rateLimited : i === 1 && shift > 0.5 ? copy.models.switched : isActive ? 'primary' : 'standby'}
                </span>
              </div>
            );
          })}
        </div>
      </ProductShot>
      {/* 关键数字：Apple 式的统计帧——一个巨大的数，一行灰字 */}
      <div style={{ position: 'absolute', left: 1180, top: 400, width: 640, textAlign: 'center', opacity: stat, transform: `translateY(${(1 - stat) * 40}px)`, filter: stat < 1 ? `blur(${(1 - stat) * 12}px)` : undefined }}>
        <div
          style={{
            fontSize: 380,
            fontWeight: 800,
            lineHeight: 1,
            letterSpacing: '-0.06em',
            background: WORD_GRADIENTS[2],
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}
        >
          0
        </div>
        <div style={{ marginTop: 10, fontSize: 40, fontWeight: 600, color: FILM.gray }}>{copy.models.statLabel}</div>
      </div>
    </div>
  );
}

// ═══════════════════════ CDS（高潮）═══════════════════════

function CdsFilmScene({ lt, d, t, copy }: { lt: number; d: number; t: number; copy: FilmTranslation }) {
  const from = sceneStart('cds');
  const stageTimes = SCORE_CUES.cdsStages.map((x) => x - from);
  const ready = SCORE_CUES.cdsReady - from;
  // A：落地那一拍，命令占满画面中央
  const cmd = typed(copy.cds.command, lt, 0.15, Array.from(copy.cds.command).length / 1.05);
  const typedDone = lt >= 1.25;
  const punch = 1 + (1 - easeOutCubic(span(lt, 0, 0.6))) * 0.08;
  // B：命令缩到顶上，四个阶段在中间逐拍打勾
  const settle = easeInOutCubic(span(lt, 1.35, 2.0));
  // C：上线——阶段退场，巨字登场
  const readyP = easeOutQuart(span(lt, ready, ready + 0.9));
  const stagesOut = easeInOutCubic(span(lt, ready - 0.1, ready + 0.4));
  const drift = 1 + 0.03 * span(lt, 0, d);
  return (
    <div style={{ ...fill, transform: `scale(${punch * drift})` }}>
      <Bloom x={960} y={560} size={1700} color={lt >= ready ? FILM.pine : FILM.clay} alpha={0.35 + 0.2 * readyP} />
      {/* 命令行 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: lerp(480, 120, settle),
          textAlign: 'center',
          fontFamily: FONT_MONO,
          fontSize: lerp(76, 36, settle),
          fontWeight: 600,
          letterSpacing: '-0.02em',
          opacity: 1 - stagesOut * 0.6,
        }}
      >
        <span style={{ color: FILM.gray }}>$ </span>
        <span>{cmd}</span>
        {!typedDone && <Caret t={lt} height={lerp(70, 34, settle)} color={FILM.text} />}
      </div>
      {/* 分支名 + 状态 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 215, display: 'flex', justifyContent: 'center', opacity: settle * (1 - stagesOut) }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14, padding: '12px 26px', borderRadius: 40, background: FILM.panel, border: `1px solid ${FILM.lineStrong}`, fontSize: 28, fontWeight: 600 }}>
          <GitBranch size={28} color={FILM.clay} />
          {copy.cds.branch}
        </span>
      </div>
      {/* 四个阶段 */}
      <div
        style={{
          position: 'absolute',
          left: 260,
          right: 260,
          top: 440,
          display: 'flex',
          alignItems: 'flex-start',
          opacity: settle * (1 - stagesOut),
          transform: `translateY(${(1 - settle) * 80 - stagesOut * 60}px) scale(${1 - stagesOut * 0.1})`,
        }}
      >
        {copy.cds.stages.map((label, i) => {
          const at = stageTimes[i];
          const doneP = easeOutQuart(span(lt, at, at + 0.4));
          const running = lt >= (i === 0 ? 1.9 : stageTimes[i - 1]) && lt < at;
          const barP = i < copy.cds.stages.length - 1 ? span(lt, at, stageTimes[i + 1] ?? at) : 0;
          const last = i === copy.cds.stages.length - 1;
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'flex-start', flex: last ? 0 : 1 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
                <div
                  style={{
                    width: 150,
                    height: 150,
                    borderRadius: 75,
                    display: 'grid',
                    placeItems: 'center',
                    background: doneP > 0 ? `${FILM.pine}22` : FILM.panel,
                    border: `3px solid ${doneP > 0 ? FILM.pine : running ? FILM.sand : FILM.lineStrong}`,
                    boxShadow: running ? `0 0 ${30 + beatPulse(t) * 40}px ${FILM.sand}99` : doneP > 0 ? `0 0 40px ${FILM.pine}55` : 'none',
                  }}
                >
                  {doneP > 0 ? (
                    <Check size={72} color={FILM.pine} strokeWidth={2.5} style={{ transform: `scale(${doneP})` }} />
                  ) : (
                    <span style={{ fontSize: 48, fontWeight: 700, color: running ? FILM.sand : FILM.textFaint }}>{i + 1}</span>
                  )}
                </div>
                <span style={{ fontSize: 38, fontWeight: 600, color: doneP > 0 ? FILM.text : FILM.gray }}>{label}</span>
              </div>
              {!last && (
                <div style={{ flex: 1, height: 6, margin: '72px 22px 0', borderRadius: 3, background: FILM.line, overflow: 'hidden' }}>
                  <div style={{ width: `${barP * 100}%`, height: '100%', background: FILM.pine }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {/* 上线 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 380, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: lt >= ready - 0.05 ? 1 : 0 }}>
        <Headline text={copy.cds.ready} lt={lt} at={ready} size={170} gradient={WORD_GRADIENTS[2]} />
        <div style={{ marginTop: 28, fontSize: 44, fontWeight: 600, color: FILM.gray, opacity: easeOutQuart(span(lt, ready + 0.6, ready + 1.3)) }}>{copy.cds.slogan}</div>
      </div>
    </div>
  );
}

// ═══════════════════════ 快切 ═══════════════════════

function MontageScene({ lt, copy }: { lt: number; copy: FilmTranslation }) {
  const words = copy.montage;
  const idx = Math.min(words.length - 1, Math.floor(lt / BEAT));
  const inBeat = lt - idx * BEAT;
  const punch = easeOutQuart(span(inBeat, 0, 0.22));
  const last = idx === words.length - 1;
  // 最后一拍是留白：字退场，把收口那一下让出来
  const fadeLast = last ? span(inBeat, 0.05, BEAT) : 0;
  const long = Array.from(words[idx]).length > 2;
  return (
    <div style={fill}>
      <Bloom x={960} y={540} size={1400} color={MONTAGE_COLORS[idx % MONTAGE_COLORS.length]} alpha={0.5 * (1 - fadeLast)} />
      <div
        style={{
          ...fill,
          display: 'grid',
          placeItems: 'center',
          opacity: 1 - fadeLast,
          transform: `scale(${lerp(1.18, 1, punch) * (1 + inBeat * 0.05)})`,
          filter: punch < 1 ? `blur(${(1 - punch) * 10}px)` : undefined,
        }}
      >
        {/*
          * key 按拍换：同一个元素只换文字时，Chromium 不会重算 background-clip: text 的裁剪区，
          * 从第二拍起整块渐变底直接露出来（导出的第一版里七个字全成了实心方块）。
          */}
        <div
          key={idx}
          style={{
            fontSize: long ? 300 : 440,
            fontWeight: 800,
            letterSpacing: '-0.05em',
            lineHeight: 1,
            background: WORD_GRADIENTS[idx % WORD_GRADIENTS.length],
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}
        >
          {words[idx]}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════ 收口 ═══════════════════════

function FinaleScene({ lt, d, copy }: { lt: number; d: number; copy: FilmTranslation }) {
  const logo = easeOutQuart(span(lt, 0, 1.1));
  const sheen = span(lt, 0.5, 1.5);
  const brand = easeOutQuart(span(lt, 0.8, 1.6));
  const cta = easeOutQuart(span(lt, FINALE_CTA_AT, FINALE_CTA_AT + 0.8));
  const out = span(lt, d - 1.4, d);
  const drift = 1 + 0.04 * span(lt, 0, d);
  return (
    <div style={{ ...fill, opacity: 1 - out, transform: `scale(${drift})` }}>
      <Bloom x={960} y={330} size={lerp(300, 1500, logo)} color={FILM.clay} alpha={0.8 * logo} />
      <div
        style={{
          position: 'absolute',
          left: 960 - 120,
          top: 330 - 120,
          width: 240,
          height: 240,
          borderRadius: 56,
          background: FILM.brandGradient,
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
          opacity: logo,
          transform: `scale(${lerp(0.82, 1, logo)})`,
          filter: logo < 1 ? `blur(${(1 - logo) * 18}px)` : undefined,
          boxShadow: `0 30px 90px ${FILM.clay}66`,
          fontSize: 94,
          fontWeight: 800,
          letterSpacing: '-0.05em',
          color: FILM.onBrand,
        }}
      >
        MAP
        {/* 高光扫过：Apple 片子里产品亮相时那一道反光 */}
        {sheen > 0 && sheen < 1 && (
          <div style={{ ...fill, background: FILM.sheen, transform: `translateX(${lerp(-120, 120, sheen)}%)` }} />
        )}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 500, textAlign: 'center', fontSize: 28, fontWeight: 600, letterSpacing: '0.24em', color: FILM.gray, opacity: brand, transform: `translateY(${(1 - brand) * 14}px)` }}>
        {copy.finale.brand}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 570, display: 'flex', justifyContent: 'center' }}>
        <Headline text={copy.finale.tagline} lt={lt} at={1.3} size={150} gradient={FILM.titleGradient} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 820, textAlign: 'center', opacity: cta, transform: `translateY(${(1 - cta) * 18}px)` }}>
        <span style={{ display: 'inline-block', padding: '22px 60px', borderRadius: 60, background: FILM.brandGradient, color: FILM.onBrand, fontSize: 34, fontWeight: 700, boxShadow: `0 0 50px ${FILM.clay}77` }}>
          {copy.finale.cta}
        </span>
      </div>
    </div>
  );
}
