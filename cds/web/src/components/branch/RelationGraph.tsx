/*
 * RelationGraph — 只读的服务关系图（plan.cds.service-relations 第四批）。
 *
 * 数据来自 GET /api/branches/:id/service-graph（服务图 + 体检 + 引用），与运行画布同一份分层：
 * 入口 → 站点框（壳在上、前缀成员在下、内网服务紧贴调用方）→ 外部项目框（跨项目引用）→ 共享基础设施。
 * 运行画布是操作面（副本、权重、隔离），这张图是决策面：只画关系与问题，不承载操作。
 * compact 模式给总览缩略卡用：同一套布局按比例缩小，不另画一份。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';

export type RoleView = 'web' | 'api' | 'worker';
export interface GraphNodeView { id: string; rawId?: string; name: string; kind: 'service' | 'infra'; pathPrefixes?: string[]; subdomain?: string; dockerImage?: string; role?: RoleView; roleSource?: string; roleReason?: string }
export interface GraphEdgeView { from: string; to: string; envKeys: string[]; dependsOn: boolean; declared?: boolean }
export interface GraphSiteView { id: string; kind: 'main' | 'subdomain'; subdomain?: string; shellId?: string; shellSource?: string; members: Array<{ id: string; prefixes: string[]; viaConvention?: boolean }>; conflicts: Array<{ prefix: string; ids: string[] }> }
export interface ServiceGraphView { nodes: GraphNodeView[]; edges: GraphEdgeView[]; layers: string[][]; sites: GraphSiteView[]; internal: string[] }
export interface LintFindingView { rule: string; severity: 'error' | 'warn' | 'info'; services: string[]; message: string; fix: string }
export interface ReferenceView { profileId: string; key: string; kind: 'cds-ref' | 'url' | 'name-hint' | 'platform'; resolved?: Array<{ url: string | null; status: string; target: { projectId?: string; projectSlug?: string; branchId?: string; branchName?: string; serviceId: string }; ref: { projectRef: string; serviceId: string; branchRef?: string } }>; matchedBranch?: { branchId: string; projectId: string; branchName: string; status: string } | null }
export interface RelationPayload { branchId: string; projectId: string; branch: string; status?: string; graph: ServiceGraphView; lint: { findings: LintFindingView[]; summary: { errors: number; warnings: number; infos: number } }; references: ReferenceView[] }

const CARD_W = 200, CARD_H = 52, EXT_W = CARD_W + 60, GAP_X = 24, GAP_Y = 56, ROW_GAP = 16, SITE_PAD = 16, SITE_LABEL = 28, FRAME_GAP = 28;
/** 左侧走线槽：入口到第二个及以后站点框的线沿这里下行，不穿过上面的框 */
const GUTTER = 40, RIGHT_PAD = 16, MIN_W = 560;
const ROLE_LABEL: Record<RoleView, string> = { web: 'WEB', api: 'API', worker: 'JOB' };
// 颜色只许走主题 token（cds-theme-tokens）：这里存 token 名，用到时包 hsl(var(...))，双主题各自成立
const ROLE_TOKEN: Record<RoleView, string> = { web: '--role-web', api: '--role-api', worker: '--role-worker' };
const tone = (token: string, alpha?: number): string => (alpha === undefined ? `hsl(var(${token}))` : `hsl(var(${token}) / ${alpha})`);

interface Pos { x: number; y: number; w: number; h: number }
interface Frame { key: string; label: string; sub: string; x: number; y: number; w: number; h: number; tone: 'site' | 'external' | 'infra' }

export interface RelationLayout {
  width: number; height: number;
  pos: Map<string, Pos>;
  frames: Frame[];
  entry: Pos;
  /**
   * inferred：这条关系是按名约定推断出来的（compose 里没声明），画虚线；其余一律实线。
   * route=side：入口到第二个及以后的站点框，沿左侧走线槽下行，进框的左沿
   */
  edges: Array<{ from: Pos; to: Pos; kind: 'entry' | 'prefix' | 'call' | 'ref' | 'broken' | 'infra'; label?: string; key: string; inferred?: boolean; route?: 'side' }>;
  externals: Array<{ id: string; label: string; sub: string; status: string; pos: Pos; broken: boolean }>;
  /** 同一个服务同时是主域名壳和子域壳（double-public-surface）时，后一个站点里用别名节点，这里映射回真实 id */
  aliasOf: Map<string, string>;
  /** 节点第二行的覆盖文案：子域网格里写「子域 xxx」，而不是这个服务在主域名下的前缀 */
  subOf: Map<string, string>;
}

