/*
 * RelationFlowStrip — 关系缩略卡里的「流向条」（plan.cds.service-relations 第五批）。
 *
 * 为什么不再画缩略版的二维分层图：那张图完整布局约 516px 高，缩略卡只有 180px，
 * 而缩放只按宽度算，宽屏上根本不缩——于是只露出「入口」和主域名框的上沿，文案说
 * 「2 个服务挂在壳下面」，图里一个都没有（2026-09-16 用户：「第一眼就很一般」）。
 *
 * 缩略态换一种读法：从左到右一行读完，入口 → 壳 → 前缀成员 → 共享基础设施 / 外部引用。
 * 前缀写在节点里，线上不挂标签；灰实线 = 域名与前缀分流，紫实线 = 环境变量引用 / 调用，
 * 蓝 = 跨项目引用，红 = 断裂；虚线只留给「按名推断」。出问题的节点自己描边并挂「N 问题」。
 *
 * `layoutFlow` 是纯函数（守卫测试直接断言它列全了每个服务），渲染层只负责摆放与连线。
 * 窄于 FLOW_NARROW_PX 时成员列与尾列各折成一个计数 chip，不让流向条再被裁掉一半。
 */
import { useEffect, useRef, useState } from 'react';
import type { LintFindingView, RelationPayload, RoleView } from './RelationGraph';

export type FlowKind = 'gw' | 'web' | 'api' | 'job' | 'db' | 'r' | 'ext';
export interface FlowChip {
  id: string;
  kind: FlowKind;
  name: string;
  sub: string;
  /** 前缀是按名约定兜底出来的（compose 里没声明）：描边用虚线 */
  inferred?: boolean;
  problem?: 'warn' | 'bad';
  problemCount?: number;
}
export interface FlowLink { from: number; to: number; kind: 'prefix' | 'call' | 'ref' | 'broken' }
export interface FlowModel {
  entry: FlowChip;
  /** 壳列：主域名壳在前，子域壳随后；主域名没有壳时是一枚灰 chip */
  shells: FlowChip[];
  /** 成员列：主域名前缀成员在前，其余（内网 / 游离）服务随后 */
  members: FlowChip[];
  /** 壳列 → 成员列：只有前缀成员有线 */
  shellLinks: FlowLink[];
  /** 尾列：共享基础设施 + 跨项目引用 */
  tail: FlowChip[];
  /** 成员列 → 尾列 */
  tailLinks: FlowLink[];
  facts: { sites: number; services: number; prefixes: number; infra: number; refs: number; errors: number; warnings: number };
}

const ROLE_KIND: Record<RoleView, FlowKind> = { web: 'web', api: 'api', worker: 'job' };
const KIND_LABEL: Record<FlowKind, string> = { gw: 'GW', web: 'WEB', api: 'API', job: 'JOB', db: 'DB', r: 'R', ext: 'EXT' };
// 颜色只许走主题 token（cds-theme-tokens）：redis 不再用 --bad——红色只在「坏了」时出现，
// 否则节点真出了问题，红描边和红徽标会打架（2026-09-16 微调 1）。
const KIND_TOKEN: Record<FlowKind, string> = { gw: '--graph-call', web: '--role-web', api: '--role-api', job: '--role-worker', db: '--series-2', r: '--series-5', ext: '--graph-external' };
export const FLOW_NARROW_PX = 880;

const svc = (id: string): string => id.replace(/^service:/, '');
const isRedis = (n: { id: string; dockerImage?: string }): boolean => /redis/i.test(n.dockerImage || n.id);

