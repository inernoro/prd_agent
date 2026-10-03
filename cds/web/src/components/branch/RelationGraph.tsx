/*
 * RelationGraph — 只读的服务关系图（plan.cds.service-relations 第四批）。
 *
 * 数据来自 GET /api/branches/:id/service-graph（服务图 + 体检 + 引用），与运行画布同一份分层：
 * 入口 → 站点框（壳在上、前缀成员在下、内网服务紧贴调用方）→ 外部项目框（跨项目引用）→ 共享基础设施。
 * 运行画布是操作面（副本、权重、隔离），这张图是决策面：只画关系与问题，不承载操作。
 * compact 模式给总览缩略卡用：同一套布局按比例缩小，不另画一份。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { edgePath, frameLabels, layoutRelations, type EdgeKind, type Pos } from './relationLayout';

export type RoleView = 'web' | 'api' | 'worker';
export interface GraphNodeView { id: string; rawId?: string; name: string; kind: 'service' | 'infra'; pathPrefixes?: string[]; subdomain?: string; dockerImage?: string; role?: RoleView; roleSource?: string; roleReason?: string }
export interface GraphEdgeView { from: string; to: string; envKeys: string[]; dependsOn: boolean; declared?: boolean }
export interface GraphSiteView { id: string; kind: 'main' | 'subdomain'; subdomain?: string; shellId?: string; shellSource?: string; members: Array<{ id: string; prefixes: string[]; viaConvention?: boolean }>; conflicts: Array<{ prefix: string; ids: string[] }> }
export interface ServiceGraphView { nodes: GraphNodeView[]; edges: GraphEdgeView[]; layers: string[][]; sites: GraphSiteView[]; internal: string[] }
export interface LintFindingView { rule: string; severity: 'error' | 'warn' | 'info'; services: string[]; message: string; fix: string }
export interface ReferenceView { profileId: string; key: string; kind: 'cds-ref' | 'url' | 'name-hint' | 'platform'; resolved?: Array<{ url: string | null; status: string; target: { projectId?: string; projectSlug?: string; branchId?: string; branchName?: string; serviceId: string }; ref: { projectRef: string; serviceId: string; branchRef?: string } }>; matchedBranch?: { branchId: string; projectId: string; branchName: string; status: string } | null }
export interface RelationPayload { branchId: string; projectId: string; branch: string; status?: string; graph: ServiceGraphView; lint: { findings: LintFindingView[]; summary: { errors: number; warnings: number; infos: number } }; references: ReferenceView[] }

export { layoutRelations, edgePath, frameLabels } from './relationLayout';
export type { RelationLayout, LayoutEdge } from './relationLayout';

const ROLE_LABEL: Record<RoleView, string> = { web: 'WEB', api: 'API', worker: 'JOB' };
// 颜色只许走主题 token（cds-theme-tokens）：这里存 token 名，用到时包 hsl(var(...))，双主题各自成立
const ROLE_TOKEN: Record<RoleView, string> = { web: '--badge-web', api: '--badge-api', worker: '--badge-job' };
const tone = (token: string, alpha?: number): string => (alpha === undefined ? `hsl(var(${token}))` : `hsl(var(${token}) / ${alpha})`);
const svc = (id: string): string => id.replace(/^service:/, '');

// 线型有语义：声明的关系一律实线，只有「按名推断」才画虚线（`inferred`）。
// 此前六种线全是虚线，整张图读起来像草稿——那正是「第一眼不专业」的来源之一。
const EDGE_STYLE: Record<EdgeKind, { stroke: string; width: number; marker?: boolean }> = {
  entry: { stroke: 'hsl(var(--hairline-strong))', width: 1.5, marker: true },
  prefix: { stroke: 'hsl(var(--hairline-strong))', width: 1.5, marker: true },
  call: { stroke: 'hsl(var(--graph-call))', width: 1.6, marker: true },
  ref: { stroke: 'hsl(var(--info))', width: 1.5, marker: true },
  broken: { stroke: 'hsl(var(--bad))', width: 1.6, marker: true },
  infra: { stroke: 'hsl(var(--graph-call))', width: 1.3, marker: true },
};
const INFERRED_DASH = '3 4';

const CHIP_SHADOW = '0 1px 2px hsl(0 0% 0% / .18)';
/** 卡片外框：与设计稿同一副——圆角 12、1.5px 发丝边，出问题时描成语义色 */
const chipBox = (p: Pos, ring?: string): CSSProperties => ({ position: 'absolute', left: p.x, top: p.y, width: p.w, height: p.h, boxSizing: 'border-box', borderRadius: 12, border: `1.5px solid ${ring ?? 'hsl(var(--hairline))'}`, boxShadow: CHIP_SHADOW, display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px 0 10px', transition: 'opacity 150ms, box-shadow 150ms' });

/** 卡片内容：徽标 / 名称（+ 旁注）/ 第二行（前缀用等宽）/ 问题数。入口、服务、外部引用共用这一份。 */
function NodeBody({ compact, badge, badgeBg, badgeInferred, badgeTitle, name, nameTitle, note, sub, mono, pill }: { compact: boolean; badge: string; badgeBg: string; badgeInferred?: boolean; badgeTitle?: string; name: string; nameTitle?: string; note?: string; sub: string; mono?: boolean; pill?: { text: string; tone: 'warn' | 'bad' | 'ok'; title?: string } }): JSX.Element {
  const size = compact ? 22 : 26;
  const pillCls = pill?.tone === 'bad' ? 'border-destructive/60 text-bad' : pill?.tone === 'ok' ? 'border-ok/50 bg-ok-soft text-[hsl(var(--ok-ink))]' : 'border-warn/60 bg-warn-soft text-[hsl(var(--warn-ink))]';
  return (
    <>
      <span className={`inline-flex shrink-0 items-center justify-center font-extrabold tracking-wide ${badgeInferred ? 'border border-dashed' : ''}`} style={{ width: size, height: size, borderRadius: compact ? 6 : 7, fontSize: compact ? 8 : 9, background: badgeBg, color: 'hsl(var(--badge-ink))', borderColor: badgeInferred ? 'hsl(var(--badge-ink) / .6)' : undefined }} title={badgeTitle}>{badge}</span>
      <span className="flex min-w-0 flex-1 flex-col" style={{ gap: compact ? 2 : 3 }}>
        {/* 名字独占第一行：旁注（「同一服务」）与问题数都放到第二行，宽屏下名字不被截（relation-visual-audit S5） */}
        <span className="truncate font-semibold leading-tight text-foreground" style={{ fontSize: compact ? 13 : 14 }} title={nameTitle ?? name} data-node-name>{name}</span>
        {/* 问题数放在第二行右侧：和名字挤在第一行时，宽屏下名字也会被截（2026-10-03 relation-visual-audit S5） */}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={`min-w-0 flex-1 truncate leading-tight text-muted-foreground ${mono ? 'font-mono' : ''}`} style={{ fontSize: mono ? (compact ? 10.5 : 11) : (compact ? 11 : 11.5) }} title={note ? `${note} · ${sub}` : sub}>{note ? <span className="font-sans">{note} · </span> : null}{sub}</span>
          {pill ? <span className={`inline-flex shrink-0 items-center rounded-full border font-semibold ${pillCls}`} style={{ height: 16, padding: '0 5px', fontSize: 10 }} title={pill.title}>{pill.text}</span> : null}
        </span>
      </span>
    </>
  );
}

export function RelationGraph({ payload, compact = false, highlight, className, style, entryHost, hideLegend = false }: { payload: RelationPayload; compact?: boolean; /** 图例由外层底栏承担时关掉浮层图例 */ hideLegend?: boolean; /** 悬停问题卡时点亮的服务（一条问题可能涉及多个服务） */ highlight?: string | string[] | null; className?: string; style?: CSSProperties; /** 入口卡第二行写的域名；没有就写分支名 */ entryHost?: string }): JSX.Element {
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
            // 标题与说明的文案、截断与占位和判据 G7 用的是同一个函数，量的就是画出来的这一份
            const lb = frameLabels(f, entryHost, layout.compact);
            return (
              <g key={f.key} data-frame={f.key}>
                <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={14} fill={f.tone === 'external' ? 'hsl(var(--info-soft))' : 'hsl(var(--surface-raised))'} fillOpacity={f.tone === 'external' ? 0.5 : 0.4}
                  stroke={f.tone === 'external' ? 'hsl(var(--info) / .5)' : 'hsl(var(--hairline))'} strokeWidth="1" />
                <text x={lb.titleRect.x} y={lb.ty} fontSize={layout.compact ? 11.5 : 12} fontWeight="650" fill="hsl(var(--foreground-muted))" data-frame-title={f.key}>{lb.title}</text>
                {lb.sub && lb.subRect ? <text x={lb.subRect.x + lb.subRect.w} y={lb.ty} fontSize={layout.compact ? 11 : 11.5} textAnchor="end" fill="hsl(var(--muted-foreground))" data-frame-sub={f.key}>{lb.sub}</text> : null}
              </g>
            );
          })}
          {layout.edges.map((e) => {
            const st = EDGE_STYLE[e.kind];
            // 线上不挂字：字会压住卡片和别的线（判据 G6 / G7 管不到字），环境变量名放到悬停提示里
            const tip = e.kind === 'prefix' ? `前缀 ${e.label ?? ''}${e.alsoDepends ? ' · 同时声明了依赖' : ''}` : e.label;
            return (
              <g key={e.key} opacity={dim(lit.size === 0 || edgeTouches(e.key))} data-edge={e.key} data-edge-kind={e.kind}>
                {tip ? <title>{tip}</title> : null}
                {/* 外层 svg 是 pointerEvents:none（不挡卡片），提示要靠这条透明的宽命中线才悬停得到；
                    线本身只有 1.5px，直接拿它当命中区几乎点不中（Codex P2，PR #1654） */}
                {tip ? <path d={edgePath(e)} fill="none" stroke="transparent" strokeWidth={10} style={{ pointerEvents: 'stroke', cursor: 'help' }} data-edge-hit="" /> : null}
                <path d={edgePath(e)} fill="none" stroke={st.stroke} strokeWidth={st.width} strokeDasharray={e.inferred ? INFERRED_DASH : undefined} strokeLinejoin="round" opacity="0.9" markerEnd={st.marker ? (e.kind === 'broken' ? 'url(#rgArrBad)' : e.kind === 'call' || e.kind === 'infra' ? 'url(#rgArrCall)' : e.kind === 'ref' ? 'url(#rgArrRef)' : 'url(#rgArr)') : undefined} />
              </g>
            );
          })}
        </svg>
        <div className="bg-background" data-node="entry" style={{ ...chipBox(layout.entry), opacity: dim(lit.size === 0) }}>
          <NodeBody compact={layout.compact} badge="GW" badgeBg={tone('--badge-gw')} name="入口" sub={entryHost ?? `分支 ${payload.branch}`} mono={Boolean(entryHost)} />
        </div>
        {Array.from(layout.pos.entries()).map(([id, p]) => {
          const realId = layout.aliasOf.get(id) ?? id;
          const n = nodeById.get(realId);
          if (!n) return null;
          const isInfra = n.kind === 'infra';
          const role = n.role ?? 'api';
          const bad = findingsOf(realId);
          const isErr = bad.some((f) => f.severity === 'error');
          const glow = lit.has(realId);
          // 基础设施徽标不占语义色：redis 不用 --bad（红色只在「坏了」时出现）、mongo 不用 --ok
          const token = isInfra ? (/redis/i.test(n.dockerImage || n.id) ? '--badge-r' : '--badge-db') : ROLE_TOKEN[role];
          const override = layout.subOf.get(id);
          const prefixes = (n.pathPrefixes ?? []).join(' · ');
          const sub = isInfra ? '共享实例 · 所有分支共用' : override ?? (prefixes || (n.subdomain ? `子域 ${n.subdomain}` : '内网 · 不对外'));
          return (
            <div key={id} className="bg-background" data-node={id} data-role={isInfra ? 'infra' : role}
              style={{ ...chipBox(p, bad.length ? (isErr ? 'hsl(var(--bad) / .75)' : 'hsl(var(--warn) / .78)') : undefined), boxShadow: glow ? `0 0 0 4px ${isErr ? 'hsl(var(--bad) / .28)' : 'hsl(var(--warn) / .28)'}` : CHIP_SHADOW, opacity: dim(lit.size === 0 || glow) }}>
              <NodeBody compact={layout.compact} badge={isInfra ? (/redis/i.test(n.dockerImage || n.id) ? 'R' : 'DB') : ROLE_LABEL[role]} badgeBg={tone(token)} badgeInferred={!isInfra && Boolean(n.roleSource) && n.roleSource !== 'declared'} badgeTitle={n.roleReason}
                name={n.name || realId} nameTitle={realId} note={id !== realId ? '同一服务' : undefined} sub={sub} mono={!isInfra && !override && Boolean(prefixes)}
                pill={bad.length > 0 ? { text: layout.compact ? String(bad.length) : `${bad.length} 问题`, tone: isErr ? 'bad' : 'warn', title: bad.map((f) => f.message).join('\n') } : undefined} />
            </div>
          );
        })}
        {layout.externals.map((e) => (
          <div key={e.id} className="bg-background" data-node={e.id} style={{ ...chipBox(e.pos, e.broken ? 'hsl(var(--bad) / .75)' : 'hsl(var(--info) / .55)'), opacity: dim(lit.size === 0) }}>
            <NodeBody compact={layout.compact} badge="EXT" badgeBg={tone('--badge-ext')} name={e.label} sub={e.sub}
              pill={{ text: e.broken ? (e.status === 'stopped' ? '已停止' : '断裂') : '可达', tone: e.broken ? 'bad' : 'ok' }} />
          </div>
        ))}
      </div>
      {!compact && !hideLegend ? <RelationLegend className="cds-surface-raised cds-hairline sticky bottom-2 left-2 mt-2 inline-flex max-w-[calc(100%-1rem)] rounded-md px-3 py-1.5" /> : null}
    </div>
  );
}

