import { MotionLink as Link, useSurfaceNavigate as useNavigate } from '@/components/layout/RouteMotion';
import { ContentLoading } from '@/components/skeletons/ContentLoading';
/*
 * OverviewPage — 「概览」菜单（plan.cds.service-relations 第四批）：全部项目的关系与体检。
 * 每个项目一张卡（代表分支、体检结论、服务构成），卡之间画跨项目引用边，右侧按严重度列需要处理的事项。
 * 数据：GET /api/overview/topology。
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useLocation } from 'react-router-dom';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { consoleAccountIdentity } from '@/lib/consoleIdentity';
import { rememberRelationReturn, overviewRelationRestoreForVisit, consumeRelationRestore } from '@/lib/relationReturn';
import { RefreshCw } from 'lucide-react';
import { AppShell, ConsoleAuthContext, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { userErrorMessage } from '@/lib/userErrorMessage';
import { createLatestWinsGate } from '@/lib/latest-wins';
import { apiRequest } from '@/lib/api';

interface OverviewProject {
  projectId: string; slug: string; name: string;
  branch: { id: string; name: string; status: string } | null;
  branchCount: number;
  counts: { services: number; sites: number; apis: number; webs: number; workers: number };
  lint: { errors: number; warnings: number; infos: number };
  headline: string;
  findings: Array<{ rule: string; severity: 'error' | 'warn' | 'info'; services: string[]; message: string; fix: string }>;
  edges: Array<{ toProjectId: string; toBranchName?: string; kind: 'cds-ref' | 'url'; status: string; fromService: string; key: string }>;
  inboundEdges: number;
}
interface OverviewResponse { generatedAt: string; summary: { errors: number; warnings: number; infos: number }; projects: OverviewProject[] }

const CARD_W = 360, CARD_H = 190, COL_GAP = 220, ROW_GAP = 40;

export function OverviewPage(): JSX.Element {
  const location = useLocation(), navigate = useNavigate();
  const auth = useContext(ConsoleAuthContext);
  const relationActor = auth.pending ? null : consoleAccountIdentity(auth.status);
  const relationRestore = useMemo(() => overviewRelationRestoreForVisit(relationActor, location.key, window.history.state?.idx), [relationActor, location.key]);
  const appliedRestore = useRef<string | null>(null);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ok'; data: OverviewResponse } | { status: 'error'; message: string }>({ status: 'loading' });
  const [refreshError, setRefreshError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const readGate = useRef(createLatestWinsGate());
  const [onlyProblems, setOnlyProblems] = useState(() => relationRestore?.task.onlyProblems ?? false);
  useEffect(() => {
    if (!relationRestore || appliedRestore.current === relationRestore.token) return;
    appliedRestore.current = relationRestore.token;
    setOnlyProblems(relationRestore.task.onlyProblems); consumeRelationRestore(relationRestore.token);
  }, [relationRestore]);
  const openRelations = (event: ReactMouseEvent<HTMLAnchorElement>, project: OverviewProject) => {
    if (!project.branch || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const token = rememberRelationReturn({ kind: 'overview', branchId: project.branch.id, projectId: project.projectId, onlyProblems }, relationActor, location.key, window.history.state?.idx);
    navigate(`/branch-relations/${encodeURIComponent(project.branch.id)}`, { state: token ? { relationReturn: token } : undefined });
  };
  const graphRoot = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const cardWidth = canvasWidth ? Math.min(CARD_W, Math.max(240, canvasWidth - 32)) : CARD_W;
  const canvasInset = canvasWidth && canvasWidth < 440 ? 16 : 40;
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const load = useCallback(async () => {
    const ticket = readGate.current.begin();
    setRefreshing(true);
    try {
      const data = await apiRequest<OverviewResponse>('/api/overview/topology');
      if (!readGate.current.accept(ticket)) return;
      setState({ status: 'ok', data }); setRefreshError(''); setRefreshing(false);
    } catch (err) {
      if (!readGate.current.accept(ticket)) return;
      const message = userErrorMessage(err);
      setRefreshError(message);
      setState(current => current.status === 'ok' ? current : { status: 'error', message });
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30_000); return () => { readGate.current.newSession(); clearInterval(t); }; }, [load]);

  const data = state.status === 'ok' ? state.data : null;
  // 布局：被引用多的项目靠右（被依赖方在右，引用方在左），同列从上到下
  const layout = useMemo(() => {
    if (!data) return null;
    const projects = onlyProblems ? data.projects.filter((p) => p.lint.errors || p.lint.warnings) : data.projects;
    const left = projects.filter((p) => p.inboundEdges === 0);
    const right = projects.filter((p) => p.inboundEdges > 0);
    const pos = new Map<string, { x: number; y: number }>();
    const placeColumn = (column: OverviewProject[], x: number) => {
      let y = canvasInset;
      for (const project of column) {
        pos.set(project.projectId, { x, y });
        y += Math.max(CARD_H, cardHeights[project.projectId] ?? 0) + ROW_GAP;
      }
      return y;
    };
    const height = Math.max(placeColumn(left, canvasInset), placeColumn(right, canvasInset + cardWidth + COL_GAP)) + canvasInset;
    const width = canvasInset * 2 + cardWidth * 2 + COL_GAP;
    return { projects, pos, width, height };
  }, [data, onlyProblems, cardHeights, cardWidth, canvasInset]);
  useLayoutEffect(() => {
    if (!graphRoot.current) return;
    const nodes = [...graphRoot.current.querySelectorAll<HTMLElement>('[data-project-id]')];
    const canvas = graphRoot.current.parentElement!;
    const measure = () => {
      const width = canvas.clientWidth;
      setCanvasWidth(previous => previous === width ? previous : width);
      setCardHeights(previous => {
        const next = Object.fromEntries(nodes.map(node => [node.dataset.projectId!, Math.ceil(node.getBoundingClientRect().height)]));
        return Object.keys(next).length === Object.keys(previous).length
          && Object.entries(next).every(([id, height]) => previous[id] === height) ? previous : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    nodes.forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [data, onlyProblems]);
  const problems = useMemo(() => {
    if (!data) return [];
    return data.projects.flatMap((p) => p.findings.map((f) => ({ ...f, project: p }))).filter((f) => f.severity !== 'info').sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));
  }, [data]);

  return (
    <AppShell
      active="overview"
      wide
      topbar={(
        <TopBar
          left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '概览' }]} />}
          right={(
            <>
              <PaletteHint />
              {data ? (
                <>
                  {refreshError ? <span className="text-sm text-muted-foreground">上次记录</span> : null}
                  <span className="inline-flex h-[1.125rem] items-center rounded-full border border-destructive/60 px-1.5 text-[0.625rem] font-semibold text-destructive">{data.summary.errors} 错误</span>
                  <span className="inline-flex h-[1.125rem] items-center rounded-full border border-warn/60 bg-warn-soft px-1.5 text-[0.625rem] font-semibold text-warn">{data.summary.warnings} 警告</span>
                </>
              ) : null}
              <Button variant={onlyProblems ? 'default' : 'outline'} size="sm" onClick={() => setOnlyProblems((v) => !v)}>只看问题</Button>
              <Button variant="outline" size="sm" disabled={refreshing} onClick={() => void load()}><RefreshCw className={refreshing ? 'animate-spin' : ''} />刷新</Button>
            </>
          )}
        />
      )}
    >
      <Workspace fluid className="cds-workspace--fill">
        {state.status === 'loading' ? <ContentLoading label="读取项目关系总览" variant="panel" /> : null}
        {state.status === 'error' ? <div className="p-6 text-xs text-destructive">读取失败：{state.message}</div> : null}
        {refreshError && data ? <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-sm text-warn"><p className="min-w-0 flex-1 basis-[15rem]">刷新失败：{refreshError}；当前为 {new Date(data.generatedAt).toLocaleString('zh-CN')} 的关系快照。</p><Button className="min-h-11" size="sm" variant="outline" disabled={refreshing} onClick={() => void load()}>重试读取</Button></div> : null}
        {data && layout?.projects.length === 0 ? <div className="mb-3 space-y-2 text-sm"><p>{onlyProblems ? '当前问题筛选没有匹配的项目。' : '还没有可展示的项目关系。'}</p>{onlyProblems ? <Button variant="outline" size="sm" onClick={() => setOnlyProblems(false)}>显示全部项目</Button> : null}</div> : null}
        {data && layout && layout.projects.length > 0 ? (
          <div className="flex min-h-0 flex-col gap-3 lg:h-full lg:flex-row" data-testid="overview-page">
            <div role="region" aria-label="跨项目关系画布" tabIndex={0} className="cds-surface-sunken cds-hairline relative h-[28rem] min-w-0 shrink-0 overflow-auto rounded-lg lg:h-auto lg:min-h-0 lg:flex-1" style={{ backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '1.625rem 1.625rem' }}>
              <div ref={graphRoot} style={{ position: 'relative', width: layout.width, height: layout.height }}>
                <svg width={layout.width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  <defs>
                    <marker id="ovArr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="hsl(var(--info))" /></marker>
                    <marker id="ovArrBad" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="hsl(var(--bad))" /></marker>
                  </defs>
                  {layout.projects.flatMap((p) => p.edges.map((e, i) => {
                    const a = layout.pos.get(p.projectId); const b = layout.pos.get(e.toProjectId);
                    if (!a || !b) return null;
                    const broken = e.status !== 'running';
                    const sx = a.x + cardWidth, sy = a.y + 40 + i * 14, tx = b.x, ty = b.y + 40 + (p.edges.length > 1 ? i * 14 : 0), mx = (sx + tx) / 2;
                    return (
                      <path key={`${p.projectId}-${e.toProjectId}-${e.key}`} d={`M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`} fill="none" stroke={broken ? 'hsl(var(--bad))' : 'hsl(var(--info))'} strokeWidth="1.5" strokeDasharray="4 4" opacity="0.85" markerEnd={broken ? 'url(#ovArrBad)' : 'url(#ovArr)'}>
                        <title>{`${p.slug} ${e.fromService} 的 ${e.key} → ${e.toBranchName ?? ''}（${e.kind === 'cds-ref' ? '引用变量' : '手写网址'} · 目标 ${e.status}）`}</title>
                      </path>
                    );
                  }))}
                </svg>
                {layout.projects.map((p) => {
                  const at = layout.pos.get(p.projectId)!;
                  const tone = p.lint.errors ? 'border-destructive/50' : p.lint.warnings ? 'border-warn/50' : 'border-[hsl(var(--hairline))]';
                  return (
                    <div key={p.projectId} className={`cds-surface-raised absolute rounded-xl border p-3 ${tone}`} style={{ left: at.x, top: at.y, width: cardWidth, minHeight: CARD_H }} data-project={p.slug} data-project-id={p.projectId}>
                      <div className="flex flex-wrap items-center gap-2 break-words [overflow-wrap:anywhere]">
                        <span className="max-w-full text-sm font-bold">{p.slug}</span>
                        <span className="min-w-0 max-w-full text-[0.6875rem] text-muted-foreground">{p.name !== p.slug ? `${p.name} · ` : ''}{p.branchCount} 个分支 · {p.counts.services} 个服务</span>
                        <span className="flex-1" />
                        {p.lint.errors ? <span className="inline-flex h-[1.125rem] items-center rounded-full border border-destructive/60 px-1.5 text-[0.625rem] font-semibold text-destructive">{p.lint.errors} 错误</span> : null}
                        {p.lint.warnings ? <span className="inline-flex h-[1.125rem] items-center rounded-full border border-warn/60 bg-warn-soft px-1.5 text-[0.625rem] font-semibold text-warn">{p.lint.warnings} 警告</span> : null}
                        {!p.lint.errors && !p.lint.warnings ? <span className="inline-flex h-[1.125rem] items-center rounded-full border border-ok/50 bg-ok-soft px-1.5 text-[0.625rem] font-semibold text-ok">正常</span> : null}
                      </div>
                      <div className="mt-2 text-xs leading-relaxed text-foreground-muted">{p.branch ? p.headline : '还没有分支'}</div>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[0.625rem]">
                        <span className="rounded-full border border-[hsl(var(--hairline-strong))] px-1.5 py-0.5 text-muted-foreground">{p.counts.sites} 站点</span>
                        <span className="rounded-full border border-[hsl(var(--hairline-strong))] px-1.5 py-0.5 text-muted-foreground">{p.counts.apis} API</span>
                        <span className="rounded-full border border-[hsl(var(--hairline-strong))] px-1.5 py-0.5 text-muted-foreground">{p.counts.webs} 静态站</span>
                        <span className="rounded-full border border-info/50 bg-info-soft px-1.5 py-0.5 text-info">引用出 {p.edges.length} · 入 {p.inboundEdges}</span>
                      </div>
                      {p.branch ? (
                        <div className="mt-2.5 space-y-2">
                          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">代表分支：{p.branch.name}</p>
                          <div className="flex flex-wrap gap-1.5">
                          <Button asChild size="sm" variant="outline" className="min-h-11 h-auto text-sm"><Link to={`/branch-relations/${encodeURIComponent(p.branch.id)}`} onClick={event => openRelations(event, p)}>打开关系图</Link></Button>
                          <Button asChild size="sm" variant="ghost" className="min-h-11 h-auto text-sm"><Link to={`/branch-panel/${encodeURIComponent(p.branch.id)}`}>查看分支</Link></Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div className="cds-surface-raised cds-hairline sticky bottom-2 left-2 inline-flex items-center gap-4 rounded-md px-3 py-1.5 text-[0.625rem] text-muted-foreground"><span className="text-info">蓝线 = 跨项目引用</span><span className="text-destructive">红线 = 目标没在跑</span><span>卡片边框颜色 = 该项目最严重的问题</span><span>被引用的项目在右列</span></div>
            </div>
            <div className="w-full shrink-0 overflow-auto rounded-lg lg:w-[20rem] border border-[hsl(var(--hairline))] p-3">
              <div className="mb-2 text-[0.6875rem] font-bold text-muted-foreground">{refreshError ? '上次体检待处理' : '需要处理'} · 按严重度</div>
              {problems.length === 0 ? <div className="rounded-md border border-ok/40 bg-ok-soft p-3 text-xs text-ok">{refreshError ? '上次体检未发现错误与警告；最新结果尚未确认。' : '所有项目体检无错误与警告。'}</div> : (
                <div className="flex flex-col gap-2">
                  {problems.map((f, i) => (
                    <Link key={`${f.project.projectId}-${f.rule}-${i}`} onClick={event => openRelations(event, f.project)} to={f.project.branch ? `/branch-relations/${encodeURIComponent(f.project.branch.id)}` : '/project-list'} className="cds-surface-sunken cds-hairline block rounded-md p-2.5 hover:border-[hsl(var(--hairline-strong))]">
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className={`inline-flex h-[1.125rem] items-center rounded-full border px-1.5 text-[0.625rem] font-semibold ${f.severity === 'error' ? 'border-destructive/60 text-destructive' : 'border-warn/60 bg-warn-soft text-warn'}`}>{f.severity === 'error' ? '错误' : '警告'}</span>
                        <b>{f.project.slug} · {f.rule}</b>
                      </div>
                      <div className="mt-1 text-[0.6875rem] text-foreground-muted">{f.message}</div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Workspace>
    </AppShell>
  );
}