export function layoutFlow(payload: RelationPayload, entryHost?: string): FlowModel {
  const { graph, references, lint } = payload;
  const nodes = graph.nodes.filter((n) => n.kind === 'service');
  const nodeById = new Map(nodes.map((n) => [n.rawId ?? svc(n.id), n]));
  const problems = (id: string): { problem?: FlowChip['problem']; problemCount?: number } => {
    const hit = lint.findings.filter((f: LintFindingView) => f.services.includes(id) && f.severity !== 'info');
    if (hit.length === 0) return {};
    return { problem: hit.some((f) => f.severity === 'error') ? 'bad' : 'warn', problemCount: hit.length };
  };
  const chipOf = (id: string, sub: string, inferred?: boolean): FlowChip => {
    const n = nodeById.get(id);
    return { id, kind: ROLE_KIND[n?.role ?? 'api'], name: n?.name || id, sub, inferred, ...problems(id) };
  };

  const main = graph.sites.find((s) => s.kind === 'main');
  const subs = graph.sites.filter((s) => s.kind === 'subdomain');
  const placed = new Set<string>();

  const shells: FlowChip[] = [];
  if (main?.shellId && nodeById.has(main.shellId)) {
    shells.push(chipOf(main.shellId, main.shellSource === 'convention' ? '壳 · 按名兜底承接 /' : '壳 · 承接 /', main.shellSource === 'convention'));
    placed.add(main.shellId);
  } else {
    shells.push({ id: 'no-shell', kind: 'web', name: '主域名没有壳', sub: '根路径没人承接' });
  }
  for (const s of subs) {
    if (!s.shellId || !nodeById.has(s.shellId) || placed.has(s.shellId)) continue;
    shells.push(chipOf(s.shellId, `子域 ${s.subdomain ?? ''} · 整站归它`));
    placed.add(s.shellId);
  }

  const members: FlowChip[] = [];
  const shellLinks: FlowLink[] = [];
  for (const m of main?.members ?? []) {
    if (!nodeById.has(m.id) || placed.has(m.id)) continue;
    const prefixes = m.prefixes.join(' · ') || '/';
    members.push(chipOf(m.id, m.viaConvention ? `${prefixes} · 按名推断` : prefixes, m.viaConvention));
    shellLinks.push({ from: 0, to: members.length - 1, kind: 'prefix' });
    placed.add(m.id);
  }
  for (const s of subs) {
    for (const m of s.members) {
      if (!nodeById.has(m.id) || placed.has(m.id)) continue;
      members.push(chipOf(m.id, `子域 ${s.subdomain ?? ''} 下 ${m.prefixes.join(' · ') || '/'}`, m.viaConvention));
      const shellIdx = shells.findIndex((c) => c.id === s.shellId);
      if (shellIdx >= 0) shellLinks.push({ from: shellIdx, to: members.length - 1, kind: 'prefix' });
      placed.add(m.id);
    }
  }
  for (const n of nodes) {
    const id = n.rawId ?? svc(n.id);
    if (placed.has(id)) continue;
    members.push(chipOf(id, n.subdomain ? `子域 ${n.subdomain}` : '内网 · 不对外'));
    placed.add(id);
  }

  const tail: FlowChip[] = [];
  const tailLinks: FlowLink[] = [];
  const memberIdx = (id: string): number => members.findIndex((c) => c.id === id);
  for (const n of graph.nodes.filter((x) => x.kind === 'infra')) {
    tail.push({ id: n.id, kind: isRedis(n) ? 'r' : 'db', name: n.name || n.id.replace(/^infra:/, ''), sub: '所有分支共用' });
  }
  for (const e of graph.edges) {
    if (!e.to.startsWith('infra:')) continue;
    const to = tail.findIndex((c) => c.id === e.to);
    const from = memberIdx(svc(e.from));
    if (to < 0) continue;
    // 壳自己连基础设施：隔着一列画不过来，记成从某个成员出发会说谎，所以只在全图里表达。
    if (from >= 0) tailLinks.push({ from, to, kind: 'call' });
  }
  let refs = 0;
  for (const r of references) {
    const targets = r.kind === 'cds-ref'
      ? (r.resolved ?? []).filter((x) => x.target.projectId && x.target.projectId !== payload.projectId).map((x) => ({ id: `ext:${x.target.projectId}:${x.target.branchId ?? x.target.branchName ?? ''}:${x.ref.serviceId}`, name: `${x.ref.serviceId} · ${x.target.branchName ?? '?'}`, sub: `${x.target.projectSlug ?? x.ref.projectRef} · 引用自 ${r.key}`, broken: x.status !== 'running' }))
      : r.kind === 'url' && r.matchedBranch && r.matchedBranch.projectId !== payload.projectId
        ? [{ id: `ext:${r.matchedBranch.projectId}:${r.matchedBranch.branchId}:url`, name: `分支 ${r.matchedBranch.branchName}`, sub: `手写网址 · ${r.key}`, broken: r.matchedBranch.status !== 'running' }]
        : [];
    for (const t of targets) {
      refs += 1;
      let to = tail.findIndex((c) => c.id === t.id);
      if (to < 0) { tail.push({ id: t.id, kind: 'ext', name: t.name, sub: t.sub, problem: t.broken ? 'bad' : undefined }); to = tail.length - 1; }
      const from = memberIdx(r.profileId);
      if (from >= 0) tailLinks.push({ from, to, kind: t.broken ? 'broken' : 'ref' });
    }
  }

  const prefixes = graph.sites.reduce((s, site) => s + site.members.reduce((m, x) => m + x.prefixes.length, 0), 0);
  return {
    entry: { id: 'entry', kind: 'gw', name: entryHost || `分支 ${payload.branch}`, sub: entryHost ? '入口 · 按域名与前缀分流' : '入口 · 按域名与前缀分流（域名未就绪）' },
    shells, members, shellLinks, tail, tailLinks,
    facts: { sites: graph.sites.length, services: nodes.length, prefixes, infra: graph.nodes.filter((n) => n.kind === 'infra').length, refs, errors: lint.summary.errors, warnings: lint.summary.warnings },
  };
}

