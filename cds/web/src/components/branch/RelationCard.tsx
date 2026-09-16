/*
 * RelationCard — 分支总览页的「关系」卡 + 半屏抽屉（plan.cds.service-relations 第四 / 五批）。
 *
 * 卡上三层：一句结论（先判断再数字）→ 一行事实（站点 / 服务 / 前缀 / 基础设施 / 引用 / 体检）
 * → 一行流向条（RelationFlowStrip）。有错误或警告时卡片边框变色，并把「需要处理」贴在流向条下面。
 * 二维分层图只留给半屏抽屉与全屏页（独立路由，可分享）。
 *
 * 2026-09-16 之前这里画的是缩略版二维图，固定 180px 高、只按宽度缩放，宽屏上被裁得只剩
 * 「入口」一枚节点——文案说 2 个服务挂在壳下面，图里一个都没有。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Maximize2, PanelRightOpen, Wrench, X } from 'lucide-react';
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

export function FindingsList({ findings, onPick, onConfigure }: { findings: LintFindingView[]; onPick?: (serviceId: string | null) => void; /** 给了就在每条后面放「去配置」，跳到能改它的地方 */ onConfigure?: () => void }): JSX.Element {
  if (findings.length === 0) return <div className="rounded-md border border-ok/40 bg-ok-soft p-3 text-xs text-ok">体检无发现：关系清楚，配置没有冲突。</div>;
  return (
    <div className="flex flex-col gap-2" data-testid="relation-findings">
      {findings.map((f, i) => (
        <div key={`${f.rule}-${i}`} className="cds-surface-sunken cds-hairline flex cursor-pointer items-start gap-2.5 rounded-md p-2.5 transition-colors duration-150" onMouseEnter={() => onPick?.(f.services[0] ?? null)} onMouseLeave={() => onPick?.(null)}>
          <span className={`mt-px inline-flex h-[1.125rem] shrink-0 items-center rounded-full border px-1.5 text-[0.625rem] font-semibold ${SEV_CLS[f.severity]}`}>{SEV_LABEL[f.severity]}</span>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-foreground-muted"><b className="font-mono text-[0.6875rem] text-foreground">{f.rule}</b> · {f.message}</div>
            <div className="mt-1 text-[0.6875rem] text-muted-foreground">修法：{f.fix}</div>
          </div>
          {onConfigure ? <Button variant="outline" size="sm" className="h-[1.625rem] shrink-0" onClick={(e) => { e.stopPropagation(); onConfigure(); }} title="到配置页签改 compose 声明"><Wrench />去配置</Button> : null}
        </div>
      ))}
    </div>
  );
}