const svc = (id: string): string => id.replace(/^service:/, '');
/** SVG 文字的估算宽度：中日韩字符按一个字号宽，其余按 0.6 个字号 */
const textW = (t: string, size: number): number => Array.from(t).reduce((w, ch) => w + (/[\u2e80-\uffff]/.test(ch) ? size : size * 0.6), 0);

/**
 * 布局按「给定宽度」排，而不是先排成一长条再整体缩小（2026-09-30 用户截图：8 个子域并排成
 * 2000px 宽，半屏里缩到字看不清、右边还被裁掉，下半截整片空着）。
 * 站点框自上而下堆叠：主域名（壳 → 前缀成员 → 内网服务）→ 带成员的子域 → 子域网格 → 外部项目 → 其它 → 共享基础设施。
 * 每一块里的卡片按宽度折行成网格，字号始终 1:1。
 */
export function layoutRelations(payload: RelationPayload, width = 960): RelationLayout {
  const { graph, references } = payload;
  const W = Math.max(MIN_W, Math.round(width));
  const frameX = GUTTER, frameW = W - GUTTER - RIGHT_PAD, innerW = frameW - SITE_PAD * 2, innerX = frameX + SITE_PAD;
  const colsFor = (cardW: number): number => Math.max(1, Math.floor((innerW + GAP_X) / (cardW + GAP_X)));
  const rowW = (n: number, cardW = CARD_W): number => (n <= 0 ? 0 : n * cardW + (n - 1) * GAP_X);

  const nodeById = new Map(graph.nodes.filter((n) => n.kind === 'service').map((n) => [n.rawId ?? svc(n.id), n]));
  const ids = Array.from(nodeById.keys());
  const placed = new Set<string>();
  const aliasOf = new Map<string, string>();
  const subOf = new Map<string, string>();
  const real = (id: string): string => aliasOf.get(id) ?? id;
  // 一个服务既有主域名路由又有子域（后端会报 double-public-surface）时，两个站点都要画它：
  // 第一次出现用真实 id，之后的站点用 `id@站点` 别名，别名映射回真实节点（Codex 八轮 P2）
  const claim = (id: string, siteId: string): string => {
    if (!placed.has(id)) { placed.add(id); return id; }
    const alias = `${id}@${siteId}`;
    aliasOf.set(alias, id);
    return alias;
  };
  const callers = (id: string): string[] => graph.edges.filter((e) => e.from.startsWith('service:') && svc(e.to) === id).map((e) => svc(e.from));

  // 主域名先认领：同一个服务既是主域名前缀成员又是子域壳时，真实 id 留在主域名，子域网格里用别名
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

  // 外部项目：跨项目引用（引用变量或手写网址指向别的项目分支）
  const externals: RelationLayout['externals'] = [];
  const extEdges: Array<{ from: string; ext: string; broken: boolean; label: string }> = [];
  for (const r of references) {
    if (r.kind === 'cds-ref') {
      for (const x of r.resolved ?? []) {
        if (!x.target.projectId || x.target.projectId === payload.projectId) continue;
        const id = `ext:${x.target.projectId}:${x.target.branchId ?? x.target.branchName ?? ''}:${x.ref.serviceId}`;
        const broken = x.status !== 'running';
        if (!externals.some((e) => e.id === id)) externals.push({ id, label: `${x.ref.serviceId} · ${x.target.branchName ?? '?'}`, sub: `${x.target.projectSlug ?? x.ref.projectRef} · 引用自 ${r.profileId} ${r.key}`, status: x.status, pos: { x: 0, y: 0, w: EXT_W, h: CARD_H }, broken });
        extEdges.push({ from: r.profileId, ext: id, broken, label: r.key });
      }
    } else if (r.kind === 'url' && r.matchedBranch && r.matchedBranch.projectId !== payload.projectId) {
      const id = `ext:${r.matchedBranch.projectId}:${r.matchedBranch.branchId}:url`;
      const broken = r.matchedBranch.status !== 'running';
      if (!externals.some((e) => e.id === id)) externals.push({ id, label: `分支 ${r.matchedBranch.branchName}`, sub: `手写网址 · ${r.profileId} ${r.key}`, status: r.matchedBranch.status, pos: { x: 0, y: 0, w: EXT_W, h: CARD_H }, broken });
      extEdges.push({ from: r.profileId, ext: id, broken, label: r.key });
    }
  }

  const pos = new Map<string, Pos>();
  const frames: Frame[] = [];
  /** 一组卡片按列数折行、每行居中；返回最后一行的下沿 */
  const grid = (list: string[], top: number, cardW = CARD_W, put: (id: string, p: Pos) => void = (id, p) => pos.set(id, p)): number => {
    if (list.length === 0) return top;
    const cols = colsFor(cardW);
    for (let i = 0; i < list.length; i += cols) {
      const row = list.slice(i, i + cols);
      const start = innerX + (innerW - rowW(row.length, cardW)) / 2;
      const y = top + Math.floor(i / cols) * (CARD_H + ROW_GAP);
      row.forEach((id, j) => put(id, { x: start + j * (cardW + GAP_X), y, w: cardW, h: CARD_H }));
    }
    return top + Math.ceil(list.length / cols) * (CARD_H + ROW_GAP) - ROW_GAP;
  };
  const frame = (key: string, label: string, sub: string, top: number, bottom: number, toneName: Frame['tone']): Frame => {
    const f: Frame = { key, label, sub, x: frameX, y: top, w: frameW, h: bottom + SITE_PAD - top, tone: toneName };
    frames.push(f);
    return f;
  };

  const entry: Pos = { x: frameX + (frameW - 200) / 2, y: 16, w: 200, h: 56 };
  let y = entry.y + entry.h + 40;
  // 框角写用户语言，不写实现术语（「壳在上 · 前缀成员在下」「forwarder」这类字读的人接不上）
  for (const b of stacked) {
    const top = y;
    let cursor = top + SITE_LABEL;
    if (b.shell) { pos.set(b.shell, { x: innerX + (innerW - CARD_W) / 2, y: cursor, w: CARD_W, h: CARD_H }); cursor += CARD_H + GAP_Y; }
    let bottom = b.shell ? cursor - GAP_Y : cursor;
    if (b.members.length > 0) { bottom = grid(b.members, cursor); cursor = bottom + GAP_Y; }
    if (b.attached.length > 0) bottom = grid(b.attached, cursor);
    const label = b.site.kind === 'main' ? '同一个域名' : `子域 ${b.site.subdomain}`;
    const sub = b.site.kind === 'main' ? (b.site.shellSource === 'convention' ? '壳是按名兜底出来的，其余按前缀分流' : '壳承接根路径，其余按前缀分流') : '子域下再按前缀分流';
    frame(b.site.id, label, sub, top, bottom, 'site');
    y = bottom + SITE_PAD + FRAME_GAP;
  }
  const subsFrameKey = 'subdomains';
  if (simpleSubs.length > 0) {
    const top = y;
    const list = simpleSubs.map((b) => { subOf.set(b.shell!, `子域 ${b.site.subdomain ?? ''}`); return b.shell!; });
    const bottom = grid(list, top + SITE_LABEL);
    frame(subsFrameKey, `子域 · ${simpleSubs.length} 个`, '每个子域整站归一个服务', top, bottom, 'site');
    y = bottom + SITE_PAD + FRAME_GAP;
  }
  if (externals.length > 0) {
    const top = y;
    const bottom = grid(externals.map((e) => e.id), top + SITE_LABEL, EXT_W, (id, p) => { const e = externals.find((z) => z.id === id); if (e) e.pos = p; });
    frame('external', '外部项目', '跨项目引用，走公网入口', top, bottom, 'external');
    y = bottom + SITE_PAD + FRAME_GAP;
  }
  // 剩余（游离或多方调用的内网）服务
  if (rest.length > 0) {
    const top = y;
    const bottom = grid(rest, top + SITE_LABEL);
    frame('rest', '其它服务', '内网服务，或被多个站点共同调用', top, bottom, 'site');
    y = bottom + SITE_PAD + FRAME_GAP;
  }
  const infra = graph.nodes.filter((n) => n.kind === 'infra');
  if (infra.length > 0) {
    const top = y;
    const bottom = grid(infra.map((n) => n.id), top + SITE_LABEL);
    frame('infra', '共享基础设施', '同项目所有分支共用同一实例', top, bottom, 'infra');
    y = bottom + SITE_PAD + FRAME_GAP;
  }

  // 入口对齐第一个站点的壳（没有壳就对齐框中线）
  const firstHead = stacked[0] ? pos.get(stacked[0].shell ?? stacked[0].members[0] ?? '') : undefined;
  if (firstHead && stacked[0]?.shell) entry.x = firstHead.x + (firstHead.w - entry.w) / 2;

  const edges: RelationLayout['edges'] = [];
  const frameOf = (key: string): Frame | undefined => frames.find((f) => f.key === key);
  stacked.forEach((b, i) => {
    const head = b.shell ?? b.members[0];
    const hp = head ? pos.get(head) : undefined;
    const inferred = b.site.kind === 'main' && b.site.shellSource === 'convention';
    if (i === 0 && hp) edges.push({ from: entry, to: hp, kind: 'entry', key: `entry-${b.site.id}`, inferred });
    else {
      const f = frameOf(b.site.id);
      if (f) edges.push({ from: entry, to: { x: f.x, y: f.y, w: 0, h: SITE_LABEL }, kind: 'entry', key: `entry-${b.site.id}`, inferred, route: 'side' });
    }
    if (b.shell) {
      const sp = pos.get(b.shell)!;
      for (const m of b.members) {
        const mp = pos.get(m); if (!mp) continue;
        const info = b.site.members.find((x) => x.id === real(m));
        edges.push({ from: sp, to: mp, kind: 'prefix', label: (info?.prefixes ?? []).join(' ') + (info?.viaConvention ? ' · 按名推断' : ''), key: `prefix-${m}`, inferred: Boolean(info?.viaConvention) });
      }
    }
  });
  const subsFrame = frameOf(subsFrameKey);
  if (subsFrame) {
    // 没有堆叠站点（只有子域）时入口直接落到子域网格上沿，否则走左侧槽
    edges.push(stacked.length === 0
      ? { from: entry, to: { x: subsFrame.x + subsFrame.w / 2 - 1, y: subsFrame.y, w: 2, h: 0 }, kind: 'entry', key: `entry-${subsFrameKey}` }
      : { from: entry, to: { x: subsFrame.x, y: subsFrame.y, w: 0, h: SITE_LABEL }, kind: 'entry', key: `entry-${subsFrameKey}`, route: 'side' });
  }
  const at = (id: string): Pos | undefined => pos.get(id);
  for (const e of graph.edges) {
    const a = at(svc(e.from)); const to = e.to.startsWith('infra:') ? at(e.to) : at(svc(e.to));
    if (!a || !to) continue;
    edges.push({ from: a, to, kind: e.to.startsWith('infra:') ? 'infra' : 'call', label: e.to.startsWith('infra:') ? undefined : (e.declared ? '声明' : e.envKeys[0] ?? 'depends_on'), key: `call-${e.from}-${e.to}` });
  }
  for (const x of extEdges) {
    const a = at(x.from); const e = externals.find((z) => z.id === x.ext);
    if (!a || !e) continue;
    edges.push({ from: a, to: e.pos, kind: x.broken ? 'broken' : 'ref', label: x.label, key: `ref-${x.from}-${x.ext}-${x.label}` });
  }
  return { width: W, height: Math.max(y - FRAME_GAP + 16, 320), pos, frames, entry, edges, externals, aliasOf, subOf };
}

