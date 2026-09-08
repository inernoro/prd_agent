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

const CARD_W = 200, CARD_H = 52, GAP_X = 28, GAP_Y = 64, SITE_PAD = 14, SITE_LABEL = 22, SITE_GAP = 36;
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
  edges: Array<{ from: Pos; to: Pos; kind: 'entry' | 'prefix' | 'call' | 'ref' | 'broken' | 'infra'; label?: string; key: string }>;
  externals: Array<{ id: string; label: string; sub: string; status: string; pos: Pos; broken: boolean }>;
  /** 同一个服务同时是主域名壳和子域壳（double-public-surface）时，后一个站点里用别名节点，这里映射回真实 id */
  aliasOf: Map<string, string>;
}

const svc = (id: string): string => id.replace(/^service:/, '');

export function layoutRelations(payload: RelationPayload, minWidth = 900): RelationLayout {
  const { graph, references } = payload;
  const nodeById = new Map(graph.nodes.filter((n) => n.kind === 'service').map((n) => [n.rawId ?? svc(n.id), n]));
  const ids = Array.from(nodeById.keys());
  const placed = new Set<string>();
  const aliasOf = new Map<string, string>();
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

  // 站点块：壳 / 前缀成员 / 内网服务（只被本站服务调用的）
  const blocks = graph.sites.map((site) => {
    const shell = site.shellId && nodeById.has(site.shellId) ? claim(site.shellId, site.id) : undefined;
    const members = site.members.filter((m) => nodeById.has(m.id)).map((m) => claim(m.id, site.id));
    return { site, shell, members, attached: [] as string[] };
  }).filter((b) => b.shell || b.members.length > 0);
  for (const id of graph.internal) {
    if (!nodeById.has(id) || placed.has(id)) continue;
    const cs = callers(id);
    if (cs.length === 0) continue;
    const owner = blocks.find((b) => cs.every((c) => (b.shell && c === real(b.shell)) || b.members.some((m) => real(m) === c)));
    if (!owner) continue;
    owner.attached.push(id); placed.add(id);
  }
  const rest = ids.filter((id) => !placed.has(id));

  const rowW = (n: number): number => (n <= 0 ? 0 : n * CARD_W + (n - 1) * GAP_X);
  const blockW = (b: (typeof blocks)[number]): number => Math.max(b.shell ? CARD_W : 0, rowW(b.members.length), rowW(b.attached.length));
  const sitesW = blocks.reduce((s, b) => s + blockW(b) + SITE_PAD * 2, 0) + Math.max(0, blocks.length - 1) * SITE_GAP;

  // 外部项目框：跨项目引用（引用变量或手写网址指向别的项目分支）
  const externals: RelationLayout['externals'] = [];
  const extEdges: Array<{ from: string; ext: string; broken: boolean; label: string }> = [];
  for (const r of references) {
    if (r.kind === 'cds-ref') {
      for (const x of r.resolved ?? []) {
        if (!x.target.projectId || x.target.projectId === payload.projectId) continue;
        const id = `ext:${x.target.projectId}:${x.target.branchId ?? x.target.branchName ?? ''}:${x.ref.serviceId}`;
        const broken = x.status !== 'running';
        if (!externals.some((e) => e.id === id)) externals.push({ id, label: `${x.ref.serviceId} · ${x.target.branchName ?? '?'}`, sub: `${x.target.projectSlug ?? x.ref.projectRef} · 引用自 ${r.profileId} ${r.key}`, status: x.status, pos: { x: 0, y: 0, w: CARD_W + 60, h: CARD_H }, broken });
        extEdges.push({ from: r.profileId, ext: id, broken, label: r.key });
      }
    } else if (r.kind === 'url' && r.matchedBranch && r.matchedBranch.projectId !== payload.projectId) {
      const id = `ext:${r.matchedBranch.projectId}:${r.matchedBranch.branchId}:url`;
      const broken = r.matchedBranch.status !== 'running';
      if (!externals.some((e) => e.id === id)) externals.push({ id, label: `分支 ${r.matchedBranch.branchName}`, sub: `手写网址 · ${r.profileId} ${r.key}`, status: r.matchedBranch.status, pos: { x: 0, y: 0, w: CARD_W + 60, h: CARD_H }, broken });
      extEdges.push({ from: r.profileId, ext: id, broken, label: r.key });
    }
  }
  const extW = externals.length > 0 ? CARD_W + 60 + SITE_PAD * 2 : 0;
  const width = Math.max(minWidth, sitesW + (extW ? extW + SITE_GAP : 0) + 40);

  const pos = new Map<string, Pos>();
  const frames: Frame[] = [];
  const entry: Pos = { x: (width - 180) / 2, y: 16, w: 180, h: 64 };
  let y = entry.y + entry.h + 56;
  const shellY = y + SITE_LABEL;
  const memberY = shellY + CARD_H + GAP_Y;
  let x = Math.max(12, (width - sitesW - (extW ? extW + SITE_GAP : 0)) / 2);
  let bottom = shellY + CARD_H;
  for (const b of blocks) {
    const bw = blockW(b);
    const inner = x + SITE_PAD;
    if (b.shell) pos.set(b.shell, { x: inner + (bw - CARD_W) / 2, y: shellY, w: CARD_W, h: CARD_H });
    const place = (list: string[], ry: number): void => {
      const start = inner + (bw - rowW(list.length)) / 2;
      list.forEach((id, i) => pos.set(id, { x: start + i * (CARD_W + GAP_X), y: ry, w: CARD_W, h: CARD_H }));
    };
    place(b.members, memberY);
    const attachedY = b.members.length > 0 ? memberY + CARD_H + GAP_Y : shellY + CARD_H + GAP_Y;
    if (b.attached.length === 1 && b.members.length <= 1) {
      const cp = pos.get(callers(b.attached[0])[0] ?? '') ?? pos.get(b.shell ?? '');
      pos.set(b.attached[0], { x: cp ? cp.x : inner, y: attachedY, w: CARD_W, h: CARD_H });
    } else place(b.attached, attachedY);
    const last = b.attached.length > 0 ? attachedY + CARD_H : b.members.length > 0 ? memberY + CARD_H : shellY + CARD_H;
    frames.push({ key: b.site.id, label: b.site.kind === 'main' ? '主域名' : `子域 ${b.site.subdomain}`, sub: b.site.kind === 'main' ? (b.site.shellSource === 'convention' ? '默认站按名兜底 · 前缀分流' : '壳在上 · 前缀成员在下') : '整站归壳', x, y, w: bw + SITE_PAD * 2, h: last + SITE_PAD - y, tone: 'site' });
    bottom = Math.max(bottom, last + SITE_PAD);
    x += bw + SITE_PAD * 2 + SITE_GAP;
  }
  // 入口对齐到第一个站点（通常是主域名）正上方，而不是整图居中：宽图在半屏里居中会把入口推到看不见的右侧
  if (frames.length > 0) entry.x = Math.max(12, frames[0].x + frames[0].w / 2 - entry.w / 2);
  if (externals.length > 0) {
    const ex = x, ey = y;
    externals.forEach((e, i) => { e.pos = { x: ex + SITE_PAD, y: ey + SITE_LABEL + i * (CARD_H + 16), w: CARD_W + 60, h: CARD_H }; });
    const eh = SITE_LABEL + externals.length * (CARD_H + 16) - 16 + SITE_PAD;
    frames.push({ key: 'external', label: '外部项目', sub: '跨项目引用 · 走公网入口', x: ex, y: ey, w: extW, h: eh, tone: 'external' });
    bottom = Math.max(bottom, ey + eh);
  }
  y = bottom + GAP_Y;
  // 剩余（游离或多方调用的内网）服务：一排居中
  if (rest.length > 0) {
    const start = Math.max(12, (width - rowW(rest.length)) / 2);
    rest.forEach((id, i) => pos.set(id, { x: start + i * (CARD_W + GAP_X), y, w: CARD_W, h: CARD_H }));
    y += CARD_H + GAP_Y;
  }
  // 共享基础设施
  const infra = graph.nodes.filter((n) => n.kind === 'infra');
  if (infra.length > 0) {
    const iw = rowW(infra.length) + SITE_PAD * 2;
    const ix = Math.max(12, (width - iw) / 2);
    infra.forEach((n, i) => pos.set(n.id, { x: ix + SITE_PAD + i * (CARD_W + GAP_X), y: y + SITE_LABEL, w: CARD_W, h: CARD_H }));
    frames.push({ key: 'infra', label: '共享基础设施', sub: '同项目所有分支共用', x: ix, y, w: iw, h: SITE_LABEL + CARD_H + SITE_PAD, tone: 'infra' });
    y += SITE_LABEL + CARD_H + SITE_PAD + 24;
  }

  const edges: RelationLayout['edges'] = [];
  for (const b of blocks) {
    const head = b.shell ?? b.members[0];
    const hp = head ? pos.get(head) : undefined;
    if (hp) edges.push({ from: entry, to: hp, kind: 'entry', key: `entry-${b.site.id}` });
    if (b.shell) {
      const sp = pos.get(b.shell)!;
      for (const m of b.members) {
        const mp = pos.get(m); if (!mp) continue;
        const info = b.site.members.find((x) => x.id === real(m));
        edges.push({ from: sp, to: mp, kind: 'prefix', label: (info?.prefixes ?? []).join(' ') + (info?.viaConvention ? ' · 按名约定' : ''), key: `prefix-${m}` });
      }
    }
  }
  for (const e of graph.edges) {
    const a = pos.get(svc(e.from)); const to = e.to.startsWith('infra:') ? pos.get(e.to) : pos.get(svc(e.to));
    if (!a || !to) continue;
    edges.push({ from: a, to, kind: e.to.startsWith('infra:') ? 'infra' : 'call', label: e.to.startsWith('infra:') ? undefined : (e.declared ? '声明' : e.envKeys[0] ?? 'depends_on'), key: `call-${e.from}-${e.to}` });
  }
  for (const x of extEdges) {
    const a = pos.get(x.from); const e = externals.find((z) => z.id === x.ext);
    if (!a || !e) continue;
    edges.push({ from: a, to: e.pos, kind: x.broken ? 'broken' : 'ref', label: x.label, key: `ref-${x.from}-${x.ext}-${x.label}` });
  }
  return { width, height: Math.max(y, 320), pos, frames, entry, edges, externals, aliasOf };
}