export function RelationCard({ branchId, previewUrl, onConfigure }: { branchId: string; /** 主入口地址：入口 chip 上写域名；没有就写分支名 */ previewUrl?: string; /** 「去配置」的落点（配置页签） */ onConfigure?: () => void }): JSX.Element | null {
  const { state, reload } = useRelationPayload(branchId);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
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
    <div className={`flex flex-col gap-2.5 rounded-xl border bg-[hsl(var(--surface-raised))] px-4 pb-4 pt-3.5 transition-colors duration-150 ${tone}`} data-testid="relation-card">
      {children}
    </div>
  );
  // 加载 / 失败态用同一副骨架，卡片高度不跳（微调 3）
  if (state.status === 'loading') {
    return shell('border-[hsl(var(--hairline))]', (
      <>
        <div className="flex items-center gap-2 text-sm font-bold">关系<span className="inline-flex h-[1.125rem] items-center rounded-full border border-[hsl(var(--hairline-strong))] px-1.5 text-[0.625rem] font-semibold text-muted-foreground">正在体检</span></div>
        <div className="text-xs text-muted-foreground">正在算服务关系、前缀归属与跨项目引用…</div>
        <RelationFlowSkeleton note="正在算服务关系与体检，通常 1 秒内完成" />
      </>
    ));
  }
  if (state.status === 'error') {
    return shell('border-destructive/50', (
      <>
        <div className="flex items-center gap-2 text-sm font-bold">关系<span className="inline-flex h-[1.125rem] items-center rounded-full border border-destructive/60 px-1.5 text-[0.625rem] font-semibold text-destructive">读取失败</span><span className="flex-1" /><Button variant="ghost" size="sm" onClick={reload}>重试</Button></div>
        <div className="text-xs text-destructive">关系图读取失败：{state.message}</div>
        <RelationFlowSkeleton note="拿不到服务图，流向条画不出来；重试或看容器日志" tone="bad" />
      </>
    ));
  }
  const data = state.data;
  // 零服务：不出事实行、不出流向条、不给半屏 / 全屏按钮——全零的数字和一枚孤零零的入口 chip 只会显得没做完
  if (data.graph.nodes.every((n) => n.kind !== 'service')) {
    return shell('border-[hsl(var(--hairline))]', (
      <>
        <div className="flex items-center gap-2 text-sm font-bold">关系<span className="inline-flex h-[1.125rem] items-center rounded-full border border-[hsl(var(--hairline-strong))] px-1.5 text-[0.625rem] font-semibold text-muted-foreground">还没有服务</span></div>
        <div className="flex justify-center py-2"><RelationEmptyState branch={data.branch} onConfigure={onConfigure} /></div>
      </>
    ));
  }
  const { errors, warnings } = data.lint.summary;
  const tone = errors ? 'border-destructive/50' : warnings ? 'border-warn/50' : 'border-[hsl(var(--hairline))]';
  const model = layoutFlow(data, entryHost);
  const actionable = data.lint.findings.filter((f) => f.severity !== 'info');
  const pill = errors
    ? <span className="inline-flex h-[1.125rem] items-center rounded-full border border-destructive/60 px-1.5 text-[0.625rem] font-semibold text-destructive">{errors} 处配置错误</span>
    : warnings
      ? <span className="inline-flex h-[1.125rem] items-center rounded-full border border-warn/60 bg-warn-soft px-1.5 text-[0.625rem] font-semibold text-warn">{warnings} 条警告</span>
      : <span className="inline-flex h-[1.125rem] items-center rounded-full border border-ok/50 bg-ok-soft px-1.5 text-[0.625rem] font-semibold text-ok">无问题</span>;
  return (
    <>
      {shell(tone, (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
            关系{pill}
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)} title="半屏查看关系图与需要处理的事项"><PanelRightOpen />半屏查看</Button>
            <Button variant="ghost" size="sm" onClick={() => navigate(fullHref)} title="全屏关系图（独立链接，可分享）"><Maximize2 />全屏</Button>
          </div>
          <div className="text-xs leading-relaxed text-foreground-muted transition-colors duration-150">{relationHeadline(data)}</div>
          <FlowFacts facts={model.facts} />
          <div className="cursor-pointer" onClick={() => setOpen(true)} title="点击半屏查看">
            <RelationFlowStrip model={model} />
          </div>
          {actionable.length > 0 ? <FindingsList findings={actionable} onConfigure={onConfigure} /> : null}
        </>
      ))}
      {open ? (
        <div className="fixed inset-0 z-50" role="dialog" aria-label="关系图" data-testid="relation-drawer">
          <div className="absolute inset-0 bg-[hsl(var(--status-ink))]/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-[min(100vw,47.5rem)] flex-col border-l border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] shadow-2xl">
            <div className="flex h-[3.25rem] items-center gap-2 border-b border-[hsl(var(--hairline))] px-4">
              <span className="text-sm font-bold">关系</span>
              <span className="font-mono text-[0.6875rem] text-muted-foreground">{data.branch}</span>
              {errors ? <span className="inline-flex h-[1.125rem] items-center rounded-full border border-destructive/60 px-1.5 text-[0.625rem] font-semibold text-destructive">{errors} 错误</span> : null}
              {warnings ? <span className="inline-flex h-[1.125rem] items-center rounded-full border border-warn/60 bg-warn-soft px-1.5 text-[0.625rem] font-semibold text-warn">{warnings} 警告</span> : null}
              <span className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => navigate(fullHref)}><Maximize2 />全屏</Button>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)} aria-label="关闭"><X /></Button>
            </div>
            <div className="flex min-h-0 flex-1">
              <RelationGraph payload={data} highlight={highlight} entryHost={entryHost} className="min-w-0 flex-1" style={{ height: '100%' }} />
              <div className="w-[17.5rem] shrink-0 overflow-auto border-l border-[hsl(var(--hairline))] p-3">
                <div className="mb-2 text-[0.6875rem] font-bold text-muted-foreground">需要处理</div>
                <FindingsList findings={data.lint.findings} onPick={setHighlight} onConfigure={onConfigure ? () => { setOpen(false); onConfigure(); } : undefined} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
