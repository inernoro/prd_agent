import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { enterAt, useSceneTimeline } from './useSceneTimeline';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useLanguage } from '../contexts/LanguageContext';
import { useLandingAsset } from '../hooks/useLandingAssets';
import { SceneCursor, SelectionSweep, type CursorSpot } from '../components/SceneCursor';
import type { LiteraryStyleKey } from '../i18n/landing';

/**
 * LiteraryScene —— 文学创作：左边文章逐段成稿，右边 384px 竖向配图工作台。
 *
 * 和第一幕同构：**开局只有文字，一张图都没有**，滚到这里才开始演——
 * 文档就位 → AI 通读全文打配图锚点（已识别 1…6 个位置）→ 一次生成全部 →
 * 配图逐张完成并**落进正文对应段落**（正文里的虚线槽位原地变成图，
 * 这是「出图后自动落进这里」最要紧的一下）→ 最后换一次风格，整列重配、正文不动。
 *
 * 照真实面板复刻的结构：段落左侧 gutter 可打锚点；右侧是竖列而不是网格
 * （步骤条 → 主按钮 → 配置行 → 工具行 → 流式状态条 → 一列 4:3 配图卡）。
 */

const pine = inkTone(SCENE_HUE.pine);
const amber = inkTone(SCENE_HUE.amber);
const clay = inkTone(SCENE_HUE.clay);

/** 四个风格分别落在墨带的钢青 / 陶土 / 松绿 / 钢蓝，禁止漂出八色带。 */
/**
 * 四个风格分别落在墨带的钢青 / 陶土 / 松绿 / 钢蓝。
 * 饱和与明度必须在同一档（28-34 / 22-28）——只换色相，这是「彩而不乱」的前提。
 * 陶土原本给到 46/32，四张并排时它一个人跳出来，像另一套配色，已收回档内。
 */
const STYLE_PALETTE: Record<LiteraryStyleKey, [number, number, number]> = {
  calm: [SCENE_HUE.steel, 30, 26],
  warm: [SCENE_HUE.clay, 34, 28],
  forest: [SCENE_HUE.pine, 28, 24],
  night: [SCENE_HUE.slate, 34, 22],
};
const STYLE_ORDER: LiteraryStyleKey[] = ['calm', 'warm', 'forest', 'night'];

/**
 * 第 3 拍是**只让手走过去**的空拍，不发生任何事。理由同视觉幕：效果在一拍的第 0
 * 毫秒发生，而指针飞过来要走位时长，挤在同一拍就成了「还没点到就已经生成了」。
 */
const HOLDS = [
  1100, // 0 只有文字
  900,  // 1 文档就位
  2400, // 2 通读打锚点
  560,  // 3 手移到「生成全部配图」（空拍，只走位）
  1100, // 4 点生成
  1600, // 5 配图 1 落位
  1600, // 6 配图 2 落位
  1500, // 7 配图 3 还在跑
  2200, // 8 换风格
];
const B = { idle: 0, uploaded: 1, marking: 2, reachGen: 3, generating: 4, fig1: 5, fig2: 6, fig3: 7, restyle: 8 } as const;

/** 拍号 → 旁白第几句。走位空拍不换句，沿用上一拍那句。 */
const NARRATION_AT = [0, 1, 2, 2, 3, 4, 5, 6, 7];

interface Tone { bg: string; mid: string; fg: string }

function toneOf(key: LiteraryStyleKey, shift = 0): Tone {
  const [h, s, l] = STYLE_PALETTE[key];
  return {
    bg: `hsl(${h} ${s}% ${l + shift}%)`,
    mid: `hsl(${h} ${s + 6}% ${l + shift + 15}%)`,
    fg: `hsl(${h} ${Math.min(64, s + 16)}% ${l + shift + 40}%)`,
  };
}

const CARD_SHAPE = [
  { sun: 268, shift: 0, doneAt: B.fig1 },
  { sun: 186, shift: 4, doneAt: B.fig2 },
  { sun: 104, shift: -3, doneAt: 99 }, // 第三张一直在跑：给已耗时与预计，不给假百分比
];

