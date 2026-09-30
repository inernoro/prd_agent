/*
 * RelationCard — 分支总览页的「关系」卡 + 展开视图（plan.cds.service-relations 第四 / 五批）。
 *
 * 卡上三层：一句结论（先判断再数字）→ 一行事实（站点 / 服务 / 前缀 / 基础设施 / 引用 / 体检）
 * → 一行流向条（RelationFlowStrip）。有错误或警告时卡片边框变色，并把「需要处理」贴在流向条下面。
 * 二维分层图只留给展开视图（居中大浮层）与全屏页（独立路由，可分享）。
 *
 * 2026-09-16 之前这里画的是缩略版二维图，固定 180px 高、只按宽度缩放，宽屏上被裁得只剩
 * 「入口」一枚节点——文案说 2 个服务挂在壳下面，图里一个都没有。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Expand, Maximize2, Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { RelationEmptyState, RelationGraph, relationHeadline, type LintFindingView, type RelationPayload } from './RelationGraph';
import { FlowFacts, RelationFlowSkeleton, RelationFlowStrip, layoutFlow } from './RelationFlowStrip';

export function useRelationPayload(branchId: string | undefined): { state: { status: 'loading' } | { status: 'ok'; data: RelationPayload } | { status: 'error'; message: string }; reload: () => void } {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ok'; data: RelationPayload } | { status: 'error'; message: string }>({ status: 'loading' });
  const reload = useCallback(() => {
    if (!branchId) return;
    setState({ status: 'loading' });
    apiRequest<RelationPayload>(`/api/branches/${encodeURIComponent(branchId)}/service-graph`)
      .then((data) => setState({ status: 'ok', data }))
      .catch((err) => setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) }));
  }, [branchId]);
  useEffect(() => { reload(); }, [reload]);
  return { state, reload };
}

const SEV_LABEL: Record<LintFindingView['severity'], string> = { error: '错误', warn: '警告', info: '建议' };
const SEV_CLS: Record<LintFindingView['severity'], string> = { error: 'border-destructive/60 text-destructive', warn: 'border-warn/60 bg-warn-soft text-warn', info: 'border-[hsl(var(--hairline-strong))] text-muted-foreground' };
const SEV_STRIPE: Record<LintFindingView['severity'], string> = { error: 'hsl(var(--bad))', warn: 'hsl(var(--warn))', info: 'hsl(var(--hairline-strong))' };

/**
 * 体检结论列表。每条是上下堆叠的一张卡：严重度 + 规则名 / 说明 / 涉及服务 / 修法 + 去配置。
 * 此前严重度、正文、按钮三列并排，放进 17.5rem 的侧栏时正文只剩七八个字宽，
 * 「double-public-surface」被折成三行（2026-09-30 用户截图）。
 * layout=grid 时按宽度自动排多列（展开视图与总览卡的整行宽度下用）。
 */
