import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ClipboardCheck, ArrowLeft, CheckCircle, XCircle, Clock, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { useSseStream } from '@/lib/useSseStream';
import { SsePhaseBar } from '@/components/sse/SsePhaseBar';
import { SseTypingBlock } from '@/components/sse/SseTypingBlock';
import { getReviewSubmission, getReviewResultStreamUrl } from '@/services';
import type { ReviewSubmission, ReviewResult, ReviewDimensionScore } from '@/services';

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
  const [streamStarted, setStreamStarted] = useState(false);

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
    url: id && !result && submission?.status !== 'Error' ? getReviewResultStreamUrl(id) : '',
    itemEvent: 'dimension_score',
    onItem: (item) => {
      setDimensionScores(prev => {
        const existing = prev.find(d => d.key === item.key);
        return existing ? prev.map(d => d.key === item.key ? item : d) : [...prev, item];
      });
    },
    onEvent: (eventType, data) => {
      if (eventType === 'result') {
        const d = data as { totalScore: number; isPassed: boolean; summary: string };
        setTotalScore(d.totalScore);
        setIsPassed(d.isPassed);
        setSummary(d.summary);
      }
    },
    onDone: () => loadData(),
    onError: (msg) => console.error('评审流错误:', msg),
  });

  useEffect(() => {
    if (submission && submission.status !== 'Done' && submission.status !== 'Error' && !streamStarted) {
      setStreamStarted(true);
      sse.start();
    }
  }, [submission, streamStarted, sse]);

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
  const isRunning = !isDone && !isError;

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
          {isDone && totalScore !== null && (
            <div className="flex-shrink-0 text-right">
              <div className={`text-2xl font-bold ${isPassed ? 'text-emerald-400' : 'text-red-400'}`}>
                {totalScore}分
              </div>
              <div className={`flex items-center gap-1 text-xs mt-0.5 justify-end ${isPassed ? 'text-emerald-400/80' : 'text-red-400/80'}`}>
                {isPassed ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                {isPassed ? '通过' : '不通过'}
              </div>
            </div>
          )}
          {isRunning && (
            <div className="flex-shrink-0">
              <div className="flex items-center gap-1.5 text-xs text-amber-400/80">
                <Clock className="w-3.5 h-3.5 animate-pulse" />
                评审中
              </div>
            </div>
          )}
          {isError && (
            <div className="flex-shrink-0">
              <div className="flex items-center gap-1.5 text-xs text-red-400/80">
                <XCircle className="w-3.5 h-3.5" />
                评审失败
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
      {summary && (
        <div className="mb-6 bg-white/3 border border-white/8 rounded-xl p-5">
          <h2 className="text-sm font-medium text-white/60 mb-3">AI 总结评语</h2>
          <p className="text-sm text-white/70 leading-relaxed">{summary}</p>
        </div>
      )}

      {/* 错误状态 */}
      {isError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-5">
          <p className="text-sm text-red-300 mb-3">{submission.errorMessage ?? '评审失败，请重试'}</p>
          <button
            onClick={() => { setStreamStarted(false); sse.start(); }}
            className="flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            重新评审
          </button>
        </div>
      )}
    </div>
  );
}