/** 图例：展开视图与全屏页放在底栏（设计稿 02），独立使用 RelationGraph 时浮在图左下。每一项自己不换行，整行按项折行 */
export function RelationLegend({ className }: { className?: string }): JSX.Element {
  return (
    <div className={`flex-wrap items-center gap-x-5 gap-y-1 text-[0.75rem] text-muted-foreground ${className ?? 'flex'}`} data-testid="relation-legend">
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg width="22" height="6" aria-hidden><path d="M0 3H22" stroke="hsl(var(--hairline-strong))" strokeWidth="1.5" /></svg>声明的关系</span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg width="22" height="6" aria-hidden><path d="M0 3H22" stroke="hsl(var(--hairline-strong))" strokeWidth="1.5" strokeDasharray={INFERRED_DASH} /></svg>按名推断</span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg width="22" height="6" aria-hidden><path d="M0 3H22" stroke={tone('--graph-call')} strokeWidth="1.5" /></svg>环境变量引用 / 调用</span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg width="22" height="6" aria-hidden><path d="M0 3H22" stroke="hsl(var(--info))" strokeWidth="1.5" /></svg>跨项目引用</span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><svg width="22" height="6" aria-hidden><path d="M0 3H22" stroke="hsl(var(--bad))" strokeWidth="1.5" /></svg>断裂</span>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><span className="inline-block h-3 w-3 rounded-[3px] border border-dashed border-foreground-muted" aria-hidden />角色是推断的</span>
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