/** 事实行：结论之下的一行数字，让人不点开就能核对这张图值不值得看。 */
export function FlowFacts({ facts }: { facts: FlowModel['facts'] }): JSX.Element {
  const tone = facts.errors ? 'text-bad' : facts.warnings ? 'text-warn' : 'text-ok';
  const item = (n: number, label: string) => <span className="whitespace-nowrap"><b className="font-semibold text-foreground-muted">{n}</b> {label}</span>;
  const dot = <span aria-hidden className="h-[3px] w-[3px] rounded-full bg-[hsl(var(--hairline-strong))]" />;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-muted-foreground" data-testid="relation-facts">
      {item(facts.sites, '站点')}{dot}{item(facts.services, '服务')}{dot}{item(facts.prefixes, '前缀')}{dot}{item(facts.infra, '共享基础设施')}{dot}{item(facts.refs, '跨项目引用')}{dot}
      <span className="whitespace-nowrap">体检 <b className={`font-semibold ${tone}`}>{facts.errors} 错 {facts.warnings} 警</b></span>
    </div>
  );
}

// 设计稿（1440 画板、14px 基准）里 chip 高 44px；站点根字号是 85%，所以这里的画布 px 一律按 1/0.85 校回，
// 否则整条流向条比设计稿矮一圈（2026-09-17 用户：「很矮小，大小不一」）。chip 的高度必须与连接器共用 ROW_H，
// 此前 chip 用 h-11（2.75rem，85% 下 37px）而连接器按 44 算，多行列的箭头对不上 chip 中线。
const ROW_H = 52, ROW_GAP = 12;
const rowCy = (i: number): number => ROW_H / 2 + i * (ROW_H + ROW_GAP);
const colH = (n: number): number => Math.max(1, n) * (ROW_H + ROW_GAP) - ROW_GAP;

const LINK_STROKE: Record<FlowLink['kind'], string> = { prefix: 'hsl(var(--hairline-strong))', call: 'hsl(var(--graph-call))', ref: 'hsl(var(--info))', broken: 'hsl(var(--bad))' };

function Connector({ links, leftRows, rightRows, dashedFrom, width: CONN_W = 48 }: { links: FlowLink[]; leftRows: number; rightRows: number; dashedFrom?: Set<number>; width?: number }): JSX.Element {
  const h = Math.max(colH(leftRows), colH(rightRows));
  // 两列不等高时各自垂直居中，连线的起止点要跟着偏移
  const lOff = (h - colH(leftRows)) / 2, rOff = (h - colH(rightRows)) / 2;
  return (
    <svg width={CONN_W} height={h} viewBox={`0 0 ${CONN_W} ${h}`} className="shrink-0" aria-hidden>
      {links.map((l, i) => {
        const y0 = lOff + rowCy(l.from), y1 = rOff + rowCy(l.to), x1 = CONN_W - 2;
        const stroke = LINK_STROKE[l.kind];
        const dashed = l.kind === 'prefix' && dashedFrom?.has(l.to);
        return (
          <g key={`${l.kind}-${l.from}-${l.to}-${i}`}>
            <path d={`M0 ${y0} C ${CONN_W / 2} ${y0}, ${CONN_W / 2} ${y1}, ${x1} ${y1}`} fill="none" stroke={stroke} strokeWidth="1.5" strokeDasharray={dashed ? '3 4' : undefined} />
            <path d={`M${x1 - 4} ${y1 - 4} L${x1} ${y1} L${x1 - 4} ${y1 + 4}`} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        );
      })}
    </svg>
  );
}

