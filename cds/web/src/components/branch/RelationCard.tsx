/*
 * RelationCard — 分支总览页的「关系」缩略卡 + 半屏抽屉（plan.cds.service-relations 第四批）。
 * 卡上先写结论再画缩略图；点开默认半屏抽屉（图 + 需要处理清单），可切全屏（独立路由，可分享）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Maximize2, PanelRightOpen, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, ApiError } from '@/lib/api';
import { RelationGraph, relationHeadline, type LintFindingView, type RelationPayload } from './RelationGraph';

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

export function FindingsList({ findings, onPick }: { findings: LintFindingView[]; onPick?: (serviceId: string | null) => void }): JSX.Element {
  if (findings.length === 0) return <div className="rounded-md border border-ok/40 bg-ok-soft p-3 text-xs text-ok">体检无发现：关系清楚，配置没有冲突。</div>;
  return (
    <div className="flex flex-col gap-2" data-testid="relation-findings">
      {findings.map((f, i) => (
        <div key={`${f.rule}-${i}`} className="cds-surface-sunken cds-hairline cursor-pointer rounded-md p-2.5" onMouseEnter={() => onPick?.(f.services[0] ?? null)} onMouseLeave={() => onPick?.(null)}>
          <div className="flex items-center gap-1.5 text-xs">
            <span className={`inline-flex h-[18px] items-center rounded-full border px-1.5 text-[10px] font-semibold ${SEV_CLS[f.severity]}`}>{SEV_LABEL[f.severity]}</span>
            <b className="font-mono text-[11px]">{f.rule}</b>
          </div>
          <div className="mt-1 text-[11px] text-foreground-muted">{f.message}</div>
          <div className="mt-1 text-[10px] text-muted-foreground">修法：{f.fix}</div>
        </div>
      ))}
    </div>
  );
}

export function RelationCard({ branchId }: { branchId: string }): JSX.Element | null {
  const { state } = useRelationPayload(branchId);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (state.status === 'loading') {
    return <div className="mx-5 mt-4 flex items-center gap-2 rounded-xl border border-[hsl(var(--hairline))] p-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在算服务关系与体检…</div>;
  }
  if (state.status === 'error') return <div className="mx-5 mt-4 rounded-xl border border-[hsl(var(--hairline))] p-3 text-xs text-destructive">关系图读取失败：{state.message}</div>;
  const data = state.data;
  const { errors, warnings } = data.lint.summary;
  const tone = errors ? 'border-destructive/50' : warnings ? 'border-warn/50' : 'border-[hsl(var(--hairline))]';
  const fullHref = `/branch-relations/${encodeURIComponent(branchId)}`;
  return (
    <>
      <div className={`mx-5 mt-4 rounded-xl border p-3 ${tone}`} data-testid="relation-card">
        <div className="mb-2 flex flex-wrap items-center gap-2 px-1 text-sm font-semibold">
          关系
          {errors ? <span className="inline-flex h-[18px] items-center rounded-full border border-destructive/60 px-1.5 text-[10px] font-semibold text-destructive">{errors} 处配置错误</span> : null}
          {warnings ? <span className="inline-flex h-[18px] items-center rounded-full border border-warn/60 bg-warn-soft px-1.5 text-[10px] font-semibold text-warn">{warnings} 条警告</span> : null}
          {!errors && !warnings ? <span className="inline-flex h-[18px] items-center rounded-full border border-ok/50 bg-ok-soft px-1.5 text-[10px] font-semibold text-ok">无问题</span> : null}
          <span className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)} title="半屏查看关系图与需要处理的事项"><PanelRightOpen />半屏查看</Button>
          <Button variant="ghost" size="sm" onClick={() => navigate(fullHref)} title="全屏关系图（独立链接，可分享）"><Maximize2 />全屏</Button>
        </div>
        <div className="px-1 text-xs leading-relaxed text-foreground-muted">{relationHeadline(data)}</div>
        <div className="mt-2 cursor-pointer rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]" style={{ height: 180 }} onClick={() => setOpen(true)} title="点击半屏查看">
          <RelationGraph payload={data} compact style={{ height: 180 }} />
        </div>
      </div>
      {open ? (
        <div className="fixed inset-0 z-50" role="dialog" aria-label="关系图" data-testid="relation-drawer">
          <div className="absolute inset-0 bg-[hsl(var(--status-ink))]/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 flex w-[min(100vw,760px)] flex-col border-l border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] shadow-2xl">
            <div className="flex h-[52px] items-center gap-2 border-b border-[hsl(var(--hairline))] px-4">
              <span className="text-sm font-bold">关系</span>
              <span className="font-mono text-[11px] text-muted-foreground">{data.branch}</span>
              {errors ? <span className="inline-flex h-[18px] items-center rounded-full border border-destructive/60 px-1.5 text-[10px] font-semibold text-destructive">{errors} 错误</span> : null}
              {warnings ? <span className="inline-flex h-[18px] items-center rounded-full border border-warn/60 bg-warn-soft px-1.5 text-[10px] font-semibold text-warn">{warnings} 警告</span> : null}
              <span className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => navigate(fullHref)}><Maximize2 />全屏</Button>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)} aria-label="关闭"><X /></Button>
            </div>
            <div className="flex min-h-0 flex-1">
              <RelationGraph payload={data} highlight={highlight} className="min-w-0 flex-1" style={{ height: '100%' }} />
              <div className="w-[280px] shrink-0 overflow-auto border-l border-[hsl(var(--hairline))] p-3">
                <div className="mb-2 text-[11px] font-bold text-muted-foreground">需要处理</div>
                <FindingsList findings={data.lint.findings} onPick={setHighlight} />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
