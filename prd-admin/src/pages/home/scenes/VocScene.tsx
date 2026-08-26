import { useMemo } from 'react';
import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { useSceneTimeline } from './useSceneTimeline';
import { useLanguage } from '../contexts/LanguageContext';
import type { VocLeaf } from '../i18n/landing';

/**
 * VocScene —— 体验全景热力图，照 `pages/team-activity/ExperienceMap.tsx` 画的缩微版。
 *
 * 那一页的核心就三件事，这里一件不少：
 *   1. squarified treemap：每块一个端点，面积 = 访问量。**布局算法是同一套**
 *      （下面 squarify 与那份实现同源，只是去掉了 ResizeObserver 与下钻联动）。
 *   2. 冷色平静海：每个模块一个色相、区内明度递变；暖色只留给告警。
 *   3. 痛点自己跳出来：报错红、慢琥珀，带发光描边；点一下下钻到痛点榜对应行。
 *
 * 分区名取自后端 `TeamActivityController.ModuleLabels`，块名取自同文件的
 * `SegmentLabels` —— 都是真表里的词，不是编的。
 *
 * 演四拍：扫描线把块写出来 → 平静 → 痛点点睛 → 下钻到痛点榜。
 */

const HOLDS = [2000, 1500, 2200, 2400];
const B = { sweep: 0, calm: 1, pain: 2, drill: 3 } as const;

/**
 * 冷色平静海的模块色相。真实那页用的是自己的 16 色带（起点 222），这里收进本站
 * 八色墨带的冷段：slate 214 → steel 196 → celadon 176 → pine 152，末位借 olive 92。
 * 不照抄 222 是因为它紧贴 no-purple 守卫的靛色起点（225），差三度不值得赌。
 */
const GROUP_HUES = [214, 196, 176, 152, 92];
/** 告警两色：报错走陶土、偏慢走琥珀，落在八色带里（不引入带外的红黄）。 */
const ERR_HUE = SCENE_HUE.clay;
const SLOW_HUE = SCENE_HUE.amber;

const VIEW_W = 1000;
const VIEW_H = 420;
const PAD = 3;
const HDR = 15;

type Rect = { x: number; y: number; w: number; h: number };
type Placed<T> = T & { rect: Rect };

function worstRatio(row: { weight: number }[], side: number, scale: number): number {
  const areas = row.map((r) => r.weight * scale);
  const sum = areas.reduce((a, b) => a + b, 0);
  const mx = Math.max(...areas);
  const mn = Math.min(...areas);
  return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
}

/** 标准 squarified treemap —— 与 ExperienceMap.tsx 的 squarify 同一套算法。 */
function squarify<T extends { weight: number }>(items: T[], rect: Rect): Placed<T>[] {
  const sorted = items
    .filter((i) => i.weight > 0)
    .map((i) => ({ ...i }))
    .sort((a, b) => b.weight - a.weight) as Placed<T>[];
  const out: Placed<T>[] = [];
  const free: Rect = { ...rect };
  let freeTotal = sorted.reduce((s, i) => s + i.weight, 0);
  let i = 0;
  while (i < sorted.length && freeTotal > 0 && free.w > 0.5 && free.h > 0.5) {
    const scale = (free.w * free.h) / freeTotal;
    const side = Math.min(free.w, free.h);
    const row: Placed<T>[] = [sorted[i]];
    let last = worstRatio(row, side, scale);
    let j = i + 1;
    while (j < sorted.length) {
      row.push(sorted[j]);
      const w = worstRatio(row, side, scale);
      if (w > last) { row.pop(); break; }
      last = w;
      j += 1;
    }
    const rowSum = row.reduce((s, r) => s + r.weight, 0);
    const thick = (rowSum * scale) / side;
    let cursor = 0;
    const horizontal = free.w >= free.h;
    for (const item of row) {
      const len = ((item.weight * scale) / thick) || 0;
      item.rect = horizontal
        ? { x: free.x, y: free.y + cursor, w: thick, h: len }
        : { x: free.x + cursor, y: free.y, w: len, h: thick };
      cursor += len;
      out.push(item);
    }
    if (horizontal) { free.x += thick; free.w -= thick; } else { free.y += thick; free.h -= thick; }
    freeTotal -= rowSum;
    i = j;
  }
  return out;
}

