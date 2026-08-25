import { useState } from 'react';
import { SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { useLanguage } from '../contexts/LanguageContext';
import type { LiteraryStyleKey } from '../i18n/landing';

/**
 * LiteraryScene —— 文学创作：左边文章逐段成稿，右边 384px 竖向配图工作台。
 *
 * 照真实面板复刻的几件事：
 *   · 段落左侧 gutter 有可打锚点的「+」，正文里内联已插入的配图与「待生成」槽位；
 *   · 右侧是**竖列**（不是网格）：步骤条 → 主按钮 → 配置行 → 工具行 → 流式状态条 → 一列 4:3 配图卡；
 *   · 配图卡三态：已完成 / 生成中（给已耗时与预计，不给会卡死的百分比）/ 待生成。
 *
 * 可交互：切换「风格」，整列配图连同正文内联图一起换色，**文字一个字都不动**——
 * 这正是 `artifact-is-experience` 说的「风格是 AI 生成时的参照，不是事后换皮」，
 * 也是 `miduo-review-lens` 镜头 5「AI 的改动范围严格等于用户指令范围」。
 */

const pine = inkTone(SCENE_HUE.pine);
const amber = inkTone(SCENE_HUE.amber);
const clay = inkTone(SCENE_HUE.clay);

/** 四个风格分别落在墨带的钢青 / 陶土 / 松绿 / 钢蓝，禁止漂出八色带。 */
const STYLE_PALETTE: Record<LiteraryStyleKey, [number, number, number]> = {
  calm: [SCENE_HUE.steel, 30, 26],
  warm: [SCENE_HUE.clay, 46, 32],
  forest: [SCENE_HUE.pine, 28, 24],
  night: [SCENE_HUE.slate, 34, 22],
};

const STYLE_ORDER: LiteraryStyleKey[] = ['calm', 'warm', 'forest', 'night'];

interface Tone {
  bg: string;
  mid: string;
  fg: string;
}

function toneOf(key: LiteraryStyleKey, shift = 0): Tone {
  const [h, s, l] = STYLE_PALETTE[key];
  return {
    bg: `hsl(${h} ${s}% ${l + shift}%)`,
    mid: `hsl(${h} ${s + 6}% ${l + shift + 15}%)`,
    fg: `hsl(${h} ${Math.min(64, s + 16)}% ${l + shift + 40}%)`,
  };
}

const CARD_SHAPE = [
  { state: 'done' as const, sun: 268, shift: 0 },
  { state: 'running' as const, sun: 186, shift: 4 },
  { state: 'idle' as const, sun: 104, shift: -3 },
];

export function LiteraryScene() {
  const { t } = useLanguage();
  const s = t.scenes.literary;
  const [style, setStyle] = useState<LiteraryStyleKey>('calm');
  const tone = toneOf(style);

  return (
    <SceneFrame
      id="scene-literary"
      hue={SCENE_HUE.pine}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      {/* 风格切换：这一幕唯一的杠杆，摆在面板顶部让人一眼看见 */}
      <div
        className="relative flex items-center gap-2 flex-wrap"
        style={{ padding: '12px 14px', borderBottom: `1px solid ${SCENE.hair}` }}
      >
        <SceneMono style={{ letterSpacing: '0.18em', textTransform: 'uppercase' }}>{s.styleLabel}</SceneMono>
        {STYLE_ORDER.map((key) => {
          const on = key === style;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setStyle(key)}
              aria-pressed={on}
              className="transition-colors duration-200"
              style={{
                height: '26px',
                padding: '0 11px',
                borderRadius: '7px',
                fontSize: '12px',
                cursor: 'pointer',
                background: on ? pine.soft : SCENE.ghost,
                border: `1px solid ${on ? pine.border : SCENE.line}`,
                color: on ? pine.bright : SCENE.inkDim,
              }}
            >
              {s.styles[key]}
            </button>
          );
        })}
        <span className="ml-auto hidden sm:block" style={{ fontSize: '11.5px', color: SCENE.inkFaint }}>
          {s.styleHint}
        </span>
      </div>

      {/*
       * 宽屏给整行钉一个高度：右边那列是三张 4:3 的配图卡，天然比左边文章高一大截，
       * 不钉高度就是「左边一大片空、右边一条长尾」。钉住之后两列同高，配图列超出即裁切
       * ——真实面板里它本来就是滚动的（content-fills-canvas：产物区要填满，不要塌成小盒子）。
       */}
      <div className="relative flex flex-col lg:flex-row lg:h-[680px] gap-4" style={{ padding: '14px' }}>
        {/* ── 左：文章编辑器 ── */}
        <div
          className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden rounded-2xl"
          style={{ border: `1px solid ${SCENE.edge}`, background: SCENE.editorSurface }}
        >
          {/* 编辑器头 */}
          <div
            className="flex items-center gap-2.5 shrink-0"
            style={{ height: '48px', padding: '0 16px', borderBottom: `1px solid ${SCENE.hair}` }}
          >
            <span className="flex items-center justify-center" style={{ color: SCENE.inkDim }}>
              <SceneIcon d="M19 12H5M11 18l-6-6 6-6" size={15} strokeWidth={1.9} />
            </span>
            <span className="flex items-center" style={{ color: SCENE.inkSoft }}>
              <SceneIcon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6" size={15} />
            </span>
            <span style={{ fontSize: '13.5px', color: SCENE.ink, whiteSpace: 'nowrap' }}>{s.fileName}</span>
            {/* 模型可见性：文学创作也是大模型功能，当前模型与模型池必须露出 */}
            <SceneMono className="ml-auto hidden md:flex items-center gap-2.5">
              <span className="block w-[5px] h-[5px] rounded-full" style={{ background: pine.solid }} />
              {s.model}
              <span className="block" style={{ width: '1px', height: '12px', background: SCENE.line }} />
              {s.pool}
            </SceneMono>
          </div>

          {/* 正文：逐段成稿，左侧 gutter 可打锚点 */}
          {/* overflow-hidden 是必须的：正文比这块高，不裁就会顶穿底部的产出小结那一条 */}
          <div
            className="flex-1 min-h-0 overflow-hidden"
            style={{
              padding: '24px 30px',
              fontFamily: 'var(--font-serif)',
              fontSize: '15.5px',
              lineHeight: 2.05,
              color: SCENE.inkSoft,
            }}
          >
            <Paragraph anchored>{s.body.p1}</Paragraph>

            <InlineFigure tone={tone} caption={s.body.fig1} variant="ridge" />

            <Paragraph>{s.body.p2}</Paragraph>

            {/* 待生成的插图槽位：产物还没到，但位置已经留好了 */}
            <div
              className="flex items-center justify-center gap-2.5"
              style={{
                margin: '0 0 20px',
                height: '62px',
                borderRadius: '10px',
                border: `1.5px dashed ${pine.border}`,
                fontFamily: 'var(--font-body)',
                fontSize: '12.5px',
                color: SCENE.inkDim,
                textAlign: 'center',
              }}
            >
              <SceneIcon d="M21 15l-5-5L5 21M3 5h18v14H3z" size={15} strokeWidth={1.7} style={{ opacity: 0.7 }} />
              {s.body.slot}
            </div>

            <Paragraph>{s.body.p3}</Paragraph>

            <div className="hidden md:block">
              <InlineFigure tone={tone} caption={s.body.fig2} variant="bridge" />
              <Paragraph last>{s.body.p4}</Paragraph>
            </div>
          </div>

          {/* 正文底：产出小结 */}
          <SceneMono
            className="flex items-center gap-4 shrink-0 flex-wrap"
            size={15}
            style={{ minHeight: '44px', padding: '0 30px', borderTop: `1px solid ${SCENE.hair}` }}
          >
            <span>{s.summary.words}</span>
            <span>{s.summary.paragraphs}</span>
            <span>{s.summary.figures}</span>
            <span className="ml-auto" style={{ color: pine.solid }}>
              {s.summary.currentStyle} {s.styles[style]}
            </span>
          </SceneMono>
        </div>

        {/* ── 右：配图工作台（384px 竖列） ── */}
        <div className="w-full lg:w-[384px] lg:shrink-0 flex flex-col gap-3 min-h-0">
          {/* 步骤条 + 主按钮 + 配置行 */}
          <div style={{ border: `1px solid ${SCENE.edge}`, borderRadius: '14px', background: SCENE.ghost, padding: '14px' }}>
            <div className="flex items-center">
              {s.steps.map((step, i) => {
                const done = i === 0;
                const activeStep = i === 1;
                const bg = done ? pine.soft : activeStep ? clay.soft : SCENE.ghost;
                const border = done ? pine.border : activeStep ? clay.border : SCENE.line;
                const fg = done ? pine.bright : activeStep ? clay.bright : SCENE.inkFaint;
                return (
                  <span key={step} className="flex items-center flex-1 last:flex-none min-w-0">
                    <span className="flex items-center gap-1.5 shrink-0">
                      <span
                        className="flex items-center justify-center"
                        style={{
                          width: '20px',
                          height: '20px',
                          borderRadius: '50%',
                          fontSize: '10.5px',
                          background: bg,
                          border: `1px solid ${border}`,
                          color: fg,
                        }}
                      >
                        {i + 1}
                      </span>
                      <span
                        style={{
                          fontSize: '12px',
                          whiteSpace: 'nowrap',
                          color: done ? SCENE.inkMid : activeStep ? SCENE.ink : SCENE.inkFaint,
                        }}
                      >
                        {step}
                      </span>
                    </span>
                    {i < s.steps.length - 1 && (
                      <span
                        className="flex-1"
                        style={{ height: '1px', background: done ? pine.border : SCENE.edge, margin: '0 8px' }}
                      />
                    )}
                  </span>
                );
              })}
            </div>

            <div
              className="flex items-center justify-center gap-1.5"
              style={{
                marginTop: '13px',
                height: '34px',
                borderRadius: '9px',
                background: SCENE.brand,
                color: SCENE.brandFg,
                fontSize: '13px',
              }}
            >
              <SceneIcon
                d="M12 3l1.9 4.4L18 9l-4.1 1.6L12 15l-1.9-4.4L6 9l4.1-1.6zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"
                size={14}
                strokeWidth={1.9}
              />
              {s.primaryAction}
            </div>

            <div
              className="flex items-center gap-1.5"
              style={{ marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${SCENE.hair}` }}
            >
              <SceneIcon
                d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
                size={14}
                strokeWidth={1.7}
                style={{ color: SCENE.inkFaint }}
              />
              {s.configPills.map((label, i) => {
                const on = i === 1;
                return (
                  <span
                    key={label}
                    className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden"
                    style={{
                      height: '26px',
                      borderRadius: '7px',
                      padding: '0 8px',
                      background: on ? pine.soft : SCENE.ghost,
                      border: `1px solid ${on ? pine.border : SCENE.edge}`,
                      fontSize: '11.5px',
                      color: on ? pine.bright : SCENE.inkDim,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <SceneIcon d={CONFIG_ICONS[i]} size={12} />
                    {i === 1 ? s.styles[style] : label}
                  </span>
                );
              })}
            </div>
          </div>

          {/* 工具行 */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="flex items-center gap-1.5"
              style={{
                height: '28px',
                padding: '0 11px',
                borderRadius: '7px',
                background: pine.soft,
                border: `1px solid ${pine.border}`,
                color: pine.solid,
                fontSize: '12px',
              }}
            >
              <SceneIcon d="M12 3l1.9 4.4L18 9l-4.1 1.6L12 15l-1.9-4.4L6 9l4.1-1.6z" size={12} strokeWidth={1.9} />
              {s.tools.generate}
            </span>
            <span
              style={{
                height: '28px',
                padding: '0 11px',
                borderRadius: '7px',
                background: SCENE.ghost,
                border: `1px solid ${SCENE.edge}`,
                color: SCENE.inkMid,
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              {s.tools.size}
            </span>
            <span
              className="ml-auto flex items-center gap-1.5"
              style={{
                height: '28px',
                padding: '0 11px',
                borderRadius: '7px',
                background: SCENE.ghost,
                border: `1px solid ${SCENE.edge}`,
                color: SCENE.inkMid,
                fontSize: '12px',
              }}
            >
              <SceneIcon d="M12 3v12m0 0l4-4m-4 4l-4-4M4 19h16" size={12} strokeWidth={1.9} />
              {s.tools.pack}
            </span>
          </div>

          {/* 流式状态条：屏幕上一直有内容在变，不是一个静止的「加载中」 */}
          <div
            className="flex items-center gap-2.5"
            style={{
              padding: '9px 11px',
              borderRadius: '9px',
              background: amber.faint,
              border: `1px solid ${amber.border}`,
              fontSize: '12px',
              color: amber.bright,
            }}
          >
            <span
              className="block shrink-0 map-scene-anim"
              style={{
                width: '13px',
                height: '13px',
                borderRadius: '50%',
                background: amber.solid,
                animation: 'mapSceneTwinkle 1.8s ease-in-out infinite',
              }}
            />
            {s.streaming}
          </div>

          {/* 竖向配图卡列表：窄屏改横滑，卡片本身仍是 4:3 竖列的比例 */}
          <div className="flex flex-col gap-3 lg:flex-1 lg:min-h-0 lg:overflow-hidden">
            {CARD_SHAPE.map((shape, i) => (
              <FigureCard
                key={s.cards[i].prompt}
                index={i + 1}
                shape={shape}
                tone={toneOf(style, shape.shift)}
                card={s.cards[i]}
                statusLabel={s.status[shape.state]}
                actions={s.cardActions}
                runningLabel={s.runningLabel}
              />
            ))}
          </div>
        </div>
      </div>
    </SceneFrame>
  );
}

const CONFIG_ICONS = [
  'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  'M21 15l-5-5L5 21M3 5h18v14H3z',
  'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
];

function Paragraph({
  children,
  anchored = false,
  last = false,
}: {
  children: React.ReactNode;
  anchored?: boolean;
  last?: boolean;
}) {
  return (
    <div className="relative" style={{ marginBottom: last ? 0 : '20px' }}>
      {anchored && (
        <span
          className="absolute hidden xl:block text-center"
          style={{
            left: '-22px',
            top: '12px',
            width: '15px',
            height: '15px',
            borderRadius: '50%',
            border: `1px solid ${pine.border}`,
            color: pine.solid,
            fontSize: '11px',
            lineHeight: '13px',
            fontFamily: 'var(--font-body)',
          }}
        >
          +
        </span>
      )}
      {children}
    </div>
  );
}

/** 正文里已插入的配图。换风格时只有它的颜色变，一个字都不动。 */
function InlineFigure({ tone, caption, variant }: { tone: Tone; caption: string; variant: 'ridge' | 'bridge' }) {
  const gid = `mapLitFig-${variant}`;
  return (
    <div
      style={{
        margin: '0 0 20px',
        borderRadius: '10px',
        overflow: 'hidden',
        border: `1px solid ${SCENE.edge}`,
      }}
    >
      <svg
        viewBox="0 0 600 132"
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height: variant === 'ridge' ? '132px' : '112px' }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`${gid}-sky`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={variant === 'ridge' ? tone.mid : tone.bg} />
            <stop offset="1" stopColor={variant === 'ridge' ? tone.bg : tone.mid} />
          </linearGradient>
          <radialGradient id={`${gid}-sun`} cx="0.72" cy="0.26" r="0.5">
            <stop offset="0" stopColor={tone.fg} stopOpacity="0.34" />
            <stop offset="1" stopColor={tone.fg} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="600" height="132" fill={`url(#${gid}-sky)`} />
        <rect width="600" height="132" fill={`url(#${gid}-sun)`} />
        {/* 山脊压在天空之上必须更暗：早先前后两道都用了比天空还亮的 mid，
            整张图糊成一块平色，看不出「山脊线保留」这件事。 */}
        <path
          d="M0 80 L118 50 L232 82 L346 46 L472 78 L600 56 L600 132 L0 132 Z"
          fill={tone.bg}
          opacity="0.7"
        />
        <path d="M0 102 L140 86 L280 108 L420 88 L600 110 L600 132 L0 132 Z" fill={tone.bg} />
        {variant === 'bridge' && <rect x="238" y="96" width="124" height="6" rx="3" fill={tone.fg} opacity="0.42" />}
      </svg>
      <div
        style={{
          padding: '7px 11px',
          fontFamily: 'var(--font-body)',
          fontSize: '11px',
          color: SCENE.inkDim,
          background: SCENE.faintFill,
        }}
      >
        {caption}
      </div>
    </div>
  );
}

function FigureCard({
  index,
  shape,
  tone,
  card,
  statusLabel,
  actions,
  runningLabel,
}: {
  index: number;
  shape: (typeof CARD_SHAPE)[number];
  tone: Tone;
  card: { size: string; prompt: string };
  statusLabel: string;
  actions: string[];
  runningLabel: string;
}) {
  const statusStyle =
    shape.state === 'done'
      ? { background: pine.soft, color: pine.bright }
      : shape.state === 'running'
        ? { background: amber.soft, color: amber.bright }
        : { background: SCENE.line, color: SCENE.inkMid };

  return (
    <div
      className="relative overflow-hidden shrink-0"
      style={{ borderRadius: '12px', border: `1px solid ${SCENE.hair}`, background: SCENE.ghost }}
    >
      <div
        className="relative"
        style={{ padding: '6px 6px 0', background: SCENE.mediaWell, boxSizing: 'border-box' }}
      >
        {shape.state === 'done' && (
          <svg
            viewBox="0 0 372 282"
            preserveAspectRatio="none"
            className="block w-full"
            style={{ aspectRatio: '4 / 3', borderRadius: '8px' }}
            aria-hidden="true"
          >
            <rect width="372" height="282" fill={tone.mid} />
            <circle cx={shape.sun} cy="66" r="88" fill={tone.fg} opacity="0.22" />
            <path
              d="M0 176 L74 128 L146 178 L214 122 L292 176 L372 138 L372 282 L0 282 Z"
              fill={tone.bg}
              opacity="0.72"
            />
            <path d="M0 218 L88 190 L176 222 L268 192 L372 224 L372 282 L0 282 Z" fill={tone.bg} />
          </svg>
        )}

        {shape.state === 'running' && (
          <div
            className="flex flex-col items-center justify-center gap-3"
            style={{ aspectRatio: '4 / 3', borderRadius: '8px', background: SCENE.base }}
          >
            <span
              className="block map-scene-anim"
              style={{
                width: '54px',
                height: '54px',
                borderRadius: '50%',
                background: tone.mid,
                animation: 'mapSceneTwinkle 2.2s ease-in-out infinite',
              }}
            />
            <SceneMono size={15} color={SCENE.inkDim}>
              {runningLabel}
            </SceneMono>
          </div>
        )}

        {shape.state === 'idle' && (
          <div className="flex items-center justify-center" style={{ aspectRatio: '4 / 3', borderRadius: '8px' }}>
            <div
              className="flex items-center justify-center"
              style={{
                width: '58%',
                aspectRatio: '4 / 3',
                borderRadius: '9px',
                background: SCENE.faintFill,
                border: `1.5px dashed ${SCENE.edgeStrong}`,
                color: SCENE.inkGhost,
              }}
            >
              <SceneIcon d="M21 15l-5-5L5 21M3 5h18v14H3z" size={20} strokeWidth={1.6} />
            </div>
          </div>
        )}

        {/* 顶部浮层：编号 + 尺寸 + 状态 */}
        <div
          className="absolute flex items-center justify-between"
          style={{
            top: '6px',
            left: '6px',
            right: '6px',
            height: '30px',
            padding: '0 9px',
            borderRadius: '8px 8px 0 0',
            background: SCENE.scrimTop,
          }}
        >
          <span style={{ fontSize: '11.5px', color: SCENE.captionFg }}>{`${index}`}</span>
          <span className="flex items-center gap-1.5">
            <SceneMono size={13} color={SCENE.captionFg} style={{ letterSpacing: '0.08em', opacity: 0.72 }}>
              {card.size}
            </SceneMono>
            <span
              className="flex items-center"
              style={{ height: '19px', padding: '0 7px', borderRadius: '5px', fontSize: '10.5px', ...statusStyle }}
            >
              {statusLabel}
            </span>
          </span>
        </div>

        {/* 底部浮层：prompt + 逐条动作（改这句 / 重新生成 —— 都是就地操作，不跳页） */}
        <div
          className="absolute"
          style={{
            left: '6px',
            right: '6px',
            bottom: 0,
            padding: '22px 9px 9px',
            background: SCENE.scrimBottom,
            borderRadius: '0 0 8px 8px',
          }}
        >
          <div style={{ fontSize: '11.5px', lineHeight: 1.6, color: SCENE.captionFg }}>{card.prompt}</div>
          <div className="flex items-center gap-1.5" style={{ marginTop: '8px' }}>
            {actions.map((label, i) => (
              <span
                key={label}
                className="flex items-center gap-1"
                style={{
                  height: '22px',
                  padding: '0 8px',
                  borderRadius: '6px',
                  background: SCENE.line,
                  fontSize: '11px',
                  color: SCENE.captionFg,
                }}
              >
                <SceneIcon
                  d={i === 0 ? 'M18.4 2.6a2 2 0 0 1 3 3L9 18l-4 1 1-4zM14 6l4 4' : 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6'}
                  size={11}
                  strokeWidth={2}
                />
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
