/**
 * 关系图的几何判据（不靠人眼）。
 *
 * 2026-10-03 用户：「我不希望再看又出问题，你需要使用一些方式保证没问题，而不是让我去看」。
 * 关系图出过的问题全是几何问题：卡片被裁掉、挤压、线从别的卡上穿过去、两条线叠成一条看不出谁连谁。
 * 这些都能从布局结果直接算出来，所以把「好不好看」里能量化的那部分钉成下面这组判据，
 * 由 relation-geometry.test.ts 拿真实分支数据和随机生成的极端数据逐宽度跑。
 *
 * 判据只读 layoutRelations / edgePath 的输出，不读渲染层——渲染层的判据（文字是否被截、对比度、
 * 横向溢出）在 cds/web/scripts/relation-visual-audit.mjs 里用真浏览器量。
 */
import { edgePath, frameLabels, type RelationLayout, type RelationPayload } from '../../web/src/components/branch/RelationGraph.js';

export interface Rect { x: number; y: number; w: number; h: number }
interface Pt { x: number; y: number }

/** 把 edgePath 生成的 path d（只用 M/L/H/V/C/Q 的绝对坐标）展开成折线采样点 */
export function samplePath(d: string): Pt[] {
  const tokens = d.match(/[MLHVCQ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  const pts: Pt[] = [];
  let i = 0, cur: Pt = { x: 0, y: 0 };
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'L') { cur = { x: num(), y: num() }; if (cmd === 'L' && pts.length) addLine(pts, pts[pts.length - 1], cur); else pts.push(cur); }
    else if (cmd === 'H') { const n = { x: num(), y: cur.y }; addLine(pts, cur, n); cur = n; }
    else if (cmd === 'V') { const n = { x: cur.x, y: num() }; addLine(pts, cur, n); cur = n; }
    else if (cmd === 'C') {
      const c1 = { x: num(), y: num() }, c2 = { x: num(), y: num() }, e = { x: num(), y: num() };
      for (let t = 1; t <= 32; t += 1) { const s = t / 32, u = 1 - s; pts.push({ x: u * u * u * cur.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * e.x, y: u * u * u * cur.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * e.y }); }
      cur = e;
    } else if (cmd === 'Q') {
      const c = { x: num(), y: num() }, e = { x: num(), y: num() };
      for (let t = 1; t <= 16; t += 1) { const s = t / 16, u = 1 - s; pts.push({ x: u * u * cur.x + 2 * u * s * c.x + s * s * e.x, y: u * u * cur.y + 2 * u * s * c.y + s * s * e.y }); }
      cur = e;
    } else throw new Error(`edgePath 出现了判据不认识的命令 ${cmd}：${d}`);
  }
  return pts;
}
function addLine(pts: Pt[], a: Pt, b: Pt): void {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(len / 4));
  if (!pts.length) pts.push(a);
  for (let k = 1; k <= n; k += 1) pts.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
}