/** 一块的填色：健康走本区色相的明度梯度，告警跳出平静海。 */
function leafFill(status: VocLeaf['status'], hue: number, depth: number): string {
  if (status === 'error') return `hsl(${ERR_HUE} 56% 46%)`;
  if (status === 'slow') return `hsl(${SLOW_HUE} 58% 46%)`;
  return `hsl(${hue} 32% ${18 + depth * 5}%)`;
}

export function VocScene() {
  const { t } = useLanguage();
  const s = t.tail.voc;
  const { beat, ref, visible } = useSceneTimeline(HOLDS);
  const steel = inkTone(SCENE_HUE.steel);

  /** 布局纯几何、与拍子无关，算一次就够 */
  const layout = useMemo(() => {
    const groups = squarify(
      s.groups.map((g) => ({ ...g, weight: g.leaves.reduce((n, l) => n + l.weight, 0) })),
      { x: 0, y: 0, w: VIEW_W, h: VIEW_H },
    );
    return groups.map((g, gi) => {
      const inner: Rect = {
        x: g.rect.x + PAD,
        y: g.rect.y + PAD + HDR,
        w: Math.max(0, g.rect.w - PAD * 2),
        h: Math.max(0, g.rect.h - PAD * 2 - HDR),
      };
      const leaves = squarify(g.leaves, inner).map((leaf, li) => ({ ...leaf, depth: li, hue: GROUP_HUES[gi % GROUP_HUES.length] }));
      return { ...g, hue: GROUP_HUES[gi % GROUP_HUES.length], leaves };
    });
  }, [s.groups]);

  /** 全图块的书写顺序按 x 排，扫描线才是"从左写到右"而不是乱蹦 */
  const order = useMemo(() => {
    const all = layout.flatMap((g) => g.leaves.map((l) => ({ key: `${g.label}/${l.label}`, x: l.rect.x })));
    all.sort((a, b) => a.x - b.x);
    return new Map(all.map((item, i) => [item.key, i]));
  }, [layout]);

  return (
    <SceneFrame
      id="scene-voc"
      hue={SCENE_HUE.slate}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      <div ref={ref} className="relative">
        <div
          className="flex items-center gap-2.5 flex-wrap"
          style={{ padding: '12px 16px', borderBottom: `1px solid ${SCENE.hair}` }}
        >
          <SceneIcon d="M4 4h7v7H4zM13 4h7v4h-7zM13 12h7v8h-7zM4 15h7v5H4z" size={14} />
          <SceneMono size={13} color={SCENE.inkDim}>{s.windowLabel}</SceneMono>
          <span className="ml-auto flex items-center gap-3 flex-wrap">
            {([
              ['ok', `hsl(${GROUP_HUES[1]} 32% 30%)`, s.legend.ok],
              ['slow', `hsl(${SLOW_HUE} 58% 46%)`, s.legend.slow],
              ['error', `hsl(${ERR_HUE} 56% 46%)`, s.legend.error],
            ] as const).map(([key, color, label]) => (
              <span key={key} className="flex items-center gap-1.5" style={{ fontSize: '11px', color: SCENE.inkDim }}>
                <span className="block w-[9px] h-[9px] rounded-[2px]" style={{ background: color }} />
                {label}
              </span>
            ))}
          </span>
        </div>

        <div style={{ padding: '16px' }}>
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            style={{ display: 'block', width: '100%', height: 'clamp(220px, 26vw, 330px)' }}
            role="img"
            aria-label={s.title}
          >
            {layout.map((group) => (
              <g key={group.label}>
                <text
                  x={group.rect.x + PAD + 2}
                  y={group.rect.y + PAD + 10}
                  style={{
                    fill: SCENE.inkDim, fontSize: '11px', fontFamily: 'var(--font-body)',
                    opacity: beat >= B.calm ? 1 : 0,
                    transition: 'opacity .6s ease',
                  }}
                >
                  {group.label}
                </text>
                {group.leaves.map((leaf) => {
                  const idx = order.get(`${group.label}/${leaf.label}`) ?? 0;
                  /*
                   * 扫描线：块按 x 顺序一个个写出来。判据钉在 visible 而不是 beat——
                   * 整个第一拍 beat 都是 0，用 beat 判会让"写字"这一拍根本没发生，
                   * 底下 transition-delay 的错峰白排了。
                   */
                  const written = visible;
                  const alarm = leaf.status !== 'ok';
                  /* 痛点要到第三拍才点睛：在那之前它跟着平静海一个色，不许提前剧透 */
                  const lit = alarm && beat >= B.pain;
                  const fill = lit ? leafFill(leaf.status, leaf.hue, leaf.depth) : leafFill('ok', leaf.hue, leaf.depth);
                  const showLabel = leaf.rect.w > 74 && leaf.rect.h > 26;
                  return (
                    <g key={leaf.label}>
                      <rect
                        x={leaf.rect.x + 1}
                        y={leaf.rect.y + 1}
                        width={Math.max(0, leaf.rect.w - 2)}
                        height={Math.max(0, leaf.rect.h - 2)}
                        rx={3}
                        style={{
                          fill,
                          stroke: lit ? leafFill(leaf.status, leaf.hue, leaf.depth) : 'transparent',
                          strokeWidth: lit ? 2 : 0,
                          opacity: written ? 1 : 0,
                          filter: lit ? 'brightness(1.18)' : undefined,
                          transition: `fill .7s ease, stroke .7s ease, opacity .5s ease ${idx * 55}ms`,
                        }}
                      />
                      {showLabel && (
                        <text
                          x={leaf.rect.x + 8}
                          y={leaf.rect.y + 19}
                          style={{
                            fill: lit ? SCENE.ink : SCENE.inkMid,
                            fontSize: '10.5px',
                            fontFamily: 'var(--font-body)',
                            opacity: written ? 1 : 0,
                            transition: `opacity .5s ease ${idx * 55 + 160}ms, fill .7s ease`,
                          }}
                        >
                          {leaf.label}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>
        </div>

        {/* 痛点榜：最后一拍从图里下钻过来，两条都指名道姓 */}
        <div
          className="overflow-hidden"
          style={{
            maxHeight: beat >= B.drill ? '190px' : '0px',
            opacity: beat >= B.drill ? 1 : 0,
            visibility: beat >= B.drill ? undefined : 'hidden',
            transition: 'max-height .6s cubic-bezier(.19,1,.22,1), opacity .5s ease',
          }}
        >
          <div style={{ padding: '0 16px 14px' }}>
            <SceneMono className="flex items-center gap-2" style={{ letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: '9px' }}>
              <span className="block w-[5px] h-[5px] rounded-full" style={{ background: steel.solid }} />
              {s.painTitle}
            </SceneMono>
            <div className="flex flex-col gap-2">
              {s.pains.map((pain) => {
                const tone = inkTone(pain.status === 'error' ? ERR_HUE : SLOW_HUE);
                return (
                  <div
                    key={pain.label}
                    className="flex items-center gap-3 flex-wrap"
                    style={{
                      padding: '10px 12px', borderRadius: '10px',
                      background: tone.faint, border: `1px solid ${tone.border}`,
                    }}
                  >
                    <span className="block w-[8px] h-[8px] rounded-[2px] shrink-0" style={{ background: tone.solid }} />
                    <span style={{ fontSize: '12.5px', color: SCENE.ink }}>{pain.label}</span>
                    <SceneMono size={13} color={tone.bright}>{pain.metric}</SceneMono>
                    <span className="min-w-0 flex-1" style={{ fontSize: '11.5px', color: SCENE.inkDim }}>{pain.note}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <BeatNarration beats={s.beats} beat={beat} hue={SCENE_HUE.slate} />
      </div>
    </SceneFrame>
  );
}
