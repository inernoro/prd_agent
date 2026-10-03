/*
 * RelationFlowStrip — 关系缩略卡里的「流向条」（plan.cds.service-relations 第五批）。
 *
 * 为什么不再画缩略版的二维分层图：那张图完整布局约 516px 高，缩略卡只有 180px，
 * 而缩放只按宽度算，宽屏上根本不缩——于是只露出「入口」和主域名框的上沿，文案说
 * 「2 个服务挂在壳下面」，图里一个都没有（2026-09-16 用户：「第一眼就很一般」）。
 *
 * 缩略态换一种读法：从左到右一行读完，入口 → 壳 → 前缀成员 → 共享基础设施 / 外部引用。
 * 只有一个壳的子域另起一条泳道排成网格（2026-09-30：8 个子域壳曾和主域名壳挤在同一列，
 * 流向条被拉到 600px 高，入口悬在中间、左侧整片空白）。
 * 前缀写在节点里，线上不挂标签；灰实线 = 域名与前缀分流，紫实线 = 环境变量引用 / 调用，
 * 蓝 = 跨项目引用，红 = 断裂；虚线只留给「按名推断」。出问题的节点自己描边并挂「N 问题」。
 *
 * `layoutFlow` 是纯函数（守卫测试直接断言它列全了每个服务），渲染层只负责摆放与连线。
 * 容器放不下横排时改竖排（成员挂在壳下的竖线上），任何宽度都不裁、不折叠成员。
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
  /** 壳列：主域名壳在前，带前缀成员的子域壳随后；主域名没有壳时是一枚灰 chip */
  shells: FlowChip[];
  /** 子域泳道：只有一个壳、下面没有成员的子域，一格一站。同一服务同时是主域名成员时两处都画 */
  subsites: FlowChip[];
  /** 成员列：主域名前缀成员在前，其余（内网 / 游离）服务随后 */
  members: FlowChip[];
  /** 壳列 → 成员列：只有前缀成员有线 */
  shellLinks: FlowLink[];
  /** 尾列：共享基础设施 + 跨项目引用 */
  tail: FlowChip[];
  /** 成员列 → 尾列 */
  tailLinks: FlowLink[];
  facts: { sites: number; services: number; prefixes: number; subdomains: number; infra: number; refs: number; errors: number; warnings: number };
}

const ROLE_KIND: Record<RoleView, FlowKind> = { web: 'web', api: 'api', worker: 'job' };
const KIND_LABEL: Record<FlowKind, string> = { gw: 'GW', web: 'WEB', api: 'API', job: 'JOB', db: 'DB', r: 'R', ext: 'EXT' };
// 颜色只许走主题 token（cds-theme-tokens）：redis 不再用 --bad——红色只在「坏了」时出现，
// 否则节点真出了问题，红描边和红徽标会打架（2026-09-16 微调 1）。
const KIND_TOKEN: Record<FlowKind, string> = { gw: '--badge-gw', web: '--badge-web', api: '--badge-api', job: '--badge-job', db: '--badge-db', r: '--badge-r', ext: '--badge-ext' };

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
  const allSubs = graph.sites.filter((s) => s.kind === 'subdomain');
  const isSimpleSub = (s: (typeof allSubs)[number]): boolean => Boolean(s.shellId && nodeById.has(s.shellId)) && !s.members.some((m) => nodeById.has(m.id));
  const subs = allSubs.filter((s) => !isSimpleSub(s));
  const simpleSubs = allSubs.filter(isSimpleSub);
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
  const subsites: FlowChip[] = simpleSubs.map((s) => chipOf(s.shellId!, `子域 ${s.subdomain ?? ''}`));
  const inSubsite = new Set(simpleSubs.map((s) => s.shellId!));
  for (const n of nodes) {
    const id = n.rawId ?? svc(n.id);
    if (placed.has(id) || inSubsite.has(id)) continue;
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
    shells, subsites, members, shellLinks, tail, tailLinks,
    facts: { sites: graph.sites.length, services: nodes.length, prefixes, subdomains: allSubs.length, infra: graph.nodes.filter((n) => n.kind === 'infra').length, refs, errors: lint.summary.errors, warnings: lint.summary.warnings },
  };
}

