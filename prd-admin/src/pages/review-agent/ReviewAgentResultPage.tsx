import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ClipboardCheck, ArrowLeft, CheckCircle, XCircle, ChevronDown, ChevronUp, AlertTriangle, User } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { SseTypingBlock } from '@/components/sse/SseTypingBlock';
import { getReviewSubmission, getReviewResultStreamUrl } from '@/services';
import type { ReviewSubmission, ReviewResult, ReviewDimensionScore } from '@/services';

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
  const [expandedDims, setExpandedDims] = useState<Set<string>>(new Set());
  const [streaming, setStreaming] = useState(false);

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
      }
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { loadData(); }, [loadData]);

  const sse = useSseStream<ReviewDimensionScore>({
    url: '',
    itemEvent: 'dimension_score',
    onItem: (item) => {
      setDimensionScores(prev => {
        const existing = prev.find(d => d.key === item.key);
        return existing ? prev.map(d => d.key === item.key ? item : d) : [...prev, item];
      });
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
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
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
              const scoreColor = pct >= 80 ? 'text-emerald-400' : pct >= 60 ? 'text-amber-400' : 'text-red-400';
              const barColor = pct >= 80 ? 'bg-emerald-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500';

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
                  {isExpanded && dim.comment && (
                    <div className="px-4 pb-3 text-sm text-white/50 border-t border-white/5 pt-3">
                      {dim.comment}
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

      {/* 解析错误 / 原始 AI 输出诊断（仅当所有维度为 0 分时显示） */}
      {isDone && !isRunning && result && totalScore === 0 && (
        <RawOutputDebug result={result} />
      )}

      {/* 底部：提交人信息 */}
      {(isDone || isError) && !isRunning && submission.submitterName && (
        <div className="flex justify-end mt-4">
          <div className="flex items-center gap-1.5 text-sm text-white/35">
            <User className="w-3.5 h-3.5" />
            {submission.submitterName}
          </div>
        </div>
      )}
    </div>
  );
}