function edgePath(a: Pos, b: Pos, route?: 'side'): string {
  if (route === 'side') {
    // 从入口左沿出，沿左侧走线槽下行，拐进目标框左沿（框标题那一行的高度）
    const sx = a.x, sy = a.y + a.h / 2, gx = GUTTER / 2, ty = b.y + b.h / 2, tx = b.x, r = 8;
    return `M${sx},${sy} H${gx + r} Q${gx},${sy} ${gx},${sy + r} V${ty - r} Q${gx},${ty} ${gx + r},${ty} H${tx}`;
  }
  const ax = a.x + a.w / 2, ay = a.y + a.h, bx = b.x + b.w / 2, by = b.y;
  if (by >= ay) { const my = (ay + by) / 2; return `M${ax},${ay} C${ax},${my} ${bx},${my} ${bx},${by}`; }
  // 目标在旁边或上方：从右侧出、左侧进
  const sx = a.x + a.w, sy = a.y + a.h / 2, tx = b.x, ty = b.y + b.h / 2, mx = (sx + tx) / 2;
  return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
}

// 线型有语义：声明的关系一律实线，只有「按名推断」才画虚线（`inferred`）。
// 此前六种线全是虚线，整张图读起来像草稿——那正是「第一眼不专业」的来源之一。
const EDGE_STYLE: Record<RelationLayout['edges'][number]['kind'], { stroke: string; width: number; marker?: boolean }> = {
  entry: { stroke: 'hsl(var(--hairline-strong))', width: 1.5, marker: true },
  prefix: { stroke: 'hsl(var(--hairline-strong))', width: 1.5, marker: true },
  call: { stroke: 'hsl(var(--graph-call))', width: 1.6, marker: true },
  ref: { stroke: 'hsl(var(--info))', width: 1.5, marker: true },
  broken: { stroke: 'hsl(var(--bad))', width: 1.6, marker: true },
  infra: { stroke: 'hsl(var(--graph-call))', width: 1.3, marker: true },
};
const INFERRED_DASH = '3 4';