/** 某张配图卡此刻是什么状态。生成的那一拍是「上一张完成的前一拍」。 */
function cardState(index: number, beat: number): 'idle' | 'running' | 'done' {
  const doneAt = CARD_SHAPE[index].doneAt;
  if (beat >= doneAt) return 'done';
  if (beat >= B.generating + index) return 'running';
  return 'idle';
}

const CONFIG_ICONS = [
  'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
  'M21 15l-5-5L5 21M3 5h18v14H3z',
  'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
];

export function LiteraryScene() {
  const { t } = useLanguage();
  const s = t.scenes.literary;
  const { beat, ref } = useSceneTimeline(HOLDS);
  const [style, setStyle] = useState<LiteraryStyleKey>('calm');
  const tone = toneOf(style);
  const marked = useMarkCounter(beat === B.marking, 6, HOLDS[B.marking]);

  /** 换风格那一拍自动切一次，让人看见整列重配；用户手点随时可以接管 */
  const touched = useRef(false);
  useEffect(() => {
    if (beat === B.restyle && !touched.current) {
      setStyle((prev) => STYLE_ORDER[(STYLE_ORDER.indexOf(prev) + 1) % STYLE_ORDER.length]);
    }
    if (beat === B.idle) touched.current = false;
  }, [beat]);

  // 指针只在 lg 以上画：窄屏下左右两栏摞成上下，配图卡不在指针那套坐标系里
  const { isDesktop } = useBreakpoint();

  /**
   * 换风格那两拍的落点：指针要**提前一拍**停在即将被点亮的那枚 chip 上，
   * 到 restyle 那拍才原地按下 —— 否则又是「颜色先变、指针后到」。
   * fig3 拍时 style 还是旧值，算出来的下一档正好就是 restyle 会切到的那档。
   */
  const [aimStyle, setAimStyle] = useState<LiteraryStyleKey>(() => STYLE_ORDER[1]);
  useEffect(() => {
    if (beat === B.fig3) setAimStyle(STYLE_ORDER[(STYLE_ORDER.indexOf(style) + 1) % STYLE_ORDER.length]);
  }, [beat, style]);

  const cursorSpot: CursorSpot | null =
    beat === B.fig3 ? { target: `style-${aimStyle}` }
      : beat === B.restyle ? { target: `style-${aimStyle}`, press: true }
        : CURSOR_AT[beat] ?? null;

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
      <div ref={ref} className="relative">
        {/* 演示指针：窄屏不画（小屏没有鼠标，画一枚箭头反而突兀）。
            挂在这一层是因为它要同时够得着顶栏的风格 chip 和下面正文里的段落。 */}
        {isDesktop && <SceneCursor spot={cursorSpot} beat={beat} />}
        {/* 风格切换：这一幕唯一的杠杆，摆在面板顶部让人一眼看见 */}
        <div className="relative flex items-center gap-2 flex-wrap" style={{ padding: '12px 14px', borderBottom: `1px solid ${SCENE.hair}` }}>
          <SceneMono style={{ letterSpacing: '0.18em', textTransform: 'uppercase' }}>{s.styleLabel}</SceneMono>
          {STYLE_ORDER.map((key) => {
            const on = key === style;
            return (
              <button
                key={key}
                type="button"
                data-cursor-target={`style-${key}`}
                onClick={() => { touched.current = true; setStyle(key); }}
                aria-pressed={on}
                style={{
                  height: '26px', padding: '0 11px', borderRadius: '7px', fontSize: '12px', cursor: 'pointer',
                  background: on ? pine.soft : SCENE.ghost,
                  border: `1px solid ${on ? pine.border : SCENE.line}`,
                  color: on ? pine.bright : SCENE.inkDim,
                  transition: 'background .3s ease, border-color .3s ease, color .3s ease',
                }}
              >
                {s.styles[key]}
              </button>
            );
          })}
          <span className="ml-auto hidden sm:block" style={{ fontSize: '11.5px', color: SCENE.inkFaint }}>{s.styleHint}</span>
        </div>

        <div className="relative flex flex-col lg:flex-row lg:h-[680px] gap-4" style={{ padding: '14px' }}>
          {/* ── 左：文章编辑器 ── */}
          <div
            className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden rounded-2xl"
            style={{ border: `1px solid ${SCENE.edge}`, background: SCENE.editorSurface }}
          >
            <div className="flex items-center gap-2.5 shrink-0" style={{ height: '48px', padding: '0 16px', borderBottom: `1px solid ${SCENE.hair}` }}>
              <span className="flex items-center justify-center" style={{ color: SCENE.inkDim }}>
                <SceneIcon d="M19 12H5M11 18l-6-6 6-6" size={15} strokeWidth={1.9} />
              </span>
              <span className="flex items-center" style={{ color: SCENE.inkSoft }}>
                <SceneIcon d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6" size={15} />
              </span>
              <span data-cursor-target="doc-title" style={{ fontSize: '13.5px', color: SCENE.ink, whiteSpace: 'nowrap', ...enterAt(beat, B.uploaded, { rise: 4 }) }}>
                {s.fileName}
              </span>
              <SceneMono className="ml-auto hidden md:flex items-center gap-2.5">
                <span className="block w-[5px] h-[5px] rounded-full" style={{ background: pine.solid }} />
                {s.model}
                <span className="block" style={{ width: '1px', height: '12px', background: SCENE.line }} />
                {s.pool}
              </SceneMono>
            </div>

            {/* overflow-hidden 是必须的：正文比这块高，不裁就会顶穿底部的产出小结那一条 */}
            <div
              className="flex-1 min-h-0 overflow-hidden"
              style={{ padding: '24px 30px', fontFamily: 'var(--font-serif)', fontSize: '15.5px', lineHeight: 2.05, color: SCENE.inkSoft }}
            >
              <Paragraph anchorAt={B.marking} beat={beat} sweep>{s.body.p1}</Paragraph>

              {/* 配图 1 落进正文 */}
              <FigureSlot beat={beat} at={B.fig1} tone={tone} caption={s.body.fig1} variant="ridge" hint={s.body.slot.replace('{n}', '1')} showHintFrom={B.marking} />

              <Paragraph anchorAt={B.marking} beat={beat} delay={140}>{s.body.p2}</Paragraph>

              {/* 配图 2：先是虚线槽位，到点原地变成图——「出图后自动落进这里」 */}
              <FigureSlot beat={beat} at={B.fig2} tone={tone} caption={s.body.fig2} variant="bridge" hint={s.body.slot.replace('{n}', '2')} showHintFrom={B.marking} />

              <Paragraph anchorAt={B.marking} beat={beat} delay={280}>{s.body.p3}</Paragraph>
              <div className="hidden md:block">
                <Paragraph anchorAt={B.marking} beat={beat} delay={420} last>{s.body.p4}</Paragraph>
              </div>
            </div>

            <SceneMono
              className="flex items-center gap-4 shrink-0 flex-wrap"
              size={15}
              style={{ minHeight: '44px', padding: '0 30px', borderTop: `1px solid ${SCENE.hair}` }}
            >
              <span>{s.summary.words}</span>
              <span>{s.summary.paragraphs}</span>
              <span>{s.summary.figures}</span>
              <span className="ml-auto" style={{ color: pine.solid, transition: 'color .4s ease' }}>
                {s.summary.currentStyle} {s.styles[style]}
              </span>
            </SceneMono>
          </div>

          {/* ── 右：配图工作台（384px 竖列） ── */}
          <div className="w-full lg:w-[384px] lg:shrink-0 flex flex-col gap-3 min-h-0">
            <div style={{ border: `1px solid ${SCENE.edge}`, borderRadius: '14px', background: SCENE.ghost, padding: '14px' }}>
              <div className="flex items-center">
                {s.steps.map((step, i) => {
                  const done = beat > B.uploaded + i * 1 && i < 1 ? true : i === 0 ? beat >= B.uploaded : i === 1 ? beat >= B.generating : beat >= B.fig1;
                  const active = i === 0 ? beat < B.uploaded : i === 1 ? beat >= B.uploaded && beat < B.generating : beat >= B.generating && beat < B.fig1;
                  const bg = done ? pine.soft : active ? clay.soft : SCENE.ghost;
                  const border = done ? pine.border : active ? clay.border : SCENE.line;
                  const fg = done ? pine.bright : active ? clay.bright : SCENE.inkFaint;
                  return (
                    <span key={step} className="flex items-center flex-1 last:flex-none min-w-0">
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span
                          className="flex items-center justify-center"
                          style={{
                            width: '20px', height: '20px', borderRadius: '50%', fontSize: '10.5px',
                            background: bg, border: `1px solid ${border}`, color: fg,
                            transition: 'background .4s ease, border-color .4s ease, color .4s ease',
                          }}
                        >
                          {done ? <SceneIcon d="M20 6L9 17l-5-5" size={11} strokeWidth={2.4} /> : i + 1}
                        </span>
                        <span style={{ fontSize: '12px', whiteSpace: 'nowrap', color: done ? SCENE.inkMid : active ? SCENE.ink : SCENE.inkFaint, transition: 'color .4s ease' }}>
                          {step}
                        </span>
                      </span>
                      {i < s.steps.length - 1 && (
                        <span className="flex-1" style={{ height: '1px', background: done ? pine.border : SCENE.edge, margin: '0 8px', transition: 'background .4s ease' }} />
                      )}
                    </span>
                  );
                })}
              </div>

              <div
                data-cursor-target="generate-all"
                className="flex items-center justify-center gap-1.5"
                style={{
                  marginTop: '13px', height: '34px', borderRadius: '9px',
                  background: SCENE.brand, color: SCENE.brandFg, fontSize: '13px',
                  transform: beat === B.generating ? 'scale(0.965)' : 'scale(1)',
                  boxShadow: beat === B.generating ? `0 0 0 4px ${clay.soft}` : 'none',
                  transition: 'transform .3s cubic-bezier(.19,1,.22,1), box-shadow .3s ease',
                }}
              >
                <SceneIcon d="M12 3l1.9 4.4L18 9l-4.1 1.6L12 15l-1.9-4.4L6 9l4.1-1.6zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" size={14} strokeWidth={1.9} />
                {s.primaryAction}
              </div>

              <div className="flex items-center gap-1.5" style={{ marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${SCENE.hair}` }}>
                <SceneIcon
                  d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
                  size={14} strokeWidth={1.7} style={{ color: SCENE.inkFaint }}
                />
                {s.configPills.map((label, i) => {
                  const on = i === 1;
                  return (
                    <span
                      key={label}
                      className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden"
                      style={{
                        height: '26px', borderRadius: '7px', padding: '0 8px',
                        background: on ? pine.soft : SCENE.ghost,
                        border: `1px solid ${on ? pine.border : SCENE.edge}`,
                        fontSize: '11.5px', color: on ? pine.bright : SCENE.inkDim, whiteSpace: 'nowrap',
                      }}
                    >
                      <SceneIcon d={CONFIG_ICONS[i]} size={12} />
                      {i === 1 ? s.styles[style] : label}
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <span style={{ height: '28px', padding: '0 11px', borderRadius: '7px', background: pine.soft, border: `1px solid ${pine.border}`, color: pine.solid, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <SceneIcon d="M12 3l1.9 4.4L18 9l-4.1 1.6L12 15l-1.9-4.4L6 9l4.1-1.6z" size={12} strokeWidth={1.9} />
                {s.tools.generate}
              </span>
              <span style={{ height: '28px', padding: '0 11px', borderRadius: '7px', background: SCENE.ghost, border: `1px solid ${SCENE.edge}`, color: SCENE.inkMid, fontSize: '12px', display: 'flex', alignItems: 'center' }}>
                {s.tools.size}
              </span>
              <span className="ml-auto flex items-center gap-1.5" style={{ height: '28px', padding: '0 11px', borderRadius: '7px', background: SCENE.ghost, border: `1px solid ${SCENE.edge}`, color: SCENE.inkMid, fontSize: '12px' }}>
                <SceneIcon d="M12 3v12m0 0l4-4m-4 4l-4-4M4 19h16" size={12} strokeWidth={1.9} />
                {s.tools.pack}
              </span>
            </div>

            {/* 流式状态条：只在通读打锚点那一拍出现，数字实时往上走 */}
            <div
              className="flex items-center gap-2.5 overflow-hidden"
              style={{
                padding: beat === B.marking ? '9px 11px' : '0 11px',
                height: beat === B.marking ? undefined : 0,
                opacity: beat === B.marking ? 1 : 0,
                borderRadius: '9px',
                background: amber.faint,
                border: `1px solid ${beat === B.marking ? amber.border : 'transparent'}`,
                fontSize: '12px',
                color: amber.bright,
                transition: 'opacity .4s ease, height .4s ease, padding .4s ease',
              }}
            >
              <span
                className="block shrink-0 map-scene-anim"
                style={{ width: '13px', height: '13px', borderRadius: '50%', background: amber.solid, animation: 'mapSceneTwinkle 1.8s ease-in-out infinite' }}
              />
              {s.marking.replace('{n}', String(marked))}
            </div>

            {/*
              * 手机上改两列：单列时每张卡按 4/3 撑到近 260px 高，三张连着就是
              * 一屏半的空框（配图还没生成时更明显）。两列后每张约 120px，
              * 整段从 ~800px 收到 ~280px。宽屏维持单列纵向排布不变。
              */}
            <div className="grid grid-cols-2 gap-3 lg:flex lg:flex-col lg:flex-1 lg:min-h-0 lg:overflow-hidden">
              {CARD_SHAPE.map((shape, i) => (
                <FigureCard
                  key={s.cards[i].prompt}
                  index={i + 1}
                  shape={shape}
                  state={cardState(i, beat)}
                  tone={toneOf(style, shape.shift)}
                  card={s.cards[i]}
                  statusLabel={s.status[cardState(i, beat)]}
                  actions={s.cardActions}
                  runningLabel={s.runningLabel}
                />
              ))}
            </div>
          </div>
        </div>

        <BeatNarration beats={s.beats} beat={NARRATION_AT[beat] ?? s.beats.length - 1} hue={SCENE_HUE.pine} />
      </div>
    </SceneFrame>
  );
}

/** 打锚点那一拍，已识别位置数从 1 走到 total，跟着这一拍的时长走完。 */
function useMarkCounter(active: boolean, total: number, durationMs: number): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!active) { setN(0); return undefined; }
    let i = 0;
    const step = Math.max(160, Math.floor(durationMs / total));
    const id = setInterval(() => {
      i += 1;
      setN(i);
      if (i >= total) clearInterval(id);
    }, step);
    return () => clearInterval(id);
  }, [active, total, durationMs]);
  return Math.max(1, n);
}

function Paragraph({
  children, beat, anchorAt, delay = 0, last = false, sweep = false,
}: { children: ReactNode; beat: number; anchorAt: number; delay?: number; last?: boolean; sweep?: boolean }) {
  return (
    <div className="relative" style={{ marginBottom: last ? 0 : '20px' }}>
      {/* gutter 锚点：AI 通读到这一段时才点亮，逐段错峰，像有人在逐段读 */}
      <span
        className="absolute hidden xl:block text-center"
        style={{
          left: '-22px', top: '12px', width: '15px', height: '15px', borderRadius: '50%',
          border: `1px solid ${pine.border}`, color: pine.solid,
          fontSize: '11px', lineHeight: '13px', fontFamily: 'var(--font-body)',
          ...enterAt(beat, anchorAt, { rise: 0, delay }),
        }}
      >
        +
      </span>
      {/* 划选：指针扫过这一段时底色跟着铺开，让「选中」这件事看得见 */}
      {sweep ? (
        <SelectionSweep active={beat >= anchorAt} hue={pine.soft} targetId="para-1">{children}</SelectionSweep>
      ) : (
        children
      )}
    </div>
  );
}

/**
 * 正文里的配图位。到点之前是虚线槽位（位置先留好），到点原地换成图。
 * 这一下是这一幕的核心动作：产物不是在别处出现，是**落进它该在的段落之间**。
 */
function FigureSlot({
  beat, at, tone, caption, variant, hint, showHintFrom = 0,
}: {
  beat: number; at: number; tone: Tone; caption: string; variant: 'ridge' | 'bridge'; hint: string; showHintFrom?: number;
}) {
  const placed = beat >= at;
  if (!placed) {
    const visible = beat >= showHintFrom;
    return (
      <div
        className="flex items-center justify-center gap-2.5"
        style={{
          margin: '0 0 20px',
          height: visible ? '62px' : '0px',
          opacity: visible ? 1 : 0,
          borderRadius: '10px',
          border: `1.5px dashed ${pine.border}`,
          borderWidth: visible ? '1.5px' : '0px',
          fontFamily: 'var(--font-body)', fontSize: '12.5px', color: SCENE.inkDim, textAlign: 'center',
          overflow: 'hidden',
          transition: 'height .45s cubic-bezier(.19,1,.22,1), opacity .35s ease',
        }}
      >
        <SceneIcon d="M21 15l-5-5L5 21M3 5h18v14H3z" size={15} strokeWidth={1.7} style={{ opacity: 0.7 }} />
        {hint}
      </div>
    );
  }
  return <InlineFigure tone={tone} caption={caption} variant={variant} />;
}


/**
 * 指针走位表：每一拍只说**指向谁**，落点由 SceneCursor 当场量那个元素。
 *
 * 这一幕的动作顺序是「划中一句 → 按下生成 → 图逐张落位 → 换风格」，指针必须踩着
 * 同一条顺序走，而且**先到位再发生**：`marking` 那一拍指针停在被划中那段的句尾，
 * 选区底色跟着铺开；`generating` 那一拍压在「生成全部配图」上，图才开始出。
 *
 * 换风格那两拍不在这张表里 —— 目标是「即将被点亮的那枚 chip」，得看当前风格算，
 * 见 `LiteraryStage` 里的 `cursorSpot`。
 */
const CURSOR_AT: Record<number, CursorSpot> = {
  [B.idle]: { target: 'doc-title', hidden: true },
  [B.uploaded]: { target: 'doc-title' },
  // 落在被划中那段的句尾：选区从左铺到右，手停在右下角，跟真的划完一句一样
  [B.marking]: { target: 'para-1', ax: 1, ay: 0.6 },
  [B.reachGen]: { target: 'generate-all' },                // 空拍：手走到按钮上
  [B.generating]: { target: 'generate-all', press: true }, // 原地按下，配图才开始出
  [B.fig1]: { target: 'card-1' },
  [B.fig2]: { target: 'card-2' },
};

/**
 * 右侧生成卡对应的真实照片槽位（按卡序号 1 起）。
 * 第 3 张在这一幕里一直停在「生成中」，本来就没有产物图，所以只有两条。
 */
const CARD_SLOT: Record<number, string> = {
  1: 'landing.literary.ridge',
  2: 'landing.literary.larch',
};

/** 正文里那张配图对应的真实照片槽位。没生成就回落到手绘底图。 */
const INLINE_FIGURE_SLOT: Record<'ridge' | 'bridge', string> = {
  ridge: 'landing.literary.ridge',
  bridge: 'landing.literary.bridge',
};

function InlineFigure({ tone, caption, variant }: { tone: Tone; caption: string; variant: 'ridge' | 'bridge' }) {
  const gid = `mapLitFig-${variant}`;
  const photo = useLandingAsset(INLINE_FIGURE_SLOT[variant]);
  return (
    <div
      style={{
        margin: '0 0 20px', borderRadius: '10px', overflow: 'hidden', border: `1px solid ${SCENE.edge}`,
        animation: 'mapSceneLand .6s cubic-bezier(.19,1,.22,1) both',
      }}
    >
      {photo ? (
        <StyledPhoto src={photo} tone={tone} height={variant === 'ridge' ? 132 : 112} />
      ) : (
      <svg
        viewBox="0 0 600 132"
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height: variant === 'ridge' ? '132px' : '112px' }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`${gid}-sky`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={variant === 'ridge' ? tone.mid : tone.bg} style={{ transition: 'stop-color .55s ease' }} />
            <stop offset="1" stopColor={variant === 'ridge' ? tone.bg : tone.mid} style={{ transition: 'stop-color .55s ease' }} />
          </linearGradient>
          <radialGradient id={`${gid}-sun`} cx="0.72" cy="0.26" r="0.5">
            <stop offset="0" stopColor={tone.fg} stopOpacity="0.34" style={{ transition: 'stop-color .55s ease' }} />
            <stop offset="1" stopColor={tone.fg} stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="600" height="132" fill={`url(#${gid}-sky)`} />
        <rect width="600" height="132" fill={`url(#${gid}-sun)`} />
        {/* 山脊压在天空之上必须更暗：两道都用比天空亮的色会糊成一块平色 */}
        <path d="M0 80 L118 50 L232 82 L346 46 L472 78 L600 56 L600 132 L0 132 Z" fill={tone.bg} opacity="0.7" style={{ transition: 'fill .55s ease' }} />
        <path d="M0 102 L140 86 L280 108 L420 88 L600 110 L600 132 L0 132 Z" fill={tone.bg} style={{ transition: 'fill .55s ease' }} />
        {variant === 'bridge' && <rect x="238" y="96" width="124" height="6" rx="3" fill={tone.fg} opacity="0.42" style={{ transition: 'fill .55s ease' }} />}
      </svg>
      )}
      <div style={{ padding: '7px 11px', fontFamily: 'var(--font-body)', fontSize: '11px', color: SCENE.inkDim, background: SCENE.faintFill }}>
        {caption}
      </div>
    </div>
  );
}

