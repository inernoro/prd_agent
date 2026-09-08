/*
 * OverviewPage — 「概览」菜单（plan.cds.service-relations 第四批）：全部项目的关系与体检。
 * 每个项目一张卡（代表分支、体检结论、服务构成），卡之间画跨项目引用边，右侧按严重度列需要处理的事项。
 * 数据：GET /api/overview/topology。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';

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
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ok'; data: OverviewResponse } | { status: 'error'; message: string }>({ status: 'loading' });
  const [onlyProblems, setOnlyProblems] = useState(false);
  const load = useCallback(async () => {
    try {
      const data = await apiRequest<OverviewResponse>('/api/overview/topology');
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [load]);

  const data = state.status === 'ok' ? state.data : null;
  // 布局：被引用多的项目靠右（被依赖方在右，引用方在左），同列从上到下
  const layout = useMemo(() => {
    if (!data) return null;
    const projects = onlyProblems ? data.projects.filter((p) => p.lint.errors || p.lint.warnings) : data.projects;
    const left = projects.filter((p) => p.inboundEdges === 0);
    const right = projects.filter((p) => p.inboundEdges > 0);
    const pos = new Map<string, { x: number; y: number }>();
    left.forEach((p, i) => pos.set(p.projectId, { x: 40, y: 40 + i * (CARD_H + ROW_GAP) }));
    right.forEach((p, i) => pos.set(p.projectId, { x: 40 + CARD_W + COL_GAP, y: 40 + i * (CARD_H + ROW_GAP) }));
    const height = 80 + Math.max(left.length, right.length, 1) * (CARD_H + ROW_GAP);
    const width = 80 + CARD_W * 2 + COL_GAP;
    return { projects, pos, width, height };
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
                  <span className="inline-flex h-[18px] items-center rounded-full border border-destructive/60 px-1.5 text-[10px] font-semibold text-destructive">{data.summary.errors} 错误</span>
                  <span className="inline-flex h-[18px] items-center rounded-full border border-warn/60 bg-warn-soft px-1.5 text-[10px] font-semibold text-warn">{data.summary.warnings} 警告</span>
                </>
              ) : null}
              <Button variant={onlyProblems ? 'default' : 'outline'} size="sm" onClick={() => setOnlyProblems((v) => !v)}>只看问题</Button>
              <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw />刷新</Button>
            </>
          )}
        />
      )}
    >
      <Workspace fluid className="cds-workspace--fill">
        {state.status === 'loading' ? <div className="p-6 text-xs text-muted-foreground">正在汇总各项目的关系与体检…</div> : null}
        {state.status === 'error' ? <div className="p-6 text-xs text-destructive">读取失败：{state.message}</div> : null}
        {data && layout ? (
          <div className="flex h-full min-h-0 gap-3" data-testid="overview-page">
            <div className="cds-surface-sunken cds-hairline relative min-w-0 flex-1 overflow-auto rounded-lg" style={{ backgroundImage: 'radial-gradient(hsl(var(--hairline)) 1px, transparent 1px)', backgroundSize: '26px 26px' }}>
              <div style={{ position: 'relative', width: layout.width, height: layout.height }}>
                <svg width={layout.width} height={layout.height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                  <defs>
                    <marker id="ovArr" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="hsl(var(--info))" /></marker>
                    <marker id="ovArrBad" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8z" fill="hsl(var(--bad))" /></marker>
                  </defs>
                  {layout.projects.flatMap((p) => p.edges.map((e, i) => {
                    const a = layout.pos.get(p.projectId); const b = layout.pos.get(e.toProjectId);
                    if (!a || !b) return null;
                    const broken = e.status !== 'running';
                    const sx = a.x + CARD_W, sy = a.y + 40 + i * 14, tx = b.x, ty = b.y + 40 + (p.edges.length > 1 ? i * 14 : 0), mx = (sx + tx) / 2;
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
                    <div key={p.projectId} className={`cds-surface-raised absolute rounded-xl border p-3 ${tone}`} style={{ left: at.x, top: at.y, width: CARD_W, minHeight: CARD_H }} data-project={p.slug}>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold">{p.slug}</span>
                        <span className="text-[11px] text-muted-foreground">{p.name !== p.slug ? `${p.name} · ` : ''}{p.branchCount} 个分支 · {p.counts.services} 个服务</span>
                        <span className="flex-1" />
                        {p.lint.errors ? <span className="inline-flex h-[18px] items-center rounded-full border border-destructive/60 px-1.5 text-[10px] font-semibold text-destructive">{p.lint.errors} 错误</span> : null}
                        {p.lint.warnings ? <span className="inline-flex h-[18px] items-center rounded-full border border-warn/60 bg-warn-soft px-1.5 text-[10px] font-semibold text-warn">{p.lint.warnings} 警告</span> : null}
                        {!p.lint.errors && !p.lint.warnings ? <span className="inline-flex h-[18px] items-center rounded-full border border-ok/50 bg-ok-soft px-1.5 text-[10px] font-semibold text-ok">正常</span> : null}
                      </div>
                      <div className="mt-2 text-xs leading-relaxed text-foreground-muted">{p.branch ? p.headline : '还没有分支'}</div>
                      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
                        <span className="rounded-full border border-[hsl(var(--hairline-strong))] px-1.5 py-0.5 text-muted-foreground">{p.counts.sites} 站点</span>
                        <span className="rounded-full border border-[hsl(var(--hairline-strong))] px-1.5 py-0.5 text-muted-foreground">{p.counts.apis} API</span>
                        <span className="rounded-full border border-[hsl(var(--hairline-strong))] px-1.5 py-0.5 text-muted-foreground">{p.counts.webs} 静态站</span>
                        <span className="rounded-full border border-info/50 bg-info-soft px-1.5 py-0.5 text-info">引用出 {p.edges.length} · 入 {p.inboundEdges}</span>
                      </div>
                      {p.branch ? (
                        <div className="mt-2.5 flex gap-1.5">
                          <Button asChild size="sm" variant="outline" className="h-6 text-[11px]"><Link to={`/branch-relations/${encodeURIComponent(p.branch.id)}`}>打开关系图</Link></Button>
                          <Button asChild size="sm" variant="ghost" className="h-6 text-[11px]"><Link to={`/branch-panel/${encodeURIComponent(p.branch.id)}`}>{p.branch.name} 分支</Link></Button>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div className="cds-surface-raised cds-hairline sticky bottom-2 left-2 inline-flex items-center gap-4 rounded-md px-3 py-1.5 text-[10px] text-muted-foreground"><span className="text-info">蓝线 = 跨项目引用</span><span className="text-destructive">红线 = 目标没在跑</span><span>卡片边框颜色 = 该项目最严重的问题</span><span>被引用的项目在右列</span></div>
            </div>
            <div className="w-[320px] shrink-0 overflow-auto rounded-lg border border-[hsl(var(--hairline))] p-3">
              <div className="mb-2 text-[11px] font-bold text-muted-foreground">需要处理 · 按严重度</div>
              {problems.length === 0 ? <div className="rounded-md border border-ok/40 bg-ok-soft p-3 text-xs text-ok">所有项目体检无错误与警告。</div> : (
                <div className="flex flex-col gap-2">
                  {problems.map((f, i) => (
                    <Link key={`${f.project.projectId}-${f.rule}-${i}`} to={f.project.branch ? `/branch-relations/${encodeURIComponent(f.project.branch.id)}` : '/project-list'} className="cds-surface-sunken cds-hairline block rounded-md p-2.5 hover:border-[hsl(var(--hairline-strong))]">
                      <div className="flex items-center gap-1.5 text-xs">
                        <span className={`inline-flex h-[18px] items-center rounded-full border px-1.5 text-[10px] font-semibold ${f.severity === 'error' ? 'border-destructive/60 text-destructive' : 'border-warn/60 bg-warn-soft text-warn'}`}>{f.severity === 'error' ? '错误' : '警告'}</span>
                        <b>{f.project.slug} · {f.rule}</b>
                      </div>
                      <div className="mt-1 text-[11px] text-foreground-muted">{f.message}</div>
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
