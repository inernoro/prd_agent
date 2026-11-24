import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import type { SceneVariant } from './SceneFrame';
import { SCENE, SCENE_HUE, galaxyBackdrop, inkTone } from './sceneTokens';
import { enterAt, useSceneTimeline } from './useSceneTimeline';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { SceneCursor, SelectionSweep, type CursorSpot } from '../components/SceneCursor';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * KnowledgeScene —— 知识库：照 `components/doc-browser/DocBrowser.tsx` 的真实三栏复刻。
 *
 * 三栏是（左）文件树 /（中）正文 /（右）本页章节；左栏搜索与筛选**只占一行**，
 * 条目两行，徽章走真实那几种（已分享 / 再加工中 / 通过 L1 / tag）。
 *
 * 划词浮层真实只有三个动作：评论 / AI 改写 / 配图。
 * （早期提示词里写过「扩写 / 建双链 / 提问」——那是编的，读了源码之后删了。
 *  `no-rootless-tree`：不假定不存在的能力。）
 * AI 改写走流式 + diff 预览，**确认才落库，原文不动**。
 *
 * 下半段是知识星系（DocumentGalaxyView）：根 → 分类 → 文档的二次贝塞尔弧线，
 * 横向引用是拱高更大的能量弧。坐标全部手排，不用 Math.random——这一屏必须每次都一样。
 */

/**
 * 这一幕复刻的是哪个真实页面。**不是注释，是判据**：
 * 守卫会拿它去核对「demo 里演的功能，真实页面到底有没有」——
 * 我先后编过一条不存在的顶部风格条、和一个文学创作根本没有的划词选区，
 * 两次都是用户一眼看出来的，源码里没有任何东西拦得住。
 */
export const MIRRORS = 'src/components/doc-browser/DocBrowser.tsx';

const olive = inkTone(SCENE_HUE.olive);

const FOLDER_ICON = 'M4 5a2 2 0 0 1 2-2h3l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z';
const FILE_ICON = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6';

/** 左栏条目的结构（文案在 i18n，形状在这里）。 */
const TREE_SHAPE = [
  { at: 0, folder: true, indent: 0, badges: [] as string[] },
  { at: 1, folder: false, indent: 1, badges: ['tag', 'shared'], active: true },
  { at: 2, folder: false, indent: 1, badges: [] as string[], fresh: true },
  { at: 4, folder: true, indent: 0, badges: [] as string[] },
  { at: 5, folder: false, indent: 1, badges: ['pass'] },
  { at: 6, folder: false, indent: 1, badges: ['redo'] },
] as const;

/** 每一拍停多久（ms）。 */
const HOLDS = [1500, 1200, 900, 1300, 2300, 2000];
const B = { reading: 0, selecting: 1, popover: 2, tapped: 3, streaming: 4, replaced: 5 } as const;

/** 要等手真的落到目标上才开始的拍（理由见 useSceneTimeline 的 gates 说明）。 */
const GATED = new Set<number>([B.selecting, B.tapped]);

/**
 * 指针走位表。这一幕是全篇动作最密的一段，顺序必须严格照旁白走：
 * 划中那一句（手停在句末，像刚拖完选区）→ 浮层弹出后手移到「AI 改写」上
 * → 下一拍才按下去 → 改写在流、手退开不挡着看。
 */
const CURSOR_AT: Record<number, CursorSpot> = {
  // 读的时候手就搭在这句话上，下一拍才划中它 —— 不能等到按下那一拍才飞过来
  [B.reading]: { target: 'selected-sentence', ax: 1, ay: 0.6 },
  [B.selecting]: { target: 'selected-sentence', ax: 1, ay: 0.6, press: true },
  [B.popover]: { target: 'rewrite-action' },     // 浮层出来了，手先移过去
  [B.tapped]: { target: 'rewrite-action', press: true },
};

