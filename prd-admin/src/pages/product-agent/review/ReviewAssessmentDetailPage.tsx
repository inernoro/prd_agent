// 产品管理专用视图：独立评审智能体保持原样；接口、弹框及流式组件继续复用。
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useReviewNavigation } from './reviewNavigation';
import { ArrowLeft, Download, RefreshCw, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { SectionShell } from '@/components/agent-shell/AgentFullscreenLayout';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { connectSse } from '@/lib/useSseStream';
import {
  getAssessment,
  rerunAssessment,
  getAssessmentStreamUrl,
  downloadAssessmentReport,
} from '@/services/real/productReviewApi';
import type {
  RequirementAssessmentRun,
  RequirementAssessmentItem,
} from '@/services/real/productReviewApi';

const TIER_STYLES: Record<string, string> = {
  P0: 'bg-token-nested text-[color:var(--accent-fg-blue)] border-token-subtle',
  P1: 'bg-token-nested text-[color:var(--accent-fg-success)] border-token-subtle',
  P2: 'bg-token-nested text-[color:var(--accent-fg-amber)] border-token-subtle',
  P3: 'bg-token-nested text-token-muted border-token-subtle',
};

function TierChip({ tier }: { tier?: string | null }) {
  if (!tier) return null;
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded border ${TIER_STYLES[tier] ?? TIER_STYLES.P3}`}>
      {tier}
    </span>
  );
}

export function ReviewAssessmentDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const reviewNav = useReviewNavigation();

  const [run, setRun] = useState<RequirementAssessmentRun | null>(null);
  const [items, setItems] = useState<RequirementAssessmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 评估流态
  const [streaming, setStreaming] = useState(false);
  const [phaseMessage, setPhaseMessage] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [modelInfo, setModelInfo] = useState<{ model: string; platform?: string | null } | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const res = await getAssessment(id);
    if (res.success && res.data) {
      setRun(res.data.run);
      setItems(res.data.items);
    }
    setLoading(false);
    return res.success ? res.data : null;
  }, [id]);

  const startStream = useCallback(() => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setStreamError(null);
    setPhaseMessage('正在连接评估服务...');

    void connectSse({
      url: getAssessmentStreamUrl(id),
      signal: controller.signal,
      onEvent: (event) => {
        if (!event.data) return;
        try {
          const data = JSON.parse(event.data);
          switch (event.event) {
            case 'phase':
              if (data.message) setPhaseMessage(data.message);
              break;
            case 'model':
              if (data.model) setModelInfo({ model: data.model, platform: data.platform });
              break;
            case 'progress':
              setProgress({ done: data.done ?? 0, total: data.total ?? 0 });
              if (data.message) setPhaseMessage(data.message);
              break;
            case 'item_scored':
              if (data.item) {
                setItems(prev => {
                  const next = prev.filter(x => x.id !== data.item.id);
                  next.push(data.item as RequirementAssessmentItem);
                  next.sort((a, b) => a.rowIndex - b.rowIndex);
                  return next;
                });
                if (typeof data.done === 'number' && typeof data.total === 'number') {
                  setProgress({ done: data.done, total: data.total });
                }
              }
              break;
            case 'error':
              setStreamError(data.message ?? '评估失败');
              break;
            default:
              break;
          }
        } catch {
          // 忽略 keepalive 等非 JSON 载荷
        }
      },
    }).then(async () => {
      setStreaming(false);
      await load(); // 流结束后拉最终结果（排序 / 报告 / 失败态）
    });
  }, [id, load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await load();
      // 待评估任务进入页面即自动开始（Draft 为旧版遗留态，后端会自动补齐条目继续）
      if (!cancelled && data && (data.run.status === 'Queued' || data.run.status === 'Draft')) startStream();
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Running 但本页没有持有评估流（中途刷新页面 / 评估在另一个连接上执行）时，
  // 轮询兜底直到出结果，用户无需手动刷新
  const runStatus = run?.status;
  useEffect(() => {
    if (streaming || runStatus !== 'Running') return;
    const timer = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(timer);
  }, [runStatus, streaming, load]);

  const handleRerun = async () => {
    const res = await rerunAssessment(id);
    if (res.success) {
      setStreamError(null);
      setRun(prev => (prev ? { ...prev, status: 'Queued', errorMessage: null } : prev));
      startStream();
    } else {
      setStreamError(res.error?.message ?? '重试失败');
    }
  };

  const backAction = <Button size="sm" variant="ghost" onClick={() => navigate(reviewNav.assessments)}><ArrowLeft size={14} />返回需求评估</Button>;
  if (loading) return <SectionShell title="需求评估" actions={backAction}><MapSectionLoader text="正在加载评估结果…" /></SectionShell>;
  if (!run) {
    return (
      <SectionShell title="需求评估" actions={backAction}><div className="rounded-lg border border-token-subtle bg-token-nested p-6 text-sm text-token-secondary">评估任务不存在或无权限查看</div></SectionShell>
    );
  }

  const isDone = run.status === 'Done';
  const isError = run.status === 'Error' || (!!streamError && !streaming);
  const inProgress = !isError && (streaming || run.status === 'Running' || run.status === 'Queued' || run.status === 'Draft');
  const scoredItems = items.filter(x => x.status === 'Scored');
  const failedItems = items.filter(x => x.status === 'Error');
  const orderedItems = isDone
    ? [...scoredItems].sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER))
    : scoredItems;
  const tierCounts = orderedItems.reduce<Record<string, number>>((acc, x) => {
    if (x.tier) acc[x.tier] = (acc[x.tier] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <SectionShell title={run.title} desc={`${run.fileName} · 工作表 ${run.sheetName} · ${run.itemCount > 0 ? `${run.itemCount} 条需求` : `${run.totalRowCount} 行数据`}${run.truncated ? `（原表 ${run.totalRowCount} 行，超出单次上限已截取）` : ''}`} actions={
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => navigate(reviewNav.assessments)} aria-label="返回需求评估列表"><ArrowLeft size={14} /><span className="hidden sm:inline">返回需求评估</span></Button>
        {isDone && <Button size="sm" onClick={() => downloadAssessmentReport(run.id, run.title)}><Download size={14} />导出报告</Button>}
      </div>
    }>
      <div className="flex min-h-full min-w-0 flex-col">
      {/* 模型可见性（顶部低饱和展示） */}
      {modelInfo && (
        <div className="text-[11px] text-token-muted font-mono mb-2">
          评估模型：{modelInfo.model}{modelInfo.platform ? ` · ${modelInfo.platform}` : ''}
        </div>
      )}

      {/* 错误提示 */}
      {isError && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-token-subtle bg-token-nested px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm text-[color:var(--accent-fg-danger)]">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">{streamError ?? run.errorMessage ?? '评估失败'}</span>
          </div>
          <Button size="sm"
            onClick={handleRerun}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重试（已评分条目保留）
          </Button>
        </div>
      )}

      {/* 进行中：进度 */}
      {inProgress && (
        <div role="status" aria-live="polite" className="mb-4 rounded-lg border border-token-subtle bg-token-nested p-4">
          <div className="flex items-center gap-3 mb-3">
            <MapSpinner size={16} />
            <span className="text-sm text-token-primary">
              {phaseMessage || (run.status === 'Running' && !streaming
                ? '评估正在后台执行，本页每 4 秒自动刷新进度...'
                : '评估准备中...')}
            </span>
          </div>
          {(() => {
            // SSE 进度优先；轮询兜底时退化用 run 上持久化的进度
            const p = progress ?? (run.itemCount > 0 ? { done: run.scoredCount, total: run.itemCount } : null);
            if (!p || p.total <= 0) return null;
            return (
              <>
                <div className="h-1.5 rounded-full bg-token-input overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${Math.round((p.done / p.total) * 100)}%`, background: 'var(--accent-fg-blue)' }}
                  />
                </div>
                <div className="text-xs text-token-muted mt-2">
                  已评估 {p.done} / {p.total} 条
                </div>
              </>
            );
          })()}
        </div>
      )}

      {/* Done：结论概览 */}
      {isDone && (
        <div className="mb-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            {(['P0', 'P1', 'P2', 'P3'] as const).map(tier => (
              <div key={tier} className={`rounded-md border px-2.5 py-1.5 text-xs ${TIER_STYLES[tier]}`}>
                {tier} <span className="font-semibold">{tierCounts[tier] ?? 0}</span> 条
              </div>
            ))}
            {orderedItems.some(x => x.isContractualOverride) && (
              <div className="rounded-md border border-token-subtle bg-token-nested px-2.5 py-1.5 text-xs text-[color:var(--accent-fg-blue)]">
                签约置顶 <span className="font-semibold">{orderedItems.filter(x => x.isContractualOverride).length}</span> 条
              </div>
            )}
            {orderedItems.some(x => x.reasonablenessVerdict === '不合理') && (
              <div className="rounded-md border border-token-subtle bg-token-nested px-2.5 py-1.5 text-xs text-[color:var(--accent-fg-danger)]">
                评论判定不合理 <span className="font-semibold">{orderedItems.filter(x => x.reasonablenessVerdict === '不合理').length}</span> 条
              </div>
            )}
          </div>
          {run.globalMissingHints.length > 0 && (
            <div className="space-y-1 rounded-lg border border-token-subtle bg-token-nested px-4 py-3 text-xs text-[color:var(--accent-fg-amber)]">
              {run.globalMissingHints.map((hint, i) => (
                <p key={i}>{hint}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 结果表（进行中实时增长 / 完成后按优先级排序） */}
      {(orderedItems.length > 0 || failedItems.length > 0) && (
        <div className="overflow-hidden rounded-lg border border-token-subtle">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] table-fixed text-sm">
              <thead className="bg-token-nested">
                <tr className="text-xs text-token-secondary border-b border-token-subtle">
                  <th className="text-left px-4 py-2.5 font-medium w-16">{isDone ? '优先级' : '行号'}</th>
                  <th className="text-left px-4 py-2.5 font-medium">需求</th>
                  <th className="text-right px-4 py-2.5 font-medium w-20">总分</th>
                  <th className="text-left px-4 py-2.5 font-medium w-16">分档</th>
                  <th className="text-right px-4 py-2.5 font-medium w-24">证据齐全度</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {orderedItems.map(item => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    isDone={isDone}
                    anchorScale={run.anchorScale ?? 5}
                    expanded={expandedId === item.id}
                    onToggle={() => setExpandedId(prev => (prev === item.id ? null : item.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {failedItems.length > 0 && (
            <div className="px-4 py-3 border-t border-token-subtle text-xs text-[color:var(--accent-fg-danger)]">
              {failedItems.length} 条需求评估失败未纳入排序：
              {failedItems.map(x => `第 ${x.rowIndex} 行「${x.name}」`).join('、')}
              {isDone && '，可点击上方重试补评'}
            </div>
          )}
        </div>
      )}
      </div>
    </SectionShell>
  );
}

function ItemRow({
  item,
  isDone,
  anchorScale,
  expanded,
  onToggle,
}: {
  item: RequirementAssessmentItem;
  isDone: boolean;
  anchorScale: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isUnreasonable = item.reasonablenessVerdict === '不合理';
  return (
    <>
      <tr
        onClick={onToggle}
        className="border-b border-token-subtle hover-bg-soft cursor-pointer transition-colors"
      >
        <td className="px-4 py-3 text-token-primary font-medium">
          {isDone ? (
            <span className="inline-flex items-center gap-1.5">
              {item.priority}
              {item.isContractualOverride && (
                <span className="rounded border border-token-subtle bg-token-nested px-1 text-[10px] text-[color:var(--accent-fg-blue)]">置顶</span>
              )}
            </span>
          ) : (
            item.rowIndex
          )}
        </td>
        <td className="px-4 py-3">
          <p title={item.name} className="text-token-primary truncate">
            {isUnreasonable && (
              <span className="mr-1.5 rounded border border-token-subtle bg-token-nested px-1 text-[10px] text-[color:var(--accent-fg-danger)] align-middle">不合理</span>
            )}
            {item.name}
          </p>
          {item.conclusion && (
            <p title={item.conclusion} className="text-xs text-token-secondary mt-0.5 truncate">{item.conclusion}</p>
          )}
        </td>
        <td className="px-4 py-3 text-right text-token-primary font-mono">{item.totalScore}</td>
        <td className="px-4 py-3"><TierChip tier={item.tier} /></td>
        <td className="px-4 py-3 text-right text-xs text-token-muted">{item.confidencePercent}%</td>
        <td className="px-2 py-3 text-token-muted">
          <button type="button" aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}${item.name}的评估依据`} onClick={(event) => { event.stopPropagation(); onToggle(); }} className="rounded p-1 hover-bg-soft focus-visible:outline focus-visible:outline-2">{expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-token-subtle">
          <td colSpan={6} className="px-4 py-4 bg-token-card">
            {item.reasonablenessVerdict && (
              <p className={`text-xs mb-3 ${isUnreasonable ? 'text-[color:var(--accent-fg-danger)]' : 'text-[color:var(--accent-fg-success)]'}`}>
                合理性判定：{item.reasonablenessVerdict}
                {isUnreasonable && <span className="text-token-muted">（已强制 P3 并排序置底）</span>}
                {item.reasonablenessEvidence && (
                  <span className="block text-token-muted mt-0.5">依据：{item.reasonablenessEvidence}</span>
                )}
              </p>
            )}
            <table className="w-full text-xs mb-3">
              <thead>
                <tr className="text-token-secondary border-b border-token-subtle">
                  <th className="text-left py-1.5 pr-3 font-medium w-32">因子</th>
                  <th className="text-right py-1.5 pr-3 font-medium w-16">锚点</th>
                  <th className="text-right py-1.5 pr-3 font-medium w-16">得分</th>
                  <th className="text-left py-1.5 font-medium">评估依据</th>
                </tr>
              </thead>
              <tbody>
                {item.factorScores.map(f => (
                  <tr key={f.key} className="border-b border-token-subtle">
                    <td className="py-1.5 pr-3 text-token-primary">{f.name}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-token-secondary">{f.anchor}/{anchorScale}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-token-secondary">{f.weightedScore}</td>
                    <td className="py-1.5 text-token-muted">
                      {f.hasEvidence ? f.evidence : <span className="text-[color:var(--accent-fg-amber)]">表格中无证据，按保守值计</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {item.missingInfo.length > 0 && (
              <p className="text-[11px] text-[color:var(--accent-fg-amber)] mb-1">建议补充信息：{item.missingInfo.join('、')}</p>
            )}
            {item.adjustmentLog.length > 0 && (
              <details className="text-[11px] text-token-muted">
                <summary className="cursor-pointer">系统调整记录（{item.adjustmentLog.length} 条）</summary>
                <ul className="mt-1 space-y-0.5 pl-4 list-disc">
                  {item.adjustmentLog.map((log, i) => (
                    <li key={i}>{log}</li>
                  ))}
                </ul>
              </details>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