export function FindingsList({ findings, onPick, onConfigure, layout = 'stack' }: { findings: LintFindingView[]; /** 悬停一条时点亮它涉及的全部服务 */ onPick?: (serviceIds: string[] | null) => void; /** 给了就在每条后面放「去配置」，跳到能改它的地方 */ onConfigure?: () => void; layout?: 'stack' | 'grid' }): JSX.Element {
  if (findings.length === 0) return <div className="rounded-md border border-ok/40 bg-ok-soft p-3 text-[0.92rem] text-ok">体检无发现：关系清楚，配置没有冲突。</div>;
  return (
    <div className={layout === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] gap-2.5' : 'flex flex-col gap-2'} data-testid="relation-findings">
      {findings.map((f, i) => (
        <div
          key={`${f.rule}-${i}`}
          className="cds-surface-sunken cds-hairline flex min-w-0 flex-col gap-1.5 rounded-md p-2.5 transition-colors duration-150 hover:bg-[hsl(var(--surface-raised))]"
          style={{ borderLeft: `3px solid ${SEV_STRIPE[f.severity]}` }}
          data-finding={f.rule}
          data-severity={f.severity}
          onMouseEnter={() => onPick?.(f.services.length ? f.services : null)}
          onMouseLeave={() => onPick?.(null)}
          onFocus={() => onPick?.(f.services.length ? f.services : null)}
          onBlur={() => onPick?.(null)}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className={`inline-flex h-[1.125rem] shrink-0 items-center rounded-full border px-2 text-[0.75rem] font-semibold ${SEV_CLS[f.severity]}`}>{SEV_LABEL[f.severity]}</span>
            <b className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-foreground" title={f.rule}>{f.rule}</b>
          </div>
          <div className="text-[0.88rem] leading-relaxed text-foreground-muted [overflow-wrap:anywhere]">{f.message}</div>
          {f.services.length > 1 ? (
            <div className="flex flex-wrap gap-1" aria-label="涉及的服务">
              {f.services.map((id) => <span key={id} className="max-w-full truncate rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-1.5 font-mono text-[0.72rem] text-foreground-muted">{id}</span>)}
            </div>
          ) : null}
          <div className="flex min-w-0 items-start justify-between gap-2 border-t border-dashed border-[hsl(var(--hairline))] pt-1.5">
            <div className="min-w-0 flex-1 text-[0.8125rem] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">修法：{f.fix}</div>
            {onConfigure ? <Button variant="outline" size="sm" className="h-[1.625rem] shrink-0" onClick={(e) => { e.stopPropagation(); onConfigure(); }} title="到配置页签改 compose 声明"><Wrench />去配置</Button> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 展开视图与全屏页共用的主体：问题带在上（横跨整宽、自适应多列），关系图在下填满剩余高度。
 * 此前问题栏是右侧 17.5rem 的窄列，和图抢宽度，两边都被挤坏。
 */
export function RelationWorkspace({ data, entryHost, onConfigure, onlyProblems = false }: { data: RelationPayload; entryHost?: string; onConfigure?: () => void; onlyProblems?: boolean }): JSX.Element {
  const [highlight, setHighlight] = useState<string[] | null>(null);
  const findings = onlyProblems ? data.lint.findings.filter((f) => f.severity !== 'info') : data.lint.findings;
  const count = (sev: LintFindingView['severity']): number => data.lint.findings.filter((f) => f.severity === sev).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="relation-workspace">
      <div className="max-h-[40%] shrink-0 overflow-auto border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[0.75rem] font-bold text-muted-foreground">
          需要处理 · {findings.length} 条
          {(['error', 'warn', 'info'] as const).map((sev) => (count(sev) ? <span key={sev} className={`inline-flex h-[1.125rem] items-center rounded-full border px-1.5 text-[0.6875rem] font-semibold ${SEV_CLS[sev]}`}>{count(sev)} {SEV_LABEL[sev]}</span> : null))}
          {findings.length > 0 ? <span className="font-normal">悬停一条，图上点亮涉及的服务</span> : null}
        </div>
        <FindingsList findings={findings} onPick={setHighlight} onConfigure={onConfigure} layout="grid" />
      </div>
      <RelationGraph payload={data} highlight={highlight} entryHost={entryHost} className="min-h-0 flex-1" />
    </div>
  );
}

/**
 * 关系卡的加载态。单独导出是为了让抽屉的整体加载骨架（BranchDrawerSkeleton）复用：
 * 抽屉等接口时画的关系卡，和数据到达后 RelationCard 自己等 service-graph 时画的关系卡，
 * 必须是同一个东西，否则用户会看到「骨架换了一副」。
 */
export type RelationCardVariant = 'card' | 'row';

export function RelationCardSkeleton({ badge = '正在体检', note = '正在算服务关系与体检，通常 1 秒内完成', variant = 'card' }: { badge?: string; note?: string; variant?: RelationCardVariant }): JSX.Element {
  if (variant === 'row') {
    return (
      <div className="flex flex-col gap-2.5 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-[1.3rem] py-3.5" data-testid="relation-card" data-loading="true" data-variant="row">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <div className="flex items-center gap-2 text-base font-bold">关系<span className="inline-flex h-[1.3rem] items-center rounded-full border border-[hsl(var(--hairline-strong))] px-2 text-[0.75rem] font-semibold text-muted-foreground">{badge}</span></div>
          <div className="min-w-[12rem] flex-1 truncate text-[0.8125rem] text-muted-foreground">正在算服务关系、前缀归属与跨项目引用…</div>
        </div>
        <RelationFlowSkeleton note={note} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-5 pb-5 pt-4 transition-colors duration-150" data-testid="relation-card" data-loading="true">
      <div className="flex items-center gap-2 text-base font-bold">关系<span className="inline-flex h-[1.3rem] items-center rounded-full border border-[hsl(var(--hairline-strong))] px-2 text-[0.75rem] font-semibold text-muted-foreground">{badge}</span></div>
      <div className="text-[0.92rem] text-foreground-muted">正在算服务关系、前缀归属与跨项目引用…</div>
      <RelationFlowSkeleton note={note} />
    </div>
  );
}

export function RelationCard({ branchId, previewUrl, onConfigure, variant = 'card' }: { branchId: string; /** 主入口地址：入口 chip 上写域名；没有就写分支名 */ previewUrl?: string; /** 「去配置」的落点（配置页签） */ onConfigure?: () => void; /** row = 指挥台底部的一行（标题、流向条、事实、按钮排成一排）；card = 独立卡片 */ variant?: RelationCardVariant }): JSX.Element | null {
  const { state, reload } = useRelationPayload(branchId);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const entryHost = previewUrl ? previewUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : undefined;
  const fullHref = `/branch-relations/${encodeURIComponent(branchId)}`;
  const shell = (tone: string, children: JSX.Element) => (
    <div className={`flex flex-col gap-3 rounded-xl border bg-[hsl(var(--surface-raised))] px-5 pb-5 pt-4 transition-colors duration-150 ${tone}`} data-testid="relation-card">
      {children}
    </div>
  );
  // 加载 / 失败态用同一副骨架，卡片高度不跳（微调 3）。
  // 加载态抽成 RelationCardSkeleton：抽屉整体的加载骨架也用它，两个阶段一个轮廓。
  if (state.status === 'loading') return <RelationCardSkeleton variant={variant} />;
  if (state.status === 'error') {
    return shell('border-destructive/50', (
      <>
        <div className="flex items-center gap-2 text-base font-bold">关系<span className="inline-flex h-[1.3rem] items-center rounded-full border border-destructive/60 px-2 text-[0.75rem] font-semibold text-destructive">读取失败</span><span className="flex-1" /><Button variant="ghost" size="sm" onClick={reload}>重试</Button></div>
        <div className="text-[0.92rem] text-destructive">关系图读取失败：{state.message}</div>
        <RelationFlowSkeleton note="拿不到服务图，流向条画不出来；重试或看容器日志" tone="bad" />
      </>
    ));
  }
  const data = state.data;
  // 零服务：不出事实行、不出流向条、不给展开 / 全屏按钮——全零的数字和一枚孤零零的入口 chip 只会显得没做完
  if (data.graph.nodes.every((n) => n.kind !== 'service')) {
    return shell('border-[hsl(var(--hairline))]', (
      <>
        <div className="flex items-center gap-2 text-base font-bold">关系<span className="inline-flex h-[1.3rem] items-center rounded-full border border-[hsl(var(--hairline-strong))] px-2 text-[0.75rem] font-semibold text-muted-foreground">还没有服务</span></div>
        <div className="flex justify-center py-2"><RelationEmptyState branch={data.branch} onConfigure={onConfigure} /></div>
      </>
    ));
  }
  const { errors, warnings } = data.lint.summary;
  const tone = errors ? 'border-destructive/50' : warnings ? 'border-warn/50' : 'border-[hsl(var(--hairline))]';
  const model = layoutFlow(data, entryHost);
  const actionable = data.lint.findings.filter((f) => f.severity !== 'info');
  const pill = errors
    ? <span className="inline-flex h-[1.3rem] items-center rounded-full border border-destructive/60 px-2 text-[0.75rem] font-semibold text-destructive">{errors} 处配置错误</span>
    : warnings
      ? <span className="inline-flex h-[1.3rem] items-center rounded-full border border-warn/60 bg-warn-soft px-2 text-[0.75rem] font-semibold text-warn">{warnings} 条警告</span>
      : <span className="inline-flex h-[1.3rem] items-center rounded-full border border-ok/50 bg-ok-soft px-2 text-[0.75rem] font-semibold text-ok">无问题</span>;
  const body = variant === 'row' ? (
    /* 行式（指挥台底部）：一行读完——标题与结论在左、流向条居中撑满、事实与按钮靠右；窄了自然折行 */
    <div className={`flex flex-col gap-3 rounded-xl border bg-[hsl(var(--surface-raised))] px-[1.3rem] py-3.5 transition-colors duration-150 ${tone}`} data-testid="relation-card" data-variant="row">
      {/* 第一行：标题、结论（截断带 title）、事实、动作；第二行：流向条满宽——抽屉宽度下三列并排放不下流向条，宁可两行也不裁 chip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="flex items-center gap-2 text-base font-bold">关系{pill}</div>
        <div className="min-w-[12rem] flex-1 truncate text-[0.8125rem] text-foreground-muted" title={relationHeadline(data)}>{relationHeadline(data)}</div>
        <FlowFacts facts={model.facts} />
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)} title="展开查看关系图与需要处理的事项"><Expand />展开</Button>
          <Button variant="ghost" size="sm" onClick={() => navigate(fullHref)} title="全屏关系图（独立链接，可分享）"><Maximize2 />全屏</Button>
        </div>
      </div>
      <div className="cursor-pointer" onClick={() => setOpen(true)} title="点击展开查看">
        <RelationFlowStrip model={model} />
      </div>
      {actionable.length > 0 ? <FindingsList findings={actionable} onConfigure={onConfigure} layout="grid" /> : null}
    </div>
  ) : shell(tone, (
    <>
      <div className="flex flex-wrap items-center gap-2 text-base font-bold">
        关系{pill}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)} title="展开查看关系图与需要处理的事项"><Expand />展开</Button>
        <Button variant="ghost" size="sm" onClick={() => navigate(fullHref)} title="全屏关系图（独立链接，可分享）"><Maximize2 />全屏</Button>
      </div>
      <div className="text-[0.92rem] leading-relaxed text-foreground-muted transition-colors duration-150">{relationHeadline(data)}</div>
      <FlowFacts facts={model.facts} />
      <div className="cursor-pointer" onClick={() => setOpen(true)} title="点击展开查看">
        <RelationFlowStrip model={model} />
      </div>
      {actionable.length > 0 ? <FindingsList findings={actionable} onConfigure={onConfigure} layout="grid" /> : null}
    </>
  ));
  return (
    <>
      {body}
      {open ? (
        /* 展开视图：居中大浮层，四周留边、底下一层均匀遮罩。此前是右侧半屏抽屉，盖住一半总览，
           被盖住的关系卡只露出半截 chip（2026-09-30 用户：「一边是遮挡，一边是折叠压缩」） */
        <div className="fixed inset-0 z-50 flex items-stretch justify-center p-0 sm:p-4 lg:p-8" role="dialog" aria-modal="true" aria-label="关系图" data-testid="relation-sheet">
          <div className="absolute inset-0 bg-[hsl(var(--status-ink))]/55 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <div className="relative flex w-full max-w-[96rem] flex-col overflow-hidden border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-base))] shadow-2xl sm:rounded-xl">
            <div className="flex h-[3.25rem] shrink-0 items-center gap-2 border-b border-[hsl(var(--hairline))] px-4">
              <span className="text-sm font-bold">关系</span>
              <span className="min-w-0 truncate font-mono text-[0.6875rem] text-muted-foreground">{data.branch}</span>
              {errors ? <span className="inline-flex h-[1.3rem] shrink-0 items-center rounded-full border border-destructive/60 px-2 text-[0.75rem] font-semibold text-destructive">{errors} 错误</span> : null}
              {warnings ? <span className="inline-flex h-[1.3rem] shrink-0 items-center rounded-full border border-warn/60 bg-warn-soft px-2 text-[0.75rem] font-semibold text-warn">{warnings} 警告</span> : null}
              <span className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => navigate(fullHref)} title="全屏关系图（独立链接，可分享）"><Maximize2 />全屏</Button>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)} aria-label="关闭"><X /></Button>
            </div>
            <RelationWorkspace data={data} entryHost={entryHost} onConfigure={onConfigure ? () => { setOpen(false); onConfigure(); } : undefined} />
          </div>
        </div>
      ) : null}
    </>
  );
}
