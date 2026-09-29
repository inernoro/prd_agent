import { useMemo } from 'react';

import { GalaxyCanvas, type GalaxyFrame } from './FilmGalaxy';
import { FILM } from './filmPalette';
import { PosterArt } from './FilmStage';
import { easeInOutCubic, easeOutCubic, lerp, span, typed } from './filmTimeline';

/**
 * 首屏满屏循环（样片阶段）：借可灵首屏的结构——背景是作品本身、没有一个字，
 * 输入框里写着「生成背后这幅画面的那句话」，声音交给用户开。
 *
 * 两个镜头，一句话对一个产物，都是产品里真有的能力：
 *   A「把仓库的 doc/ 目录同步进知识库」→ 知识星系从银心长出来（真建树 + 真布局 + 本仓库真文档）
 *   B「为新品发布会做一张海报」→ 视觉创作的四张图逐张显影
 * 末尾淡回深空，与第 0 秒同一个状态，所以循环没有接缝。
 * 画面是 t 的纯函数，与片花同一套做法：可以逐帧导出，也可以在页面上实时跑。
 */
export const HERO_LOOP_DURATION = 16;

/** 首屏打开时从这一刻起播：星系已经长好，第一眼就是作品，不是一片空的深空 */
export const HERO_LOOP_ENTRY = 5.2;

interface Shot {
  /** 这一句从哪一刻开始打 */
  typeAt: number;
  /** 按下「开启创作」的那一刻 */
  pressAt: number;
}

const SHOTS: [Shot, Shot] = [
  { typeAt: 0.25, pressAt: 2.0 },
  { typeAt: 8.3, pressAt: 10.0 },
];

/** 海报的设计宽度：与片花视觉创作一幕的图块同宽（FilmStage 的 TILE.w） */
const POSTER_DESIGN_W = 468;

/** 镜头 B 的四张图各自在哪一刻开始显影 */
const DEVELOP_AT = [10.25, 10.65, 11.05, 11.45];

export interface HeroLoopBeat {
  /** 当前是哪一句（0 = 知识库，1 = 视觉创作） */
  shot: 0 | 1;
  /** 输入框里此刻显示的字 */
  shown: string;
  /** 光标是否在闪（正在打字） */
  typing: boolean;
  /** 「开启创作」按钮按下的进度（0..1，一次完整手势） */
  press: number;
}

/** 输入框那一层读这个：此刻该显示哪一句、打到第几个字、按钮按没按。 */
export function heroLoopBeat(t: number, prompts: [string, string]): HeroLoopBeat {
  const shot: 0 | 1 = t >= SHOTS[1].typeAt - 0.4 ? 1 : 0;
  const { typeAt, pressAt } = SHOTS[shot];
  const text = prompts[shot];
  const cps = Array.from(text).length / Math.max(0.6, pressAt - 0.25 - typeAt);
  // 按下之后字还留着，到下一句开打之前清空；末尾淡回深空时也清空，和第 0 秒一致
  const clearAt = shot === 0 ? SHOTS[1].typeAt - 0.4 : HERO_LOOP_DURATION - 1.0;
  const shown = t < clearAt ? typed(text, t, typeAt, cps) : '';
  return {
    shot,
    shown,
    typing: t >= typeAt - 0.2 && t < pressAt,
    press: span(t, pressAt, pressAt + 0.26),
  };
}