export function RelationGraph({ payload, compact = false, highlight, className, style, entryHost }: { payload: RelationPayload; compact?: boolean; /** 悬停问题卡时点亮的服务（一条问题可能涉及多个服务） */ highlight?: string | string[] | null; className?: string; style?: CSSProperties; /** 入口卡第二行写的域名；没有就写分支名 */ entryHost?: string }): JSX.Element {
  const nodeById = new Map(payload.graph.nodes.map((n) => [n.kind === 'service' ? (n.rawId ?? svc(n.id)) : n.id, n]));
  const findingsOf = (id: string) => payload.lint.findings.filter((f) => f.services.includes(id) && f.severity !== 'info');
  // 按容器宽度排版：宽度量到之后重新排，卡片按列折行、字号 1:1；只有窄于最小画布宽时才整体缩小
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostW, setHostW] = useState(0);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setHostW(el.clientWidth));
    ro.observe(el);
    setHostW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const avail = hostW > 0 ? hostW - (compact ? 8 : 16) : (compact ? 720 : 960);
  const layout = layoutRelations(payload, avail);
  // 非缩略模式最小缩到 0.6：再小就看不清字，改为横向滚动
  const fit = avail / layout.width;
  const scale = compact ? Math.min(1, fit) : Math.min(1, Math.max(0.6, fit));
  const lit = new Set(highlight == null ? [] : Array.isArray(highlight) ? highlight : [highlight]);
  const dim = (touch: boolean): number => (lit.size === 0 ? 1 : touch ? 1 : 0.28);
  const edgeTouches = (key: string): boolean => Array.from(lit).some((id) => key.includes(id));
  // 一个 service 都没有：一枚入口节点漂在整张空画布上，比什么都不画更难看（2026-09-16 用户截图）。
  // 这里直接给空态，画布、图例都不出。
  if (payload.graph.nodes.every((n) => n.kind !== 'service')) {
    return (
      <div ref={hostRef} className={`${className ?? ''} flex items-center justify-center p-6`} style={style} data-testid="relation-graph-empty">
        <RelationEmptyState branch={payload.branch} />
      </div>
    );
  }
  return (
    <div ref={hostRef} className={className} style={{ position: 'relative', overflow: compact ? 'hidden' : 'auto', ...style }} data-testid="relation-graph">
      <div style={{ position: 'relative', width: layout.width, height: layout.height, transform: scale !== 1 ? `scale(${scale})` : undefined, transformOrigin: 'top left', marginBottom: scale !== 1 ? -(layout.height * (1 - scale)) : undefined, marginLeft: compact ? 4 : Math.max(0, (hostW - layout.width * scale) / 2), marginRight: scale !== 1 ? -(layout.width * (1 - scale)) : undefined, backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
        <svg width={layout.width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <defs>
            <marker id="rgArr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="hsl(var(--hairline-strong))" /></marker>
            <marker id="rgArrCall" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="hsl(var(--graph-call))" /></marker>
            <marker id="rgArrRef" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="hsl(var(--info))" /></marker>
            <marker id="rgArrBad" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="hsl(var(--bad))" /></marker>
          </defs>
          {layout.frames.map((f) => {
            const title = f.key === 'main' && entryHost ? `${f.label} · ${entryHost}` : f.label;
            // 框标题与右侧说明挤不下时只留标题：窄画布里两段字叠在一起比少一句说明更难读
            const fits = textW(title, 11) + textW(f.sub, 10) + 40 < f.w;
            return (
              <g key={f.key}>
                <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={14} fill={f.tone === 'external' ? 'hsl(var(--info-soft))' : 'hsl(var(--surface-raised))'} fillOpacity={f.tone === 'external' ? 0.5 : 0.35}
                  stroke={f.tone === 'external' ? 'hsl(var(--info) / .5)' : 'hsl(var(--hairline))'} strokeWidth="1.2" />
                <text x={f.x + 14} y={f.y + 18} fontSize="11" fontWeight="700" fill={f.tone === 'external' ? 'hsl(var(--info))' : 'hsl(var(--muted-foreground))'}>{title}</text>
                {fits ? <text x={f.x + f.w - 14} y={f.y + 18} fontSize="10" textAnchor="end" fill="hsl(var(--muted-foreground))" opacity="0.8">{f.sub}</text> : null}
              </g>
            );
          })}
          {layout.edges.map((e, idx) => {
            const st = EDGE_STYLE[e.kind];
            const t = 0.42 + (idx % 3) * 0.16;
            const lx = e.from.x + e.from.w / 2 + (e.to.x + e.to.w / 2 - e.from.x - e.from.w / 2) * t;
            const ly = e.from.y + e.from.h + (e.to.y - e.from.y - e.from.h) * t + 3;
            // 入口与前缀线不挂标签：前缀已经写在成员卡的第二行，线上再写一遍只会叠字
            const raw = e.kind === 'entry' || e.kind === 'prefix' ? undefined : e.label;
            const label = raw && raw.length > 26 ? `${raw.slice(0, 25)}…` : raw;
            return (
              <g key={e.key} opacity={dim(lit.size === 0 || edgeTouches(e.key))}>
                <path d={edgePath(e.from, e.to, e.route)} fill="none" stroke={st.stroke} strokeWidth={st.width} strokeDasharray={e.inferred ? INFERRED_DASH : undefined} opacity="0.9" markerEnd={st.marker ? (e.kind === 'broken' ? 'url(#rgArrBad)' : e.kind === 'call' || e.kind === 'infra' ? 'url(#rgArrCall)' : e.kind === 'ref' ? 'url(#rgArrRef)' : 'url(#rgArr)') : undefined} />
                {label ? (
                  <>
                    <rect x={lx - 4 - label.length * 2.8} y={ly - 9} width={label.length * 5.6 + 8} height={13} rx={3} fill="hsl(var(--surface-sunken))" opacity="0.92" />
                    <text x={lx} y={ly} textAnchor="middle" fontSize="9" fill={e.kind === 'broken' ? 'hsl(var(--bad))' : e.inferred ? 'hsl(var(--warn))' : 'hsl(var(--muted-foreground))'} className="font-mono">{label}</text>
                  </>
                ) : null}
              </g>
            );
          })}
        </svg>
        <div className="cds-surface-raised cds-hairline" style={{ position: 'absolute', left: layout.entry.x, top: layout.entry.y, width: layout.entry.w, height: layout.entry.h, borderRadius: 12, padding: '8px 10px', fontSize: 12 }}>
          <div className="flex items-center gap-2 font-bold"><span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[9px] font-extrabold text-primary-foreground" style={{ background: tone('--graph-call') }}>GW</span>入口</div>
          <div className={`mt-1 truncate text-[10px] text-muted-foreground ${entryHost ? 'font-mono' : ''}`} title={entryHost ?? payload.branch}>{entryHost ?? `分支 ${payload.branch}`}</div>
        </div>
        {Array.from(layout.pos.entries()).map(([id, p]) => {
          const realId = layout.aliasOf.get(id) ?? id;
          const n = nodeById.get(realId);
          if (!n) return null;
          const isInfra = n.kind === 'infra';
          const role = n.role ?? 'api';
          const bad = findingsOf(realId);
          const glow = lit.has(realId);
          // 基础设施徽标不占语义色：redis 不用 --bad（红色只在「坏了」时出现）、mongo 不用 --ok
          const token = isInfra ? (/redis/i.test(n.dockerImage || n.id) ? '--series-5' : '--series-2') : ROLE_TOKEN[role];
          const color = tone(token);
          return (
            <div key={id} className="bg-background" data-node={id} data-role={isInfra ? 'infra' : role}
              style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h, borderRadius: 12, border: `1.5px solid ${bad.some((f) => f.severity === 'error') ? 'hsl(var(--bad) / .7)' : bad.length ? 'hsl(var(--warn) / .7)' : tone(token, 0.35)}`, boxShadow: glow ? `0 0 0 3px ${bad.some((f) => f.severity === 'error') ? 'hsl(var(--bad) / .35)' : 'hsl(var(--warn) / .35)'}, 0 4px 12px hsl(0 0% 0% / .25)` : '0 4px 12px hsl(0 0% 0% / .25)', fontSize: 12, opacity: dim(lit.size === 0 || glow), transition: 'opacity 150ms, box-shadow 150ms' }}>
              <div className="flex items-center gap-2 px-2.5 pt-2 text-[13px] font-bold">
                <span className={`inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[9px] font-extrabold text-primary-foreground ${!isInfra && n.roleSource && n.roleSource !== 'declared' ? 'border border-dashed border-primary-foreground/70' : ''}`} style={{ background: color }} title={n.roleReason}>
                  {isInfra ? (/redis/i.test(n.dockerImage || n.id) ? 'R' : 'DB') : ROLE_LABEL[role]}
                </span>
                <span className="min-w-0 flex-1 truncate" title={realId}>{n.name || realId}{id !== realId ? <span className="ml-1 text-[9px] font-normal text-muted-foreground">同一服务</span> : null}</span>
                {bad.length > 0 ? <span className={`inline-flex h-[16px] shrink-0 items-center rounded-full border px-1.5 text-[9px] font-semibold ${bad.some((f) => f.severity === 'error') ? 'border-destructive/60 text-destructive' : 'border-warn/60 bg-warn-soft text-warn'}`} title={bad.map((f) => f.message).join('\n')}>{bad.length} 问题</span> : null}
              </div>
              <div className="truncate px-2.5 pb-1 text-[10px] text-muted-foreground">
                {isInfra ? '共享实例 · 所有分支共用' : layout.subOf.get(id) ?? ((n.pathPrefixes ?? []).join(' ') || (n.subdomain ? `子域 ${n.subdomain}` : '内网 · 不对外'))}
              </div>
            </div>
          );
        })}
        {layout.externals.map((e) => (
          <div key={e.id} className="bg-background" data-node={e.id} style={{ position: 'absolute', left: e.pos.x, top: e.pos.y, width: e.pos.w, height: e.pos.h, borderRadius: 12, border: `1.5px solid ${e.broken ? 'hsl(var(--bad) / .7)' : 'hsl(var(--info) / .5)'}`, fontSize: 12, boxShadow: '0 4px 12px hsl(0 0% 0% / .25)' }}>
            <div className="flex items-center gap-2 px-2.5 pt-2 text-[13px] font-bold">
              <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[9px] font-extrabold text-primary-foreground" style={{ background: tone('--graph-external') }}>EXT</span>
              <span className="min-w-0 flex-1 truncate">{e.label}</span>
              <span className={`inline-flex h-[16px] shrink-0 items-center rounded-full border px-1.5 text-[9px] font-semibold ${e.broken ? 'border-destructive/60 text-destructive' : 'border-ok/50 bg-ok-soft text-ok'}`}>{e.broken ? (e.status === 'running' ? '可达' : e.status === 'stopped' ? '已停止' : '断裂') : '可达'}</span>
            </div>
            <div className="truncate px-2.5 pb-1 text-[10px] text-muted-foreground" title={e.sub}>{e.sub}</div>
          </div>
        ))}
      </div>
      {!compact ? (
        /* 图例：每一项自己不换行（窄抽屉里「声明的关系」曾被折成两行三个字一坨），整行按项折行 */
        <div className="cds-surface-raised cds-hairline sticky bottom-2 left-2 mt-2 inline-flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-3 py-1.5 text-[10px] text-muted-foreground" data-testid="relation-legend">
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg width="22" height="6" aria-hidden><path d="M0 3H22" stroke="hsl(var(--hairline-strong))" strokeWidth="1.5" /></svg>声明的关系</span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg width="22" height="6" aria-hidden><path d="M0 3H22" stroke="hsl(var(--hairline-strong))" strokeWidth="1.5" strokeDasharray={INFERRED_DASH} /></svg>按名推断</span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg width="22" height="6" aria-hidden><path d="M0 3H22" stroke={tone('--graph-call')} strokeWidth="1.5" /></svg>环境变量引用 / 调用</span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg width="22" height="6" aria-hidden><path d="M0 3H22" stroke="hsl(var(--info))" strokeWidth="1.5" /></svg>跨项目引用</span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg width="22" height="6" aria-hidden><path d="M0 3H22" stroke="hsl(var(--bad))" strokeWidth="1.5" /></svg>断裂</span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="inline-block h-3 w-3 rounded-[3px] border border-dashed border-foreground-muted" aria-hidden />角色是推断的</span>
        </div>
      ) : null}
    </div>
  );
}

