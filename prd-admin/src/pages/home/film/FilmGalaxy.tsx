import { useLayoutEffect, useRef } from 'react';

import { buildDocGalaxy, DOC_TYPES, type GalaxyNode } from '@/lib/docGalaxy/buildDocGalaxy';
import { DOC_TYPE_COLOR, colorForDocType } from '@/lib/docGalaxy/docTypeColors';
import { layoutRadial2D } from '@/lib/docGalaxy/radialLayout';

import docs from './filmDocs.json';
import { FILM } from './filmPalette';
import { easeInOutCubic, easeOutBack, easeOutCubic, lerp, seeded, span } from './filmTimeline';

/**
 * 片花「知识星系」：不是手画的示意图，是知识库星系页的真东西。
 *
 * 数据是本仓库 doc/ 的文件名快照（filmDocs.json），建树用知识库星系同一个函数
 * buildDocGalaxy（根 → 分类 → 应用 → 子模块 → 文档），摆位用星系页「折叠 2D」同一个
 * 放射布局 layoutRadial2D，叶子按文档类型取色（docTypeColors，与星系页同一份）。
 * 画法照星系页的视觉语言：深空穹顶、父端亮蓝渐隐到子端类型色的外拱弧线、
 * 从银心向外的生长波、枢纽缓旋星芒、沿光路巡游的流光。
 *
 * 用 canvas 而不是 SVG：七百多个节点每帧重排 SVG 太重；canvas 每帧是 lt 的纯函数，
 * 在 useLayoutEffect 里同步画完，逐帧导出时截到的就是这一帧（与画面其它部分同一个时间）。
 */

interface Star {
  node: GalaxyNode;
  x: number;
  y: number;
  parent: Star | null;
  /** 在这一幕里长出来的时刻（秒，幕内时间） */
  born: number;
  color: string;
  r: number;
}

interface GalaxyModel {
  stars: Star[];
  maxR: number;
  docCount: number;
  /** 最大的几个应用分组，给它们挂名字 */
  labeled: Star[];
  /** 流光走的路：根 → 某篇文档 */
  routes: Star[][];
}

let cached: GalaxyModel | null = null;

function galaxyModel(): GalaxyModel {
  if (cached) return cached;
  const galaxy = buildDocGalaxy(docs.names.map((name) => ({ id: name, title: name })));
  const { pos2dById, maxRadius } = layoutRadial2D(galaxy.root);
  const jitter = seeded(4242);
  const stars: Star[] = [];
  const walk = (node: GalaxyNode, parent: Star | null) => {
    const p = pos2dById.get(node.id) ?? { x: 0, y: 0 };
    const dist = Math.hypot(p.x, p.y);
    const hub = node.kind !== 'leaf';
    const star: Star = {
      node,
      x: p.x,
      y: p.y,
      parent,
      // 生长波：由银心向外按半径错峰，同一环上略有先后，不是一整圈同时蹦出来
      born: 0.2 + 1.5 * (dist / maxRadius) + jitter() * 0.12,
      color: hub ? FILM.galaxyHub : colorForDocType(node.docType),
      // 只有前两层是看得见的「枢纽」；更深的分组只是一颗比叶子略大的星，不抢戏
      r: node.kind === 'root' ? 11 : !hub ? 2.1 : node.depth <= 2 ? Math.min(8.5, 2.6 + 1.1 * Math.sqrt(node.docCount)) + (node.depth === 1 ? 1.5 : 0) : 2.6,
    };
    stars.push(star);
    for (const child of node.children) walk(child, star);
  };
  walk(galaxy.root, null);

  // 挂名字的：按篇数从大到小挑应用分组，和已挑中的任何一个角度差不足 0.45 弧度就跳过（名字不叠在一起）
  const labeled: Star[] = [];
  const angle = (s: Star) => Math.atan2(s.y, s.x);
  for (const s of stars
    .filter((x) => x.node.depth === 2 && x.node.kind === 'group')
    .sort((a, b) => b.node.docCount - a.node.docCount)) {
    const clash = labeled.some((l) => {
      const dA = Math.abs(angle(l) - angle(s));
      return Math.min(dA, Math.PI * 2 - dA) < 0.45;
    });
    if (!clash) labeled.push(s);
    if (labeled.length === 5) break;
  }
  const leaves = stars.filter((s) => s.node.kind === 'leaf');
  const pick = seeded(77);
  const routes = Array.from({ length: 9 }, () => {
    const route: Star[] = [];
    for (let s: Star | null = leaves[Math.floor(pick() * leaves.length)]; s; s = s.parent) route.unshift(s);
    return route;
  });
  cached = { stars, maxR: maxRadius, docCount: leaves.length, labeled, routes };
  return cached;
}

