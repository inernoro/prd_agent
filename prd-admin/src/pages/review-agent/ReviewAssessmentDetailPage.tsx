import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ListOrdered, Download, RefreshCw, ChevronDown, ChevronRight, Play, AlertTriangle, FileSpreadsheet } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { connectSse } from '@/lib/useSseStream';
import {
  getAssessment,
  startAssessment,
  rerunAssessment,
  getAssessmentStreamUrl,
  downloadAssessmentReport,
} from '@/services';
import type {
  RequirementAssessmentRun,
  RequirementAssessmentItem,
  RequirementFactorDefinition,
} from '@/services';

const TIER_STYLES: Record<string, string> = {
  P0: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  P1: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  P2: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
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

  const [run, setRun] = useState<RequirementAssessmentRun | null>(null);
  const [items, setItems] = useState<RequirementAssessmentItem[]>([]);
  const [factors, setFactors] = useState<RequirementFactorDefinition[]>([]);
  const [previewRows, setPreviewRows] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 列映射编辑态（Draft）
  const [nameCol, setNameCol] = useState<number | ''>('');
  const [descCol, setDescCol] = useState<number | ''>('');
  const [factorCols, setFactorCols] = useState<Record<string, number[]>>({});
  const [starting, setStarting] = useState(false);

  // 评估流态
  const [streaming, setStreaming] = useState(false);
  const [phaseMessage, setPhaseMessage] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number; message?: string } | null>(null);
  const [modelInfo, setModelInfo] = useState<{ model: string; platform?: string | null } | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    const res = await getAssessment(id);
    if (res.success && res.data) {
      setRun(res.data.run);
      setItems(res.data.items);
      setFactors(res.data.factors);
      setPreviewRows(res.data.previewRows ?? []);
      if (res.data.run.status === 'Draft') {
        setNameCol(res.data.run.nameColumnIndex ?? '');
        setDescCol(res.data.run.descColumnIndex ?? '');
        setFactorCols(res.data.run.factorColumnMapping ?? {});
      }
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
              setProgress({ done: data.done ?? 0, total: data.total ?? 0, message: data.message });
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
      // Queued 任务进入页面即自动开始评估（断点续评同样走这里）
      if (!cancelled && data && data.run.status === 'Queued') startStream();
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const toggleFactorCol = (factorKey: string, colIndex: number) => {
    setFactorCols(prev => {
      const cols = prev[factorKey] ?? [];
      const next = cols.includes(colIndex) ? cols.filter(c => c !== colIndex) : [...cols, colIndex];
      return { ...prev, [factorKey]: next };
    });
  };

  const handleStart = async () => {
    if (nameCol === '' || starting) return;
    setStarting(true);
    const res = await startAssessment(id, {
      nameColumnIndex: nameCol,
      descColumnIndex: descCol === '' ? null : descCol,
      factorColumns: factorCols,
    });
    setStarting(false);
    if (res.success && res.data) {
      setRun(res.data.run);
      startStream();
    } else {
      setStreamError(res.error?.message ?? '启动评估失败');
    }
  };

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

  if (loading) return <div className="max-w-5xl mx-auto px-4 py-6"><MapSectionLoader /></div>;
  if (!run) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-16 text-center text-sm text-token-muted">
        评估任务不存在或无权限查看
      </div>
    );
  }

  const isDraft = run.status === 'Draft';
  const isDone = run.status === 'Done';
  const isError = run.status === 'Error' || (!!streamError && !streaming);
  const inProgress = streaming || run.status === 'Running' || run.status === 'Queued';
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
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* 模型可见性（顶部低饱和展示） */}
      {modelInfo && (
        <div className="text-[11px] text-token-muted font-mono mb-2">
          评估模型：{modelInfo.model}{modelInfo.platform ? ` · ${modelInfo.platform}` : ''}
        </div>
      )}

      {/* 页头 */}
      <div className="flex items-center justify-between mb-6 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate('/review-agent/assessments')}
            className="p-2 rounded-lg bg-token-nested border border-token-subtle hover-bg-soft transition-colors flex-shrink-0"
            title="返回需求评估列表"
          >
            <ArrowLeft className="w-4 h-4 text-token-secondary" />
          </button>
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
            <ListOrdered className="w-5 h-5 text-indigo-400" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-token-primary truncate">{run.title}</h1>
            <p className="text-sm text-token-muted mt-0.5 truncate">
              {run.fileName} · 工作表 {run.sheetName}
              {run.itemCount > 0 ? ` · ${run.itemCount} 条需求` : ` · ${run.totalRowCount} 行数据`}
              {run.truncated && `（超出上限已截取前 ${run.headers.length > 0 ? '300' : ''} 条）`}
            </p>
          </div>
        </div>
        {isDone && (
          <button
            onClick={() => downloadAssessmentReport(run.id, run.title)}
            className="flex items-center gap-1.5 text-sm text-token-secondary hover-text-primary bg-token-nested hover-bg-soft border border-token-subtle rounded-lg px-3 py-2 transition-colors flex-shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            导出报告
          </button>
        )}
      </div>

      {/* 错误提示 */}
      {isError && (
        <div className="mb-5 flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30">
          <div className="flex items-center gap-2 text-sm text-red-400 min-w-0">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span className="truncate">{streamError ?? run.errorMessage ?? '评估失败'}</span>
          </div>
          <button
            onClick={handleRerun}
            className="flex items-center gap-1.5 text-sm text-white bg-red-600/80 hover:bg-red-500 rounded-lg px-3 py-1.5 transition-colors flex-shrink-0"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重试（已评分条目保留）
          </button>
        </div>
      )}

      {/* Draft：列映射确认 */}
      {isDraft && (
        <div className="space-y-5">
          <div className="bg-token-nested border border-token-subtle rounded-xl p-5">
            <h2 className="text-sm font-medium text-token-primary mb-1">第一步：确认列映射</h2>
            <p className="text-xs text-token-muted mb-4">
              AI 已给出建议映射，请核对需求名称列与各评估因子的证据来源列。映射越准确，评估依据越充分。
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
              <div>
                <label className="block text-xs text-token-secondary mb-1.5">需求名称列（必选）</label>
                <select
                  value={nameCol}
                  onChange={e => setNameCol(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full bg-token-input border border-token-subtle rounded-lg px-3 py-2 text-sm text-token-primary focus:outline-none focus:border-indigo-500/50"
                >
                  <option value="">请选择...</option>
                  {run.headers.map((h, i) => (
                    <option key={i} value={i}>{h}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-token-secondary mb-1.5">需求描述列（可选）</label>
                <select
                  value={descCol}
                  onChange={e => setDescCol(e.target.value === '' ? '' : Number(e.target.value))}
                  className="w-full bg-token-input border border-token-subtle rounded-lg px-3 py-2 text-sm text-token-primary focus:outline-none focus:border-indigo-500/50"
                >
                  <option value="">不指定</option>
                  {run.headers.map((h, i) => (
                    <option key={i} value={i}>{h}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-3">
              {factors.map(f => (
                <div key={f.key} className="flex flex-col sm:flex-row sm:items-center gap-2">
                  <div className="w-44 flex-shrink-0">
                    <span className="text-xs text-token-primary">{f.name}</span>
                    <span className="text-[11px] text-token-muted ml-1.5">权重 {f.weight}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {run.headers.map((h, i) => {
                      const active = (factorCols[f.key] ?? []).includes(i);
                      return (
                        <button
                          key={i}
                          onClick={() => toggleFactorCol(f.key, i)}
                          className={`text-[11px] px-2 py-1 rounded-md border transition-colors ${
                            active
                              ? 'bg-indigo-600 text-white border-indigo-500'
                              : 'bg-token-input text-token-muted border-token-subtle hover-text-primary'
                          }`}
                        >
                          {h}
                        </button>
                      );
                    })}
                    {(factorCols[f.key] ?? []).length === 0 && (
                      <span className="text-[11px] text-token-muted self-center">未映射（将从需求描述中找证据，找不到按保守值计）</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 数据预览 */}
          {previewRows.length > 0 && (
            <div className="bg-token-nested border border-token-subtle rounded-xl p-5">
              <h2 className="text-sm font-medium text-token-primary mb-3 flex items-center gap-2">
                <FileSpreadsheet className="w-4 h-4 text-token-muted" />
                数据预览（前 {previewRows.length} 行 / 共 {run.totalRowCount} 行）
              </h2>
              <div className="overflow-x-auto">
                <table className="text-xs w-full">
                  <thead>
                    <tr>
                      {run.headers.map((h, i) => (
                        <th key={i} className="text-left px-2 py-1.5 text-token-secondary font-medium whitespace-nowrap border-b border-token-subtle">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map((row, r) => (
                      <tr key={r}>
                        {run.headers.map((_, c) => (
                          <td key={c} className="px-2 py-1.5 text-token-muted whitespace-nowrap max-w-[200px] truncate border-b border-token-subtle/50">
                            {row[c] ?? ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={handleStart}
              disabled={nameCol === '' || starting}
              className="flex items-center gap-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg px-5 py-2.5 transition-colors"
            >
              {starting ? <MapSpinner size={14} /> : <Play className="w-4 h-4" />}
              开始评估（{run.totalRowCount > 300 ? 300 : run.totalRowCount} 条需求）
            </button>
          </div>
        </div>
      )}

      {/* 进行中：进度 + 实时结果 */}
      {!isDraft && inProgress && !isError && (
        <div className="mb-5 bg-token-nested border border-token-subtle rounded-xl p-5">
          <div className="flex items-center gap-3 mb-3">
            <MapSpinner size={16} />
            <span className="text-sm text-token-primary">{phaseMessage || '评估准备中...'}</span>
          </div>
          {progress && progress.total > 0 && (
            <>
              <div className="h-1.5 rounded-full bg-token-input overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-700"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
              <div className="text-xs text-token-muted mt-2">
                已评估 {progress.done} / {progress.total} 条
              </div>
            </>
          )}
        </div>
      )}

      {/* Done：结论概览 */}
      {isDone && (
        <div className="mb-5 space-y-3">
          <div className="flex flex-wrap gap-2">
            {(['P0', 'P1', 'P2', 'P3'] as const).map(tier => (
              <div key={tier} className={`px-3 py-2 rounded-lg border text-sm ${TIER_STYLES[tier]}`}>
                {tier} <span className="font-semibold">{tierCounts[tier] ?? 0}</span> 条
              </div>
            ))}
            {orderedItems.some(x => x.isContractualOverride) && (
              <div className="px-3 py-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 text-sm text-indigo-300">
                签约置顶 <span className="font-semibold">{orderedItems.filter(x => x.isContractualOverride).length}</span> 条
              </div>
            )}
          </div>
          {run.globalMissingHints.length > 0 && (
            <div className="px-4 py-3 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-300/90 space-y-1">
              {run.globalMissingHints.map((hint, i) => (
                <p key={i}>{hint}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 结果表（进行中实时增长 / 完成后按优先级排序） */}
      {!isDraft && (orderedItems.length > 0 || failedItems.length > 0) && (
        <div className="bg-token-nested border border-token-subtle rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
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
                    expanded={expandedId === item.id}
                    onToggle={() => setExpandedId(prev => (prev === item.id ? null : item.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {failedItems.length > 0 && (
            <div className="px-4 py-3 border-t border-token-subtle text-xs text-red-400/90">
              {failedItems.length} 条需求评估失败未纳入排序：
              {failedItems.map(x => `第 ${x.rowIndex} 行「${x.name}」`).join('、')}
              {isDone && '，可点击右上角重试补评'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ItemRow({
  item,
  isDone,
  expanded,
  onToggle,
}: {
  item: RequirementAssessmentItem;
  isDone: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="border-b border-token-subtle/50 hover-bg-soft cursor-pointer transition-colors"
      >
        <td className="px-4 py-3 text-token-primary font-medium">
          {isDone ? (
            <span className="inline-flex items-center gap-1.5">
              {item.priority}
              {item.isContractualOverride && (
                <span className="text-[10px] text-indigo-300 border border-indigo-500/30 bg-indigo-500/10 rounded px-1">置顶</span>
              )}
            </span>
          ) : (
            item.rowIndex
          )}
        </td>
        <td className="px-4 py-3">
          <p className="text-token-primary truncate max-w-[320px]">{item.name}</p>
          {item.conclusion && (
            <p className="text-xs text-token-muted mt-0.5 truncate max-w-[400px]">{item.conclusion}</p>
          )}
        </td>
        <td className="px-4 py-3 text-right text-token-primary font-mono">{item.totalScore}</td>
        <td className="px-4 py-3"><TierChip tier={item.tier} /></td>
        <td className="px-4 py-3 text-right text-xs text-token-muted">{item.confidencePercent}%</td>
        <td className="px-2 py-3 text-token-muted">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-token-subtle/50">
          <td colSpan={6} className="px-4 py-4 bg-token-card">
            <table className="w-full text-xs mb-3">
              <thead>
                <tr className="text-token-secondary border-b border-token-subtle/60">
                  <th className="text-left py-1.5 pr-3 font-medium w-32">因子</th>
                  <th className="text-right py-1.5 pr-3 font-medium w-16">锚点</th>
                  <th className="text-right py-1.5 pr-3 font-medium w-16">得分</th>
                  <th className="text-left py-1.5 font-medium">评估依据</th>
                </tr>
              </thead>
              <tbody>
                {item.factorScores.map(f => (
                  <tr key={f.key} className="border-b border-token-subtle/30">
                    <td className="py-1.5 pr-3 text-token-primary">{f.name}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-token-secondary">{f.anchor}/5</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-token-secondary">{f.weightedScore}</td>
                    <td className="py-1.5 text-token-muted">
                      {f.hasEvidence ? f.evidence : <span className="text-amber-400/70">表格中无证据，按保守值计</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {item.missingInfo.length > 0 && (
              <p className="text-[11px] text-amber-300/80 mb-1">建议补充信息：{item.missingInfo.join('、')}</p>
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