export const RELATION_EMPTY_HEADLINE = '这个分支还没有任何 service，关系无从画起。';

/** 零服务的空态：卡片、半屏抽屉、全屏页共用一份，不各写各的。 */
export function RelationEmptyState({ branch, onConfigure }: { branch?: string; onConfigure?: () => void }): JSX.Element {
  return (
    <div className="flex max-w-[26rem] flex-col items-center gap-2 text-center" data-testid="relation-empty">
      <svg width="88" height="40" viewBox="0 0 88 40" aria-hidden className="text-muted-foreground/70">
        <rect x="1" y="12" width="26" height="16" rx="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M27 20 H38" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
        <rect x="38" y="12" width="26" height="16" rx="5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
        <path d="M64 20 H75" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
        <rect x="75" y="12" width="12" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" />
      </svg>
      <div className="text-sm font-semibold text-foreground">{RELATION_EMPTY_HEADLINE}</div>
      <div className="text-xs leading-relaxed text-muted-foreground">
        在 compose 里声明服务并部署{branch ? `分支 ${branch}` : ''}之后，这里会画出入口、壳、前缀成员与共享基础设施之间的流向，并给出体检结论。
      </div>
      {onConfigure ? <button type="button" className="mt-1 inline-flex h-7 items-center rounded-md border border-[hsl(var(--hairline-strong))] px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))]" onClick={onConfigure}>去配置服务</button> : null}
    </div>
  );
}

