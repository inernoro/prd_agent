import { Fragment, type ReactNode } from 'react';
import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import type { SceneVariant } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { useSceneTimeline } from './useSceneTimeline';
import { useLanguage } from '../contexts/LanguageContext';
import type { CdsTopologyData, GatewayStackData, MapLaneData } from '../i18n/landing';

/**
 * LayersScene —— 三层一体：MAP / LLMGW / CDS。
 *
 * 三块并排摆成三列时，不管里面画什么，读出来都是「三张同款卡」——列宽一样、
 * 高度一样、边框一样，形状先于内容把它们抹平了。而这一幕要说的是**三层**：
 * 上面那层站在下面那层上。所以改成**三条通栏横带上下叠**，左边一根 01/02/03
 * 的层号轨把它们串起来。版式本身就是那句话。
 *
 * 三条带子里各是一种不同的拓扑，形状承担语义：
 *
 *   01 MAP    横向工位流   你 → Agent → Agent → 产物   一条向右传递的链
 *   02 LLMGW  横向收敛漏斗 调用方 ▸ 池 ▸ 顺位 ▸ 上游    四段逐段收窄
 *   03 CDS    分支拓扑     main 拉出分支 → 服务 → 域名  一张六边形底的网络图
 *
 * 三带**同拍播放**：同一条请求依次点亮 MAP 的下一站、LLMGW 的下一段、
 * CDS 的下一块。滚到这一幕，三条带子是一起往右走的。
 *
 * CDS 那条的形制照用户给的参考图：六边形底纹、main 上拉出分支的曲线、
 * 服务块、预览域名卡、最下面一行终端输出。
 */

const HOLDS = [1600, 1500, 1500, 1500, 2400];
/** 五拍：就位 → 第一站 → 第二站 → 第三站 → 落地 */
const B = { idle: 0, s1: 1, s2: 2, s3: 3, done: 4 } as const;

const clay = inkTone(SCENE_HUE.clay);
const steel = inkTone(SCENE_HUE.steel);
const pine = inkTone(SCENE_HUE.pine);

/** 这一拍第 i 站/段是否已经点亮。三条带共用同一条判定，节奏才对得齐。 */
function litAt(index: number, beat: number): boolean {
  return beat >= B.s1 + index;
}

export function LayersScene({ variant }: { variant?: SceneVariant }) {
  const { t } = useLanguage();
  const s = t.scenes.layers;
  const { beat, ref } = useSceneTimeline(HOLDS);

  return (
    <SceneFrame
      id="scene-layers"
      variant={variant}
      hue={SCENE_HUE.clay}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      <div ref={ref}>
        <div style={{ padding: '18px 16px 4px' }}>
          <Band index="01" name="MAP" role={s.map.role} meta={s.map.meta} lead={s.map.lead} tone={clay} footnote={s.map.footnote}>
            <MapLane lane={s.map.lane} beat={beat} />
          </Band>

          <Band index="02" name="LLMGW" role={s.gateway.role} meta={s.gateway.meta} lead={s.gateway.lead} tone={steel} footnote={s.gateway.footnote}>
            <GatewayFunnel stack={s.gateway.stack} beat={beat} />
          </Band>

          <Band index="03" name="CDS" role={s.cds.role} meta={s.cds.meta} lead={s.cds.lead} tone={pine} footnote={s.cds.footnote} last>
            <CdsTopology cds={s.cds} beat={beat} />
          </Band>
        </div>

        <BeatNarration beats={s.beats} beat={beat} hue={SCENE_HUE.clay} />
      </div>
    </SceneFrame>
  );
}

/* ══════════════════ 01 · MAP —— 横向工位流 ══════════════════ */

const LANE_ICON = {
  you: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21a8 8 0 0 1 16 0',
  agent: 'M9 3h6v3h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3zM9 12h.01M15 12h.01',
  artifact: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4',
} as const;