/** 预渲染的柔光贴图：每种颜色一张，叠加模式下 drawImage 比每颗星现建渐变便宜一个量级。 */
const sprites = new Map<string, HTMLCanvasElement>();
function glow(color: string): HTMLCanvasElement {
  const hit = sprites.get(color);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, color);
    grad.addColorStop(0.25, `${color}88`);
    grad.addColorStop(1, `${color}00`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  sprites.set(color, c);
  return c;
}

/** 二次贝塞尔的前 p 段（de Casteljau）：光路从父端向子端「画」出来。 */
function partialQuad(ctx: CanvasRenderingContext2D, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, p: number) {
  const ax = lerp(x0, cx, p);
  const ay = lerp(y0, cy, p);
  const bx = lerp(cx, x1, p);
  const by = lerp(cy, y1, p);
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(ax, ay, lerp(ax, bx, p), lerp(ay, by, p));
}

/** 连线的控制点：中点往「背离银心」的法向推一点——弧线向外微拱，不穿过别的枝。 */
function control(a: Star, b: Star): { x: number; y: number } {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let nx = -dy / len;
  let ny = dx / len;
  if (nx * mx + ny * my < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: mx + nx * len * 0.14, y: my + ny * len * 0.14 };
}

const DPR = 2;

/** 取景：星系中心放在哪、盘面半径多大、挂不挂名字。片花里的窗口用默认值，首屏满屏背景另给。 */
export interface GalaxyFrame {
  cx?: number;
  cy?: number;
  /** 盘面最外环在屏幕上的半径（像素） */
  radius?: number;
  labels?: boolean;
  dpr?: number;
  /** 画不画深空底与星场（false = 透明底，只画星图，叠在别的层上） */
  sky?: boolean;
  /** 画不画星图本体（false = 只剩深空与星场） */
  nodes?: boolean;
  /** 星场一开始就在，不随生长淡入（循环背景的首尾要一致） */
  starsAlways?: boolean;
  /** 柔光与星芒的强弱倍数（小屏盘面小、光晕尺寸不变，会糊成一团，要压下去） */
  glow?: number;
}