/** 一句话结论：先给判断再给数字（conclusion-before-numbers）。 */
export function relationHeadline(payload: RelationPayload): string {
  const services = payload.graph.nodes.filter((n) => n.kind === 'service');
  if (services.length === 0) return RELATION_EMPTY_HEADLINE;
  const main = payload.graph.sites.find((s) => s.kind === 'main');
  const subs = payload.graph.sites.filter((s) => s.kind === 'subdomain').length;
  const parts: string[] = [];
  // 用节点的显示名，和流向条 / 关系图上的 chip 一致；此前写 id，同一个服务在句子里叫 demo-web、在图上叫 web（演示）
  const nameOf = (id: string): string => services.find((n) => (n.rawId ?? n.id.replace(/^service:/, '')) === id)?.name || id;
  if (main?.shellId) parts.push(`主域名下 ${nameOf(main.shellId)} 是壳，${main.members.length} 个服务按前缀挂在它下面`);
  else if (services.length) parts.push(`${services.length} 个服务，主域名没有壳`);
  if (subs) parts.push(`${subs} 个子域各成一站`);
  const errs = payload.lint.findings.filter((f) => f.severity === 'error');
  const warns = payload.lint.findings.filter((f) => f.severity === 'warn');
  // 体检文案自带句号时去掉，免得拼出「。。」
  const trim = (m: string): string => m.replace(/[。.]+$/, '');
  if (errs[0]) parts.push(trim(errs[0].message));
  else if (warns[0]) parts.push(trim(warns[0].message));
  else parts.push('体检无错误');
  return parts.join('。') + '。';
}
