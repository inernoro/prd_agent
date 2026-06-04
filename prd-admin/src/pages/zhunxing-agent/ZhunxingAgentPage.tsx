import { useMemo, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { askZhunxing, submitZhunxingFeedback, type ZhunxingAskResponse } from '@/services/real/zhunxing';
import { AlertCircle, ChevronDown, ChevronUp, Search, ShieldAlert, ShieldCheck } from 'lucide-react';

const STARTERS = [
  '员工迟到怎么认定？',
  '跨部门交接最少要包含哪些信息？',
  '请假审批的标准流程是什么？',
];

export default function ZhunxingAgentPage() {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ZhunxingAskResponse | null>(null);
  const [expandedClauseIds, setExpandedClauseIds] = useState<Set<string>>(new Set());
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  const confidencePercent = useMemo(() => Math.round((result?.confidence ?? 0) * 100), [result?.confidence]);

  const confidenceTone = useMemo(() => {
    if (confidencePercent >= 80) return '#34D399';
    if (confidencePercent >= 60) return '#FBBF24';
    return '#FB923C';
  }, [confidencePercent]);

  const riskMeta = useMemo(() => {
    const riskLevel = result?.riskLevel ?? 'public';
    if (riskLevel === 'sensitive') return { label: '高风险', color: '#FB7185' };
    if (riskLevel === 'internal') return { label: '内部', color: '#FBBF24' };
    return { label: '公开', color: '#60A5FA' };
  }, [result?.riskLevel]);

  const runAsk = async (q?: string) => {
    const text = (q ?? question).trim();
    if (!text || loading) return;

    setLoading(true);
    setError(null);
    setFeedbackStatus(null);
    setFeedbackError(null);
    setExpandedClauseIds(new Set());
    try {
      const res = await askZhunxing(text, 3);
      if (!res.success || !res.data) {
        setResult(null);
        setError(res.error?.message || '准星暂时不可用，请稍后重试');
        return;
      }
      setQuestion(text);
      setResult(res.data);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : '网络异常，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const toggleClauseExpand = (clauseId: string) => {
    setExpandedClauseIds((prev) => {
      const next = new Set(prev);
      if (next.has(clauseId)) {
        next.delete(clauseId);
      } else {
        next.add(clauseId);
      }
      return next;
    });
  };

  const submitNoMatchFeedback = async () => {
    if (!question.trim() || submittingFeedback) return;

    setSubmittingFeedback(true);
    setFeedbackError(null);
    setFeedbackStatus(null);
    try {
      const res = await submitZhunxingFeedback({
        question: question.trim(),
        matched: false,
        confidence: result?.confidence ?? 0,
        feedbackType: 'no_match',
        citationClauseIds: [],
      });
      if (!res.success || !res.data) {
        setFeedbackError(res.error?.message || '反馈提交失败，请稍后重试');
        return;
      }

      setFeedbackStatus('未命中反馈已提交，管理员会补充规则后自动提升命中率。');
    } catch (e) {
      setFeedbackError(e instanceof Error ? e.message : '反馈提交失败，请稍后重试');
    } finally {
      setSubmittingFeedback(false);
    }
  };

  return (
    <div className="h-full min-h-0 overflow-auto px-4 py-4">
      <div className="max-w-5xl mx-auto flex flex-col gap-4">
        <GlassCard variant="subtle" animated className="p-4">
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: 'rgba(59, 130, 246, 0.15)',
                border: '1px solid rgba(59, 130, 246, 0.35)',
              }}
            >
              <ShieldCheck size={20} style={{ color: '#60A5FA' }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                准星智能体
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                面向公司制度、产研规范、跨部门协作流程的问答入口
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: 'rgba(255,255,255,0.4)' }}
              />
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void runAsk();
                  }
                }}
                placeholder="输入你的问题，例如：考勤、请假、交接流程..."
                className="w-full pl-9 pr-3 py-2.5 rounded-lg text-sm outline-none"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'var(--text-primary)',
                }}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void runAsk(s)}
                  className="px-2.5 py-1 rounded-md text-xs transition-colors"
                  style={{
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {s}
                </button>
              ))}
            </div>

            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={() => void runAsk()} disabled={!question.trim() || loading}>
                {loading ? <MapSpinner size={14} color="var(--text-primary)" /> : null}
                提交问题
              </Button>
            </div>
          </div>
        </GlassCard>

        {error && (
          <GlassCard variant="subtle" animated className="p-3 flex items-center gap-2">
            <AlertCircle size={16} style={{ color: '#FB923C' }} />
            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
              {error}
            </span>
          </GlassCard>
        )}

        {result && (
          <GlassCard variant="subtle" animated className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span
                className="px-2 py-0.5 rounded-md text-xs"
                style={{
                  background: result.matched ? 'rgba(52, 211, 153, 0.15)' : 'rgba(251, 146, 60, 0.15)',
                  border: result.matched ? '1px solid rgba(52, 211, 153, 0.4)' : '1px solid rgba(251, 146, 60, 0.4)',
                  color: result.matched ? '#34D399' : '#FB923C',
                }}
              >
                {result.matched ? '已命中条款' : '未命中'}
              </span>
              <span
                className="px-2 py-0.5 rounded-md text-xs"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${confidenceTone}66`,
                  color: confidenceTone,
                }}
              >
                置信度 {confidencePercent}%
              </span>
              <span
                className="px-2 py-0.5 rounded-md text-xs"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: `1px solid ${riskMeta.color}66`,
                  color: riskMeta.color,
                }}
              >
                风险等级：{riskMeta.label}
              </span>
            </div>

            <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
              回答
            </div>
            <div className="text-sm leading-6 whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>
              {result.answer}
            </div>

            {result.followUpSuggestion && (
              <div className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                建议下一步：{result.followUpSuggestion}
              </div>
            )}

            {!result.matched && (
              <div className="mt-3 flex flex-col gap-2">
                <div
                  className="rounded-lg p-2.5 text-xs"
                  style={{
                    background: 'rgba(251, 146, 60, 0.08)',
                    border: '1px solid rgba(251, 146, 60, 0.25)',
                    color: 'rgba(255,255,255,0.8)',
                  }}
                >
                  当前问题未命中有效条款，可一键反馈给管理员补充知识库。
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void submitNoMatchFeedback()}
                    disabled={submittingFeedback}
                  >
                    {submittingFeedback ? <MapSpinner size={14} color="var(--text-primary)" /> : <ShieldAlert size={14} />}
                    提交未命中反馈
                  </Button>
                  {feedbackStatus && (
                    <span className="text-xs" style={{ color: '#34D399' }}>
                      {feedbackStatus}
                    </span>
                  )}
                  {feedbackError && (
                    <span className="text-xs" style={{ color: '#FB923C' }}>
                      {feedbackError}
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="mt-4">
              <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
                依据条款
              </div>
              <div className="flex flex-col gap-2">
                {result.citations.map((c, idx) => (
                  <div
                    key={c.clauseId || `${c.documentId}-${c.chapter}-${idx}`}
                    className="rounded-lg p-2.5"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {c.documentTitle} / {c.chapter} / {c.clauseTitle}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span
                        className="px-2 py-0.5 rounded-md text-[11px]"
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: 'var(--text-muted)',
                        }}
                      >
                        匹配分：{c.matchScore}
                      </span>
                      <span
                        className="px-2 py-0.5 rounded-md text-[11px]"
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: c.riskLevel === 'sensitive' ? '#FB7185' : c.riskLevel === 'internal' ? '#FBBF24' : '#60A5FA',
                        }}
                      >
                        {c.riskLevel === 'sensitive' ? '高风险' : c.riskLevel === 'internal' ? '内部' : '公开'}
                      </span>
                    </div>
                    <div className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>
                      {expandedClauseIds.has(c.clauseId) ? c.fullText : c.snippet}
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleClauseExpand(c.clauseId)}
                      className="mt-2 inline-flex items-center gap-1 text-xs transition-opacity hover:opacity-90"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {expandedClauseIds.has(c.clauseId) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      {expandedClauseIds.has(c.clauseId) ? '收起全文' : '展开全文'}
                    </button>
                  </div>
                ))}
                {result.citations.length === 0 && (
                  <div className="rounded-lg p-2.5 text-xs" style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-muted)' }}>
                    当前没有可展示的依据条款。
                  </div>
                )}
              </div>
            </div>
          </GlassCard>
        )}
      </div>
    </div>
  );
}
