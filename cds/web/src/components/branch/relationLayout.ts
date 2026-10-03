/*
 * 关系图的布局与走线（纯函数，不碰 DOM）。RelationGraph 只负责把这里算出来的东西画出来。
 *
 * 为什么单独成文件：关系图出过的问题全是几何问题——卡被裁、卡被挤、线从别的卡上穿过、
 * 两条线叠成一条、线压在框标题上。这些都能从布局结果直接算出来，所以布局必须是纯函数，
 * 由 cds/tests/web/relation-geometry.test.ts 拿真实分支和随机极端样本逐宽度验（判据 G1–G8）。
 *
 * 布局：站点框自上而下堆叠（主域名 → 带成员的子域 → 子域网格 → 外部项目 → 其它 → 共享基础设施），
 * 框里的卡片按行排；行与行之间的空隙、框右侧的走线槽是线的「通道」，卡片本身永远不让线穿过。
 *
 * 走线：
 * - 入口 → 主域名壳：同一条竖线（入口就对齐在壳正上方）；入口 → 其它框：沿左侧走线槽下行，进框的左沿。
 * - 壳 → 前缀成员：一条总线。第一排成员从总线直接落下；成员多到第二排时，落线走列与列之间的缝，
 *   再在行间隙里横到成员正上方——不穿过第一排的卡（2026-10-03 判据 G6 抓到的第一个真实缺陷）。
 * - 依赖 / 基础设施 / 跨项目引用：只在行间隙与右侧走线槽里走直角线。同一个空隙里的多条线分到不同轨道，
 *   空隙不够就把它撑开；右侧走线槽不够就把站点框收窄。
 */
import type { RelationPayload } from './RelationGraph';

export interface Pos { x: number; y: number; w: number; h: number }
export interface Frame {
  key: string; label: string; sub: string; x: number; y: number; w: number; h: number; tone: 'site' | 'external' | 'infra';
  /** 竖着穿过标题行的线的 x（入口 → 壳那一条）。标题与说明要给它让位 */
  cross: number[];
}
export type EdgeKind = 'entry' | 'prefix' | 'call' | 'ref' | 'broken' | 'infra';
export interface LayoutEdge {
  from: Pos; to: Pos; kind: EdgeKind; key: string;
  /** 线上不再挂字（会和卡片、别的线打架），悬停时作为提示显示 */
  label?: string;
  /** 按名约定推断出来的关系画虚线 */
  inferred?: boolean;
  /** 已算好的直角路径（只用 M / H / V） */
  d: string;
  /** 这条前缀线同时也是一条依赖（同一对服务的依赖线并入这条，不再另画一条） */
  alsoDepends?: boolean;
}
export interface RelationLayout {
  width: number; height: number;
  pos: Map<string, Pos>;
  frames: Frame[];
  entry: Pos;
  edges: LayoutEdge[];
  externals: Array<{ id: string; label: string; sub: string; status: string; pos: Pos; broken: boolean }>;
  /** 同一个服务同时是主域名壳 / 成员和子域壳（double-public-surface）时，后一处用别名节点，这里映射回真实 id */
  aliasOf: Map<string, string>;
  /** 节点第二行的覆盖文案：子域网格里写「子域 xxx」，而不是这个服务在主域名下的前缀 */
  subOf: Map<string, string>;
  /** 手机档（成员树状、网格两列） */
  compact: boolean;
}

/**
 * 两档几何（设计稿「CDS 关系视图改版」02 / 04 画板）：
 * - 桌面档：卡片 232–280×56，壳到成员 52，同框行距 16，框间距 24；左侧 56 走线槽
 * - 手机档：前缀成员改成带竖线的树状列表，其余网格两列，卡片 44 高——不再把桌面布局整体缩到 0.6 倍
 */
interface Geo { compact: boolean; cardW: number; cardH: number; heroH: number; gapX: number; gapY: number; rowGap: number; pad: number; label: number; trackTop: number; frameGap: number; gutter: number; right: number; entryGap: number }
const WIDE: Geo = { compact: false, cardW: 280, cardH: 56, heroH: 56, gapX: 24, gapY: 52, rowGap: 16, pad: 16, label: 34, trackTop: 30, frameGap: 24, gutter: 56, right: 32, entryGap: 32 };
const COMPACT: Geo = { compact: true, cardW: 0, cardH: 44, heroH: 48, gapX: 12, gapY: 12, rowGap: 8, pad: 12, label: 30, trackTop: 26, frameGap: 16, gutter: 24, right: 12, entryGap: 16 };
/** 窄于这个宽度切手机档；再窄于 MIN_W 才整体缩小 */
const RELATION_COMPACT_BELOW = 640;
const RELATION_MIN_W = 320;
/** 手机档树状列表：成员卡相对壳缩进多少，竖线在缩进的中间 */
const TREE_INDENT = 40;
/** 同一个空隙里相邻两条线的间距 */
const TRACK = 8;
/** 框标题的基线相对框顶的位置（渲染层与判据共用） */
const frameTitleY = (compact: boolean): number => (compact ? 19 : 22);