function edgePath(a: Pos, b: Pos): string {
  const ax = a.x + a.w / 2, ay = a.y + a.h, bx = b.x + b.w / 2, by = b.y;
  if (by >= ay) { const my = (ay + by) / 2; return `M${ax},${ay} C${ax},${my} ${bx},${my} ${bx},${by}`; }
  // 目标在旁边或上方：从右侧出、左侧进
  const sx = a.x + a.w, sy = a.y + a.h / 2, tx = b.x, ty = b.y + b.h / 2, mx = (sx + tx) / 2;
  return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
}

const EDGE_STYLE: Record<RelationLayout['edges'][number]['kind'], { stroke: string; dash: string; width: number; marker?: boolean }> = {
  entry: { stroke: 'hsl(var(--muted-foreground))', dash: '5 5', width: 1.4, marker: true },
  prefix: { stroke: 'hsl(var(--muted-foreground))', dash: '2 4', width: 1.4, marker: true },
  call: { stroke: 'hsl(var(--graph-call))', dash: '5 5', width: 1.6, marker: true },
  ref: { stroke: 'hsl(var(--info))', dash: '4 4', width: 1.5, marker: true },
  broken: { stroke: 'hsl(var(--bad))', dash: '4 4', width: 1.6, marker: true },
  infra: { stroke: 'hsl(var(--muted-foreground))', dash: '5 5', width: 1.2 },
};

