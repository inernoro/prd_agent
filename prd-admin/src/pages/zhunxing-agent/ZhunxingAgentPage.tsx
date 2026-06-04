import { useCallback, useEffect, useMemo, useState } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  askZhunxing,
  getZhunxingFeedbackSummary,
  listZhunxingFeedbacks,
  markZhunxingFeedbackFollowUp,
  replayZhunxingFeedback,
  submitZhunxingFeedback,
  updateZhunxingFeedbackWorkflow,
  type ZhunxingAskResponse,
  type ZhunxingFeedbackListItem,
  type ZhunxingFeedbackListResult,
  type ZhunxingFeedbackSummary,
} from '@/services/real/zhunxing';
import { AlertCircle, BarChart3, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, RefreshCw, Search, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';

const STARTERS = [
  '员工迟到怎么认定？',
  '跨部门交接最少要包含哪些信息？',
  '请假审批的标准流程是什么？',
];

const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  new: '新建',
  triaged: '已受理',
  in_progress: '处理中',
  resolved: '已解决',
  closed: '已关闭',
};

const ANSWER_ROLE_LABELS: Record<'employee' | 'supervisor' | 'hr', string> = {
  employee: '员工版',
  supervisor: '主管版',
  hr: 'HR版',
};

export default function ZhunxingAgentPage() {
  const permissions = useAuthStore((s) => s.permissions);
  const hasWritePermission = useMemo(
    () => permissions.includes('zhunxing-agent.write') || permissions.includes('super'),
    [permissions],
  );

  const [viewMode, setViewMode] = useState<'ask' | 'dashboard'>('ask');

  // Q&A state
  const [question, setQuestion] = useState('');
  const [answerRole, setAnswerRole] = useState<'employee' | 'supervisor' | 'hr'>('employee');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ZhunxingAskResponse | null>(null);
  const [expandedClauseIds, setExpandedClauseIds] = useState<Set<string>>(new Set());
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [feedbackStatus, setFeedbackStatus] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  // Dashboard state
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [feedbackSummary, setFeedbackSummary] = useState<ZhunxingFeedbackSummary | null>(null);
  const [feedbackList, setFeedbackList] = useState<ZhunxingFeedbackListResult | null>(null);
  const [feedbackTypeFilter, setFeedbackTypeFilter] = useState<'all' | 'no_match' | 'answer_inaccurate' | 'missing_context'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'new' | 'triaged' | 'in_progress' | 'resolved' | 'closed'>('all');
  const [matchedFilter, setMatchedFilter] = useState<'all' | 'true' | 'false'>('all');
  const [keywordInput, setKeywordInput] = useState('');
  const [keywordFilter, setKeywordFilter] = useState('');
  const [page, setPage] = useState(1);
  const [actingFeedbackId, setActingFeedbackId] = useState<string | null>(null);
  const [dashboardNotice, setDashboardNotice] = useState<string | null>(null);

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
      const res = await askZhunxing(text, 3, answerRole);
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

  const loadDashboard = useCallback(async () => {
    setDashboardLoading(true);
    setDashboardError(null);
    try {
      const matched = matchedFilter === 'all' ? undefined : matchedFilter === 'true';
      const [summaryRes, listRes] = await Promise.all([
        getZhunxingFeedbackSummary(8),
        listZhunxingFeedbacks({
          feedbackType: feedbackTypeFilter,
          status: statusFilter,
          matched,
          keyword: keywordFilter || undefined,
          page,
          pageSize: 10,
        }),
      ]);

      if (!summaryRes.success || !summaryRes.data) {
        throw new Error(summaryRes.error?.message || '反馈看板摘要加载失败');
      }

      if (!listRes.success || !listRes.data) {
        throw new Error(listRes.error?.message || '反馈列表加载失败');
      }

      setFeedbackSummary(summaryRes.data);
      setFeedbackList(listRes.data);
    } catch (e) {
      setDashboardError(e instanceof Error ? e.message : '反馈看板加载失败');
      setFeedbackSummary(null);
      setFeedbackList(null);
    } finally {
      setDashboardLoading(false);
    }
  }, [feedbackTypeFilter, keywordFilter, matchedFilter, page, statusFilter]);

  useEffect(() => {
    if (viewMode !== 'dashboard') return;
    void loadDashboard();
  }, [viewMode, loadDashboard]);

  const updateFeedbackStatus = useCallback(async (item: ZhunxingFeedbackListItem, status: 'triaged' | 'in_progress' | 'resolved' | 'closed') => {
    if (!hasWritePermission || actingFeedbackId) return;
    setActingFeedbackId(item.id);
    setDashboardError(null);
    setDashboardNotice(null);
    try {
      const res = await updateZhunxingFeedbackWorkflow(item.id, { status });
      if (!res.success || !res.data) {
        setDashboardError(res.error?.message || '状态更新失败');
        return;
      }
      setDashboardNotice(`反馈已更新为「${FEEDBACK_STATUS_LABELS[status] || status}」`);
      await loadDashboard();
    } catch (e) {
      setDashboardError(e instanceof Error ? e.message : '状态更新失败');
    } finally {
      setActingFeedbackId(null);
    }
  }, [actingFeedbackId, hasWritePermission, loadDashboard]);

  const replayFeedback = useCallback(async (item: ZhunxingFeedbackListItem) => {
    if (!hasWritePermission || actingFeedbackId) return;
    setActingFeedbackId(item.id);
    setDashboardError(null);
    setDashboardNotice(null);
    try {
      const res = await replayZhunxingFeedback(item.id, { question: item.question, topK: 3 });
      if (!res.success || !res.data) {
        setDashboardError(res.error?.message || '回放验证失败');
        return;
      }
      setDashboardNotice(
        res.data.matched
          ? `回放验证完成：已命中，置信度 ${Math.round((res.data.confidence ?? 0) * 100)}%`
          : '回放验证完成：仍未命中，建议继续补充条款',
      );
      await loadDashboard();
    } catch (e) {
      setDashboardError(e instanceof Error ? e.message : '回放验证失败');
    } finally {
      setActingFeedbackId(null);
    }
  }, [actingFeedbackId, hasWritePermission, loadDashboard]);

  const followUpFeedback = useCallback(async (item: ZhunxingFeedbackListItem) => {
    if (!hasWritePermission || actingFeedbackId) return;
    setActingFeedbackId(item.id);
    setDashboardError(null);
    setDashboardNotice(null);
    try {
      const res = await markZhunxingFeedbackFollowUp(item.id, {});
      if (!res.success || !res.data) {
        setDashboardError(res.error?.message || '回访标记失败');
        return;
      }
      setDashboardNotice('已记录回访通知');
      await loadDashboard();
    } catch (e) {
      setDashboardError(e instanceof Error ? e.message : '回访标记失败');
    } finally {
      setActingFeedbackId(null);
    }
  }, [actingFeedbackId, hasWritePermission, loadDashboard]);

  const askPanel = (
    <>
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

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                输出模式
              </span>
              <select
                value={answerRole}
                onChange={(e) => setAnswerRole(e.target.value as 'employee' | 'supervisor' | 'hr')}
                className="rounded-md px-2 py-1.5 text-xs outline-none"
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  color: 'var(--text-primary)',
                }}
              >
                <option value="employee">员工版（结论+步骤）</option>
                <option value="supervisor">主管版（审批+风险）</option>
                <option value="hr">HR版（条款+例外）</option>
              </select>
            </div>
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
            <span
              className="px-2 py-0.5 rounded-md text-xs"
              style={{
                background: 'rgba(96,165,250,0.1)',
                border: '1px solid rgba(96,165,250,0.4)',
                color: '#60A5FA',
              }}
            >
              {ANSWER_ROLE_LABELS[(result.answerRole || 'employee') as 'employee' | 'supervisor' | 'hr']}
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

          {result.conflictDetected && (
            <div
              className="mt-3 rounded-lg p-3"
              style={{
                background: 'rgba(251, 113, 133, 0.1)',
                border: '1px solid rgba(251, 113, 133, 0.35)',
              }}
            >
              <div className="text-xs font-semibold" style={{ color: '#FB7185' }}>
                口径冲突提示
              </div>
              <div className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.85)' }}>
                {result.conflictMessage || '命中条款存在潜在冲突，请先人工确认后再执行。'}
              </div>
              {result.conflictClauses?.length ? (
                <div className="mt-2 flex flex-col gap-2">
                  {result.conflictClauses.map((conflict) => (
                    <div
                      key={conflict.clauseId}
                      className="rounded-md px-2 py-1.5 text-xs"
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <div>
                        {conflict.documentTitle} / {conflict.chapter} / {conflict.clauseTitle}
                      </div>
                      <div style={{ color: 'var(--text-muted)' }}>{conflict.conflictReason}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          {result.decisionTree?.length ? (
            <div className="mt-4">
              <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
                流程化回答（决策树）
              </div>
              <div className="flex flex-col gap-2">
                {result.decisionTree.map((step) => (
                  <div
                    key={`${step.stepNo}-${step.clauseId || step.condition}`}
                    className="rounded-lg p-2.5"
                    style={{
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div className="text-xs mb-1" style={{ color: '#60A5FA' }}>
                      Step {step.stepNo}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      IF：{step.condition}
                    </div>
                    <div className="text-sm mt-1" style={{ color: 'var(--text-primary)' }}>
                      THEN：{step.action}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

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
    </>
  );

  const dashboardPanel = (
    <GlassCard variant="subtle" animated className="p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          准星反馈看板
        </div>
        <Button variant="secondary" size="sm" onClick={() => void loadDashboard()} disabled={dashboardLoading}>
          {dashboardLoading ? <MapSpinner size={14} color="var(--text-primary)" /> : <RefreshCw size={14} />}
          刷新
        </Button>
      </div>

      {dashboardError && (
        <div className="mb-3 rounded-lg p-2.5 text-xs" style={{ background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.25)', color: '#FB923C' }}>
          {dashboardError}
        </div>
      )}
      {dashboardNotice && (
        <div className="mb-3 rounded-lg p-2.5 text-xs" style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)', color: '#34D399' }}>
          {dashboardNotice}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2 mb-3">
        <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>总反馈</div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{feedbackSummary?.totalCount ?? '-'}</div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>未命中</div>
          <div className="text-sm font-semibold" style={{ color: '#FB923C' }}>{feedbackSummary?.noMatchCount ?? '-'}</div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>答案不准确</div>
          <div className="text-sm font-semibold" style={{ color: '#FBBF24' }}>{feedbackSummary?.answerInaccurateCount ?? '-'}</div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>待处理工单</div>
          <div className="text-sm font-semibold" style={{ color: '#FB923C' }}>{feedbackSummary?.pendingCount ?? '-'}</div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>已回访</div>
          <div className="text-sm font-semibold" style={{ color: '#34D399' }}>{feedbackSummary?.followUpNotifiedCount ?? '-'}</div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>回放通过</div>
          <div className="text-sm font-semibold" style={{ color: '#60A5FA' }}>
            {feedbackSummary?.replayMatchedCount ?? '-'} / {feedbackSummary?.replayVerifiedCount ?? '-'}
          </div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>缺少上下文</div>
          <div className="text-sm font-semibold" style={{ color: '#60A5FA' }}>{feedbackSummary?.missingContextCount ?? '-'}</div>
        </div>
      </div>

      <div className="rounded-lg p-3 mb-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
          高频未命中问题（聚类）
        </div>
        {feedbackSummary?.topNoMatchQuestions?.length ? (
          <div className="flex flex-col gap-2">
            {feedbackSummary.topNoMatchQuestions.map((item) => (
              <div key={item.clusterKey} className="flex items-center justify-between gap-3">
                <div className="text-sm truncate" style={{ color: 'var(--text-primary)' }} title={item.sampleQuestion}>
                  {item.sampleQuestion}
                </div>
                <div className="text-xs shrink-0" style={{ color: '#FB923C' }}>
                  {item.count} 次
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>暂无未命中聚类数据</div>
        )}
      </div>

      <div className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select
            value={feedbackTypeFilter}
            onChange={(e) => {
              setFeedbackTypeFilter(e.target.value as typeof feedbackTypeFilter);
              setPage(1);
            }}
            className="rounded-md px-2 py-1 text-xs outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
          >
            <option value="all">全部类型</option>
            <option value="no_match">未命中</option>
            <option value="answer_inaccurate">答案不准确</option>
            <option value="missing_context">缺少上下文</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as typeof statusFilter);
              setPage(1);
            }}
            className="rounded-md px-2 py-1 text-xs outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
          >
            <option value="all">工单状态：全部</option>
            <option value="new">新建</option>
            <option value="triaged">已受理</option>
            <option value="in_progress">处理中</option>
            <option value="resolved">已解决</option>
            <option value="closed">已关闭</option>
          </select>
          <select
            value={matchedFilter}
            onChange={(e) => {
              setMatchedFilter(e.target.value as typeof matchedFilter);
              setPage(1);
            }}
            className="rounded-md px-2 py-1 text-xs outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
          >
            <option value="all">命中状态：全部</option>
            <option value="true">仅命中</option>
            <option value="false">仅未命中</option>
          </select>
          <input
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            placeholder="按问题关键词筛选"
            className="min-w-44 rounded-md px-2 py-1 text-xs outline-none"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'var(--text-primary)' }}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setKeywordFilter(keywordInput.trim());
              setPage(1);
            }}
            className="whitespace-nowrap"
          >
            <Search size={13} />
            查询
          </Button>
        </div>
        {!hasWritePermission && (
          <div className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
            当前账号为只读模式，可查看反馈与回放结果，工单处理操作需 `zhunxing-agent.write` 权限。
          </div>
        )}

        {dashboardLoading ? (
          <div className="flex items-center justify-center py-8">
            <MapSpinner size={18} color="var(--text-primary)" />
          </div>
        ) : feedbackList?.items?.length ? (
          <div className="flex flex-col gap-2">
            {feedbackList.items.map((item) => (
              <div key={item.id} className="rounded-lg p-2.5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="text-[11px] px-2 py-0.5 rounded-md" style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}>
                    {item.feedbackType}
                  </span>
                  <span
                    className="text-[11px] px-2 py-0.5 rounded-md"
                    style={{
                      background: item.status === 'resolved' || item.status === 'closed'
                        ? 'rgba(52,211,153,0.12)'
                        : item.status === 'in_progress'
                          ? 'rgba(96,165,250,0.12)'
                          : 'rgba(251,146,60,0.12)',
                      color: item.status === 'resolved' || item.status === 'closed'
                        ? '#34D399'
                        : item.status === 'in_progress'
                          ? '#60A5FA'
                          : '#FB923C',
                    }}
                  >
                    {FEEDBACK_STATUS_LABELS[item.status] ?? item.status}
                  </span>
                  <span className="text-[11px] px-2 py-0.5 rounded-md" style={{ background: item.matched ? 'rgba(52,211,153,0.12)' : 'rgba(251,146,60,0.12)', color: item.matched ? '#34D399' : '#FB923C' }}>
                    {item.matched ? '命中' : '未命中'}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    置信度 {Math.round((item.confidence ?? 0) * 100)}%
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  </span>
                </div>
                <div className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}>{item.question}</div>
                {(item.ownerDepartment || item.assigneeUserId) && (
                  <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                    {item.ownerDepartment ? `责任部门：${item.ownerDepartment}` : ''}
                    {item.ownerDepartment && item.assigneeUserId ? ' · ' : ''}
                    {item.assigneeUserId ? `处理人：${item.assigneeUserId}` : ''}
                  </div>
                )}
                {item.comment ? (
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>备注：{item.comment}</div>
                ) : null}
                {item.resolutionNote ? (
                  <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    处置说明：{item.resolutionNote}
                  </div>
                ) : null}
                {item.replayAt ? (
                  <div className="text-xs mt-1" style={{ color: item.replayMatched ? '#34D399' : '#FB923C' }}>
                    回放验证：{item.replayMatched ? '已命中' : '未命中'}（{new Date(item.replayAt).toLocaleString('zh-CN', { hour12: false })}）
                  </div>
                ) : null}
                {item.followUpNotifiedAt ? (
                  <div className="text-xs mt-1" style={{ color: '#34D399' }}>
                    已回访：{new Date(item.followUpNotifiedAt).toLocaleString('zh-CN', { hour12: false })}
                  </div>
                ) : null}
                {hasWritePermission && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void updateFeedbackStatus(item, 'triaged')}
                      disabled={actingFeedbackId === item.id || item.status !== 'new'}
                      className="whitespace-nowrap"
                    >
                      {actingFeedbackId === item.id ? <MapSpinner size={12} color="var(--text-primary)" /> : null}
                      受理
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void updateFeedbackStatus(item, 'in_progress')}
                      disabled={actingFeedbackId === item.id || (item.status !== 'triaged' && item.status !== 'new')}
                      className="whitespace-nowrap"
                    >
                      处理中
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void updateFeedbackStatus(item, 'resolved')}
                      disabled={actingFeedbackId === item.id || (item.status !== 'triaged' && item.status !== 'in_progress' && item.status !== 'new')}
                      className="whitespace-nowrap"
                    >
                      标记已解决
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void replayFeedback(item)}
                      disabled={actingFeedbackId === item.id}
                      className="whitespace-nowrap"
                    >
                      回放验证
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void followUpFeedback(item)}
                      disabled={actingFeedbackId === item.id || (item.status !== 'resolved' && item.status !== 'closed')}
                      className="whitespace-nowrap"
                    >
                      标记已回访
                    </Button>
                  </div>
                )}
              </div>
            ))}

            <div className="mt-2 flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={(feedbackList?.page ?? 1) <= 1}
                className="whitespace-nowrap"
              >
                <ChevronLeft size={13} />
                上一页
              </Button>
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                第 {feedbackList?.page ?? 1} 页 / 共 {Math.max(1, Math.ceil((feedbackList?.total ?? 0) / (feedbackList?.pageSize ?? 10)))} 页
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={(feedbackList?.page ?? 1) >= Math.max(1, Math.ceil((feedbackList?.total ?? 0) / (feedbackList?.pageSize ?? 10)))}
                className="whitespace-nowrap"
              >
                下一页
                <ChevronRight size={13} />
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-xs py-4" style={{ color: 'var(--text-muted)' }}>
            暂无符合条件的反馈记录
          </div>
        )}
      </div>
    </GlassCard>
  );

  return (
    <div className="h-full min-h-0 overflow-auto px-4 py-4">
      <div className="max-w-5xl mx-auto flex flex-col gap-4">
        <GlassCard variant="subtle" className="p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <BarChart3 size={15} />
              准星工作台
            </div>
            <div className="flex items-center gap-2">
              <Button variant={viewMode === 'ask' ? 'primary' : 'secondary'} size="sm" onClick={() => setViewMode('ask')} className="whitespace-nowrap">
                问答
              </Button>
              <Button variant={viewMode === 'dashboard' ? 'primary' : 'secondary'} size="sm" onClick={() => setViewMode('dashboard')} className="whitespace-nowrap">
                反馈看板
              </Button>
            </div>
          </div>
        </GlassCard>

        {viewMode === 'ask' ? askPanel : dashboardPanel}
      </div>
    </div>
  );
}