/**
 * 一条向右传递的链：一站接一站往右点亮，站间的箭头等下一站亮了才通。
 *
 * 手机放不下四站时横向滚动，不换行 —— 换行就把「一条链」读成「一堆格子」
 * （`mobile-first-density` 第 5 条）。
 */
function MapLane({ lane, beat }: { lane: MapLaneData; beat: number }) {
  return (
    <div className="flex items-stretch overflow-x-auto no-scrollbar" style={{ paddingBottom: '2px' }}>
      {lane.map((stop, i) => {
        const lit = litAt(i, beat);
        const tone = stop.kind === 'artifact' ? pine : clay;
        return (
          <Fragment key={stop.label}>
            {i > 0 && <LaneArrow lit={lit} />}
            <div
              className="flex items-center gap-2.5 shrink-0 sm:shrink sm:flex-1"
              style={{
                minWidth: '146px',
                padding: '11px 12px',
                borderRadius: '11px',
                background: lit ? tone.faint : SCENE.ghost,
                border: `1px solid ${lit ? tone.border : SCENE.hair}`,
                opacity: lit ? 1 : 0.5,
                transition: 'background .5s ease, border-color .5s ease, opacity .5s ease',
              }}
            >
              <span
                className="flex items-center justify-center shrink-0"
                style={{
                  width: '28px', height: '28px', borderRadius: '9px',
                  background: lit ? tone.soft : SCENE.tile,
                  color: lit ? tone.bright : SCENE.inkGhost,
                  transition: 'background .5s ease, color .5s ease',
                }}
              >
                <SceneIcon d={LANE_ICON[stop.kind]} size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate" style={{ fontSize: '12.5px', color: lit ? SCENE.ink : SCENE.inkGhost }}>
                  {stop.label}
                </span>
                <span className="block truncate" style={{ fontSize: '10.5px', color: SCENE.inkGhost }}>
                  {stop.detail}
                </span>
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/** 站与站之间的传递箭头。`lit` 是**下一站**的状态：交接完成了它才通电。 */
function LaneArrow({ lit }: { lit: boolean }) {
  return (
    <span className="flex items-center justify-center shrink-0" style={{ width: '30px' }} aria-hidden>
      <svg width="26" height="10" viewBox="0 0 26 10" fill="none">
        <path
          d="M0 5h20M16 1.5 20 5l-4 3.5"
          stroke={lit ? clay.solid : SCENE.line}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transition: 'stroke .5s ease' }}
        />
      </svg>
    </span>
  );
}

/* ══════════════════ 02 · LLMGW —— 横向收敛漏斗 ══════════════════ */

/**
 * 四段往右**逐段收窄**：从「谁在调」一路筛到「打哪个上游」。
 *
 * 和 MAP 的区别不只是内容 —— MAP 是等宽的传递（每一站活儿一样多），
 * 这里是收敛（候选越往右越少）。宽度递减 + 背景两条向内收的斜线，
 * 不用读字就看得出这是个漏斗。
 */
const FUNNEL_GROW = [1.5, 1.2, 0.98, 0.82];

function GatewayFunnel({ stack, beat }: { stack: GatewayStackData; beat: number }) {
  return (
    <div className="relative">
      {/*
        漏斗本体是一块**有填充**的楔形，不是两条线。
        第一版画的是两条 hairline 斜线，渲出来在方块背后一点都看不见 ——
        看不见的东西等于没画。填充的楔形在方块之间的缝里露得出来，才读得出「收窄」。
      */}
      <svg
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{ width: '100%', height: '100%' }}
      >
        <polygon points="0,0 100,17 100,83 0,100" fill={steel.faint} />
        <path d="M0 0 L100 17" stroke={steel.border} strokeWidth="1" vectorEffect="non-scaling-stroke" fill="none" />
        <path d="M0 100 L100 83" stroke={steel.border} strokeWidth="1" vectorEffect="non-scaling-stroke" fill="none" />
      </svg>

      {/* 上下留 16px：楔形要在方块之外露出来，贴着画就被方块盖满了 */}
      <div className="relative flex items-center overflow-x-auto no-scrollbar" style={{ padding: '16px 0' }}>
        {stack.map((layer, i) => {
          const lit = litAt(i, beat);
          return (
            <Fragment key={layer.label}>
              {i > 0 && (
                <span className="flex items-center justify-center shrink-0" style={{ width: '24px' }} aria-hidden>
                  <SceneIcon
                    d="M9 6l6 6-6 6"
                    size={13}
                    style={{ color: lit ? steel.solid : SCENE.line, transition: 'color .5s ease' }}
                  />
                </span>
              )}
              <div
                className="flex flex-col gap-0.5 shrink-0 sm:shrink"
                style={{
                  // 宽度递减 —— 视觉上就是候选一路被筛掉
                  flexGrow: FUNNEL_GROW[i] ?? 1,
                  flexBasis: 0,
                  minWidth: '140px',
                  padding: '10px 12px',
                  borderRadius: '10px',
                  background: lit ? steel.faint : SCENE.ghost,
                  border: `1px solid ${lit ? steel.border : SCENE.hair}`,
                  opacity: lit ? 1 : 0.5,
                  transition: 'background .5s ease, border-color .5s ease, opacity .5s ease',
                }}
              >
                <SceneMono size={11} color={SCENE.inkGhost}>{layer.label}</SceneMono>
                <span className="truncate" style={{ fontSize: '12.5px', color: lit ? SCENE.ink : SCENE.inkGhost }}>
                  {layer.detail}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* ══════════════════ 03 · CDS —— 分支拓扑（照参考图） ══════════════════ */

const SERVICE_ICON: Record<string, string> = {
  api: 'M4 7h16M4 12h10M4 17h13',
  admin: 'M3 5h18v14H3zM3 9h18',
  mongo: 'M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  redis: 'M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
};
const FALLBACK_SERVICE_ICON = 'M4 4h16v16H4z';

/**
 * 照用户给的那张 CDS 拓扑图做的缩微版，四个构件一个不少：
 *   1. 六边形底纹（SVG pattern）
 *   2. main 上拉出一条曲线到 feature 分支
 *   3. 一排服务块（技术栈是它自己认出来的）
 *   4. 预览域名卡 + 最下面一行终端输出
 *
 * 与那张图唯一不同的是**域名只给形状不给真域名** —— 每个人的 CDS 域名不一样，
 * 写死一个既是假的，也违反「地址由 CDS 下发、不由前端拼」这条本身。
 *
 * 分支图整块用一个固定 viewBox 的 SVG 画（含 main / 分支名两处标注），
 * `xMidYMid meet` 等比缩放：横向拉伸会把那条曲线拉扁，就不像参考图了。
 */
function CdsTopology({ cds, beat }: { cds: CdsTopologyData; beat: number }) {
  const branchDrawn = beat >= B.s1;
  const previewReady = beat >= B.done;

  return (
    <div className="relative">
      {/* 六边形底纹：参考图最认得出的那层质感 */}
      <svg aria-hidden className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%' }}>
        <defs>
          <pattern id="cds-hex" width="34" height="59" patternUnits="userSpaceOnUse" patternTransform="scale(0.58)">
            <path d="M17 0 L34 10 L34 30 L17 40 L0 30 L0 10 Z" fill="none" stroke={SCENE.hair} strokeWidth="1" />
          </pattern>
          <linearGradient id="cds-hex-fade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
            <stop offset="70%" stopColor="#fff" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="cds-hex-mask">
            <rect width="100%" height="100%" fill="url(#cds-hex-fade)" />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="url(#cds-hex)" mask="url(#cds-hex-mask)" />
      </svg>

      <div className="relative flex flex-col lg:flex-row gap-4 lg:gap-6 lg:items-center">
        {/* ── 左：main 拉出分支 ── */}
        <div className="shrink-0" style={{ width: '100%', maxWidth: '340px' }}>
          <svg viewBox="0 0 320 116" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: 'auto', display: 'block' }}>
            {/* main 主干 */}
            <line x1="6" y1="30" x2="176" y2="30" stroke={SCENE.line} strokeWidth="2" strokeLinecap="round" />
            {[54, 92, 130].map((x) => (
              <circle key={x} cx={x} cy="30" r="4" fill={SCENE.base} stroke={SCENE.edgeStrong} strokeWidth="2" />
            ))}
            <text x="6" y="18" fill={SCENE.inkGhost} style={{ fontFamily: 'var(--font-terminal)', fontSize: '13px', letterSpacing: '0.1em' }}>
              {cds.baseBranch}
            </text>

            {/* 拉出去的那条：strokeDasharray + offset 做「画出来」的动效 */}
            <path
              d="M130 30 C 176 30, 168 76, 206 76 L 232 76"
              fill="none"
              stroke={pine.solid}
              strokeWidth="2"
              strokeLinecap="round"
              strokeDasharray="190"
              strokeDashoffset={branchDrawn ? 0 : 190}
              style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(.45,0,.2,1)' }}
            />
            <circle
              cx="232" cy="76" r="5"
              fill={pine.solid}
              style={{ opacity: branchDrawn ? 1 : 0, transition: 'opacity .4s ease .9s' }}
            />
            {/* 字号 11 而非 13、锚在 226：SVG 默认 overflow:hidden，
                超出 viewBox 的那半截分支名会被直接切掉（上一版切在 auth-flov） */}
            <text
              x="226" y="98" textAnchor="middle"
              fill={branchDrawn ? pine.bright : SCENE.inkGhost}
              style={{ fontFamily: 'var(--font-terminal)', fontSize: '11px', letterSpacing: '0.06em', transition: 'fill .5s ease' }}
            >
              {cds.branch}
            </text>
            <text x="6" y="108" fill={SCENE.inkGhost} style={{ fontFamily: 'var(--font-terminal)', fontSize: '12px', letterSpacing: '0.08em' }}>
              {cds.branchMeta}
            </text>
          </svg>
        </div>

        {/* ── 右：这条分支自己那一套 ── */}
        <div className="min-w-0 flex-1 flex flex-col gap-2.5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {cds.services.map((svc, i) => {
              /* 四个服务分两拍上：前两个在 s2，后两个在 s3 */
              const lit = beat >= (i < 2 ? B.s2 : B.s3);
              return (
                <div
                  key={svc.name}
                  className="flex flex-col gap-1 min-w-0"
                  style={{
                    padding: '9px 10px',
                    borderRadius: '10px',
                    background: lit ? SCENE.tileHi : SCENE.ghost,
                    border: `1px solid ${lit ? pine.border : SCENE.hair}`,
                    opacity: lit ? 1 : 0.45,
                    transition: 'background .5s ease, border-color .5s ease, opacity .5s ease',
                  }}
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    <SceneIcon d={SERVICE_ICON[svc.name] ?? FALLBACK_SERVICE_ICON} size={12} />
                    <span className="truncate" style={{ fontSize: '11.5px', color: lit ? SCENE.ink : SCENE.inkGhost }}>
                      {svc.name}
                    </span>
                    {svc.port && (
                      <SceneMono size={10} color={SCENE.inkGhost} className="ml-auto shrink-0">{svc.port}</SceneMono>
                    )}
                  </span>
                  <span className="truncate" style={{ fontSize: '10px', color: SCENE.inkGhost }}>{svc.detail}</span>
                </div>
              );
            })}
          </div>

          {/* 预览域名卡 —— 参考图右下那张 */}
          <div
            className="flex items-center gap-2"
            style={{
              padding: '9px 11px',
              borderRadius: '10px',
              background: previewReady ? pine.faint : SCENE.ghost,
              border: `1px solid ${previewReady ? pine.border : SCENE.hair}`,
              opacity: previewReady ? 1 : 0.45,
              transition: 'background .55s ease, border-color .55s ease, opacity .55s ease',
            }}
          >
            <SceneIcon d="M9 15l6-6M11 6l1-1a4 4 0 1 1 6 6l-1 1M13 18l-1 1a4 4 0 1 1-6-6l1-1" size={13} />
            <span className="min-w-0 flex-1">
              <SceneMono size={10} color={SCENE.inkGhost} className="block">{cds.previewLabel}</SceneMono>
              <SceneMono size={12} color={previewReady ? pine.bright : SCENE.inkGhost} className="block truncate">
                {cds.previewShape}
              </SceneMono>
            </span>
            <span
              className="block shrink-0 map-scene-anim"
              style={{
                width: '8px', height: '8px', borderRadius: '999px',
                background: previewReady ? pine.solid : SCENE.line,
                animation: previewReady ? 'mapSceneTwinkle 1.9s ease-in-out infinite' : undefined,
                transition: 'background .5s ease',
              }}
            />
          </div>

          {/* 终端输出 —— 参考图最下面那一行 */}
          <div className="flex items-center gap-2 overflow-hidden">
            <SceneMono size={12} color={SCENE.inkGhost} className="truncate">{cds.terminal}</SceneMono>
            <span
              className="block shrink-0 map-scene-anim"
              style={{ width: '6px', height: '11px', background: SCENE.inkGhost, animation: 'mapSceneCaret 1.1s steps(1) infinite' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════ 共用外壳 —— 一条通栏的层 ══════════════════ */

/**
 * 一层 = 左边一个层号 + 右边这层自己的样子，三层上下叠。
 *
 * 层号下面那根竖线连到下一层 —— 没有它，三条带子只是三个并排的区块；
 * 有了它才读得出「上面那层站在下面那层上」。
 */
function Band({
  index,
  name,
  role,
  meta,
  lead,
  tone,
  footnote,
  last,
  children,
}: {
  index: string;
  name: string;
  role: string;
  meta: string;
  lead: string;
  tone: ReturnType<typeof inkTone>;
  footnote: string;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-stretch gap-3 sm:gap-5">
      {/* 层号轨 */}
      <div className="hidden sm:flex flex-col items-center shrink-0" style={{ width: '30px' }}>
        <span
          className="flex items-center justify-center shrink-0"
          style={{
            width: '30px', height: '30px', borderRadius: '999px',
            border: `1px solid ${tone.border}`,
            background: tone.faint,
            fontFamily: 'var(--font-terminal)',
            fontSize: '14px',
            letterSpacing: '0.06em',
            color: tone.bright,
          }}
        >
          {index}
        </span>
        {!last && <span className="flex-1" style={{ width: '1px', background: SCENE.line, marginTop: '8px' }} />}
      </div>

      <div
        className="min-w-0 flex-1"
        style={{
          paddingBottom: last ? '14px' : '20px',
          marginBottom: last ? 0 : '20px',
          borderBottom: last ? undefined : `1px solid ${SCENE.hair}`,
        }}
      >
        <div className="flex items-baseline gap-2.5 flex-wrap">
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '15.5px', fontWeight: 500, color: tone.bright }}>
            {name}
          </span>
          <span style={{ fontSize: '12.5px', color: SCENE.inkMid }}>{role}</span>
          <SceneMono size={13} className="ml-auto shrink-0" color={SCENE.inkGhost}>{meta}</SceneMono>
        </div>
        <div style={{ margin: '5px 0 12px', fontSize: '11.5px', lineHeight: 1.7, color: SCENE.inkDim, maxWidth: '62em' }}>
          {lead}
        </div>

        {children}

        <div style={{ marginTop: '11px', fontSize: '10.5px', lineHeight: 1.65, color: SCENE.inkFaint }}>{footnote}</div>
      </div>
    </div>
  );
}
