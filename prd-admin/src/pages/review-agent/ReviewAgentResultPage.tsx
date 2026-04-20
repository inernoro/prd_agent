import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ClipboardCheck, ArrowLeft, CheckCircle, XCircle, ChevronDown, ChevronUp, AlertTriangle, User, RefreshCw } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { SseTypingBlock } from '@/components/sse/SseTypingBlock';
import { getReviewSubmission, getReviewResultStreamUrl, rerunReviewSubmission, getReviewDimensions } from '@/services';
import type { ReviewSubmission, ReviewResult, ReviewDimensionScore, ReviewDimensionConfig, DimensionCheckItemResult } from '@/services';

function ChecklistTable({ items }: { items: DimensionCheckItemResult[] }) {
  const grouped = items.reduce<Record<string, DimensionCheckItemResult[]>>((acc, it) => {
    const key = it.category || '其他';
    (acc[key] ||= []).push(it);
    return acc;
  }, {});
  const total = items.length;
  const passed = items.filter(it => !it.involved || it.covered).length;

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
        <p className="text-xs text-white/50 font-medium">全局规则检查清单</p>
        <p className="text-xs tabular-nums text-white/40">
          通过 <span className="text-emerald-400">{passed}</span> / {total}
        </p>
      </div>
      <div className="divide-y divide-white/5">
        {Object.entries(grouped).map(([cat, list]) => (
          <div key={cat} className="px-3 py-2">
            <p className="text-[11px] text-indigo-400/80 mb-1.5 font-medium">{cat}</p>
            <div className="space-y-1">
              {list.map(item => {
                const passedItem = !item.involved || item.covered;
                const isRisk = item.involved && !item.covered;
                const tagBg = !item.involved
                  ? 'bg-white/5 text-white/40'
                  : item.covered
                    ? 'bg-emerald-500/10 text-emerald-300'
                    : 'bg-rose-500/15 text-rose-300';
                const label = !item.involved ? '不涉及' : item.covered ? '已包含' : '涉及 · 缺失';
                return (
                  <div
                    key={item.id}
                    className={`flex items-start gap-2 rounded px-2 py-1.5 ${isRisk ? 'bg-rose-500/5' : ''}`}
                  >
                    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${tagBg}`}>{label}</span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs leading-relaxed ${passedItem ? 'text-white/55' : 'text-rose-200'}`}>
                        {item.text}
                      </p>
                      {item.evidence && (
                        <p className="text-[11px] text-white/35 mt-0.5 leading-relaxed">{item.evidence}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RawOutputDebug({ result }: { result: ReviewResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mb-4 bg-amber-500/8 border border-amber-500/20 rounded-xl p-4">
      <div className="flex items-start gap-2 mb-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-300">评分解析失败</p>
          {result.parseError && (
            <p className="text-xs text-amber-400/70 mt-0.5 font-mono break-all">{result.parseError}</p>
          )}
        </div>
      </div>
      <button
        onClick={() => setExpanded(v => !v)}
        className="text-xs text-amber-400/60 hover:text-amber-400 transition-colors flex items-center gap-1"
      >
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        {expanded ? '收起' : '查看'} AI 原始输出（用于诊断）
      </button>
      {expanded && (
        <pre className="mt-3 text-xs text-white/50 bg-black/20 rounded p-3 overflow-auto max-h-64 whitespace-pre-wrap break-all">
          {result.fullMarkdown || '（空）'}
        </pre>
      )}
    </div>
  );
}

export function ReviewAgentResultPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [submission, setSubmission] = useState<ReviewSubmission | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [dimensionScores, setDimensionScores] = useState<ReviewDimensionScore[]>([]);
  const [summary, setSummary] = useState('');
  const [totalScore, setTotalScore] = useState<number | null>(null);
  const [isPassed, setIsPassed] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [dimConfigs, setDimConfigs] = useState<ReviewDimensionConfig[]>([]);
  const [expandedDims, setExpandedDims] = useState<Set<string>>(new Set());
  const [streaming, setStreaming] = useState(false);
  const [rerunning, setRerunning] = useState(false);

  const loadData = useCallback(async () => {
    if (!id) return;
    const res = await getReviewSubmission(id);
    if (res.success && res.data) {
      setSubmission(res.data.submission);
      if (res.data.result) {
        setResult(res.data.result);
        setDimensionScores(res.data.result.dimensionScores);
        setSummary(res.data.result.summary);
        setTotalScore(res.data.result.totalScore);
        setIsPassed(res.data.result.isPassed);
        // 默认展开所有维度
        setExpandedDims(new Set(res.data.result.dimensionScores.map((d: { key: string }) => d.key)));
      }
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { loadData(); }, [loadData]);

  // 加载维度配置（用于显示明细要求）
  useEffect(() => {
    getReviewDimensions().then(res => {
      if (res.success && res.data) setDimConfigs(res.data.dimensions);
    });
  }, []);

  const sse = useSseStream<ReviewDimensionScore>({
    url: '',
    itemEvent: 'dimension_score',
    onItem: (item) => {
      setDimensionScores(prev => {
        const existing = prev.find(d => d.key === item.key);
        return existing ? prev.map(d => d.key === item.key ? item : d) : [...prev, item];
      });
      // 流式新增维度自动展开
      setExpandedDims(prev => new Set([...prev, item.key]));
    },
    onEvent: {
      result: (data: unknown) => {
        const d = data as { totalScore: number; isPassed: boolean; summary: string };
        setTotalScore(d.totalScore);
        setIsPassed(d.isPassed);
        setSummary(d.summary);
      },
    },
    onDone: () => {
      setStreaming(false);
      loadData();
    },
    onError: (msg) => {
      console.error('评审流错误:', msg);
      setStreaming(false);
      loadData();
    },
  });

  // 自动开始 SSE：未完成的 submission
  useEffect(() => {
    if (!submission || streaming) return;
    if (submission.status === 'Queued' || submission.status === 'Running') {
      setStreaming(true);
      sse.start({ url: getReviewResultStreamUrl(submission.id) });
    }
  }, [submission]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleRerun() {
    if (!id || rerunning) return;
    setRerunning(true);
    try {
      const res = await rerunReviewSubmission(id);
      if (res.success) {
        setResult(null);
        setDimensionScores([]);
        setSummary('');
        setTotalScore(null);
        setIsPassed(null);
        setExpandedDims(new Set());
        setStreaming(true);
        setSubmission(prev => prev ? { ...prev, status: 'Queued', resultId: undefined } : prev);
        sse.start({ url: getReviewResultStreamUrl(id!) });
      }
    } finally {
      setRerunning(false);
    }
  }

  function toggleDim(key: string) {
    setExpandedDims(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-indigo-500/50 border-t-indigo-400 rounded-full animate-spin" />
      </div>
    );
  }

  if (!submission) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 text-center">
        <p className="text-white/40">提交记录不存在</p>
        <button onClick={() => navigate('/review-agent')} className="mt-4 text-indigo-400 hover:text-indigo-300 text-sm">
          返回列表
        </button>
      </div>
    );
  }

  const isDone = submission.status === 'Done' || totalScore !== null;
  const isError = submission.status === 'Error';
  const isRunning = streaming || (!isDone && !isError);

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* 返回导航 */}
      <button
        onClick={() => navigate('/review-agent')}
        className="flex items-center gap-1.5 text-sm text-white/40 hover:text-white/70 mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        返回我的提交
      </button>

      {/* 方案信息 */}
      <div className="bg-white/3 border border-white/8 rounded-xl p-5 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/10 flex items-center justify-center flex-shrink-0">
              <ClipboardCheck className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-white">{submission.title}</h1>
              <p className="text-xs text-white/40 mt-0.5">{submission.fileName} · {new Date(submission.submittedAt).toLocaleString('zh-CN')}</p>
            </div>
          </div>
          {/* 总分/状态 */}
          {isDone && totalScore !== null && !isRunning && (
            <div className="flex-shrink-0 text-right">
              <div className={`text-2xl font-bold ${isPassed ? 'text-emerald-400' : 'text-orange-400'}`}>
                {totalScore}分
              </div>
              <div className={`flex items-center gap-1 text-xs mt-0.5 justify-end ${isPassed ? 'text-emerald-400/80' : 'text-orange-400/80'}`}>
                {isPassed ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                {isPassed ? '已通过' : '未通过'}
              </div>
            </div>
          )}
          {isRunning && (
            <div className="flex-shrink-0">
              <div className="flex items-center gap-1.5 text-xs text-amber-400/80">
                <MapSpinner size={14} />
                评审中
              </div>
            </div>
          )}
          {isError && !isRunning && (
            <div className="flex-shrink-0">
              <div className="flex items-center gap-1.5 text-xs text-red-400/80">
                <XCircle className="w-3.5 h-3.5" />
                失败
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 评审进行中：SSE 实时状态 */}
      {isRunning && (
        <div className="mb-6 space-y-4">
          <SsePhaseBar phase={sse.phase} message={sse.phaseMessage} />
          {sse.typing && (
            <div className="bg-white/3 border border-white/8 rounded-xl p-4">
              <p className="text-xs text-white/40 mb-2 font-medium">AI 评审中...</p>
              <SseTypingBlock text={sse.typing} />
            </div>
          )}
        </div>
      )}

      {/* 分项评分结果 */}
      {dimensionScores.length > 0 && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-white/60 mb-3">分项评分</h2>
          <div className="space-y-2">
            {dimensionScores.map((dim) => {
              const pct = dim.maxScore > 0 ? (dim.score / dim.maxScore) * 100 : 0;
              const isExpanded = expandedDims.has(dim.key);
              const scoreColor = pct >= 90 ? 'text-emerald-400' : pct >= 75 ? 'text-cyan-400' : pct >= 60 ? 'text-amber-400' : 'text-rose-400';
              const barColor = pct >= 90 ? 'bg-emerald-500' : pct >= 75 ? 'bg-cyan-500' : pct >= 60 ? 'bg-amber-500' : 'bg-rose-500';
              const dimCfg = dimConfigs.find(c => c.key === dim.key);

              return (
                <div key={dim.key} className="bg-white/3 border border-white/8 rounded-lg overflow-hidden">
                  <button
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/3 transition-colors"
                    onClick={() => toggleDim(dim.key)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-sm text-white/80">{dim.name}</span>
                        <span className={`text-sm font-semibold tabular-nums ${scoreColor}`}>
                          {dim.score}/{dim.maxScore}
                        </span>
                      </div>
                      <div className="h-1.5 bg-white/8 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-white/30 flex-shrink-0">
                      {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="px-4 pb-3 border-t border-white/5 pt-3 space-y-2.5">
                      {dim.comment && (
                        <p className="text-sm text-white/60 leading-relaxed">{dim.comment}</p>
                      )}
                      {dim.items && dim.items.length > 0 && (
                        <ChecklistTable items={dim.items} />
                      )}
                      {dimCfg?.description && (
                        <div className="rounded-lg px-3 py-2" style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)' }}>
                          <p className="text-xs text-indigo-400/70 mb-1 font-medium">明细要求</p>
                          <p className="text-xs text-white/40 leading-relaxed whitespace-pre-wrap">{dimCfg.description}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* AI 总结评语 */}
      {summary && !isRunning && (
        <div className="mb-6 bg-white/3 border border-white/8 rounded-xl p-5">
          <h2 className="text-sm font-medium text-white/60 mb-3">AI 总结评语</h2>
          <p className="text-sm text-white/70 leading-relaxed">{summary}</p>
        </div>
      )}

      {/* 解析错误 / 原始 AI 输出诊断（仅当解析失败时显示） */}
      {isDone && !isRunning && result?.parseError && (
        <RawOutputDebug result={result} />
      )}

      {/* 底部：失败重评审 + 提交人 */}
      {(isDone || isError) && !isRunning && (
        <div className="flex items-center justify-between mt-4">
          <div>
            {isError && (
              <button
                onClick={handleRerun}
                disabled={rerunning}
                className="flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${rerunning ? 'animate-spin' : ''}`} />
                重新评审
              </button>
            )}
          </div>
          {submission.submitterName && (
            <div className="flex items-center gap-1.5 text-sm text-white/35">
              <User className="w-3.5 h-3.5" />
              {submission.submitterName}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