function Chip({ chip, index }: { chip: FlowChip; index: number }): JSX.Element {
  const ring = chip.problem === 'bad' ? 'hsl(var(--bad) / .8)' : chip.problem === 'warn' ? 'hsl(var(--warn) / .75)' : 'hsl(var(--hairline))';
  return (
    <div
      className="cds-relation-chip-in flex w-full items-center gap-2.5 rounded-[0.75rem] bg-background pl-2.5 pr-3 shadow-[0_1px_2px_rgb(0_0_0/.25)] transition-colors duration-150"
      style={{ height: ROW_H, border: `1.5px ${chip.inferred ? 'dashed' : 'solid'} ${ring}`, animationDelay: `${index * 40}ms` }}
      data-node={chip.id}
      data-kind={chip.kind}
      data-problem={chip.problem}
      title={chip.problemCount ? `${chip.name} · ${chip.problemCount} 个问题` : chip.name}
    >
      <span className="inline-flex h-[1.625rem] w-[1.625rem] shrink-0 items-center justify-center rounded-[0.4rem] text-[0.66rem] font-extrabold tracking-wide text-primary-foreground" style={{ background: `hsl(var(${KIND_TOKEN[chip.kind]}))` }}>{KIND_LABEL[chip.kind]}</span>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="truncate text-[0.92rem] font-bold leading-tight">{chip.name}</div>
        <div className="mt-0.5 truncate text-[0.77rem] leading-tight text-muted-foreground">{chip.sub}</div>
      </div>
      {chip.problemCount ? (
        <span className={`inline-flex h-[1.125rem] shrink-0 items-center rounded-full border px-1.5 text-[0.66rem] font-semibold ${chip.problem === 'bad' ? 'border-destructive/60 text-destructive' : 'border-warn/60 bg-warn-soft text-warn'}`}>{chip.problemCount} 问题</span>
      ) : null}
    </div>
  );
}

/**
 * 一列 chip。宽度是「基准宽 width，容器有富余时按比例长到 1.6 倍」：宽抽屉里流向条撑满整条，
 * 不再两侧各留一大片点阵空白（2026-09-20 用户截图：三枚 chip 缩在中间，左右各空 200px）。
 * 装不下时不收缩（flex-shrink 0），由外层横向滚动接住——连接器几何仍按列高逐像素对齐。
 */
function Column({ chips, width, offset = 0 }: { chips: FlowChip[]; width: number; offset?: number }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col justify-center" style={{ gap: ROW_GAP, flex: `1 1 ${width}px`, minWidth: width, maxWidth: Math.round(width * 1.6) }}>
      {chips.map((c, i) => <Chip key={c.id} chip={c} index={offset + i} />)}
    </div>
  );
}

const W = { entry: 280, shell: 236, member: 236, infra: 176, ext: 248, conn: 56 } as const;
/** 窄容器（< FLOW_NARROW_PX）下的一档：列折成计数 chip 之外，每枚 chip 与连接器也收窄 */
const W_NARROW = { entry: 176, shell: 200, member: 200, infra: 164, ext: 200, conn: 42 } as const;