/**
 * 带风格色的真实照片。
 *
 * 这一幕演的是「切一下风格，整列配图连同正文内联图一起换色，文字不动」。手绘底图靠改
 * SVG 的 fill 就能换色；换成真照片之后必须自己把这件事补回来，否则切风格时控件动了、
 * 图没动，这一幕就当场失效（`miduo-review-lens` 镜头 4：变化必须可感知）。
 *
 * 做法是在照片上盖一层当前风格色、用 `color` 混合模式 —— 它只替换色相与饱和度、保留
 * 原图明度，所以山脊、雾、木纹这些结构还在，只是整体转到了这一档风格的色调上。
 * 和 SVG 那版共用同一条 .55s 过渡，切换时两种底图的节奏对得上。
 */
function StyledPhoto({ src, tone, height }: { src: string; tone: Tone; height: number }) {
  return (
    <div className="relative block w-full" style={{ height: `${height}px`, overflow: 'hidden' }}>
      <StyledPhotoFill src={src} tone={tone} />
    </div>
  );
}

/** 撑满父容器的那一版，父容器负责定尺寸（内联配图给固定高，右侧卡给 4:3）。 */
function StyledPhotoFill({ src, tone }: { src: string; tone: Tone }) {
  return (
    <div className="relative w-full h-full">
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        className="block w-full h-full"
        style={{ objectFit: 'cover' }}
      />
      <span
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background: tone.mid,
          mixBlendMode: 'color',
          // 0.34 而不是 0.72：0.72 会把照片洗成一块单色，看着又变回「贴图」了，
          // 而这几张的全部意义就是「这是真照片」。压到三成左右，切风格时色调仍然
          // 明显在变，但山脊、雾、木纹的固有色还在。
          opacity: 0.34,
          transition: 'background-color .55s ease',
        }}
      />
    </div>
  );
}