export function RelationGraph({ payload, compact = false, highlight, className, style }: { payload: RelationPayload; compact?: boolean; highlight?: string | null; className?: string; style?: CSSProperties }): JSX.Element {
  const layout = layoutRelations(payload, compact ? 720 : 960);
  const nodeById = new Map(payload.graph.nodes.map((n) => [n.kind === 'service' ? (n.rawId ?? svc(n.id)) : n.id, n]));
  const findingsOf = (id: string) => payload.lint.findings.filter((f) => f.services.includes(id) && f.severity !== 'info');
  // 按容器宽度整体缩放（半屏抽屉、缩略卡、窄屏全屏都能整图入镜，不靠横向滚动找入口）
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
  // 非缩略模式最小缩到 0.6：再小就看不清字，改为横向滚动
  const fit = hostW > 0 ? (hostW - (compact ? 8 : 16)) / layout.width : (compact ? 640 / layout.width : 1);
  const scale = compact ? Math.min(1, fit) : Math.min(1, Math.max(0.6, fit));
  const dim = (touch: boolean): number => (!highlight ? 1 : touch ? 1 : 0.28);
  return (
    <div ref={hostRef} className={className} style={{ position: 'relative', overflow: compact ? 'hidden' : 'auto', ...style }} data-testid="relation-graph">
      <div style={{ position: 'relative', width: layout.width, height: layout.height, transform: scale !== 1 ? `scale(${scale})` : undefined, transformOrigin: 'top left', marginBottom: scale !== 1 ? -(layout.height * (1 - scale)) : undefined, marginLeft: compact ? 4 : Math.max(0, (hostW - layout.width * scale) / 2), marginRight: scale !== 1 ? -(layout.width * (1 - scale)) : undefined, backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
        <svg width={layout.width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <defs>
            <marker id="rgArr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="hsl(var(--muted-foreground))" /></marker>
            <marker id="rgArrBad" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="hsl(var(--bad))" /></marker>
          </defs>
          {layout.frames.map((f) => (
            <g key={f.key}>
              <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={14} fill={f.tone === 'external' ? 'hsl(var(--info-soft))' : 'hsl(var(--surface-raised))'} fillOpacity={f.tone === 'external' ? 0.5 : 0.35}
                stroke={f.tone === 'external' ? 'hsl(var(--info) / .5)' : 'hsl(var(--hairline))'} strokeWidth="1.2" strokeDasharray="6 5" />
              <text x={f.x + 12} y={f.y + 15} fontSize="10" fontWeight="700" fill={f.tone === 'external' ? 'hsl(var(--info))' : 'hsl(var(--muted-foreground))'}>{f.label}</text>
              <text x={f.x + f.w - 12} y={f.y + 15} fontSize="9" textAnchor="end" fill="hsl(var(--muted-foreground))" opacity="0.8">{f.sub}</text>
            </g>
          ))}
          {layout.edges.map((e, idx) => {
            const st = EDGE_STYLE[e.kind];
            const t = 0.42 + (idx % 3) * 0.16;
            const lx = e.from.x + e.from.w / 2 + (e.to.x + e.to.w / 2 - e.from.x - e.from.w / 2) * t;
            const ly = e.from.y + e.from.h + (e.to.y - e.from.y - e.from.h) * t + 3;
            const label = e.label && e.label.length > 26 ? `${e.label.slice(0, 25)}…` : e.label;
            return (
              <g key={e.key} opacity={dim(!highlight || e.key.includes(highlight))}>
                <path d={edgePath(e.from, e.to)} fill="none" stroke={st.stroke} strokeWidth={st.width} strokeDasharray={st.dash} opacity="0.8" markerEnd={st.marker ? (e.kind === 'broken' ? 'url(#rgArrBad)' : 'url(#rgArr)') : undefined} />
                {label ? (
                  <>
                    <rect x={lx - 4 - label.length * 2.8} y={ly - 9} width={label.length * 5.6 + 8} height={13} rx={3} fill="hsl(var(--surface-sunken))" opacity="0.92" />
                    <text x={lx} y={ly} textAnchor="middle" fontSize="9" fill={e.kind === 'broken' ? 'hsl(var(--bad))' : 'hsl(var(--muted-foreground))'} className="font-mono">{label}</text>
                  </>
                ) : null}
              </g>
            );
          })}
        </svg>
        <div className="cds-surface-raised cds-hairline" style={{ position: 'absolute', left: layout.entry.x, top: layout.entry.y, width: layout.entry.w, height: layout.entry.h, borderRadius: 12, padding: '8px 10px', fontSize: 12 }}>
          <div className="flex items-center gap-2 font-bold"><span className="inline-flex h-[22px] w-[22px] items-center justify-center rounded-md text-[9px] font-extrabold text-primary-foreground" style={{ background: tone('--graph-call') }}>GW</span>入口</div>
          <div className="mt-1 truncate text-[10px] text-muted-foreground">{payload.branch} · forwarder 按 host 与前缀分流</div>
        </div>
        {Array.from(layout.pos.entries()).map(([id, p]) => {
          const realId = layout.aliasOf.get(id) ?? id;
          const n = nodeById.get(realId);
          if (!n) return null;
          const isInfra = n.kind === 'infra';
          const role = n.role ?? 'api';
          const bad = findingsOf(realId);
          const token = isInfra ? (/redis/i.test(n.dockerImage || n.id) ? '--bad' : '--ok') : ROLE_TOKEN[role];
          const color = tone(token);
          return (
            <div key={id} className="bg-background" data-node={id} data-role={isInfra ? 'infra' : role}
              style={{ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h, borderRadius: 12, border: `1.5px solid ${bad.some((f) => f.severity === 'error') ? 'hsl(var(--bad) / .7)' : bad.length ? 'hsl(var(--warn) / .7)' : tone(token, 0.35)}`, boxShadow: '0 4px 12px hsl(0 0% 0% / .25)', fontSize: 12, opacity: dim(!highlight || realId === highlight) }}>
              <div className="flex items-center gap-2 px-2.5 pt-2 text-[13px] font-bold">
                <span className={`inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[9px] font-extrabold text-primary-foreground ${!isInfra && n.roleSource && n.roleSource !== 'declared' ? 'border border-dashed border-primary-foreground/70' : ''}`} style={{ background: color }} title={n.roleReason}>
                  {isInfra ? (/redis/i.test(n.dockerImage || n.id) ? 'R' : 'DB') : ROLE_LABEL[role]}
                </span>
                <span className="min-w-0 flex-1 truncate" title={realId}>{n.name || realId}{id !== realId ? <span className="ml-1 text-[9px] font-normal text-muted-foreground">同一服务</span> : null}</span>
                {bad.length > 0 ? <span className={`inline-flex h-[16px] shrink-0 items-center rounded-full border px-1.5 text-[9px] font-semibold ${bad.some((f) => f.severity === 'error') ? 'border-destructive/60 text-destructive' : 'border-warn/60 bg-warn-soft text-warn'}`} title={bad.map((f) => f.message).join('\n')}>{bad.length} 问题</span> : null}
              </div>
              <div className="truncate px-2.5 pb-1 text-[10px] text-muted-foreground">
                {isInfra ? '共享实例' : n.subdomain ? `子域 ${n.subdomain}` : (n.pathPrefixes ?? []).join(' ') || '内网'}
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
        <div className="cds-surface-raised cds-hairline sticky bottom-2 left-2 mt-2 inline-flex items-center gap-4 rounded-md px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>虚线框 = 同一 host</span><span>灰线 = 入口分流 / 前缀分流</span><span style={{ color: tone('--graph-call') }}>紫线 = 环境变量引用 / 调用</span><span className="text-info">蓝线 = 跨项目引用</span><span className="text-destructive">红线 = 断裂</span><span>徽标虚边 = 角色是推断的</span>
        </div>
      ) : null}
    </div>
  );
}

/** 一句话结论：先给判断再给数字（conclusion-before-numbers）。 */
export function relationHeadline(payload: RelationPayload): string {
  const services = payload.graph.nodes.filter((n) => n.kind === 'service');
  const main = payload.graph.sites.find((s) => s.kind === 'main');
  const subs = payload.graph.sites.filter((s) => s.kind === 'subdomain').length;
  const parts: string[] = [];
  if (main?.shellId) parts.push(`主域名下 ${main.shellId} 是壳，${main.members.length} 个服务按前缀挂在它下面`);
  else if (services.length) parts.push(`${services.length} 个服务，主域名没有壳`);
  if (subs) parts.push(`${subs} 个子域各成一站`);
  const errs = payload.lint.findings.filter((f) => f.severity === 'error');
  const warns = payload.lint.findings.filter((f) => f.severity === 'warn');
  if (errs[0]) parts.push(errs[0].message);
  else if (warns[0]) parts.push(warns[0].message);
  else parts.push('体检无错误');
  return parts.join('。') + '。';
}