/** 流向条本体。SSR / 首帧按宽版渲染，量到容器宽度后再决定要不要折叠。 */
export function RelationFlowStrip({ model, className }: { model: FlowModel; className?: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth > 0 && el.clientWidth < FLOW_NARROW_PX));
    ro.observe(el);
    setNarrow(el.clientWidth > 0 && el.clientWidth < FLOW_NARROW_PX);
    return () => ro.disconnect();
  }, []);

  const w = narrow ? W_NARROW : W;
  const tailW = model.tail.some((c) => c.kind === 'ext') ? w.ext : w.infra;
  const members = narrow && model.members.length > 1
    ? [{ id: 'members', kind: 'api' as FlowKind, name: `${model.members.length} 个服务`, sub: '前缀成员与内网服务 · 点开看全图', problem: model.members.find((c) => c.problem === 'bad')?.problem ?? model.members.find((c) => c.problem === 'warn')?.problem, problemCount: model.members.reduce((s, c) => s + (c.problemCount ?? 0), 0) || undefined }]
    : model.members;
  const tail = narrow && model.tail.length > 1
    ? [{ id: 'tail', kind: (model.tail.every((c) => c.kind === 'ext') ? 'ext' : 'db') as FlowKind, name: `${model.tail.length} 个共享 / 外部`, sub: '基础设施与跨项目引用', problem: model.tail.find((c) => c.problem)?.problem }]
    : model.tail;
  const shellLinks = narrow && model.members.length > 1 ? (model.shellLinks.length ? [{ from: 0, to: 0, kind: 'prefix' as const }] : []) : model.shellLinks;
  const tailLinks = narrow && (model.members.length > 1 || model.tail.length > 1)
    ? (model.tailLinks.length ? [{ from: 0, to: 0, kind: model.tailLinks.some((l) => l.kind === 'broken') ? 'broken' as const : 'call' as const }] : [])
    : model.tailLinks;
  const inferredMembers = new Set(members.map((c, i) => (c.inferred ? i : -1)).filter((i) => i >= 0));

  return (
    <div
      ref={hostRef}
      className={`overflow-x-auto rounded-[0.75rem] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-4 ${className ?? ''}`}
      style={{ backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}
      data-testid="relation-strip"
      data-narrow={narrow ? 'true' : undefined}
    >
      {/* 内层 w-full + min-w-max：装得下就按比例撑满（列会长到 1.6 倍基准宽），装不下就保持 max-content 横向滚动——
          justify-center 配 overflow 会把左端裁掉、还滚不回来，所以居中靠 mx-auto 而不是 justify */}
      <div className="mx-auto flex w-full min-w-max items-center justify-center">
        <Column chips={[model.entry]} width={w.entry} />
        <Connector links={[{ from: 0, to: 0, kind: 'prefix' }]} leftRows={1} rightRows={model.shells.length} width={w.conn} />
        <Column chips={model.shells} width={w.shell} offset={1} />
        {members.length > 0 ? (
          <>
            <Connector links={shellLinks} leftRows={model.shells.length} rightRows={members.length} dashedFrom={inferredMembers} width={w.conn} />
            <Column chips={members} width={w.member} offset={1 + model.shells.length} />
          </>
        ) : null}
        {tail.length > 0 ? (
          <>
            <Connector links={tailLinks} leftRows={Math.max(1, members.length)} rightRows={tail.length} width={w.conn} />
            <Column chips={tail} width={tailW} offset={1 + model.shells.length + members.length} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** 加载 / 失败态用同一副骨架：卡片不会在算完那一刻突然长出 200px，把下面的入口卡顶跑。 */
export function RelationFlowSkeleton({ note, tone = 'muted' }: { note: string; tone?: 'muted' | 'bad' }): JSX.Element {
  const ghost = (w: number, i: number) => <div key={i} className="min-w-0 flex-1 rounded-[0.75rem] border border-[hsl(var(--hairline))] bg-background/60 motion-safe:animate-pulse" style={{ maxWidth: w, height: ROW_H, animationDelay: `${i * 120}ms` }} />;
  return (
    <div className="relative flex items-center justify-center gap-8 overflow-hidden rounded-[0.75rem] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-4" data-testid="relation-strip-skeleton">
      {[W.entry, W.shell, W.member, W.infra].map((w, i) => ghost(w, i))}
      <div className={`absolute inset-x-0 bottom-1.5 text-center text-[0.8125rem] ${tone === 'bad' ? 'text-destructive' : 'text-muted-foreground'}`}>{note}</div>
    </div>
  );
}