const BADGE_TONE: Record<string, { bg: string; fg: string }> = {
  shared: { bg: inkTone(176).soft, fg: inkTone(176).bright },
  redo: { bg: inkTone(SCENE_HUE.amber).soft, fg: inkTone(SCENE_HUE.amber).bright },
  pass: { bg: inkTone(SCENE_HUE.pine).soft, fg: inkTone(SCENE_HUE.pine).bright },
  tag: { bg: SCENE.tile, fg: SCENE.inkMid },
};

/** 银心 + 三个一级枢纽 + 叶子。坐标手排，画布必须可复现。 */
const NODES = [
  { x: 692, y: 156, r: 9 },
  { x: 496, y: 108, r: 6 },
  { x: 878, y: 122, r: 6 },
  { x: 640, y: 236, r: 6 },
  { x: 372, y: 74, r: 3.4 },
  { x: 404, y: 156, r: 3.4 },
  { x: 566, y: 62, r: 3.4 },
  { x: 984, y: 78, r: 3.4 },
  { x: 1010, y: 168, r: 3.4 },
  { x: 802, y: 62, r: 3.4 },
  { x: 528, y: 262, r: 3.4 },
  { x: 754, y: 268, r: 3.4 },
];

/** 星系节点只走墨带八色相里的四支，禁止漂出去。 */
const NODE_HUES = [SCENE_HUE.slate, SCENE_HUE.steel, SCENE_HUE.olive, SCENE_HUE.pine];

function arc(a: (typeof NODES)[number], b: (typeof NODES)[number], lift: number, stroke: string, w: number) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 - lift;
  return { d: `M${a.x} ${a.y} Q${mx} ${my} ${b.x} ${b.y}`, stroke, w };
}

const hub = `hsla(${SCENE_HUE.slate}, 54%, 68%, 0.34)`;
const leafSteel = `hsla(${SCENE_HUE.steel}, 54%, 68%, 0.22)`;
const leafOlive = `hsla(${SCENE_HUE.olive}, 54%, 68%, 0.22)`;
const leafPine = `hsla(${SCENE_HUE.pine}, 54%, 68%, 0.22)`;
/** 横向引用（双链）：拱高更大的能量弧，走琥珀，一眼和树状层级分得开。 */
const crossLink = `hsla(${SCENE_HUE.amber}, 54%, 68%, 0.30)`;

const ARCS = [
  arc(NODES[0], NODES[1], 26, hub, 1.4),
  arc(NODES[0], NODES[2], 26, hub, 1.4),
  arc(NODES[0], NODES[3], 18, hub, 1.4),
  arc(NODES[1], NODES[4], 14, leafSteel, 1),
  arc(NODES[1], NODES[5], 12, leafSteel, 1),
  arc(NODES[1], NODES[6], 12, leafSteel, 1),
  arc(NODES[2], NODES[7], 14, leafOlive, 1),
  arc(NODES[2], NODES[8], 14, leafOlive, 1),
  arc(NODES[2], NODES[9], 12, leafOlive, 1),
  arc(NODES[3], NODES[10], 12, leafPine, 1),
  arc(NODES[3], NODES[11], 12, leafPine, 1),
  arc(NODES[4], NODES[9], 62, crossLink, 1.2),
  arc(NODES[10], NODES[8], 58, crossLink, 1.2),
];

/** 星场：确定性伪随机（不用 Math.random，这一屏每次必须长一样）。 */
const STARS = Array.from({ length: 34 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 12345.6789;
  const c = Math.sin(i * 39.425) * 24634.6345;
  return {
    x: (a - Math.floor(a)) * 100,
    y: (b - Math.floor(b)) * 100,
    size: 1 + (c - Math.floor(c)) * 1.4,
    opacity: 0.25 + (a - Math.floor(a)) * 0.5,
    duration: 2.4 + (b - Math.floor(b)) * 3.2,
  };
});