/** 背景：纯画面，不带任何字。compact = 手机竖屏构图。 */
export function HeroLoop({ t, w, h, compact = false, dpr }: { t: number; w: number; h: number; compact?: boolean; dpr?: number }) {
  const galaxyLt = t - (SHOTS[0].pressAt + 0.1);
  // 镜头 A → B 的交叉溶解，B 收尾淡回深空
  const toB = easeInOutCubic(span(t, 8.0, 9.0));
  const outro = easeInOutCubic(span(t, HERO_LOOP_DURATION - 1.0, HERO_LOOP_DURATION));
  const galaxyAlpha = 1 - toB;
  const postersAlpha = toB * (1 - outro);

  const frame = useMemo<GalaxyFrame>(
    () =>
      compact
        ? // 手机：作品在屏幕正中，标题在上、输入框在下，从上往下读是「标题 → 作品 → 生成它的那句话」
          { cx: w * 0.5, cy: h * 0.52, radius: w * 0.7, labels: false, dpr: dpr ?? 2, sky: false, glow: 0.55 }
        : { cx: w * 0.5, cy: h * 0.6, radius: h * 0.56, labels: false, dpr: dpr ?? 1, sky: false },
    [compact, w, h, dpr],
  );
  const skyFrame = useMemo<GalaxyFrame>(
    () => ({ ...frame, sky: true, nodes: false, starsAlways: true }),
    [frame],
  );

  // 镜头 B：四张图的构图。宽屏一行四张、向远处微倾；手机两行两张
  const push = 1 + 0.08 * easeOutCubic(span(t, 9.0, HERO_LOOP_DURATION));
  const tiles = compact
    ? { cols: 2, tw: w * 0.42, th: w * 0.42 * 0.72, gap: w * 0.04, top: h * 0.52 - (w * 0.42 * 0.72 + w * 0.02) }
    : { cols: 4, tw: w * 0.17, th: w * 0.17 * 1.18, gap: w * 0.02, top: h * 0.6 };
  const gridW = tiles.cols * tiles.tw + (tiles.cols - 1) * tiles.gap;

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: FILM.spaceEdge }}>
      {/* 深空与星场：一直在，首尾同一个状态 */}
      <GalaxyCanvas lt={t} d={HERO_LOOP_DURATION} w={w} h={h} frame={skyFrame} />
      {/* 镜头 A：知识星系本体，透明底叠在深空上 */}
      {galaxyAlpha > 0 && galaxyLt > -0.1 && (
        <div style={{ position: 'absolute', inset: 0, opacity: galaxyAlpha }}>
          <GalaxyCanvas lt={galaxyLt} d={7} w={w} h={h} frame={frame} />
        </div>
      )}

      {/* 镜头 B：四张图逐张显影 */}
      {postersAlpha > 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: postersAlpha,
            perspective: compact ? 900 : 1800,
            perspectiveOrigin: '50% 30%',
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: (w - gridW) / 2,
              top: tiles.top,
              width: gridW,
              transform: `rotateX(${compact ? 8 : 14}deg) scale(${push})`,
              transformOrigin: '50% 0%',
              display: 'grid',
              gridTemplateColumns: `repeat(${tiles.cols}, ${tiles.tw}px)`,
              gap: tiles.gap,
            }}
          >
            {DEVELOP_AT.map((at, i) => {
              const develop = span(t, at, at + 0.9);
              const rise = easeOutCubic(span(t, at - 0.3, at + 0.5));
              return (
                <div
                  key={i}
                  style={{
                    position: 'relative',
                    height: tiles.th,
                    borderRadius: compact ? 12 : 20,
                    overflow: 'hidden',
                    boxShadow: FILM.shadow,
                    opacity: lerp(0.35, 1, rise),
                    transform: `translateY(${(1 - rise) * 40}px)`,
                  }}
                >
                  {/* 海报里的字号是按片花那一幕的尺寸写的：先按原尺寸画，再整体等比缩到格子大小，字才不会被截 */}
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: POSTER_DESIGN_W,
                      height: POSTER_DESIGN_W * (tiles.th / tiles.tw),
                      transform: `scale(${tiles.tw / POSTER_DESIGN_W})`,
                      transformOrigin: '0 0',
                    }}
                  >
                    <PosterArt variant={i} develop={develop} drift={Math.max(0, t - at) / 5} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 字压在画面上要读得清：上半截与正中压暗，四角留亮（可灵那一屏也是这么做的） */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: compact
            ? `linear-gradient(180deg, ${FILM.spaceEdge}F2 0%, ${FILM.spaceEdge}99 24%, ${FILM.spaceEdge}00 38%, ${FILM.spaceEdge}00 66%, ${FILM.spaceEdge}B3 80%, ${FILM.spaceEdge}F2 100%)`
            : `radial-gradient(ellipse 70% 55% at 50% 40%, ${FILM.spaceEdge}B3 0%, ${FILM.spaceEdge}00 70%), linear-gradient(180deg, ${FILM.spaceEdge}CC 0%, ${FILM.spaceEdge}00 22%, ${FILM.spaceEdge}00 78%, ${FILM.spaceEdge}99 100%)`,
        }}
      />
    </div>
  );
}