function FigureCard({
  index, shape, state, tone, card, statusLabel, actions, runningLabel,
}: {
  index: number;
  shape: (typeof CARD_SHAPE)[number];
  state: 'idle' | 'running' | 'done';
  tone: Tone;
  card: { size: string; prompt: string };
  statusLabel: string;
  actions: string[];
  runningLabel: string;
}) {
  const photo = useLandingAsset(CARD_SLOT[index] ?? '');
  const statusStyle =
    state === 'done' ? { background: pine.soft, color: pine.bright }
      : state === 'running' ? { background: amber.soft, color: amber.bright }
        : { background: SCENE.line, color: SCENE.inkMid };

  return (
    <div data-cursor-target={`card-${index}`} className="relative overflow-hidden shrink-0" style={{ borderRadius: '12px', border: `1px solid ${SCENE.hair}`, background: SCENE.ghost }}>
      <div className="relative" style={{ padding: '6px 6px 0', background: SCENE.mediaWell, boxSizing: 'border-box' }}>
        {state === 'done' && photo && (
          <div style={{ aspectRatio: '4 / 3', borderRadius: '8px', overflow: 'hidden', animation: 'mapSceneLand .55s cubic-bezier(.19,1,.22,1) both' }}>
            <StyledPhotoFill src={photo} tone={tone} />
          </div>
        )}

        {state === 'done' && !photo && (
          <svg
            viewBox="0 0 372 282"
            preserveAspectRatio="none"
            className="block w-full"
            style={{ aspectRatio: '4 / 3', borderRadius: '8px', animation: 'mapSceneLand .55s cubic-bezier(.19,1,.22,1) both' }}
            aria-hidden="true"
          >
            {/* fill 走 CSS transition：换风格时如果是零中间帧硬切，控件动了产物没动，
                「变化可感知」就落空了（验收 D5 抓到过这一条） */}
            <rect width="372" height="282" fill={tone.mid} style={{ transition: 'fill .55s ease' }} />
            <circle cx={shape.sun} cy="66" r="88" fill={tone.fg} opacity="0.22" style={{ transition: 'fill .55s ease' }} />
            <path d="M0 176 L74 128 L146 178 L214 122 L292 176 L372 138 L372 282 L0 282 Z" fill={tone.bg} opacity="0.72" style={{ transition: 'fill .55s ease' }} />
            <path d="M0 218 L88 190 L176 222 L268 192 L372 224 L372 282 L0 282 Z" fill={tone.bg} style={{ transition: 'fill .55s ease' }} />
          </svg>
        )}

        {state === 'running' && (
          <div className="flex flex-col items-center justify-center gap-3" style={{ aspectRatio: '4 / 3', borderRadius: '8px', background: SCENE.base }}>
            <span
              className="block map-scene-anim"
              style={{ width: '54px', height: '54px', borderRadius: '50%', background: tone.mid, animation: 'mapSceneTwinkle 2.2s ease-in-out infinite' }}
            />
            <SceneMono size={15} color={SCENE.inkDim}>{runningLabel}</SceneMono>
          </div>
        )}

        {state === 'idle' && (
          <div className="flex items-center justify-center" style={{ aspectRatio: '4 / 3', borderRadius: '8px' }}>
            <div
              className="flex items-center justify-center"
              style={{ width: '58%', aspectRatio: '4 / 3', borderRadius: '9px', background: SCENE.faintFill, border: `1.5px dashed ${SCENE.edgeStrong}`, color: SCENE.inkGhost }}
            >
              <SceneIcon d="M21 15l-5-5L5 21M3 5h18v14H3z" size={20} strokeWidth={1.6} />
            </div>
          </div>
        )}

        <div
          className="absolute flex items-center justify-between"
          style={{ top: '6px', left: '6px', right: '6px', height: '30px', padding: '0 9px', borderRadius: '8px 8px 0 0', background: SCENE.scrimTop }}
        >
          <span style={{ fontSize: '11.5px', color: SCENE.captionFg }}>{index}</span>
          <span className="flex items-center gap-1.5">
            <SceneMono size={13} color={SCENE.captionFg} style={{ letterSpacing: '0.08em', opacity: 0.72 }}>{card.size}</SceneMono>
            <span
              className="flex items-center"
              style={{ height: '19px', padding: '0 7px', borderRadius: '5px', fontSize: '10.5px', transition: 'background .4s ease, color .4s ease', ...statusStyle }}
            >
              {statusLabel}
            </span>
          </span>
        </div>

        {state === 'done' && (
          <div
            className="absolute"
            style={{ left: '6px', right: '6px', bottom: 0, padding: '22px 9px 9px', background: SCENE.scrimBottom, borderRadius: '0 0 8px 8px' }}
          >
            <div style={{ fontSize: '11.5px', lineHeight: 1.6, color: SCENE.captionFg }}>{card.prompt}</div>
            <div className="flex items-center gap-1.5" style={{ marginTop: '8px' }}>
              {actions.map((label, i) => (
                <span
                  key={label}
                  className="flex items-center gap-1"
                  style={{ height: '22px', padding: '0 8px', borderRadius: '6px', background: SCENE.line, fontSize: '11px', color: SCENE.captionFg }}
                >
                  <SceneIcon d={i === 0 ? 'M18.4 2.6a2 2 0 0 1 3 3L9 18l-4 1 1-4zM14 6l4 4' : 'M21 12a9 9 0 1 1-3-6.7M21 3v6h-6'} size={11} strokeWidth={2} />
                  {label}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