function draw(ctx: CanvasRenderingContext2D, lt: number, w: number, h: number, d: number, frame: GalaxyFrame = {}) {
  const model = galaxyModel();
  const dpr = frame.dpr ?? DPR;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // 深空穹顶
  const cx = frame.cx ?? w / 2;
  const cy = frame.cy ?? h / 2 - 20;
  ctx.clearRect(0, 0, w, h);
  if (frame.sky !== false) {
  const sky = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.75);
  sky.addColorStop(0, FILM.spaceCore);
  sky.addColorStop(1, FILM.spaceEdge);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // 远景星场：固定种子，只随时间呼吸
  const rnd = seeded(9001);
  ctx.fillStyle = FILM.text;
  const starCount = Math.round(170 * Math.max(1, (w * h) / (700 * 764)) ** 0.5);
  for (let i = 0; i < starCount; i += 1) {
    const x = rnd() * w;
    const y = rnd() * h;
    const r = 0.4 + rnd() * 0.9;
    const phase = rnd() * Math.PI * 2;
    ctx.globalAlpha = (0.12 + 0.3 * (0.5 + 0.5 * Math.sin(lt * 1.6 + phase))) * (frame.starsAlways ? 1 : easeOutCubic(span(lt, 0, 0.6)));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  }
  if (frame.nodes === false) return;

  // 镜头：缓推 + 缓转
  const fit = (frame.radius ?? Math.min(w, h) / 2 - 30) / model.maxR;
  const zoom = fit * lerp(0.9, 1.06, easeOutCubic(span(lt, 0, d)));
  const rot = lerp(-0.12, 0.05, easeInOutCubic(span(lt, 0, d)));
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const toScreen = (s: Star) => ({ x: cx + (s.x * cos - s.y * sin) * zoom, y: cy + (s.x * sin + s.y * cos) * zoom });

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.scale(zoom, zoom);
  const px = 1 / zoom;

  // 光路：父端亮蓝 → 子端类型色，跟着生长波从父端画向子端
  ctx.lineCap = 'round';
  for (const s of model.stars) {
    const parent = s.parent;
    if (!parent) continue;
    const p = easeInOutCubic(span(lt, parent.born + 0.05, s.born + 0.2));
    if (p <= 0) continue;
    const c = control(parent, s);
    const leaf = s.node.kind === 'leaf';
    ctx.beginPath();
    partialQuad(ctx, parent.x, parent.y, c.x, c.y, s.x, s.y, p);
    if (leaf) {
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = 0.26;
      ctx.lineWidth = 0.9 * px;
    } else {
      const grad = ctx.createLinearGradient(parent.x, parent.y, s.x, s.y);
      grad.addColorStop(0, FILM.galaxyHub);
      grad.addColorStop(1, `${FILM.galaxyHub}33`);
      ctx.strokeStyle = grad;
      ctx.globalAlpha = parent.node.kind === 'root' ? 0.7 : 0.5;
      ctx.lineWidth = (parent.node.kind === 'root' ? 1.8 : 1.3) * px;
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 柔光（叠加模式）：枢纽亮、叶子淡，整盘像一片星云而不是一堆圆点
  ctx.globalCompositeOperation = 'lighter';
  for (const s of model.stars) {
    const pop = easeOutBack(span(lt, s.born, s.born + 0.45));
    if (pop <= 0) continue;
    const tier = s.node.kind === 'root' ? 0 : s.node.kind === 'leaf' ? 3 : Math.min(s.node.depth, 3);
    // 按层分档：银心最亮、一级枢纽次之、应用分组再次；更深的分组和叶子只留一层薄光，
    // 否则同一环上几百颗星的光晕叠加成一圈发白的光带
    const [spread, alpha] = ([[11, 0.8], [7, 0.55], [5, 0.38], [3.2, 0.16]] as const)[tier];
    const size = s.r * spread * pop * px * (frame.glow ?? 1);
    ctx.globalAlpha = alpha * Math.min(1, frame.glow ?? 1);
    ctx.drawImage(glow(s.node.kind === 'root' ? FILM.clay : s.color), s.x - size, s.y - size, size * 2, size * 2);
  }

  // 银心与一级枢纽的缓旋星芒
  for (const s of model.stars) {
    if (s.node.depth > 1) continue;
    const pop = easeOutCubic(span(lt, s.born, s.born + 0.6));
    if (pop <= 0) continue;
    const len = (s.node.kind === 'root' ? 70 : 26) * pop * px;
    const spin = lt * 0.35 + (s.node.depth === 1 ? 0.6 : 0);
    ctx.globalAlpha = s.node.kind === 'root' ? 0.55 : 0.35;
    for (let k = 0; k < 2; k += 1) {
      const a = spin + (k * Math.PI) / 2;
      const grad = ctx.createLinearGradient(s.x - Math.cos(a) * len, s.y - Math.sin(a) * len, s.x + Math.cos(a) * len, s.y + Math.sin(a) * len);
      grad.addColorStop(0, `${FILM.galaxyCore}00`);
      grad.addColorStop(0.5, FILM.galaxyCore);
      grad.addColorStop(1, `${FILM.galaxyCore}00`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.2 * px;
      ctx.beginPath();
      ctx.moveTo(s.x - Math.cos(a) * len, s.y - Math.sin(a) * len);
      ctx.lineTo(s.x + Math.cos(a) * len, s.y + Math.sin(a) * len);
      ctx.stroke();
    }
  }

  // 流光：沿「根 → 某篇文档」的光路巡游，数据在星系里流动
  for (let i = 0; i < model.routes.length; i += 1) {
    const route = model.routes[i];
    const last = route[route.length - 1];
    if (lt < last.born + 0.4) continue;
    const u = ((lt - last.born - 0.4) * 0.55 + i * 0.137) % 1;
    const f = u * (route.length - 1);
    const k = Math.min(route.length - 2, Math.floor(f));
    const a = route[k];
    const b = route[k + 1];
    const x = lerp(a.x, b.x, f - k);
    const y = lerp(a.y, b.y, f - k);
    const size = 9 * px;
    ctx.globalAlpha = Math.sin(u * Math.PI) * 0.9;
    ctx.drawImage(glow(FILM.galaxyCore), x - size, y - size, size * 2, size * 2);
  }

  // 实心星体
  ctx.globalCompositeOperation = 'source-over';
  for (const s of model.stars) {
    const pop = easeOutBack(span(lt, s.born, s.born + 0.45));
    if (pop <= 0) continue;
    const leaf = s.node.kind === 'leaf';
    ctx.globalAlpha = Math.min(1, pop);
    ctx.fillStyle = s.node.kind === 'root' ? FILM.galaxyCore : s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(0, s.r * pop) * px, 0, Math.PI * 2);
    ctx.fill();
    if (!leaf) {
      // 枢纽的白热核：正中亮、往外回落本色
      ctx.fillStyle = FILM.galaxyCore;
      ctx.globalAlpha = Math.min(1, pop) * 0.85;
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.max(0, s.r * 0.45 * pop) * px, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // 最大的几个应用分组挂上名字（应用名本来就是英文标识，中英两版同一套）
  ctx.globalCompositeOperation = 'source-over';
  ctx.font = '600 15px "JetBrains Mono", ui-monospace, monospace';
  ctx.shadowColor = FILM.spaceEdge;
  ctx.shadowBlur = 8;
  ctx.textBaseline = 'middle';
  for (const s of frame.labels === false ? [] : model.labeled) {
    const alpha = easeOutCubic(span(lt, s.born + 0.3, s.born + 0.9));
    if (alpha <= 0) continue;
    const p = toScreen(s);
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const x = p.x + (dx / len) * (s.r + 16);
    const y = p.y + (dy / len) * (s.r + 16);
    ctx.textAlign = Math.abs(dx / len) < 0.3 ? 'center' : dx > 0 ? 'left' : 'right';
    // 深空色柔影垫底，名字压在光路上也读得清
    ctx.globalAlpha = alpha * 0.9;
    ctx.fillStyle = FILM.text;
    ctx.fillText(s.node.name, x, y);
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

/** 只有星系本体（深空 + 星图），不带左上角篇数与底部图例——给首屏满屏背景用。 */
export function GalaxyCanvas({ lt, d, w, h, frame }: { lt: number; d: number; w: number; h: number; frame?: GalaxyFrame }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = frame?.dpr ?? DPR;
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx) draw(ctx, lt, w, h, d, frame);
  }, [lt, w, h, d, frame]);
  return <canvas ref={ref} width={Math.round(w * dpr)} height={Math.round(h * dpr)} style={{ position: 'absolute', inset: 0, width: w, height: h }} />;
}

export function FilmGalaxy({ lt, d, w, h, stat }: { lt: number; d: number; w: number; h: number; stat: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx) draw(ctx, lt, w, h, d);
  }, [lt, w, h, d]);
  const model = galaxyModel();
  const legendIn = easeOutCubic(span(lt, 1.4, 2.0));
  const count = Math.round(model.docCount * easeOutCubic(span(lt, 0.2, 1.8)));
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <canvas ref={ref} width={w * DPR} height={h * DPR} style={{ position: 'absolute', inset: 0, width: w, height: h }} />
      <div style={{ position: 'absolute', left: 28, top: 22, display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 44, fontWeight: 700, letterSpacing: '-0.03em', color: FILM.text, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
        <span style={{ fontSize: 19, color: FILM.gray }}>{stat}</span>
      </div>
      <div style={{ position: 'absolute', left: 28, right: 28, bottom: 22, display: 'flex', flexWrap: 'wrap', gap: '8px 18px', opacity: legendIn }}>
        {DOC_TYPES.map((type) => (
          <span key={type} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 15, color: FILM.textDim, fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}>
            <span style={{ width: 9, height: 9, borderRadius: 5, background: DOC_TYPE_COLOR[type], boxShadow: `0 0 8px ${DOC_TYPE_COLOR[type]}` }} />
            {type}
          </span>
        ))}
      </div>
    </div>
  );
}
