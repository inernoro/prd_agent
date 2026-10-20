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
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { Expand, Maximize2, Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { RelationEmptyState, RelationGraph, RelationLegend, relationHeadline, type LintFindingView, type RelationPayload } from './RelationGraph';
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
const SEV_CLS: Record<LintFindingView['severity'], string> = { error: 'border-destructive/60 text-bad', warn: 'border-warn/60 bg-warn-soft text-[hsl(var(--warn-ink))]', info: 'border-[hsl(var(--hairline-strong))] text-muted-foreground' };
/** 严重度落在整张卡上：描一圈淡色边 + 极淡底色（设计稿 03）。不用左侧色条——那是模板化卡片的通病 */
const SEV_CARD: Record<LintFindingView['severity'], CSSProperties> = {
  error: { borderColor: 'hsl(var(--bad) / .45)', background: 'color-mix(in srgb, hsl(var(--bad)) 6%, hsl(var(--background)))' },
  warn: { borderColor: 'hsl(var(--warn) / .45)', background: 'color-mix(in srgb, hsl(var(--warn-soft)) 60%, hsl(var(--background)))' },
  info: { borderColor: 'hsl(var(--hairline))', background: 'hsl(var(--background))' },
};

/**
 * 体检结论列表。每条是上下堆叠的一张卡：严重度 + 规则名 / 说明 / 涉及服务 / 修法 + 去配置。
 * 此前严重度、正文、按钮三列并排，放进 17.5rem 的侧栏时正文只剩七八个字宽，
 * 「double-public-surface」被折成三行（2026-09-30 用户截图）。
 * layout=grid 时按宽度自动排多列（展开视图与总览卡的整行宽度下用）。
 */
export function FindingsList({ findings, onPick, onConfigure, layout = 'stack' }: { findings: LintFindingView[]; /** 悬停一条时点亮它涉及的全部服务 */ onPick?: (serviceIds: string[] | null) => void; /** 给了就在每条后面放「去配置」，跳到能改它的地方 */ onConfigure?: () => void; layout?: 'stack' | 'grid' }): JSX.Element {
  if (findings.length === 0) return <div className="rounded-md border border-ok/40 bg-ok-soft p-3 text-[0.92rem] text-[hsl(var(--ok-ink))]">体检无发现：关系清楚，配置没有冲突。</div>;
  return (
    <div className={layout === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,21rem),1fr))] items-start gap-2.5' : 'flex flex-col gap-2'} data-testid="relation-findings">
      {findings.map((f, i) => (
        <div
          key={`${f.rule}-${i}`}
          className="flex min-w-0 flex-col gap-2 rounded-[0.625rem] border px-3.5 py-3 transition-[border-color,box-shadow] duration-150 hover:shadow-[0_0_0_3px_hsl(var(--warn)/.18)]"
          style={SEV_CARD[f.severity]}
          tabIndex={onPick ? 0 : undefined}
          data-finding={f.rule}
          data-severity={f.severity}
          data-finding-services={f.services.join(' ')}
          onMouseEnter={() => onPick?.(f.services.length ? f.services : null)}
          onMouseLeave={() => onPick?.(null)}
          onFocus={() => onPick?.(f.services.length ? f.services : null)}
          onBlur={() => onPick?.(null)}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className={`inline-flex h-[1.125rem] shrink-0 items-center rounded-full border px-2 text-[0.75rem] font-semibold ${SEV_CLS[f.severity]}`}>{SEV_LABEL[f.severity]}</span>
            <b className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] font-semibold text-foreground" title={f.rule}>{f.rule}</b>
          </div>
          <p className="m-0 text-[0.875rem] leading-[1.6] text-foreground-muted [overflow-wrap:anywhere] [text-wrap:pretty]">{f.message}</p>
          {f.services.length > 1 ? (
            <div className="flex flex-wrap gap-1" aria-label="涉及的服务">
              {f.services.map((id) => <span key={id} className="max-w-full truncate rounded-[0.3rem] border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-[0.45rem] font-mono text-[0.72rem] leading-[1.25rem] text-foreground-muted">{id}</span>)}
            </div>
          ) : null}
          <div className="flex min-w-0 items-center justify-between gap-3 border-t border-dashed border-[hsl(var(--hairline))] pt-2">
            <div className="min-w-0 flex-1 text-[0.8125rem] leading-[1.55] text-muted-foreground [overflow-wrap:anywhere]">修法：{f.fix}</div>
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
function useNarrow(query = '(max-width: 639px)'): boolean {
  const get = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const on = (): void => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

export function RelationWorkspace({ data, entryHost, onConfigure, onlyProblems = false }: { data: RelationPayload; entryHost?: string; onConfigure?: () => void; onlyProblems?: boolean }): JSX.Element {
  const [highlight, setHighlight] = useState<string[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const narrow = useNarrow();
  const findings = onlyProblems ? data.lint.findings.filter((f) => f.severity !== 'info') : data.lint.findings;
  // 计数按当前显示的这批算：「只看问题」滤掉建议之后，标题里不能还挂着「5 建议」（Codex P2，PR #1654）
  const count = (sev: LintFindingView['severity']): number => findings.filter((f) => f.severity === sev).length;
  // 手机上问题带只先放要处理的（错误 / 警告），建议收成一行，免得问题带吃掉整屏（设计稿 04）
  const actionable = findings.filter((f) => f.severity !== 'info');
  const folded = narrow && !showAll && actionable.length > 0 && actionable.length < findings.length;
  const visible = folded ? actionable : findings;
  const hidden = findings.filter((f) => !visible.includes(f));
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="relation-workspace">
      <div className="max-h-[45%] shrink-0 overflow-auto border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-4 py-3 sm:px-[1.375rem] sm:py-4">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[0.78rem] text-muted-foreground">
          <b className="font-semibold text-foreground-muted">需要处理 · {findings.length} 条</b>
          {(['error', 'warn', 'info'] as const).map((sev) => (count(sev) ? <span key={sev} className={`inline-flex h-[1.125rem] items-center rounded-full border px-1.5 text-[0.6875rem] font-semibold ${SEV_CLS[sev]}`}>{count(sev)} {SEV_LABEL[sev]}</span> : null))}
          {findings.length > 0 ? <span className="ml-1 hidden sm:inline">悬停一条，图上点亮它涉及的服务</span> : null}
        </div>
        <FindingsList findings={visible} onPick={setHighlight} onConfigure={onConfigure} layout="grid" />
        {folded ? (
          <button type="button" className="mt-2.5 flex h-8 w-full items-center justify-between rounded-md px-1 text-[0.8125rem] text-foreground-muted transition-colors hover:text-foreground" onClick={() => setShowAll(true)} data-testid="relation-findings-more">
            <span className="truncate">另有 {hidden.length} 条建议 · <span className="font-mono">{hidden.map((f) => f.rule).join(' / ')}</span></span>
            <span className="shrink-0 text-muted-foreground">展开</span>
          </button>
        ) : null}
      </div>
      <RelationGraph payload={data} highlight={highlight} entryHost={entryHost} hideLegend className="min-h-0 flex-1" />
      <RelationLegend className="hidden h-10 shrink-0 border-t border-[hsl(var(--hairline))] px-[1.375rem] sm:flex" />
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
    // 捕获阶段先接住 Esc 并截停：分支详情抽屉也在 window 上听 Esc，冒泡阶段两个都会触发，
    // 按一下 Esc 就连浮层带抽屉一起关掉、退回分支列表（2026-10-03 relation-visual-audit S8 抓到）
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
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
        <div className="flex items-center gap-2 text-base font-bold">关系<span className="inline-flex h-[1.3rem] items-center rounded-full border border-destructive/60 px-2 text-[0.75rem] font-semibold text-bad">读取失败</span><span className="flex-1" /><Button variant="ghost" size="sm" onClick={reload}>重试</Button></div>
        <div className="text-[0.92rem] text-bad">关系图读取失败：{state.message}</div>
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
    ? <span className="inline-flex h-[1.3rem] items-center rounded-full border border-destructive/60 px-2 text-[0.75rem] font-semibold text-bad">{errors} 处配置错误</span>
    : warnings
      ? <span className="inline-flex h-[1.3rem] items-center rounded-full border border-warn/60 bg-warn-soft px-2 text-[0.75rem] font-semibold text-[hsl(var(--warn-ink))]">{warnings} 条警告</span>
      : <span className="inline-flex h-[1.3rem] items-center rounded-full border border-ok/50 bg-ok-soft px-2 text-[0.75rem] font-semibold text-[hsl(var(--ok-ink))]">无问题</span>;
  const body = variant === 'row' ? (
    /* 行式（分支详情总览，设计稿 01）：标题行放动作，结论句完整显示不截断，其下事实行、两条泳道、问题卡 */
    <section className={`flex flex-col gap-4 rounded-[0.875rem] border bg-[hsl(var(--surface-raised))] px-[1.375rem] pb-[1.375rem] pt-5 transition-colors duration-150 ${tone}`} data-testid="relation-card" data-variant="row">
      <div className="flex items-center gap-2.5">
        <h2 className="m-0 text-[1.0625rem] font-bold">关系</h2>
        {pill}
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)} title="展开查看关系图与需要处理的事项"><Expand />展开</Button>
        <Button variant="ghost" size="sm" onClick={() => navigate(fullHref)} title="全屏关系图（独立链接，可分享）"><Maximize2 />全屏</Button>
      </div>
      <p className="m-0 text-[0.875rem] leading-[1.7] text-foreground-muted [text-wrap:pretty]">{relationHeadline(data)}</p>
      <FlowFacts facts={model.facts} />
      <div className="cursor-pointer" onClick={() => setOpen(true)} title="点击展开查看">
        <RelationFlowStrip model={model} />
      </div>
      {actionable.length > 0 ? <FindingsList findings={actionable} onConfigure={onConfigure} layout="grid" /> : null}
    </section>
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
          <div className="relative flex w-full max-w-[96rem] flex-col overflow-hidden border border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-base))] shadow-2xl sm:rounded-2xl">
            <div className="flex h-[3.25rem] shrink-0 items-center gap-2 border-b border-[hsl(var(--hairline))] px-4">
              <h2 className="m-0 text-base font-bold">关系</h2>
              <span className="hidden min-w-0 truncate font-mono text-[0.78rem] text-muted-foreground sm:inline">{data.branch}</span>
              {errors ? <span className="inline-flex h-[1.3rem] shrink-0 items-center rounded-full border border-destructive/60 px-2 text-[0.75rem] font-semibold text-bad">{errors} 错误</span> : null}
              {warnings ? <span className="inline-flex h-[1.3rem] shrink-0 items-center rounded-full border border-warn/60 bg-warn-soft px-2 text-[0.75rem] font-semibold text-[hsl(var(--warn-ink))]">{warnings} 警告</span> : null}
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