/** 事实行：结论之下的一行数字，让人不点开就能核对这张图值不值得看。 */
export function FlowFacts({ facts }: { facts: FlowModel['facts'] }): JSX.Element {
  const tone = facts.errors ? 'text-bad' : facts.warnings ? 'text-[hsl(var(--warn-ink))]' : 'text-[hsl(var(--ok-ink))]';
  // 为零的可选项不占位（没有子域 / 基础设施 / 跨项目引用就不写「0 个」），读起来只剩有信息的数字
  const items: Array<[number, string]> = [[facts.sites, '站点'], [facts.services, '服务'], [facts.prefixes, '前缀']];
  if (facts.subdomains) items.push([facts.subdomains, '子域']);
  if (facts.infra) items.push([facts.infra, '共享基础设施']);
  if (facts.refs) items.push([facts.refs, '跨项目引用']);
  const dot = <span aria-hidden className="h-[3px] w-[3px] rounded-full bg-[hsl(var(--hairline-strong))]" />;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem] text-muted-foreground" data-testid="relation-facts">
      {items.map(([n, label]) => <span key={label} className="inline-flex items-center gap-2.5 whitespace-nowrap"><span><b className="font-semibold text-foreground-muted">{n}</b> {label}</span>{dot}</span>)}
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
      <span className="inline-flex h-[1.625rem] w-[1.625rem] shrink-0 items-center justify-center rounded-[0.4rem] text-[0.66rem] font-extrabold tracking-wide" style={{ background: `hsl(var(${KIND_TOKEN[chip.kind]}))`, color: 'hsl(var(--badge-ink))' }}>{KIND_LABEL[chip.kind]}</span>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="truncate text-[0.92rem] font-bold leading-tight">{chip.name}</div>
        <div className="mt-0.5 truncate text-[0.77rem] leading-tight text-muted-foreground">{chip.sub}</div>
      </div>
      {chip.problemCount ? (
        <span className={`inline-flex h-[1.125rem] shrink-0 items-center rounded-full border px-1.5 text-[0.66rem] font-semibold ${chip.problem === 'bad' ? 'border-destructive/60 text-bad' : 'border-warn/60 bg-warn-soft text-[hsl(var(--warn-ink))]'}`}>{chip.problemCount} 问题</span>
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
/** 泳道左右内边距 + 边框（px-4 在 85% 根字号下约 27px，再加 2px 边框，留余量取 32） */
const LANE_CHROME = 32;
/** 横排时整行至少要多宽（各列基准宽 + 连接器）。容器比这窄就改竖排，不再横向滚动或裁掉一截 */
export function flowRowMin(model: FlowModel): number {
  const tailW = model.tail.some((c) => c.kind === 'ext') ? W.ext : W.infra;
  return W.entry + W.conn + W.shell + (model.members.length > 0 ? W.conn + W.member : 0) + (model.tail.length > 0 ? W.conn + tailW : 0);
}

/**
 * 流向条本体。两种排法，按容器实际宽度选：
 * - 横排：入口 → 壳 → 前缀成员 → 共享 / 外部，一行读完；
 * - 竖排：容器放不下横排时，入口、壳在上，成员挂在壳下的竖线上，共享 / 外部排在最后。
 * 此前还有一档「窄横排」：把成员折成一枚「N 个服务」，名字全看不到，而且在 1440 宽的屏幕上照样被裁掉一截
 * （2026-10-03 relation-visual-audit C1：内容 1123 / 可见 884）。竖排把每个成员都列出来，任何宽度都不裁。
 * SSR / 首帧按横排渲染，量到容器宽度后再决定。
 */
export function RelationFlowStrip({ model, className }: { model: FlowModel; className?: string }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const rowMin = flowRowMin(model);
  const [stacked, setStacked] = useState(false);
  useEffect(() => {
    const el = hostRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = (): void => setStacked(el.clientWidth > 0 && el.clientWidth < rowMin + LANE_CHROME);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [rowMin]);

  const tailW = model.tail.some((c) => c.kind === 'ext') ? W.ext : W.infra;
  const inferredMembers = new Set(model.members.map((c, i) => (c.inferred ? i : -1)).filter((i) => i >= 0));
  const head = <LaneHead title={`主域名${model.entry.name.includes('.') ? ` · ${model.entry.name}` : ''}`} note="壳承接 /，其余按前缀分流" mono={model.entry.name.includes('.')} />;
  const laneCls = 'rounded-[0.75rem] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 pb-4 pt-3.5';
  const laneStyle = { backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' };

  const flow = stacked ? (
    <div className={laneCls} style={laneStyle} data-testid="relation-strip-main">
      {head}
      <StackedFlow model={model} />
    </div>
  ) : (
    <div className={`overflow-x-auto ${laneCls}`} style={laneStyle} data-testid="relation-strip-main">
      {head}
      {/* 内层 w-full + 显式最小宽：装得下就按比例撑满（列会长到 1.6 倍基准宽）。justify-center 配 overflow 会把左端裁掉，所以居中靠 mx-auto */}
      <div className="mx-auto flex w-full items-center justify-center" style={{ minWidth: rowMin }}>
        <Column chips={[model.entry]} width={W.entry} />
        <Connector links={[{ from: 0, to: 0, kind: 'prefix' }]} leftRows={1} rightRows={model.shells.length} width={W.conn} />
        <Column chips={model.shells} width={W.shell} offset={1} />
        {model.members.length > 0 ? (
          <>
            <Connector links={model.shellLinks} leftRows={model.shells.length} rightRows={model.members.length} dashedFrom={inferredMembers} width={W.conn} />
            <Column chips={model.members} width={W.member} offset={1 + model.shells.length} />
          </>
        ) : null}
        {model.tail.length > 0 ? (
          <>
            <Connector links={model.tailLinks} leftRows={Math.max(1, model.members.length)} rightRows={model.tail.length} width={W.conn} />
            <Column chips={model.tail} width={tailW} offset={1 + model.shells.length + model.members.length} />
          </>
        ) : null}
      </div>
    </div>
  );

  return (
    <div ref={hostRef} className={`flex min-w-0 flex-col gap-2.5 ${className ?? ''}`} data-testid="relation-strip" data-mode={stacked ? 'stacked' : 'row'}>
      {flow}
      {model.subsites.length > 0 ? (
        /* 子域泳道：一格一站，按宽度自动排列数，不再把卡片拉高 */
        <div className="rounded-[0.75rem] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 py-3" data-testid="relation-strip-subsites">
          <LaneHead title={`子域 · ${model.subsites.length} 个`} note="每个子域整站归一个服务" />
          <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${stacked ? 200 : 236}px), 1fr))` }}>
            {model.subsites.map((c, i) => <Chip key={`${c.id}-${i}`} chip={c} index={1 + model.shells.length + model.members.length + model.tail.length + i} />)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 竖排的分组：每个壳只带它真正连着的成员（按 shellLinks 的 from / to），没有连线的成员单独成组。
 * 不能「所有成员都挂在第一个壳下」：内网服务、别的子域壳的成员会被画成主域名壳的前缀成员，
 * 连线表达的关系就是错的（Codex P1，PR #1654）。
 */
export function stackedGroups(model: FlowModel): { groups: Array<{ shell: FlowChip; members: FlowChip[] }>; loose: FlowChip[] } {
  const owner = new Map<number, number>();
  for (const l of model.shellLinks) if (!owner.has(l.to)) owner.set(l.to, l.from);
  const groups = model.shells.map((shell) => ({ shell, members: [] as FlowChip[] }));
  const loose: FlowChip[] = [];
  model.members.forEach((c, i) => {
    const from = owner.get(i);
    if (from !== undefined && groups[from]) groups[from].members.push(c);
    else loose.push(c);
  });
  return { groups, loose };
}

/** 竖排：入口在上；每个壳下面用竖线挂它自己的成员；没连在任何壳下的服务单列一组、不画连线；共享 / 外部在最后 */
function StackedFlow({ model }: { model: FlowModel }): JSX.Element {
  const line = 'bg-[hsl(var(--hairline-strong))]';
  const { groups, loose } = stackedGroups(model);
  let n = 0;
  const grid = (chips: FlowChip[], min: number) => (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${min}px), 1fr))` }}>{chips.map((c) => <Chip key={c.id} chip={c} index={n++} />)}</div>
  );
  return (
    <div className="flex min-w-0 flex-col" data-testid="relation-strip-stacked">
      <Chip chip={model.entry} index={n++} />
      {groups.map(({ shell, members }) => (
        <div key={shell.id} className="flex min-w-0 flex-col" data-stack-group={shell.id}>
          <span aria-hidden className={`ml-[1.375rem] h-3 w-px ${line}`} />
          <Chip chip={shell} index={n++} />
          {members.length > 0 ? (
            <div className="flex min-w-0 flex-col pt-2.5">
              {members.map((c, i) => {
                const last = i === members.length - 1;
                return (
                  <div key={c.id} className="relative pb-2.5 pl-10 last:pb-0" data-tree-member={c.id}>
                    {/* 竖线：从上一行延续下来，最后一个成员只画到自己中线 */}
                    <span aria-hidden className={`absolute left-[1.375rem] top-[-0.625rem] w-px ${line}`} style={{ height: last ? 'calc(50% + 0.625rem)' : 'calc(100% + 0.625rem)' }} />
                    <span aria-hidden className={`absolute left-[1.375rem] top-1/2 h-px w-[1.125rem] ${line} ${c.inferred ? 'opacity-60' : ''}`} />
                    <Chip chip={c} index={n++} />
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ))}
      {loose.length > 0 ? (
        <div className="mt-3 border-t border-dashed border-[hsl(var(--hairline))] pt-3" data-testid="relation-strip-loose">
          <div className="mb-2 text-[0.75rem] text-muted-foreground">其它服务（内网服务，或没有挂在任何壳下）</div>
          {grid(loose, 200)}
        </div>
      ) : null}
      {model.tail.length > 0 ? (
        <div className="mt-3 border-t border-dashed border-[hsl(var(--hairline))] pt-3">
          <div className="mb-2 text-[0.75rem] text-muted-foreground">共享基础设施与跨项目引用</div>
          {grid(model.tail, 160)}
        </div>
      ) : null}
    </div>
  );
}

function LaneHead({ title, note, mono }: { title: string; note: string; /** 标题里带域名时，域名那段用等宽 */ mono?: boolean }): JSX.Element {
  const [head, ...rest] = title.split(' · ');
  return (
    <div className="mb-3 flex min-w-0 items-baseline justify-between gap-4 text-[0.75rem] text-muted-foreground">
      <span className="min-w-0 truncate font-semibold text-foreground-muted" title={title}>{head}{rest.length ? <> · <span className={mono ? 'font-mono font-medium' : ''}>{rest.join(' · ')}</span></> : null}</span>
      <span className="hidden shrink-0 sm:inline">{note}</span>
    </div>
  );
}

/** 加载 / 失败态用同一副骨架：卡片不会在算完那一刻突然长出 200px，把下面的入口卡顶跑。 */
export function RelationFlowSkeleton({ note, tone = 'muted' }: { note: string; tone?: 'muted' | 'bad' }): JSX.Element {
  const ghost = (w: number, i: number) => <div key={i} className="min-w-0 flex-1 rounded-[0.75rem] border border-[hsl(var(--hairline))] bg-background/60 motion-safe:animate-pulse" style={{ maxWidth: w, height: ROW_H, animationDelay: `${i * 120}ms` }} />;
  return (
    <div className="relative flex flex-col overflow-hidden rounded-[0.75rem] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-4 pb-4 pt-3.5" data-testid="relation-strip-skeleton">
      {/* 与真实流向条同一副外形：一行泳道标题 + 一排 chip，数据到了只换内容不换高度 */}
      <div className="mb-3 h-[1.125rem] w-40 rounded bg-background/60 motion-safe:animate-pulse" />
      <div className="flex items-center justify-center gap-8">{[W.entry, W.shell, W.member, W.infra].map((w, i) => ghost(w, i))}</div>
      <div className={`absolute inset-x-0 bottom-1.5 text-center text-[0.8125rem] ${tone === 'bad' ? 'text-bad' : 'text-muted-foreground'}`}>{note}</div>
    </div>
  );
}