const svc = (id: string): string => id.replace(/^service:/, '');
/** 文字估算宽度：中日韩字符按一个字号宽，其余按 0.62 个字号（Inter 的平均字宽，略偏宽以留余量） */
const textW = (t: string, size: number): number => Array.from(t).reduce((w, ch) => w + (/[⺀-￿]/.test(ch) ? size : size * 0.62), 0);

/**
 * 框标题与右侧说明的最终文案与占位（渲染层画它、判据 G7 查它，同一份）。
 * 竖着穿过标题行的线（入口 → 壳）旁边留 10 的空：标题太长就截断加省略号，说明放不下就不放。
 */
export function frameLabels(f: Frame, entryHost: string | undefined, compact: boolean): { title: string; titleRect: Pos; sub?: string; subRect?: Pos; ty: number } {
  const ty = f.y + frameTitleY(compact);
  const tSize = compact ? 11.5 : 12, sSize = compact ? 11 : 11.5;
  const left = f.x + 20, rightEdge = f.x + f.w - 20;
  const blockers = [...f.cross].sort((a, b) => a - b);
  // 标题能用到的最右处：第一条在标题起点右边的竖线左侧 10，或者框右沿
  const firstCross = blockers.find((x) => x > left);
  const titleMax = (firstCross ?? rightEdge + 10) - 10 - left;
  let title = f.key === 'main' && entryHost && !compact ? `${f.label} · ${entryHost}` : f.label;
  if (textW(title, tSize) > titleMax) {
    const chars = Array.from(title);
    while (chars.length > 1 && textW(chars.join('') + '…', tSize) > titleMax) chars.pop();
    title = chars.join('') + '…';
  }
  const titleRect = { x: left, y: ty - 11, w: textW(title, tSize), h: 14 };
  const subW = textW(f.sub, sSize);
  const subRect = { x: rightEdge - subW, y: ty - 11, w: subW, h: 14 };
  const subFits = f.sub !== '' && subRect.x > titleRect.x + titleRect.w + 16 && !blockers.some((x) => x > subRect.x - 10 && x < subRect.x + subRect.w + 10);
  return subFits ? { title, titleRect, sub: f.sub, subRect, ty } : { title, titleRect, ty };
}

interface Row { frame: string; idx: number; ids: string[]; top: number; bottom: number }
interface Gap { key: string; top: number; height: number; /** 已被总线 / 换排落线占用的那一条横线（若有） */ reservedY?: number; firstTrack: number }

interface Extras { gaps: Map<string, number>; right: number }

/** 主入口：按给定宽度排版 + 走线。最多三轮：走线发现空隙不够就撑开再排。 */
export function layoutRelations(payload: RelationPayload, width = 960): RelationLayout {
  let extras: Extras = { gaps: new Map(), right: 0 };
  let result = layoutPass(payload, width, extras);
  for (let i = 0; i < 4; i += 1) {
    const need = result.need;
    const grow = need.right > extras.right || Array.from(need.gaps).some(([k, v]) => v > (extras.gaps.get(k) ?? 0));
    if (!grow) break;
    const gaps = new Map(extras.gaps);
    for (const [k, v] of need.gaps) gaps.set(k, Math.max(v, gaps.get(k) ?? 0));
    extras = { gaps, right: Math.max(extras.right, need.right) };
    result = layoutPass(payload, width, extras);
  }
  return result.layout;
}