/** 阅读头只留三个主操作，其余收进「更多」——五个平铺在这么窄的中栏里就是噪音。 */
const READER_TOOL_ICONS = [
  'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  'M12 3l1.9 4.4L18 9l-4.1 1.6L12 15l-1.9-4.4L6 9l4.1-1.6z',
  'M21 15l-5-5L5 21M3 5h18v14H3z',
];

const SELECTION_ICONS = [
  'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  'M12 3l1.9 4.4L18 9l-4.1 1.6L12 15l-1.9-4.4L6 9l4.1-1.6z',
  'M21 15l-5-5L5 21M3 5h18v14H3z',
];

export function KnowledgeScene({ variant }: { variant?: SceneVariant }) {
  const { t } = useLanguage();
  const s = t.scenes.knowledge;
  // 必须在节拍器之前取：gates 要用它决定启不启用（不画指针就没人 release）
  const { isDesktop } = useBreakpoint();
  const { beat, ref, armed, release, visible } = useSceneTimeline(HOLDS, { gates: isDesktop ? GATED : undefined });

  return (
    <SceneFrame
      id="scene-knowledge"
      variant={variant}
      hue={SCENE_HUE.olive}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      {/* ── 三栏阅读器 ── */}
      <div ref={ref} className="relative flex" style={{ height: 'clamp(460px, 58vh, 620px)' }}>
        {/* 演示指针：这一幕旁白连写两个动作（划中一句话、点了 AI 改写），
            之前一只手都没有 —— 看的人只会觉得浮层自己冒出来。窄屏不画。 */}
        {isDesktop && <SceneCursor spot={CURSOR_AT[armed ?? beat] ?? null} beat={armed ?? beat} onArrive={release} />}
        {/* 左：文件树 */}
        <div
          className="hidden md:flex flex-col shrink-0 relative"
          style={{ width: '300px', borderRight: `1px solid ${SCENE.hair}` }}
        >
          {/* 搜索 + 筛选，只此一行 */}
          <div className="flex items-center gap-1.5 shrink-0" style={{ padding: '13px 12px' }}>
            <span
              className="flex-1 min-w-0 flex items-center gap-1.5"
              style={{
                height: '30px',
                padding: '0 9px',
                borderRadius: '8px',
                background: SCENE.tile,
                border: `1px solid ${SCENE.edge}`,
                fontSize: '12px',
                color: SCENE.inkFaint,
              }}
            >
              <SceneIcon d="M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12M21 21l-5.2-5.2" size={13} />
              {s.search}
            </span>
            <span
              className="flex items-center justify-center shrink-0"
              style={{
                width: '30px',
                height: '30px',
                borderRadius: '8px',
                background: SCENE.ghost,
                border: `1px solid ${SCENE.edge}`,
                color: SCENE.inkMid,
              }}
            >
              <SceneIcon d="M4 6h16M7 12h10M10 18h4" size={13} />
            </span>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden" style={{ padding: '0 8px' }}>
            {TREE_SHAPE.map((row, i) => {
              const entry = s.tree[i];
              const active = 'active' in row && row.active;
              return (
                <div
                  key={entry.name}
                  className="flex items-start gap-2"
                  style={{
                    padding: '7px 9px',
                    marginLeft: row.indent ? '14px' : 0,
                    borderRadius: '8px',
                    background: active ? olive.soft : 'transparent',
                    border: `1px solid ${active ? olive.border : 'transparent'}`,
                    ...enterAt(beat, 0, { rise: 6, delay: i * 70 }),
                  }}
                >
                  <SceneIcon
                    d={row.folder ? FOLDER_ICON : FILE_ICON}
                    size={14}
                    style={{ marginTop: '2px', color: active ? olive.solid : SCENE.inkFaint }}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className="flex items-center gap-1.5"
                      style={{
                        fontSize: '12.5px',
                        color: active ? SCENE.ink : SCENE.inkSoft,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {entry.name}
                      {'fresh' in row && row.fresh && (
                        <SceneMono size={12} color={olive.bright} style={{ letterSpacing: '0.14em' }}>
                          NEW
                        </SceneMono>
                      )}
                    </span>
                    <span className="flex items-center gap-1.5" style={{ marginTop: '3px' }}>
                      <SceneMono size={12}>{entry.time}</SceneMono>
                      {row.badges.map((key) => (
                        <span
                          key={key}
                          style={{
                            height: '16px',
                            padding: '0 6px',
                            borderRadius: '4px',
                            fontSize: '10px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            background: BADGE_TONE[key].bg,
                            color: BADGE_TONE[key].fg,
                          }}
                        >
                          {s.badges[key as keyof typeof s.badges]}
                        </span>
                      ))}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>

          {/* 右下角调色盘 FAB：库内「新增」的唯一入口 */}
          <span
            className="absolute flex items-center justify-center"
            style={{
              right: '16px',
              bottom: '16px',
              width: '42px',
              height: '42px',
              borderRadius: '50%',
              background: SCENE.brand,
              color: SCENE.brandFg,
              boxShadow: SCENE.liftSm,
            }}
          >
            <SceneIcon
              d="M12 3a9 9 0 1 0 0 18 1.8 1.8 0 0 0 1.4-2.9 1.8 1.8 0 0 1 1.4-2.9H17a4 4 0 0 0 4-4 9 9 0 0 0-9-8.2M7.5 10.5v.01M12 7.5v.01M16.5 10.5v.01"
              size={19}
            />
          </span>
        </div>

        {/* 中：正文 */}
        <div className="flex-1 min-w-0 flex flex-col relative">
          <div style={{ padding: '15px 20px 0' }}>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '19px',
                fontWeight: 500,
                letterSpacing: '-0.01em',
                color: SCENE.ink,
              }}
            >
              {s.doc.title}
            </div>
            <SceneMono size={14} style={{ display: 'block', marginTop: '5px', letterSpacing: '0.08em' }}>
              {s.doc.meta}
            </SceneMono>
          </div>

          {/* 主操作行 */}
          <div
            className="flex items-center gap-1 overflow-x-auto"
            style={{ padding: '11px 20px 10px', borderBottom: `1px solid ${SCENE.hair}` }}
          >
            {s.readerTools.slice(0, 3).map((label, i) => {
              const on = beat >= B.tapped ? i === 1 : i === 0;
              return (
                <span
                  key={label}
                  className="flex items-center gap-1.5 shrink-0"
                  style={{
                    height: '27px',
                    padding: '0 9px',
                    borderRadius: '7px',
                    fontSize: '11.5px',
                    background: on ? olive.soft : SCENE.ghost,
                    border: `1px solid ${on ? olive.border : SCENE.edge}`,
                    color: on ? olive.bright : SCENE.inkMid,
                  }}
                >
                  <SceneIcon d={READER_TOOL_ICONS[i]} size={12} />
                  {label}
                </span>
              );
            })}
            <span
              className="flex items-center gap-1.5 shrink-0"
              style={{
                height: '27px', padding: '0 9px', borderRadius: '7px', fontSize: '11.5px',
                background: SCENE.ghost, border: `1px solid ${SCENE.edge}`, color: SCENE.inkDim,
              }}
            >
              <SceneIcon d="M12 5v.01M12 12v.01M12 19v.01" size={12} />
              {s.more}
            </span>
          </div>

          {/* 阅读进度条 */}
          <div style={{ height: '2px', background: SCENE.hair }}>
            <span className="block h-full" style={{ width: '38%', background: olive.solid }} />
          </div>

          {/* 正文 */}
          <div
            className="flex-1 min-h-0 relative overflow-hidden"
            style={{
              padding: '22px 20px',
              fontFamily: 'var(--font-serif)',
              fontSize: '15px',
              lineHeight: 2.02,
              color: SCENE.inkSoft,
            }}
          >
            <p style={{ marginBottom: '18px' }}>{s.doc.p1}</p>
            <p style={{ marginBottom: '18px' }}>
              {s.doc.p2before}
              {/* 选区高亮划词那一拍才亮；最后一拍整句换成改写后的文本——
                  「替换原文」不能只是浮层里点一下，正文得真的变 */}
              {/*
                划词是这一幕的真实功能（DocBrowser 里有 getSelection），所以底色
                **从左扫到右**，跟手拖出来一样，而不是整块瞬间变色。
                这道扫过原本被我放在文学创作那一幕 —— 那边的编辑器根本没有划词。
              */}
              <SelectionSweep
                active={beat >= B.selecting && beat < B.replaced}
                hue={`hsla(${SCENE_HUE.olive}, 54%, 58%, 0.26)`}
                targetId="selected-sentence"
              >
                <span style={{ color: beat >= B.replaced ? SCENE.ink : 'inherit', transition: 'color .45s ease' }}>
                  {beat >= B.replaced ? s.rewrite.after : s.doc.selected}
                </span>
              </SelectionSweep>
              {s.doc.p2after}
            </p>

            {/* 浮层出场时才给它腾地方，收起就还回去——常驻一个 186px 的空档
                正是这一幕之前显得又密又挤的一半原因 */}
            <div
              style={{
                height: beat >= B.popover && beat < B.replaced ? '196px' : '0px',
                transition: 'height .5s cubic-bezier(.19,1,.22,1)',
              }}
            />

            <p style={{ marginBottom: '18px' }}>{s.doc.p3}</p>
            <p className="hidden lg:block" style={{ marginBottom: '18px' }}>
              {s.doc.p4}
            </p>

            {/* 划词浮层：真实是 h-8 三动作，浮在选区上方。只在「浮层出现 → 点了改写」两拍在场 */}
            <div
              className="absolute flex items-center"
              style={{
                ...enterAt(beat, B.popover, { rise: 6 }),
                ...(beat > B.tapped ? { opacity: 0, pointerEvents: 'none' as const } : null),
                left: '20px',
                top: '48px',
                height: '32px',
                padding: '0 6px',
                borderRadius: '10px',
                background: SCENE.overlay,
                border: `1px solid ${olive.border}`,
                boxShadow: SCENE.liftSm,
                fontFamily: 'var(--font-body)',
              }}
            >
              {s.selectionActions.map((label, i) => (
                <span key={label} className="flex items-center">
                  {i > 0 && (
                    <span className="block" style={{ width: '1px', height: '16px', background: SCENE.line, margin: '0 2px' }} />
                  )}
                  <span
                    // 旁白第 3 拍写的是「点了 AI 改写」，那就得看见手按在这一项上。
                    // 三个动作里它是第 2 个（评论 / AI 改写 / 配图）。
                    data-cursor-target={i === 1 ? 'rewrite-action' : undefined}
                    className="flex items-center gap-1.5 whitespace-nowrap"
                    style={{
                      height: '26px',
                      padding: '0 8px',
                      borderRadius: '8px',
                      fontSize: '11px',
                      fontWeight: 500,
                      color: olive.bright,
                      // 被点中的那一项按下去一下，让人看清「点的是哪个」
                      background: beat >= B.tapped && i === 1 ? olive.soft : 'transparent',
                      transform: beat >= B.tapped && i === 1 ? 'scale(0.95)' : 'scale(1)',
                      transition: 'background .25s ease, transform .25s ease',
                    }}
                  >
                    <SceneIcon d={SELECTION_ICONS[i]} size={13} strokeWidth={1.9} />
                    {label}
                  </span>
                </span>
              ))}
            </div>

            {/* AI 改写浮层：流式 + diff 预览 + 替换/插入。点了才来，替换完就走 */}
            <div
              className="absolute"
              style={{
                ...enterAt(beat, B.tapped, { rise: 8 }),
                ...(beat >= B.replaced ? { opacity: 0, pointerEvents: 'none' as const } : null),
                left: '20px',
                right: '20px',
                top: '100px',
                maxWidth: '430px',
                borderRadius: '12px',
                background: SCENE.overlay,
                border: `1px solid ${SCENE.edge}`,
                boxShadow: SCENE.liftLg,
                padding: '12px',
                fontFamily: 'var(--font-body)',
              }}
            >
              <SceneMono className="flex items-center gap-2">
                <span
                  className="block map-scene-anim"
                  style={{
                    width: '5px',
                    height: '5px',
                    borderRadius: '50%',
                    background: olive.solid,
                    animation: 'mapSceneTwinkle 1.6s ease-in-out infinite',
                  }}
                />
                {s.rewrite.status}
              </SceneMono>
              <div
                style={{
                  marginTop: '9px',
                  borderRadius: '8px',
                  overflow: 'hidden',
                  border: `1px solid ${SCENE.hair}`,
                }}
              >
                <div
                  style={{
                    padding: '7px 10px',
                    fontSize: '12px',
                    lineHeight: 1.7,
                    background: `hsla(${SCENE_HUE.clay}, 54%, 58%, 0.10)`,
                    color: SCENE.inkMid,
                    textDecoration: 'line-through',
                    textDecorationColor: `hsla(${SCENE_HUE.clay}, 54%, 62%, 0.6)`,
                  }}
                >
                  {s.rewrite.before}
                </div>
                <div
                  style={{
                    padding: '7px 10px',
                    fontSize: '12px',
                    lineHeight: 1.7,
                    background: `hsla(${SCENE_HUE.pine}, 54%, 58%, 0.10)`,
                    color: SCENE.ink,
                  }}
                >
                  {beat >= B.streaming ? s.rewrite.after : ''}
                  <span
                    className="inline-block map-scene-anim"
                    style={{
                      width: '2px',
                      height: '12px',
                      background: olive.solid,
                      marginLeft: '3px',
                      verticalAlign: '-2px',
                      animation: 'mapSceneCaret 1s steps(1) infinite',
                    }}
                  />
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap" style={{ marginTop: '10px' }}>
                <span
                  className="flex items-center"
                  style={{
                    height: '26px',
                    padding: '0 11px',
                    borderRadius: '7px',
                    background: SCENE.brand,
                    color: SCENE.brandFg,
                    fontSize: '11.5px',
                  }}
                >
                  {s.rewrite.replace}
                </span>
                <span
                  className="flex items-center"
                  style={{
                    height: '26px',
                    padding: '0 11px',
                    borderRadius: '7px',
                    background: SCENE.tile,
                    border: `1px solid ${SCENE.edge}`,
                    color: SCENE.inkMid,
                    fontSize: '11.5px',
                  }}
                >
                  {s.rewrite.insert}
                </span>
                <span className="ml-auto" style={{ fontSize: '10.5px', color: SCENE.inkFaint }}>
                  {s.rewrite.guard}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* 右：本页章节 */}
        <div
          className="hidden xl:flex flex-col shrink-0 gap-1"
          style={{ width: '208px', borderLeft: `1px solid ${SCENE.hair}`, padding: '15px 14px' }}
        >
          <SceneMono style={{ letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: '8px' }}>
            {s.tocTitle}
          </SceneMono>
          {s.toc.map((item, i) => {
            const on = i === 1;
            return (
              <span
                key={item.label}
                style={{
                  fontSize: '11.5px',
                  lineHeight: 1.6,
                  padding: '5px 8px',
                  paddingLeft: item.depth ? '18px' : '8px',
                  borderRadius: '6px',
                  color: on ? SCENE.ink : SCENE.inkDim,
                  background: on ? olive.soft : 'transparent',
                  borderLeft: `2px solid ${on ? olive.solid : 'transparent'}`,
                }}
              >
                {item.label}
              </span>
            );
          })}
        </div>
      </div>

      {/* ── 知识星系：文档之间的关系一眼看见 ── */}
      <div
        className="relative overflow-hidden"
        style={{
          height: '300px',
          borderTop: `1px solid ${SCENE.edge}`,
          background: galaxyBackdrop(SCENE_HUE.slate),
        }}
      >
        {STARS.map((star, i) => (
          <span
            key={i}
            className="absolute rounded-full map-scene-anim"
            style={{
              left: `${star.x}%`,
              top: `${star.y}%`,
              width: `${star.size}px`,
              height: `${star.size}px`,
              background: SCENE.captionFg,
              opacity: star.opacity,
              // 只在这一幕进视口时闪：滚开还在跑就是白烧帧
              animation: visible ? `mapSceneTwinkle ${star.duration.toFixed(2)}s ease-in-out infinite` : undefined,
            }}
          />
        ))}

        {/* 银心辉光 */}
        <div
          className="absolute pointer-events-none"
          style={{
            left: '50%',
            top: '52%',
            width: '420px',
            height: '420px',
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            background: `radial-gradient(circle, hsla(${SCENE_HUE.slate}, 54%, 62%, 0.20) 0%, hsla(${SCENE_HUE.slate}, 54%, 62%, 0.05) 42%, transparent 70%)`,
          }}
        />

        {/* 光路与节点 */}
        <svg
          viewBox="0 0 1384 300"
          preserveAspectRatio="xMidYMid slice"
          className="absolute inset-0 block w-full h-full"
          aria-hidden="true"
        >
          {ARCS.map((a) => (
            <path key={a.d} d={a.d} fill="none" stroke={a.stroke} strokeWidth={a.w} strokeLinecap="round" />
          ))}
          {NODES.map((node, i) => {
            const color = `hsl(${NODE_HUES[i % NODE_HUES.length]} 54% 66%)`;
            return (
              <g key={`${node.x}-${node.y}`}>
                <circle cx={node.x} cy={node.y} r={node.r * 2.6} fill={color} opacity="0.16" />
                <circle cx={node.x} cy={node.y} r={node.r} fill={color} />
              </g>
            );
          })}
        </svg>

        {/* hover 节点名 */}
        <div
          className="absolute hidden md:block"
          style={{
            left: '52%',
            top: '30%',
            padding: '5px 9px',
            borderRadius: '7px',
            background: SCENE.overlay,
            border: `1px solid ${SCENE.edge}`,
            fontSize: '11.5px',
            color: SCENE.ink,
            whiteSpace: 'nowrap',
          }}
        >
          {s.galaxy.hovered}
        </div>

        {/* type 图例筛选 */}
        <div className="absolute flex flex-col gap-1.5" style={{ left: '16px', top: '16px' }}>
          <SceneMono color={SCENE.inkFaint} style={{ letterSpacing: '0.16em', textTransform: 'uppercase' }}>
            {s.galaxy.legendTitle}
          </SceneMono>
          {s.galaxy.legend.map((label, i) => (
            <span
              key={label}
              className="inline-flex items-center gap-1.5"
              style={{
                height: '22px',
                padding: '0 8px',
                borderRadius: '6px',
                fontSize: '11px',
                background: SCENE.tile,
                border: `1px solid ${SCENE.edge}`,
                color: SCENE.inkMid,
                width: 'fit-content',
              }}
            >
              <span
                className="block w-[7px] h-[7px] rounded-full"
                style={{ background: `hsl(${NODE_HUES[i % NODE_HUES.length]} 54% 66%)` }}
              />
              {label}
            </span>
          ))}
        </div>

        <div className="absolute text-right" style={{ right: '16px', bottom: '14px' }}>
          <div style={{ fontSize: '12.5px', color: SCENE.inkMid }}>{s.galaxy.hint}</div>
          <SceneMono size={13} color={SCENE.inkGhost} style={{ display: 'block', marginTop: '3px' }}>
            {s.galaxy.stats}
          </SceneMono>
        </div>
      </div>

      <BeatNarration beats={s.beats} beat={beat} hue={SCENE_HUE.olive} />
    </SceneFrame>
  );
}