/** 折线里的水平 / 竖直线段（用来查两条线是否叠成一条） */
export function straightSegments(d: string): Array<{ axis: 'h' | 'v'; at: number; from: number; to: number }> {
  const out: Array<{ axis: 'h' | 'v'; at: number; from: number; to: number }> = [];
  const tokens = d.match(/[MLHVCQ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  let i = 0, cur: Pt = { x: 0, y: 0 };
  const num = (): number => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M') cur = { x: num(), y: num() };
    else if (cmd === 'H') { const x = num(); out.push({ axis: 'h', at: cur.y, from: Math.min(cur.x, x), to: Math.max(cur.x, x) }); cur = { x, y: cur.y }; }
    else if (cmd === 'V') { const y = num(); out.push({ axis: 'v', at: cur.x, from: Math.min(cur.y, y), to: Math.max(cur.y, y) }); cur = { x: cur.x, y }; }
    else if (cmd === 'L') { const n = { x: num(), y: num() }; if (Math.abs(n.y - cur.y) < 0.01) out.push({ axis: 'h', at: cur.y, from: Math.min(cur.x, n.x), to: Math.max(cur.x, n.x) }); else if (Math.abs(n.x - cur.x) < 0.01) out.push({ axis: 'v', at: cur.x, from: Math.min(cur.y, n.y), to: Math.max(cur.y, n.y) }); cur = n; }
    else if (cmd === 'C') { i += 4; cur = { x: num(), y: num() }; }
    else if (cmd === 'Q') { i += 2; cur = { x: num(), y: num() }; }
  }
  return out;
}

const inside = (p: Pt, r: Rect, inset: number): boolean => p.x > r.x + inset && p.x < r.x + r.w - inset && p.y > r.y + inset && p.y < r.y + r.h - inset;
const overlap = (a: Rect, b: Rect, tol = 0.5): boolean => a.x < b.x + b.w - tol && b.x < a.x + a.w - tol && a.y < b.y + b.h - tol && b.y < a.y + a.h - tol;
const contains = (outer: Rect, inner: Rect, tol = 0.5): boolean => inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;
/** 点到矩形边框的距离（点在框内时取到最近一条边的距离） */
function distToBorder(p: Pt, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  return Math.min(p.x - r.x, r.x + r.w - p.x, p.y - r.y, r.y + r.h - p.y);
}
const same = (a: Rect, b: Rect): boolean => a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

export interface GeometryReport { violations: string[]; cards: number; edges: number }

/**
 * 判据清单（任一条命中即红）：
 *  G1 每个服务 / 基础设施都画出来了
 *  G2 卡片互不重叠
 *  G3 卡片与站点框都在画布里（不会被裁掉一截）
 *  G4 每张服务卡都落在某个站点框里；站点框互不重叠
 *  G5 每条线从起点卡的边上出发、落到终点卡（或终点框）的边上——不是悬空的线
 *  G6 线不从第三张卡片上穿过（被卡片盖住的线读不出连的是谁）
 *  G7 线不压在站点框的标题字上
 *  G8 不同来源的两条线不叠成同一段（叠在一起就分不清谁连谁）
 */
export function auditLayout(layout: RelationLayout, payload: RelationPayload, entryHost?: string): GeometryReport {
  const v: string[] = [];
  const W = layout.width, H = layout.height;
  const cards: Array<{ id: string; r: Rect }> = [{ id: 'entry', r: layout.entry }];
  for (const [id, r] of layout.pos) cards.push({ id, r });
  for (const e of layout.externals) cards.push({ id: e.id, r: e.pos });

  // G1
  const placedReal = new Set(Array.from(layout.pos.keys()).map((id) => layout.aliasOf.get(id) ?? id));
  for (const n of payload.graph.nodes) {
    const id = n.kind === 'service' ? (n.rawId ?? n.id.replace(/^service:/, '')) : n.id;
    if (!placedReal.has(id)) v.push(`G1 没画出来：${id}`);
  }
  // G2
  for (let i = 0; i < cards.length; i += 1) for (let j = i + 1; j < cards.length; j += 1) {
    if (overlap(cards[i].r, cards[j].r)) v.push(`G2 卡片重叠：${cards[i].id} × ${cards[j].id}`);
  }
  // G3
  for (const c of cards) if (c.r.x < 0 || c.r.y < 0 || c.r.x + c.r.w > W + 0.5 || c.r.y + c.r.h > H + 0.5) v.push(`G3 卡片出画布：${c.id} (${Math.round(c.r.x)},${Math.round(c.r.y)},${Math.round(c.r.w)}x${Math.round(c.r.h)}) 画布 ${W}x${H}`);
  for (const f of layout.frames) if (f.x < 0 || f.y < 0 || f.x + f.w > W + 0.5 || f.y + f.h > H + 0.5) v.push(`G3 站点框出画布：${f.key}`);
  // G4
  for (const c of cards) {
    if (c.id === 'entry') continue;
    if (!layout.frames.some((f) => contains(f, c.r))) v.push(`G4 卡片不在任何站点框里：${c.id}`);
  }
  for (let i = 0; i < layout.frames.length; i += 1) for (let j = i + 1; j < layout.frames.length; j += 1) {
    if (overlap(layout.frames[i], layout.frames[j])) v.push(`G4 站点框重叠：${layout.frames[i].key} × ${layout.frames[j].key}`);
  }
  // 框标题占的区域：与渲染层调用的是同一个 frameLabels（含截断与让位），不另算一份
  const labelRects = layout.frames.flatMap((f) => {
    const lb = frameLabels(f, entryHost, layout.compact);
    const rects: Array<{ key: string; r: Rect }> = [{ key: `${f.key} 标题`, r: lb.titleRect }];
    if (lb.subRect) rects.push({ key: `${f.key} 说明`, r: lb.subRect });
    return rects;
  });

  // G5–G8
  const segs: Array<{ key: string; from: Rect; kind: string; s: ReturnType<typeof straightSegments>[number] }> = [];
  for (const e of layout.edges) {
    const d = edgePath(e);
    const pts = samplePath(d);
    if (pts.length < 2) { v.push(`G5 线没有长度：${e.key}`); continue; }
    const start = pts[0], end = pts[pts.length - 1];
    if (distToBorder(start, e.from) > 3) v.push(`G5 线不是从起点卡的边上出发：${e.key}（离边 ${distToBorder(start, e.from).toFixed(1)}px）`);
    const endGap = distToBorder(end, e.to);
    if (endGap > 4) v.push(`G5 线没落到终点的边上：${e.key}（离边 ${endGap.toFixed(1)}px）`);
    for (const c of cards) {
      if (same(c.r, e.from) || same(c.r, e.to)) continue;
      const hit = pts.find((p) => inside(p, c.r, 1.5));
      if (hit) { v.push(`G6 线从别的卡片上穿过：${e.key} 穿过 ${c.id}`); break; }
    }
    for (const lr of labelRects) {
      if (pts.some((p) => inside(p, lr.r, 0))) { v.push(`G7 线压在框标题上：${e.key} 压住 ${lr.key}`); break; }
    }
    for (const s of straightSegments(d)) segs.push({ key: e.key, from: e.from, kind: e.kind, s });
  }
  for (let i = 0; i < segs.length; i += 1) for (let j = i + 1; j < segs.length; j += 1) {
    const a = segs[i], b = segs[j];
    if (a.key === b.key || a.s.axis !== b.s.axis || Math.abs(a.s.at - b.s.at) > 0.5) continue;
    // 同一个起点的前缀线共用总线、入口线共用左侧走线槽，是有意的一棵树；其余任何两条线都不许叠
    if (same(a.from, b.from) && a.kind === b.kind && (a.kind === 'prefix' || a.kind === 'entry')) continue;
    const shared = Math.min(a.s.to, b.s.to) - Math.max(a.s.from, b.s.from);
    if (shared > 2) v.push(`G8 两条线叠成一段：${a.key} 与 ${b.key}（${a.s.axis === 'h' ? '横' : '竖'}向共 ${Math.round(shared)}px）`);
  }
  return { violations: Array.from(new Set(v)), cards: cards.length, edges: layout.edges.length };
}

/** 确定性随机数（mulberry32），让随机样本每次跑都一样、失败可复现 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机生成一份「合法但极端」的服务图：长名字、多子域、双公网面、内网服务、互相依赖、基础设施、跨项目引用都可能出现 */
export function randomPayload(seed: number): RelationPayload {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const n = 1 + Math.floor(r() * 26);
  const words = ['api', 'web', 'admin', 'worker', 'gateway', 'open-platform', 'scan-runtime', 'vendor', 'product-batch', 'code-return', 'generation', 'cloudbridge', 'notify', 'billing'];
  const ids = Array.from({ length: n }, (_, i) => `${pick(words)}-${i}${r() < 0.3 ? '-' + pick(words) + '-' + pick(words) : ''}`);
  const roles = ['web', 'api', 'worker'] as const;
  const nodes: RelationPayload['graph']['nodes'] = ids.map((id) => ({ id: `service:${id}`, rawId: id, name: id, kind: 'service', role: pick([...roles]), pathPrefixes: r() < 0.5 ? [`/${id}/`] : [] }));
  const infraN = Math.floor(r() * 5);
  for (let i = 0; i < infraN; i += 1) nodes.push({ id: `infra:db-${i}`, name: `db-${i}`, kind: 'infra', dockerImage: r() < 0.5 ? 'redis:7' : 'mongo:7' });
  const shuffled = [...ids].sort(() => r() - 0.5);
  const sites: RelationPayload['graph']['sites'] = [];
  const hasMain = r() < 0.85;
  let cursor = 0;
  if (hasMain) {
    const shell = r() < 0.9 ? shuffled[cursor++] : undefined;
    const mCount = Math.floor(r() * Math.min(9, n));
    const members = shuffled.slice(cursor, cursor + mCount).map((id) => ({ id, prefixes: [`/${id}/`], viaConvention: r() < 0.2 }));
    cursor += mCount;
    sites.push({ id: 'main', kind: 'main', shellId: shell, shellSource: r() < 0.2 ? 'convention' : 'declared', members, conflicts: [] });
  }
  const subCount = Math.floor(r() * 14);
  for (let i = 0; i < subCount; i += 1) {
    // 三成概率挑一个已经在主域名下的服务做子域壳（双公网面）
    const shell = r() < 0.3 && cursor > 0 ? shuffled[Math.floor(r() * cursor)] : shuffled[cursor++];
    if (!shell) break;
    const members = r() < 0.15 && cursor < n ? [{ id: shuffled[cursor++], prefixes: ['/x/'] }] : [];
    sites.push({ id: `sub:s${i}`, kind: 'subdomain', subdomain: `sub-${i}-${pick(words)}`, shellId: shell, shellSource: 'declared', members, conflicts: [] });
  }
  const internal = shuffled.slice(cursor);
  const edges: RelationPayload['graph']['edges'] = [];
  const eCount = Math.floor(r() * 12);
  for (let i = 0; i < eCount; i += 1) {
    const a = pick(ids), b = pick(ids);
    if (a !== b && !edges.some((e) => e.from === `service:${a}` && e.to === `service:${b}`)) edges.push({ from: `service:${a}`, to: `service:${b}`, envKeys: r() < 0.5 ? ['X_URL'] : [], dependsOn: r() < 0.5 });
  }
  for (let i = 0; i < infraN; i += 1) if (r() < 0.6) edges.push({ from: `service:${pick(ids)}`, to: `infra:db-${i}`, envKeys: ['DB_URL'], dependsOn: false });
  const references: RelationPayload['references'] = [];
  const refN = Math.floor(r() * 3);
  for (let i = 0; i < refN; i += 1) references.push({ profileId: pick(ids), key: `REF_${i}`, kind: 'cds-ref', resolved: [{ url: null, status: r() < 0.5 ? 'running' : 'stopped', target: { projectId: `other-${i}`, projectSlug: `proj-${i}`, branchName: 'main', serviceId: `svc-${i}` }, ref: { projectRef: `proj-${i}`, serviceId: `svc-${i}` } }] });
  const findings: RelationPayload['lint']['findings'] = [];
  for (const id of ids) if (r() < 0.15) findings.push({ rule: 'random', severity: pick(['error', 'warn', 'info'] as const), services: [id], message: 'm', fix: 'f' });
  return {
    branchId: `b${seed}`, projectId: 'p', branch: `fuzz-${seed}`, status: 'running',
    graph: { nodes, edges, layers: [], sites, internal },
    lint: { findings, summary: { errors: findings.filter((f) => f.severity === 'error').length, warnings: findings.filter((f) => f.severity === 'warn').length, infos: findings.filter((f) => f.severity === 'info').length } },
    references,
  };
}