function layoutPass(payload: RelationPayload, width: number, extras: Extras): { layout: RelationLayout; need: Extras } {
  const { graph, references } = payload;
  const W = Math.max(RELATION_MIN_W, Math.round(width));
  const base = W < RELATION_COMPACT_BELOW ? COMPACT : WIDE;
  const right = base.right + extras.right;
  const frameX = base.gutter, frameW = W - base.gutter - right, innerW = frameW - base.pad * 2, innerX = frameX + base.pad;
  // 桌面档卡片宽在 232–280 之间按容器自适应：固定 280 时 1300 宽的浮层只排得下 3 列，第 4 个前缀成员掉到第二行
  const wideCols = Math.max(1, Math.floor((innerW + base.gapX) / (232 + base.gapX)));
  // 手机档两列网格；两列时每张卡不到 150 宽（右侧走线槽被很多依赖线撑宽时会这样）就改一列，
  // 否则服务名只剩四十几像素可见（2026-10-03 relation-visual-audit C2，密集样本 390 宽）
  const halfW = Math.floor((innerW - base.gapX) / 2);
  const G: Geo = base.compact
    ? { ...base, cardW: halfW >= 150 ? halfW : innerW }
    : { ...base, cardW: Math.min(base.cardW, Math.floor((innerW - (wideCols - 1) * base.gapX) / wideCols)) };
  const EXT_W = G.compact ? innerW : Math.min(innerW, G.cardW + 60);
  const heroW = G.compact ? innerW : G.cardW;
  const gapExtra = (key: string): number => extras.gaps.get(key) ?? 0;

  // ---------- 1. 归属：哪个服务进哪个框（与运行画布同一套分层） ----------
  const nodeById = new Map(graph.nodes.filter((n) => n.kind === 'service').map((n) => [n.rawId ?? svc(n.id), n]));
  const ids = Array.from(nodeById.keys());
  const placed = new Set<string>();
  const aliasOf = new Map<string, string>();
  const subOf = new Map<string, string>();
  const real = (id: string): string => aliasOf.get(id) ?? id;
  // 一个服务既有主域名路由又有子域（后端会报 double-public-surface）时，两个站点都要画它：
  // 第一次出现用真实 id，之后的站点用 `id@站点` 别名，别名映射回真实节点
  const claim = (id: string, siteId: string): string => {
    if (!placed.has(id)) { placed.add(id); return id; }
    const alias = `${id}@${siteId}`;
    aliasOf.set(alias, id);
    return alias;
  };
  const callers = (id: string): string[] => graph.edges.filter((e) => e.from.startsWith('service:') && svc(e.to) === id).map((e) => svc(e.from));
  const ordered = [...graph.sites].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'main' ? -1 : 1));
  const blocks = ordered.map((site) => {
    const shell = site.shellId && nodeById.has(site.shellId) ? claim(site.shellId, site.id) : undefined;
    const members = site.members.filter((m) => nodeById.has(m.id)).map((m) => claim(m.id, site.id));
    return { site, shell, members, attached: [] as string[] };
  }).filter((b) => b.shell || b.members.length > 0);
  for (const id of graph.internal) {
    if (!nodeById.has(id) || placed.has(id)) continue;
    const cs = callers(id);
    if (cs.length === 0) continue;
    const owner = blocks.find((b) => cs.every((c) => (b.shell && real(b.shell) === c) || b.members.some((m) => real(m) === c)));
    if (!owner) continue;
    owner.attached.push(id); placed.add(id);
  }
  const rest = ids.filter((id) => !placed.has(id));
  // 只有一个壳、没有成员也没挂内网服务的子域：收进一张「子域」网格，一格一站
  const isSimpleSub = (b: (typeof blocks)[number]): boolean => b.site.kind === 'subdomain' && Boolean(b.shell) && b.members.length === 0 && b.attached.length === 0;
  const stacked = blocks.filter((b) => !isSimpleSub(b));
  const simpleSubs = blocks.filter(isSimpleSub);

  const externals: RelationLayout['externals'] = [];
  const extEdges: Array<{ from: string; ext: string; broken: boolean; label: string }> = [];
  for (const r of references) {
    if (r.kind === 'cds-ref') {
      for (const x of r.resolved ?? []) {
        if (!x.target.projectId || x.target.projectId === payload.projectId) continue;
        const id = `ext:${x.target.projectId}:${x.target.branchId ?? x.target.branchName ?? ''}:${x.ref.serviceId}`;
        const broken = x.status !== 'running';
        if (!externals.some((e) => e.id === id)) externals.push({ id, label: `${x.ref.serviceId} · ${x.target.branchName ?? '?'}`, sub: `${x.target.projectSlug ?? x.ref.projectRef} · 引用自 ${r.profileId} ${r.key}`, status: x.status, pos: { x: 0, y: 0, w: EXT_W, h: G.cardH }, broken });
        extEdges.push({ from: r.profileId, ext: id, broken, label: r.key });
      }
    } else if (r.kind === 'url' && r.matchedBranch && r.matchedBranch.projectId !== payload.projectId) {
      const id = `ext:${r.matchedBranch.projectId}:${r.matchedBranch.branchId}:url`;
      const broken = r.matchedBranch.status !== 'running';
      if (!externals.some((e) => e.id === id)) externals.push({ id, label: `分支 ${r.matchedBranch.branchName}`, sub: `手写网址 · ${r.profileId} ${r.key}`, status: r.matchedBranch.status, pos: { x: 0, y: 0, w: EXT_W, h: G.cardH }, broken });
      extEdges.push({ from: r.profileId, ext: id, broken, label: r.key });
    }
  }

  // ---------- 2. 摆放：先定每一行的卡片与横向位置，再自上而下定纵向位置 ----------
  const pos = new Map<string, Pos>();
  const frames: Frame[] = [];
  const rows: Row[] = [];
  const gaps: Gap[] = [];
  const colsFor = (cardW: number): number => Math.max(1, Math.floor((innerW + G.gapX) / (cardW + G.gapX)));
  const rowW = (n: number, cardW: number): number => (n <= 0 ? 0 : n * cardW + (n - 1) * G.gapX);
  /** 网格：一排放得下就居中；放不下就按列对齐（所有行共用同一组列，列缝才能当落线通道） */
  const gridRows = (list: string[], cardW: number): Array<Array<{ id: string; x: number; col: number }>> => {
    const cols = colsFor(cardW);
    if (list.length <= cols) {
      const start = innerX + (innerW - rowW(list.length, cardW)) / 2;
      return [list.map((id, j) => ({ id, x: start + j * (cardW + G.gapX), col: j }))];
    }
    const start = innerX + (innerW - rowW(cols, cardW)) / 2;
    const out: Array<Array<{ id: string; x: number; col: number }>> = [];
    for (let i = 0; i < list.length; i += cols) out.push(list.slice(i, i + cols).map((id, j) => ({ id, x: start + j * (cardW + G.gapX), col: j })));
    return out;
  };

  /** 一个框：若干行，行与行之间的空隙可被走线撑开；返回框底 */
  const buildFrame = (key: string, label: string, sub: string, tone: Frame['tone'], top: number, spec: Array<{ cells: Array<{ id: string; x: number; w: number }>; h: number; gapBefore: number; reserved?: 'bus' | 'channel' }>, put: (id: string, p: Pos) => void = (id, p) => pos.set(id, p)): Frame => {
    let cursor = top + G.label + gapExtra(`${key}:0`);
    gaps.push({ key: `${key}:0`, top: top + G.trackTop - TRACK, height: cursor - (top + G.trackTop - TRACK), firstTrack: top + G.trackTop });
    spec.forEach((row, i) => {
      if (i > 0) {
        const gTop = cursor;
        const base = row.gapBefore;
        const reservedY = row.reserved === 'bus' ? gTop + base / 2 : row.reserved === 'channel' ? gTop + base / 2 : undefined;
        const firstTrack = reservedY !== undefined ? reservedY + TRACK : gTop + TRACK;
        cursor = gTop + base + gapExtra(`${key}:${i}`);
        gaps.push({ key: `${key}:${i}`, top: gTop, height: cursor - gTop, reservedY, firstTrack });
      }
      for (const c of row.cells) put(c.id, { x: c.x, y: cursor, w: c.w, h: row.h });
      rows.push({ frame: key, idx: i, ids: row.cells.map((c) => c.id), top: cursor, bottom: cursor + row.h });
      cursor += row.h;
    });
    const bTop = cursor;
    cursor += G.pad + gapExtra(`${key}:${spec.length}`);
    gaps.push({ key: `${key}:${spec.length}`, top: bTop, height: cursor - bTop, firstTrack: bTop + TRACK });
    const f: Frame = { key, label, sub, x: frameX, y: top, w: frameW, h: cursor - top, tone, cross: [] };
    frames.push(f);
    return f;
  };

  const entry: Pos = { x: innerX + (innerW - heroW) / 2, y: G.compact ? 12 : 16, w: heroW, h: G.heroH };
  let y = entry.y + entry.h + G.entryGap;
  /** 每个前缀成员落在哪一行哪一列（走总线用） */
  const memberSlot = new Map<string, { row: number; col: number; colX: number }>();
  const frameOfBlock = new Map<string, Frame>();

  for (const b of stacked) {
    const spec: Parameters<typeof buildFrame>[5] = [];
    if (b.shell) spec.push({ cells: [{ id: b.shell, x: innerX + (innerW - heroW) / 2, w: heroW }], h: G.heroH, gapBefore: 0 });
    if (b.members.length > 0) {
      if (G.compact && b.shell) {
        // 手机档：前缀成员一行一个，缩进挂在壳下面的竖线上
        b.members.forEach((m, i) => spec.push({ cells: [{ id: m, x: innerX + TREE_INDENT, w: innerW - TREE_INDENT }], h: G.cardH, gapBefore: i === 0 ? G.gapY : G.rowGap }));
      } else {
        gridRows(b.members, G.cardW).forEach((row, i) => {
          row.forEach((c) => memberSlot.set(c.id, { row: i, col: c.col, colX: c.x }));
          spec.push({ cells: row.map((c) => ({ id: c.id, x: c.x, w: G.cardW })), h: G.cardH, gapBefore: i === 0 ? G.gapY : G.rowGap, reserved: b.shell ? (i === 0 ? 'bus' : 'channel') : undefined });
        });
      }
    }
    if (b.attached.length > 0) gridRows(b.attached, G.cardW).forEach((row, i) => spec.push({ cells: row.map((c) => ({ id: c.id, x: c.x, w: G.cardW })), h: G.cardH, gapBefore: i === 0 ? G.gapY : G.rowGap }));
    // 框角写用户语言，不写实现术语
    const label = b.site.kind === 'main' ? '主域名' : `子域 ${b.site.subdomain}`;
    const sub = b.site.kind === 'main' ? (b.site.shellSource === 'convention' ? '壳是按名兜底出来的，其余按前缀分流' : '壳承接 /，其余按前缀分流') : '子域下再按前缀分流';
    const f = buildFrame(b.site.id, label, sub, 'site', y, spec);
    frameOfBlock.set(b.site.id, f);
    y = f.y + f.h + G.frameGap;
  }
  const gridFrame = (key: string, label: string, sub: string, tone: Frame['tone'], list: string[], cardW: number, put?: (id: string, p: Pos) => void): Frame | undefined => {
    if (list.length === 0) return undefined;
    const spec = gridRows(list, cardW).map((row, i) => ({ cells: row.map((c) => ({ id: c.id, x: c.x, w: cardW })), h: G.cardH, gapBefore: i === 0 ? 0 : G.rowGap }));
    const f = buildFrame(key, label, sub, tone, y, spec, put);
    y = f.y + f.h + G.frameGap;
    return f;
  };
  const subsFrame = gridFrame('subdomains', `子域 · ${simpleSubs.length} 个`, '每个子域整站归一个服务', 'site', simpleSubs.map((b) => { subOf.set(b.shell!, `子域 ${b.site.subdomain ?? ''}`); return b.shell!; }), G.cardW);
  gridFrame('external', '外部项目', '跨项目引用，走公网入口', 'external', externals.map((e) => e.id), EXT_W, (id, p) => { const e = externals.find((z) => z.id === id); if (e) e.pos = p; });
  gridFrame('rest', '其它服务', '内网服务，或被多个站点共同调用', 'site', rest, G.cardW);
  gridFrame('infra', '共享基础设施', '同项目所有分支共用同一实例', 'infra', graph.nodes.filter((n) => n.kind === 'infra').map((n) => n.id), G.cardW);
  const height = Math.max(y - G.frameGap + 16, G.compact ? 200 : 320);

  // ---------- 3. 走线 ----------
  const cardOf = (id: string): Pos | undefined => pos.get(id) ?? externals.find((e) => e.id === id)?.pos;
  const rowOf = (id: string): Row | undefined => rows.find((r) => r.ids.includes(id));
  const gapByKey = new Map(gaps.map((g) => [g.key, g]));
  const frameIndex = (key: string): number => frames.findIndex((f) => f.key === key);
  const edges: LayoutEdge[] = [];
  const need: Extras = { gaps: new Map(), right: 0 };
  const cx = (p: Pos): number => p.x + p.w / 2;

  // 3a. 入口
  stacked.forEach((b, i) => {
    const f = frameOfBlock.get(b.site.id)!;
    const inferred = b.site.kind === 'main' && b.site.shellSource === 'convention';
    const shellPos = b.shell ? pos.get(b.shell) : undefined;
    if (i === 0 && shellPos) {
      // 入口与壳同宽同列：一条竖线
      f.cross.push(cx(shellPos));
      edges.push({ from: entry, to: shellPos, kind: 'entry', key: `entry-${b.site.id}`, inferred, d: `M${cx(entry)},${entry.y + entry.h} V${shellPos.y - 2}` });
    } else if (i === 0) {
      // 首个框没有壳：落到框的上沿，表示「这一整框都从入口进」
      edges.push({ from: entry, to: { x: cx(entry) - 1, y: f.y, w: 2, h: 0 }, kind: 'entry', key: `entry-${b.site.id}`, inferred, d: `M${cx(entry)},${entry.y + entry.h} V${f.y - 2}` });
    } else edges.push(sideEntry(b.site.id, f, inferred));
  });
  if (subsFrame) edges.push(stacked.length === 0 ? { from: entry, to: { x: cx(entry) - 1, y: subsFrame.y, w: 2, h: 0 }, kind: 'entry', key: 'entry-subdomains', d: `M${cx(entry)},${entry.y + entry.h} V${subsFrame.y - 2}` } : sideEntry('subdomains', subsFrame));
  function sideEntry(key: string, f: Frame, inferred?: boolean): LayoutEdge {
    // 从入口左沿出，沿左侧走线槽下行，横进目标框左沿（标题那一行的高度）
    const sx = entry.x, sy = entry.y + entry.h / 2, gx = G.gutter / 2, ty = f.y + frameTitleY(G.compact) - 4, tx = f.x;
    return { from: entry, to: { x: f.x, y: ty - 6, w: 0, h: 12 }, kind: 'entry', key: `entry-${key}`, inferred, d: `M${sx},${sy} H${gx} V${ty} H${tx - 2}` };
  }

  // 3b. 壳 → 前缀成员
  /** 壳 → 成员 这一对服务已经有的前缀线（依赖线若与它同一对，并入它） */
  const prefixByPair = new Map<string, LayoutEdge>();
  for (const b of stacked) {
    if (!b.shell) continue;
    const sp = pos.get(b.shell)!;
    for (const m of b.members) {
      const mp = pos.get(m); if (!mp) continue;
      const info = b.site.members.find((x) => x.id === real(m));
      const inferred = Boolean(info?.viaConvention);
      const pairKey = `${real(b.shell)}>${real(m)}`;
      let d: string;
      if (G.compact) {
        const trunk = innerX + TREE_INDENT / 2;
        d = `M${trunk},${sp.y + sp.h} V${mp.y + mp.h / 2} H${mp.x - 2}`;
      } else {
        const slot = memberSlot.get(m)!;
        const bus = gapByKey.get(`${b.site.id}:1`)!.reservedY!;
        if (slot.row === 0) d = `M${cx(sp)},${sp.y + sp.h} V${bus} H${cx(mp)} V${mp.y - 2}`;
        else {
          // 换排：走这一列左边的列缝下去，在本排上方的空隙里横到成员正上方
          const lane = slot.colX - G.gapX / 2;
          const above = gapByKey.get(`${b.site.id}:${1 + slot.row}`)!.reservedY!;
          d = `M${cx(sp)},${sp.y + sp.h} V${bus} H${lane} V${above} H${cx(mp)} V${mp.y - 2}`;
        }
      }
      const pe: LayoutEdge = { from: sp, to: mp, kind: 'prefix', key: `prefix-${m}`, inferred, label: (info?.prefixes ?? []).join(' '), d };
      edges.push(pe);
      prefixByPair.set(pairKey, pe);
    }
  }

  // 3c. 依赖 / 基础设施 / 跨项目引用：只走行间隙与右侧走线槽
  interface Want { key: string; kind: EdgeKind; label?: string; s: string; t: string }
  const wants: Want[] = [];
  /** 同一个服务有多处（双公网面）时，挑与对方同框的那一处 */
  const instances = (realId: string): string[] => [realId, ...Array.from(aliasOf.entries()).filter(([, r]) => r === realId).map(([a]) => a)].filter((id) => cardOf(id));
  const choose = (a: string, b: string): [string, string] | undefined => {
    const as = instances(a), bs = instances(b);
    if (!as.length || !bs.length) return undefined;
    for (const x of as) for (const z of bs) if (rowOf(x)?.frame === rowOf(z)?.frame) return [x, z];
    return [as[0], bs[0]];
  };
  for (const e of graph.edges) {
    const isInfra = e.to.startsWith('infra:');
    const a = svc(e.from), b = isInfra ? e.to : svc(e.to);
    const pe = isInfra ? undefined : prefixByPair.get(`${a}>${b}`);
    if (pe) {
      // 这对服务之间已经有一条前缀分流线：依赖并入那条线，不再另画一条贴着它走的线
      pe.alsoDepends = true;
      continue;
    }
    const pair = isInfra ? (cardOf(b) && instances(a)[0] ? [instances(a)[0], b] as [string, string] : undefined) : choose(a, b);
    if (!pair || pair[0] === pair[1]) continue;
    wants.push({ key: `call-${e.from}-${e.to}`, kind: isInfra ? 'infra' : 'call', label: e.envKeys.join(' · ') || (e.declared ? '声明的依赖' : e.dependsOn ? 'depends_on' : undefined), s: pair[0], t: pair[1] });
  }
  for (const x of extEdges) {
    const s = instances(x.from)[0];
    if (!s || !cardOf(x.ext)) continue;
    wants.push({ key: `ref-${x.from}-${x.ext}-${x.label}`, kind: x.broken ? 'broken' : 'ref', label: x.label, s, t: x.ext });
  }

  // 端口：一条线进出一张卡用卡边上的一个点，不同的线用不同的点，竖段就不会叠在一起
  const ports = new Map<string, number[]>();
  const centerTaken = new Set<string>();
  for (const e of edges) {
    if (e.kind === 'entry' && e.to.w > 2) centerTaken.add(`${idAt(e.to)}:top`);
    if (e.kind === 'prefix' && !G.compact) { centerTaken.add(`${idAt(e.from)}:bottom`); centerTaken.add(`${idAt(e.to)}:top`); }
    if (e.kind === 'prefix' && G.compact) centerTaken.add(`${idAt(e.from)}:bottom`);
  }
  function idAt(p: Pos): string { for (const [id, q] of pos) if (q === p) return id; return externals.find((z) => z.pos === p)?.id ?? ''; }
  const FRACTIONS = [0.5, 0.3, 0.7, 0.2, 0.8, 0.4, 0.6, 0.12, 0.88, 0.35, 0.65, 0.25, 0.75];
  /** 已经占用的竖线（前缀落线、入口线、已分配的依赖线出入口）。新端口要避开同一段空隙里同一个 x 的竖线 */
  const verticals: Array<{ x: number; lo: number; hi: number }> = [];
  for (const e of edges) {
    let cur = { x: 0, y: 0 };
    for (const m of e.d.matchAll(/([MHV])(-?[\d.]+)(?:,(-?[\d.]+))?/g)) {
      if (m[1] === 'M') cur = { x: Number(m[2]), y: Number(m[3]) };
      else if (m[1] === 'H') cur = { x: Number(m[2]), y: cur.y };
      else { const ny = Number(m[2]); verticals.push({ x: cur.x, lo: Math.min(cur.y, ny), hi: Math.max(cur.y, ny) }); cur = { x: cur.x, y: ny }; }
    }
  }
  /** 卡片某一侧挨着的那段空隙（端口竖线就走在这里） */
  const sideGap = (id: string, side: 'top' | 'bottom'): { lo: number; hi: number } => {
    const r = rowOf(id)!;
    const g = gapByKey.get(`${r.frame}:${side === 'bottom' ? r.idx + 1 : r.idx}`)!;
    return { lo: g.top - 1, hi: g.top + g.height + 1 };
  };
  const port = (id: string, side: 'top' | 'bottom'): number => {
    const k = `${id}:${side}`;
    const p = cardOf(id)!;
    const span = sideGap(id, side);
    const list = centerTaken.has(k) ? FRACTIONS.slice(1) : FRACTIONS;
    const taken = new Set(ports.get(k) ?? []);
    const free = list.map((f) => p.x + p.w * f).find((x) => !taken.has(x) && !verticals.some((v) => Math.abs(v.x - x) < 4 && v.lo < span.hi && v.hi > span.lo));
    const x = free ?? p.x + p.w * list[Math.min(taken.size, list.length - 1)];
    ports.set(k, [...taken, x]);
    verticals.push({ x, lo: span.lo, hi: span.hi });
    return x;
  };

  interface Plan { want: Want; sx: number; sy: number; tx: number; ty: number; legs: Array<{ gap: string; from: number; to: number }>; gutter?: { from: number; to: number } }
  const plans: Plan[] = [];
  for (const w of wants) {
    const S = cardOf(w.s)!, T = cardOf(w.t)!;
    const rs = rowOf(w.s)!, rt = rowOf(w.t)!;
    const sameFrame = rs.frame === rt.frame;
    const below = frameIndex(rt.frame) > frameIndex(rs.frame) || (sameFrame && rt.idx > rs.idx);
    if (sameFrame && rt.idx === rs.idx) {
      const sx = port(w.s, 'bottom'), tx = port(w.t, 'bottom');
      plans.push({ want: w, sx, sy: S.y + S.h, tx, ty: T.y + T.h + 2, legs: [{ gap: `${rs.frame}:${rs.idx + 1}`, from: sx, to: tx }] });
    } else if (sameFrame && Math.abs(rt.idx - rs.idx) === 1) {
      const down = rt.idx > rs.idx;
      const sx = port(w.s, down ? 'bottom' : 'top'), tx = port(w.t, down ? 'top' : 'bottom');
      plans.push({ want: w, sx, sy: down ? S.y + S.h : S.y, tx, ty: down ? T.y - 2 : T.y + T.h + 2, legs: [{ gap: `${rs.frame}:${down ? rs.idx + 1 : rs.idx}`, from: sx, to: tx }] });
    } else {
      // 远距离：出卡进本行的空隙 → 横到右侧走线槽 → 竖到目标那一行的空隙 → 横到目标正上 / 正下方进卡
      const sx = port(w.s, below ? 'bottom' : 'top'), tx = port(w.t, below ? 'top' : 'bottom');
      const gx = frameX + frameW;
      plans.push({ want: w, sx, sy: below ? S.y + S.h : S.y, tx, ty: below ? T.y - 2 : T.y + T.h + 2, legs: [{ gap: `${rs.frame}:${below ? rs.idx + 1 : rs.idx}`, from: sx, to: gx }, { gap: `${rt.frame}:${below ? rt.idx : rt.idx + 1}`, from: gx, to: tx }], gutter: { from: 0, to: 0 } });
    }
  }
  // 轨道分配：同一个空隙里横向区间重叠的线放到不同轨道（区间图着色，按左端排序贪心）
  const trackOf = new Map<string, number>();
  const byGap = new Map<string, Array<{ id: string; lo: number; hi: number }>>();
  plans.forEach((p, i) => p.legs.forEach((leg, j) => {
    const list = byGap.get(leg.gap) ?? [];
    list.push({ id: `${i}:${j}`, lo: Math.min(leg.from, leg.to), hi: Math.max(leg.from, leg.to) });
    byGap.set(leg.gap, list);
  }));
  for (const [gapKey, list] of byGap) {
    list.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    const ends: number[] = [];
    for (const it of list) {
      let t = ends.findIndex((end) => end < it.lo - 6);
      if (t < 0) { t = ends.length; ends.push(it.hi); } else ends[t] = it.hi;
      trackOf.set(it.id, t);
    }
    const g = gapByKey.get(gapKey);
    if (!g) continue;
    // 需要的高度：第一条轨道起点 + 轨道数 × 间距，再留一个间距到下一行
    const needH = (g.firstTrack - g.top) + (ends.length - 1) * TRACK + TRACK;
    const deficit = needH - g.height;
    if (deficit > 0) need.gaps.set(gapKey, (extras.gaps.get(gapKey) ?? 0) + deficit);
  }
  const trackY = (gapKey: string, t: number): number => gapByKey.get(gapKey)!.firstTrack + t * TRACK;
  // 右侧走线槽：竖向区间重叠的线放到不同的槽位
  const gutterList = plans.map((p, i) => ({ i, p })).filter((x) => x.p.gutter).map(({ i, p }) => {
    const y1 = trackY(p.legs[0].gap, trackOf.get(`${i}:0`)!), y2 = trackY(p.legs[1].gap, trackOf.get(`${i}:1`)!);
    return { i, lo: Math.min(y1, y2), hi: Math.max(y1, y2) };
  }).sort((a, b) => a.lo - b.lo);
  const gutterEnds: number[] = [];
  const gutterTrack = new Map<number, number>();
  for (const it of gutterList) {
    let t = gutterEnds.findIndex((end) => end < it.lo - 6);
    if (t < 0) { t = gutterEnds.length; gutterEnds.push(it.hi); } else gutterEnds[t] = it.hi;
    gutterTrack.set(it.i, t);
  }
  if (gutterEnds.length) {
    const needRight = TRACK + gutterEnds.length * TRACK + 4;
    if (needRight > right) need.right = extras.right + (needRight - right);
  }
  plans.forEach((p, i) => {
    const S = cardOf(p.want.s)!, T = cardOf(p.want.t)!;
    let d: string;
    if (!p.gutter) {
      const ty0 = trackY(p.legs[0].gap, trackOf.get(`${i}:0`)!);
      d = `M${p.sx},${p.sy} V${ty0} H${p.tx} V${p.ty}`;
    } else {
      const y1 = trackY(p.legs[0].gap, trackOf.get(`${i}:0`)!), y2 = trackY(p.legs[1].gap, trackOf.get(`${i}:1`)!);
      const gx = frameX + frameW + TRACK + gutterTrack.get(i)! * TRACK;
      d = `M${p.sx},${p.sy} V${y1} H${gx} V${y2} H${p.tx} V${p.ty}`;
    }
    edges.push({ from: S, to: T, kind: p.want.kind, key: p.want.key, label: p.want.label, d });
  });

  const layout: RelationLayout = { width: W, height, pos, frames, entry, edges, externals, aliasOf, subOf, compact: G.compact };
  return { layout, need };
}

/** 路径就是布局给的那一条（判据 G5–G8 与渲染层读同一份，没有第二种画法） */
export function edgePath(e: LayoutEdge): string {
  return e.d;
}

