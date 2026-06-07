import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { GlassCard } from '@/components/design/GlassCard';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  askZhunxing,
  createZhunxingClause,
  createZhunxingDocument,
  deactivateZhunxingDocument,
  getZhunxingAccessScope,
  getMyZhunxingTopicSubscription,
  getMyZhunxingTopicUpdates,
  getZhunxingKnowledgeHeatmap,
  getZhunxingFeedbackSummary,
  listZhunxingDocuments,
  listZhunxingFeedbacks,
  markZhunxingFeedbackFollowUp,
  replayZhunxingFeedback,
  submitZhunxingFeedback,
  updateMyZhunxingTopicSubscription,
  updateZhunxingFeedbackWorkflow,
  type ZhunxingAccessScopeResult,
  type ZhunxingAskResponse,
  type ZhunxingFeedbackListItem,
  type ZhunxingFeedbackListResult,
  type ZhunxingFeedbackSummary,
  type ZhunxingKnowledgeDocument,
  type ZhunxingKnowledgeHeatmap,
  type ZhunxingTopicSubscriptionResult,
  type ZhunxingTopicUpdateFeed,
} from '@/services/real/zhunxing';
import {
  AlertCircle,
  BarChart3,
  BellRing,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileStack,
  Flame,
  FolderCog,
  RefreshCw,
  Rocket,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
  Workflow,
} from 'lucide-react';
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

const TOPIC_LABELS: Record<string, string> = {
  attendance: '考勤管理',
  leave: '请假休假',
  handover: '交接流程',
  approval: '审批规则',
  discipline: '违规与处罚',
  rnd: '产研协作',
  sales: '市场销售协同',
};

const TOPIC_OPTIONS = Object.entries(TOPIC_LABELS).map(([value, label]) => ({ value, label }));

const FUTURE_PORTALS = [
  {
    title: '知识图谱导航',
    description: '跨制度关系图与影响路径追踪，定位“条款-流程-角色”全链路。',
  },
  {
    title: '主动预警中心',
    description: '基于岗位与订阅主题推送制度变更、风险项和待确认冲突。',
  },
  {
    title: '协同执行编排',
    description: '把问答结果直接转换为跨部门任务流，自动拉齐责任人与SLA。',
  },
  {
    title: '多模态知识接入',
    description: '支持文档、会议纪要、流程图、录音等统一索引与可追溯问答。',
  },
];

const AVAILABLE_ENTRIES = [
  {
    mode: 'ask' as const,
    title: '智能问答',
    description: '制度/流程问题即时回答，支持角色化输出与条款依据。',
    tag: '立即使用',
    icon: ShieldCheck,
  },
  {
    mode: 'library' as const,
    title: '文件库维护',
    description: '按部门上传制度文档、补充条款，并执行部门隔离管控。',
    tag: '立即使用',
    icon: FolderCog,
  },
  {
    mode: 'dashboard' as const,
    title: '反馈看板',
    description: '查看未命中聚类、工单流转、回放验证与回访闭环。',
    tag: '立即使用',
    icon: BarChart3,
  },
];

type VisualStyleMode = 'aurora' | 'cosmic' | 'slate';

const STYLE_MODE_OPTIONS: Array<{ value: VisualStyleMode; label: string }> = [
  { value: 'aurora', label: '晨曦白' },
  { value: 'slate', label: '雾银灰' },
  { value: 'cosmic', label: '深空黑' },
];

export default function ZhunxingAgentPage() {
  const permissions = useAuthStore((s) => s.permissions);
  const hasWritePermission = useMemo(
    () => permissions.includes('zhunxing-agent.write') || permissions.includes('super'),
    [permissions],
  );

  const [viewMode, setViewMode] = useState<'ask' | 'library' | 'dashboard'>('ask');
  const [visualStyle, setVisualStyle] = useState<VisualStyleMode>('aurora');

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
  const [topicSubscription, setTopicSubscription] = useState<ZhunxingTopicSubscriptionResult | null>(null);
  const [selectedTopics, setSelectedTopics] = useState<string[]>([]);
  const [savingTopics, setSavingTopics] = useState(false);
  const [topicUpdates, setTopicUpdates] = useState<ZhunxingTopicUpdateFeed | null>(null);
  const [heatmap, setHeatmap] = useState<ZhunxingKnowledgeHeatmap | null>(null);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [accessScope, setAccessScope] = useState<ZhunxingAccessScopeResult | null>(null);
  const [documents, setDocuments] = useState<ZhunxingKnowledgeDocument[]>([]);
  const [newDocTitle, setNewDocTitle] = useState('');
  const [newDocVersion, setNewDocVersion] = useState('v1.0');
  const [newDocScopeInput, setNewDocScopeInput] = useState('all-departments');
  const [newDocDepartment, setNewDocDepartment] = useState('');
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [deactivatingDocId, setDeactivatingDocId] = useState<string | null>(null);
  const [newClauseDocumentId, setNewClauseDocumentId] = useState('');
  const [newClauseChapter, setNewClauseChapter] = useState('');
  const [newClauseTitle, setNewClauseTitle] = useState('');
  const [newClauseRiskLevel, setNewClauseRiskLevel] = useState<'public' | 'internal' | 'sensitive'>('internal');
  const [newClauseKeywords, setNewClauseKeywords] = useState('');
  const [newClauseText, setNewClauseText] = useState('');
  const [newClauseSortOrder, setNewClauseSortOrder] = useState(10);
  const [creatingClause, setCreatingClause] = useState(false);

  const visualStyleTokens = useMemo(() => {
    if (visualStyle === 'cosmic') {
      return {
        pageBackground: 'radial-gradient(1200px 520px at 50% -10%, rgba(59,130,246,0.14), transparent 65%), #020617',
        cardBackground: 'rgba(2,6,23,0.38)',
        cardBorder: '1px solid rgba(148,163,184,0.22)',
        surfaceBackground: 'rgba(255,255,255,0.03)',
        surfaceBorder: '1px solid rgba(255,255,255,0.08)',
        controlBackground: 'rgba(255,255,255,0.04)',
        controlBorder: '1px solid rgba(255,255,255,0.1)',
        textPrimary: '#e5e7eb',
        textMuted: '#94a3b8',
        orbA: 'rgba(96,165,250,0.35)',
        orbB: 'rgba(129,140,248,0.3)',
        orbC: 'rgba(56,189,248,0.25)',
      };
    }

    if (visualStyle === 'slate') {
      return {
        pageBackground:
          'radial-gradient(1200px 520px at 50% -10%, rgba(148,163,184,0.22), transparent 70%), linear-gradient(180deg, #0f172a 0%, #1e293b 100%)',
        cardBackground: 'rgba(15,23,42,0.28)',
        cardBorder: '1px solid rgba(148,163,184,0.28)',
        surfaceBackground: 'rgba(255,255,255,0.08)',
        surfaceBorder: '1px solid rgba(148,163,184,0.28)',
        controlBackground: 'rgba(255,255,255,0.08)',
        controlBorder: '1px solid rgba(148,163,184,0.28)',
        textPrimary: '#f8fafc',
        textMuted: '#cbd5e1',
        orbA: 'rgba(148,163,184,0.35)',
        orbB: 'rgba(125,211,252,0.28)',
        orbC: 'rgba(191,219,254,0.24)',
      };
    }

    return {
      pageBackground:
        'radial-gradient(1200px 620px at 25% -10%, rgba(191,219,254,0.85), transparent 70%), radial-gradient(900px 520px at 85% 0%, rgba(167,243,208,0.55), transparent 70%), linear-gradient(180deg, #f7fbff 0%, #e8f3ff 100%)',
      cardBackground: 'rgba(255,255,255,0.78)',
      cardBorder: '1px solid rgba(148,163,184,0.24)',
      surfaceBackground: 'rgba(255,255,255,0.7)',
      surfaceBorder: '1px solid rgba(148,163,184,0.2)',
      controlBackground: 'rgba(255,255,255,0.92)',
      controlBorder: '1px solid rgba(148,163,184,0.32)',
      textPrimary: '#0f172a',
      textMuted: '#475569',
      orbA: 'rgba(125,211,252,0.45)',
      orbB: 'rgba(167,243,208,0.4)',
      orbC: 'rgba(191,219,254,0.35)',
    };
  }, [visualStyle]);

  const pageStyle = useMemo(() => {
    return {
      background: visualStyleTokens.pageBackground,
      transition: 'background 320ms ease',
      ['--text-primary' as string]: visualStyleTokens.textPrimary,
      ['--text-muted' as string]: visualStyleTokens.textMuted,
    } as CSSProperties;
  }, [visualStyleTokens]);

  const breathingStyleSheet = `
    @keyframes zhunxingOrbFloatA {
      0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
      50% { transform: translate3d(20px, -30px, 0) scale(1.06); }
    }
    @keyframes zhunxingOrbFloatB {
      0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
      50% { transform: translate3d(-22px, 24px, 0) scale(1.08); }
    }
    @keyframes zhunxingOrbFloatC {
      0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
      50% { transform: translate3d(14px, 16px, 0) scale(1.05); }
    }
    @keyframes zhunxingCardBreath {
      0%, 100% { box-shadow: 0 10px 22px rgba(59,130,246,0.07); transform: translateY(0); }
      50% { box-shadow: 0 16px 32px rgba(59,130,246,0.11); transform: translateY(-2px); }
    }
    .zhunxing-workbench .zhunxing-orb {
      position: absolute;
      border-radius: 9999px;
      filter: blur(48px);
      pointer-events: none;
      opacity: 0.55;
      will-change: transform;
    }
    .zhunxing-workbench .zhunxing-orb-a {
      width: 360px;
      height: 360px;
      top: -120px;
      left: -80px;
      animation: zhunxingOrbFloatA 16s ease-in-out infinite;
    }
    .zhunxing-workbench .zhunxing-orb-b {
      width: 300px;
      height: 300px;
      top: 18%;
      right: -90px;
      animation: zhunxingOrbFloatB 20s ease-in-out infinite;
    }
    .zhunxing-workbench .zhunxing-orb-c {
      width: 260px;
      height: 260px;
      bottom: 8%;
      left: 40%;
      animation: zhunxingOrbFloatC 18s ease-in-out infinite;
    }
    .zhunxing-workbench .zhunxing-breath-card {
      animation: zhunxingCardBreath 9s ease-in-out infinite;
      will-change: transform, box-shadow;
    }
    .zhunxing-workbench .zhunxing-breath-card:nth-of-type(2n) {
      animation-delay: 1.4s;
    }
    @media (prefers-reduced-motion: reduce) {
      .zhunxing-workbench .zhunxing-orb,
      .zhunxing-workbench .zhunxing-breath-card {
        animation: none !important;
      }
    }
  `;

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

  const manageableDepartments = useMemo(
    () => accessScope?.manageableDepartments ?? [],
    [accessScope?.manageableDepartments],
  );

  const departmentOptions = useMemo(() => {
    const labels = accessScope?.departmentLabels ?? {};
    return manageableDepartments.map((dept) => ({
      value: dept,
      label: labels[dept] ?? dept,
    }));
  }, [accessScope?.departmentLabels, manageableDepartments]);

  const canManageDepartment = useCallback((department?: string | null) => {
    if (!department) return false;
    return manageableDepartments.includes(department);
  }, [manageableDepartments]);

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
      const [summaryRes, listRes, subscriptionRes, updatesRes, heatmapRes] = await Promise.all([
        getZhunxingFeedbackSummary(8),
        listZhunxingFeedbacks({
          feedbackType: feedbackTypeFilter,
          status: statusFilter,
          matched,
          keyword: keywordFilter || undefined,
          page,
          pageSize: 10,
        }),
        getMyZhunxingTopicSubscription(),
        getMyZhunxingTopicUpdates(30, 20),
        getZhunxingKnowledgeHeatmap(30, 8),
      ]);

      if (!summaryRes.success || !summaryRes.data) {
        throw new Error(summaryRes.error?.message || '反馈看板摘要加载失败');
      }

      if (!listRes.success || !listRes.data) {
        throw new Error(listRes.error?.message || '反馈列表加载失败');
      }

      if (!subscriptionRes.success || !subscriptionRes.data) {
        throw new Error(subscriptionRes.error?.message || '订阅配置加载失败');
      }

      if (!updatesRes.success || !updatesRes.data) {
        throw new Error(updatesRes.error?.message || '订阅更新加载失败');
      }

      if (!heatmapRes.success || !heatmapRes.data) {
        throw new Error(heatmapRes.error?.message || '知识热力图加载失败');
      }

      setFeedbackSummary(summaryRes.data);
      setFeedbackList(listRes.data);
      setTopicSubscription(subscriptionRes.data);
      setSelectedTopics(subscriptionRes.data.topics || []);
      setTopicUpdates(updatesRes.data);
      setHeatmap(heatmapRes.data);
    } catch (e) {
      setDashboardError(e instanceof Error ? e.message : '反馈看板加载失败');
      setFeedbackSummary(null);
      setFeedbackList(null);
      setTopicSubscription(null);
      setTopicUpdates(null);
      setHeatmap(null);
    } finally {
      setDashboardLoading(false);
    }
  }, [feedbackTypeFilter, keywordFilter, matchedFilter, page, statusFilter]);

  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      const [scopeRes, docsRes] = await Promise.all([
        getZhunxingAccessScope(),
        listZhunxingDocuments(),
      ]);

      if (!scopeRes.success || !scopeRes.data) {
        throw new Error(scopeRes.error?.message || '权限范围加载失败');
      }
      if (!docsRes.success || !docsRes.data) {
        throw new Error(docsRes.error?.message || '文件库加载失败');
      }

      setAccessScope(scopeRes.data);
      setDocuments(docsRes.data.items || []);
      if (scopeRes.data.manageableDepartments.length > 0) {
        setNewDocDepartment((prev) => prev || scopeRes.data.manageableDepartments[0]);
      }
      if (docsRes.data.items?.length) {
        setNewClauseDocumentId((prev) => prev || docsRes.data.items[0].id);
      }
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : '文件库加载失败');
      setAccessScope(null);
      setDocuments([]);
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  const submitNewDocument = useCallback(async () => {
    if (!newDocTitle.trim() || !newDocDepartment || creatingDocument) return;
    setCreatingDocument(true);
    setLibraryError(null);
    setLibraryNotice(null);
    try {
      const scope = newDocScopeInput
        .split(/[,\s，]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      const res = await createZhunxingDocument({
        title: newDocTitle.trim(),
        version: newDocVersion.trim() || 'v1.0',
        ownerDepartment: newDocDepartment,
        scope,
      });
      if (!res.success || !res.data) {
        setLibraryError(res.error?.message || '新建文档失败');
        return;
      }

      setLibraryNotice('文档已入库，可继续录入条款。');
      setNewDocTitle('');
      setNewDocVersion('v1.0');
      await loadLibrary();
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : '新建文档失败');
    } finally {
      setCreatingDocument(false);
    }
  }, [creatingDocument, loadLibrary, newDocDepartment, newDocScopeInput, newDocTitle, newDocVersion]);

  const submitNewClause = useCallback(async () => {
    if (!newClauseDocumentId || !newClauseChapter.trim() || !newClauseTitle.trim() || !newClauseText.trim() || creatingClause) {
      return;
    }
    setCreatingClause(true);
    setLibraryError(null);
    setLibraryNotice(null);
    try {
      const keywords = newClauseKeywords
        .split(/[,\s，]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      const res = await createZhunxingClause({
        documentId: newClauseDocumentId,
        chapter: newClauseChapter.trim(),
        title: newClauseTitle.trim(),
        ruleText: newClauseText.trim(),
        keywords,
        riskLevel: newClauseRiskLevel,
        sortOrder: newClauseSortOrder,
      });
      if (!res.success) {
        setLibraryError(res.error?.message || '新增条款失败');
        return;
      }
      setLibraryNotice('条款已新增。');
      setNewClauseChapter('');
      setNewClauseTitle('');
      setNewClauseText('');
      setNewClauseKeywords('');
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : '新增条款失败');
    } finally {
      setCreatingClause(false);
    }
  }, [
    creatingClause,
    newClauseChapter,
    newClauseDocumentId,
    newClauseKeywords,
    newClauseRiskLevel,
    newClauseSortOrder,
    newClauseText,
    newClauseTitle,
  ]);

  const handleDeactivateDocument = useCallback(async (doc: ZhunxingKnowledgeDocument) => {
    if (deactivatingDocId) return;
    setDeactivatingDocId(doc.id);
    setLibraryError(null);
    setLibraryNotice(null);
    try {
      const res = await deactivateZhunxingDocument(doc.id);
      if (!res.success) {
        setLibraryError(res.error?.message || '文档下线失败');
        return;
      }
      setLibraryNotice(`文档「${doc.title}」已下线。`);
      await loadLibrary();
    } catch (e) {
      setLibraryError(e instanceof Error ? e.message : '文档下线失败');
    } finally {
      setDeactivatingDocId(null);
    }
  }, [deactivatingDocId, loadLibrary]);

  useEffect(() => {
    if (viewMode !== 'dashboard') return;
    void loadDashboard();
  }, [viewMode, loadDashboard]);

  useEffect(() => {
    if (viewMode !== 'library') return;
    void loadLibrary();
  }, [viewMode, loadLibrary]);

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

  const toggleTopic = (topic: string) => {
    setSelectedTopics((prev) => {
      if (prev.includes(topic)) {
        return prev.filter((item) => item !== topic);
      }
      return [...prev, topic];
    });
  };

  const saveTopicSubscription = useCallback(async () => {
    if (savingTopics) return;
    setSavingTopics(true);
    setDashboardError(null);
    setDashboardNotice(null);
    try {
      const res = await updateMyZhunxingTopicSubscription(selectedTopics);
      if (!res.success || !res.data) {
        setDashboardError(res.error?.message || '主题订阅保存失败');
        return;
      }
      setTopicSubscription(res.data);
      setSelectedTopics(res.data.topics || []);
      setDashboardNotice('主题订阅已保存，后续将按订阅主题推送条款更新。');
      await loadDashboard();
    } catch (e) {
      setDashboardError(e instanceof Error ? e.message : '主题订阅保存失败');
    } finally {
      setSavingTopics(false);
    }
  }, [savingTopics, selectedTopics, loadDashboard]);

  const askPanel = (
    <>
      <GlassCard variant="subtle" animated className="p-4 zhunxing-breath-card" style={{ background: visualStyleTokens.cardBackground, border: visualStyleTokens.cardBorder }}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-[11px]" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: '#22C55E' }}>
              <Rocket size={12} />
              Zhunxing Knowledge OS · Beta
            </div>
            <div className="mt-2 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              企业AI知识中枢，覆盖问答、流程决策与风险预警。
            </div>
            <div className="mt-1 text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
              当前阶段聚焦“问答可用、流程可执行、风险可治理”，后续将演进为知识图谱、主动预警、自动编排的一体化平台。
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="px-2 py-0.5 rounded-md text-[11px]" style={{ background: 'rgba(96,165,250,0.14)', border: '1px solid rgba(96,165,250,0.32)', color: '#60A5FA' }}>P1 问答执行化</span>
              <span className="px-2 py-0.5 rounded-md text-[11px]" style={{ background: 'rgba(52,211,153,0.14)', border: '1px solid rgba(52,211,153,0.32)', color: '#34D399' }}>P2 反馈运营化</span>
              <span className="px-2 py-0.5 rounded-md text-[11px]" style={{ background: 'rgba(251,191,36,0.14)', border: '1px solid rgba(251,191,36,0.32)', color: '#FBBF24' }}>P3 知识网络化</span>
              <span className="px-2 py-0.5 rounded-md text-[11px]" style={{ background: 'rgba(251,113,133,0.14)', border: '1px solid rgba(251,113,133,0.32)', color: '#FB7185' }}>P4 智能自治化</span>
            </div>
          </div>
          <div className="w-full lg:max-w-[340px] rounded-lg p-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
            <div className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
              <Workflow size={13} />
              能力演进路径
            </div>
            <div className="flex flex-col gap-2">
              <div className="text-xs flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
                <span>问答与条款引用</span><span style={{ color: '#34D399' }}>已上线</span>
              </div>
              <div className="text-xs flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
                <span>决策树与冲突治理</span><span style={{ color: '#34D399' }}>已上线</span>
              </div>
              <div className="text-xs flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
                <span>主题订阅与热力运营</span><span style={{ color: '#34D399' }}>已上线</span>
              </div>
              <div className="text-xs flex items-center justify-between" style={{ color: 'var(--text-primary)' }}>
                <span>知识图谱与主动预警</span><span style={{ color: '#FBBF24' }}>规划中</span>
              </div>
            </div>
          </div>
        </div>
      </GlassCard>

      <GlassCard variant="subtle" animated className="p-4 zhunxing-breath-card" style={{ background: visualStyleTokens.cardBackground, border: visualStyleTokens.cardBorder }}>
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
              即时问答入口
            </div>
            <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              面向制度、流程、交接与协作规范的问题求解台（支持角色化输出）
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
              style={{ color: 'var(--text-muted)' }}
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
                background: visualStyleTokens.controlBackground,
                border: visualStyleTokens.controlBorder,
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
                  background: visualStyleTokens.controlBackground,
                  border: visualStyleTokens.controlBorder,
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
                  background: visualStyleTokens.controlBackground,
                  border: visualStyleTokens.controlBorder,
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
        <GlassCard variant="subtle" animated className="p-3 flex items-center gap-2 zhunxing-breath-card" style={{ background: visualStyleTokens.cardBackground, border: visualStyleTokens.cardBorder }}>
          <AlertCircle size={16} style={{ color: '#FB923C' }} />
          <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
            {error}
          </span>
        </GlassCard>
      )}

      {result && (
        <GlassCard variant="subtle" animated className="p-4 zhunxing-breath-card" style={{ background: visualStyleTokens.cardBackground, border: visualStyleTokens.cardBorder }}>
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
              <div className="text-xs mt-1" style={{ color: 'var(--text-primary)' }}>
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
                      background: visualStyleTokens.surfaceBackground,
                      border: visualStyleTokens.surfaceBorder,
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
                    background: visualStyleTokens.surfaceBackground,
                    border: visualStyleTokens.surfaceBorder,
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
                <div className="rounded-lg p-2.5 text-xs" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder, color: 'var(--text-muted)' }}>
                  当前没有可展示的依据条款。
                </div>
              )}
            </div>
          </div>
        </GlassCard>
      )}

    </>
  );

  const libraryPanel = (
    <GlassCard variant="subtle" animated className="p-4 zhunxing-breath-card" style={{ background: visualStyleTokens.cardBackground, border: visualStyleTokens.cardBorder }}>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <div className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <FileStack size={16} />
            知识文件库维护
          </div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
            入口说明：这里负责文档入库、条款维护和下线。系统会按部门权限隔离写操作。
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void loadLibrary()} disabled={libraryLoading} className="whitespace-nowrap">
          {libraryLoading ? <MapSpinner size={14} color="var(--text-primary)" /> : <RefreshCw size={14} />}
          刷新文件库
        </Button>
      </div>

      {libraryError && (
        <div className="mb-3 rounded-lg p-2.5 text-xs" style={{ background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.25)', color: '#FB923C' }}>
          {libraryError}
        </div>
      )}
      {libraryNotice && (
        <div className="mb-3 rounded-lg p-2.5 text-xs" style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)', color: '#34D399' }}>
          {libraryNotice}
        </div>
      )}

      <div className="rounded-lg p-3 mb-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
        <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
          当前账号可维护范围
        </div>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          写权限：{accessScope?.writable ? '已开通' : '未开通'}；全部门维护：{accessScope?.canManageAllDepartments ? '是' : '否'}。
          {!accessScope?.canManageAllDepartments && accessScope?.manageableDepartments?.length
            ? ` 可维护部门：${accessScope.manageableDepartments.map((d) => accessScope.departmentLabels?.[d] ?? d).join('、')}`
            : ''}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <div className="rounded-lg p-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="text-sm font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
            <Upload size={14} />
            上传新文档
          </div>
          <div className="flex flex-col gap-2">
            <input
              value={newDocTitle}
              onChange={(e) => setNewDocTitle(e.target.value)}
              placeholder="文档标题（如：产研交接规范）"
              className="rounded-md px-2 py-1.5 text-xs outline-none"
              style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={newDocVersion}
                onChange={(e) => setNewDocVersion(e.target.value)}
                placeholder="版本（v1.0）"
                className="rounded-md px-2 py-1.5 text-xs outline-none"
                style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
              />
              <select
                value={newDocDepartment}
                onChange={(e) => setNewDocDepartment(e.target.value)}
                className="rounded-md px-2 py-1.5 text-xs outline-none"
                style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
              >
                {!departmentOptions.length && <option value="">暂无可维护部门</option>}
                {departmentOptions.map((dept) => (
                  <option key={dept.value} value={dept.value}>{dept.label}</option>
                ))}
              </select>
            </div>
            <input
              value={newDocScopeInput}
              onChange={(e) => setNewDocScopeInput(e.target.value)}
              placeholder="适用范围（逗号分隔，如 all-departments,rnd）"
              className="rounded-md px-2 py-1.5 text-xs outline-none"
              style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => void submitNewDocument()}
              disabled={!newDocTitle.trim() || !newDocDepartment || creatingDocument}
              className="whitespace-nowrap"
            >
              {creatingDocument ? <MapSpinner size={14} color="var(--text-primary)" /> : null}
              提交文档入库
            </Button>
          </div>
        </div>

        <div className="rounded-lg p-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
            新增条款
          </div>
          <div className="flex flex-col gap-2">
            <select
              value={newClauseDocumentId}
              onChange={(e) => setNewClauseDocumentId(e.target.value)}
              className="rounded-md px-2 py-1.5 text-xs outline-none"
              style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
            >
              {!documents.length && <option value="">暂无文档</option>}
              {documents.map((doc) => (
                <option key={doc.id} value={doc.id}>
                  {doc.title}（{accessScope?.departmentLabels?.[doc.ownerDepartment || ''] ?? doc.ownerDepartment ?? '未分配'}）
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={newClauseChapter}
                onChange={(e) => setNewClauseChapter(e.target.value)}
                placeholder="章节（如 3.2）"
                className="rounded-md px-2 py-1.5 text-xs outline-none"
                style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
              />
              <select
                value={newClauseRiskLevel}
                onChange={(e) => setNewClauseRiskLevel(e.target.value as 'public' | 'internal' | 'sensitive')}
                className="rounded-md px-2 py-1.5 text-xs outline-none"
                style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
              >
                <option value="public">公开</option>
                <option value="internal">内部</option>
                <option value="sensitive">高风险</option>
              </select>
            </div>
            <input
              value={newClauseTitle}
              onChange={(e) => setNewClauseTitle(e.target.value)}
              placeholder="条款标题"
              className="rounded-md px-2 py-1.5 text-xs outline-none"
              style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
            />
            <input
              value={newClauseKeywords}
              onChange={(e) => setNewClauseKeywords(e.target.value)}
              placeholder="关键词（逗号分隔）"
              className="rounded-md px-2 py-1.5 text-xs outline-none"
              style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
            />
            <textarea
              value={newClauseText}
              onChange={(e) => setNewClauseText(e.target.value)}
              placeholder="条款正文"
              className="rounded-md px-2 py-1.5 text-xs outline-none min-h-[84px]"
              style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
            />
            <input
              type="number"
              value={newClauseSortOrder}
              onChange={(e) => setNewClauseSortOrder(Number(e.target.value || 0))}
              placeholder="排序值"
              className="rounded-md px-2 py-1.5 text-xs outline-none"
              style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-primary)' }}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void submitNewClause()}
              disabled={!newClauseDocumentId || !newClauseChapter.trim() || !newClauseTitle.trim() || !newClauseText.trim() || creatingClause}
              className="whitespace-nowrap"
            >
              {creatingClause ? <MapSpinner size={14} color="var(--text-primary)" /> : null}
              提交条款
            </Button>
          </div>
        </div>
      </div>

      <div className="rounded-lg p-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
        <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
          已入库文档
        </div>
        {libraryLoading ? (
          <div className="py-6 flex items-center justify-center">
            <MapSpinner size={16} color="var(--text-primary)" />
          </div>
        ) : documents.length ? (
          <div className="flex flex-col gap-2">
            {documents.map((doc) => {
              const ownerDepartment = doc.ownerDepartment || '';
              const canManage = canManageDepartment(ownerDepartment);
              return (
                <div key={doc.id} className="rounded-md p-2.5" style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder }}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {doc.title}
                      </div>
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        版本 {doc.version} · 部门 {(accessScope?.departmentLabels?.[ownerDepartment] ?? ownerDepartment) || '未分配'} · 生效于 {new Date(doc.effectiveDate).toLocaleDateString('zh-CN')}
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        scope: {(doc.scope || []).join(', ') || '-'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] px-2 py-0.5 rounded-md" style={{
                        background: canManage ? 'rgba(52,211,153,0.12)' : 'rgba(251,191,36,0.12)',
                        color: canManage ? '#34D399' : '#FBBF24',
                      }}>
                        {canManage ? '可维护' : '只读'}
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleDeactivateDocument(doc)}
                        disabled={!canManage || deactivatingDocId === doc.id}
                        className="whitespace-nowrap"
                      >
                        {deactivatingDocId === doc.id ? <MapSpinner size={12} color="var(--text-primary)" /> : <Trash2 size={12} />}
                        下线文档
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            当前暂无已入库文档。
          </div>
        )}
      </div>
    </GlassCard>
  );

  const dashboardPanel = (
    <GlassCard variant="subtle" animated className="p-4 zhunxing-breath-card" style={{ background: visualStyleTokens.cardBackground, border: visualStyleTokens.cardBorder }}>
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
        <div className="rounded-lg p-2.5" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>总反馈</div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{feedbackSummary?.totalCount ?? '-'}</div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>未命中</div>
          <div className="text-sm font-semibold" style={{ color: '#FB923C' }}>{feedbackSummary?.noMatchCount ?? '-'}</div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>答案不准确</div>
          <div className="text-sm font-semibold" style={{ color: '#FBBF24' }}>{feedbackSummary?.answerInaccurateCount ?? '-'}</div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>待处理工单</div>
          <div className="text-sm font-semibold" style={{ color: '#FB923C' }}>{feedbackSummary?.pendingCount ?? '-'}</div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>已回访</div>
          <div className="text-sm font-semibold" style={{ color: '#34D399' }}>{feedbackSummary?.followUpNotifiedCount ?? '-'}</div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>回放通过</div>
          <div className="text-sm font-semibold" style={{ color: '#60A5FA' }}>
            {feedbackSummary?.replayMatchedCount ?? '-'} / {feedbackSummary?.replayVerifiedCount ?? '-'}
          </div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>缺少上下文</div>
          <div className="text-sm font-semibold" style={{ color: '#60A5FA' }}>{feedbackSummary?.missingContextCount ?? '-'}</div>
        </div>
      </div>

      <div className="rounded-lg p-3 mb-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <div className="rounded-lg p-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-xs font-semibold flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
              <BellRing size={13} />
              主题订阅与更新提醒
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void saveTopicSubscription()}
              disabled={savingTopics}
              className="whitespace-nowrap"
            >
              {savingTopics ? <MapSpinner size={12} color="var(--text-primary)" /> : null}
              保存订阅
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 mb-2">
            {TOPIC_OPTIONS.map((topic) => (
              <button
                key={topic.value}
                type="button"
                onClick={() => toggleTopic(topic.value)}
                className="px-2 py-1 rounded-md text-xs transition-opacity hover:opacity-90"
                style={{
                  background: selectedTopics.includes(topic.value) ? 'rgba(96,165,250,0.2)' : 'rgba(255,255,255,0.04)',
                  border: selectedTopics.includes(topic.value) ? '1px solid rgba(96,165,250,0.5)' : '1px solid rgba(255,255,255,0.08)',
                  color: selectedTopics.includes(topic.value) ? '#60A5FA' : 'var(--text-muted)',
                }}
              >
                {topic.label}
              </button>
            ))}
          </div>
          <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
            最近 30 天命中更新 {topicUpdates?.totalUpdates ?? 0} 条，当前展示 {topicUpdates?.returnedUpdates ?? 0} 条
            {topicSubscription?.updatedAt ? `（订阅更新于 ${new Date(topicSubscription.updatedAt).toLocaleString('zh-CN', { hour12: false })}）` : ''}
          </div>
          {topicUpdates?.items?.length ? (
            <div className="flex flex-col gap-2 max-h-48 overflow-auto pr-1">
              {topicUpdates.items.map((item) => (
                <div
                  key={`${item.topic}-${item.clauseId}-${item.updatedAt}`}
                  className="rounded-md p-2 text-xs"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span style={{ color: '#60A5FA' }}>{item.topicLabel}</span>
                    <span style={{ color: 'var(--text-muted)' }}>
                      {new Date(item.updatedAt).toLocaleDateString('zh-CN')}
                    </span>
                  </div>
                  <div className="mt-1" style={{ color: 'var(--text-primary)' }}>
                    {item.documentTitle} / {item.chapter} / {item.clauseTitle}
                  </div>
                  <div className="mt-1" style={{ color: 'var(--text-muted)' }}>
                    {item.summary}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              当前订阅主题暂无条款更新。
            </div>
          )}
        </div>

        <div className="rounded-lg p-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
          <div className="text-xs font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
            <Flame size={13} />
            知识热力图（近 {heatmap?.days ?? 30} 天）
          </div>
          {heatmap?.buckets?.length ? (
            <div className="flex flex-col gap-2">
              {heatmap.buckets.map((bucket, index) => {
                const maxScore = heatmap.buckets[0]?.heatScore || 1;
                const width = Math.max(8, Math.round((bucket.heatScore / maxScore) * 100));
                return (
                  <div key={bucket.topic} className="rounded-md p-2" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div className="flex items-center justify-between text-xs">
                      <span style={{ color: 'var(--text-primary)' }}>
                        {index + 1}. {bucket.topicLabel}
                      </span>
                      <span style={{ color: '#FB923C' }}>热度 {bucket.heatScore}</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.08)' }}>
                      <div className="h-1.5 rounded-full" style={{ width: `${width}%`, background: 'linear-gradient(90deg, #FBBF24, #FB7185)' }} />
                    </div>
                    <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      提问 {bucket.questionCount} · 未命中 {bucket.noMatchCount} · 待处理 {bucket.pendingCount} · 平均置信度 {Math.round((bucket.avgConfidence ?? 0) * 100)}%
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              近 30 天暂无可聚合的反馈数据。
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg p-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
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
              <div key={item.id} className="rounded-lg p-2.5" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
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
    <div
      className="zhunxing-workbench relative h-full min-h-0 overflow-auto px-3 py-4 sm:px-4 md:px-6"
      style={pageStyle}
    >
      <style>{breathingStyleSheet}</style>
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="zhunxing-orb zhunxing-orb-a" style={{ background: visualStyleTokens.orbA }} />
        <div className="zhunxing-orb zhunxing-orb-b" style={{ background: visualStyleTokens.orbB }} />
        <div className="zhunxing-orb zhunxing-orb-c" style={{ background: visualStyleTokens.orbC }} />
      </div>

      <div className="relative z-10 max-w-6xl mx-auto flex flex-col gap-4">
        <GlassCard variant="subtle" className="p-3 zhunxing-breath-card" style={{ background: visualStyleTokens.cardBackground, border: visualStyleTokens.cardBorder }}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                <BarChart3 size={15} />
                准星工作台
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                企业AI知识中枢，覆盖问答、流程决策与风险预警。
              </div>
            </div>
            <div className="flex flex-col gap-2 lg:items-end">
              <div className="flex items-center gap-2">
                {STYLE_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setVisualStyle(option.value)}
                    className="px-2 py-1 rounded-md text-[11px] whitespace-nowrap transition-opacity hover:opacity-90"
                    style={{
                      background: visualStyle === option.value ? 'rgba(96,165,250,0.2)' : visualStyleTokens.controlBackground,
                      border: visualStyle === option.value ? '1px solid rgba(96,165,250,0.5)' : visualStyleTokens.controlBorder,
                      color: visualStyle === option.value ? '#60A5FA' : 'var(--text-muted)',
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Button variant={viewMode === 'ask' ? 'primary' : 'secondary'} size="sm" onClick={() => setViewMode('ask')} className="whitespace-nowrap">
                  问答
                </Button>
                <Button variant={viewMode === 'library' ? 'primary' : 'secondary'} size="sm" onClick={() => setViewMode('library')} className="whitespace-nowrap">
                  文件库
                </Button>
                <Button variant={viewMode === 'dashboard' ? 'primary' : 'secondary'} size="sm" onClick={() => setViewMode('dashboard')} className="whitespace-nowrap">
                  反馈看板
                </Button>
              </div>
            </div>
          </div>
        </GlassCard>

        <GlassCard variant="subtle" className="p-4 zhunxing-breath-card" style={{ background: visualStyleTokens.cardBackground, border: visualStyleTokens.cardBorder }}>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
            <div className="rounded-lg p-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
              <div className="text-xs font-semibold mb-2" style={{ color: '#34D399' }}>可立即使用</div>
              <div className="flex flex-col gap-2">
                {AVAILABLE_ENTRIES.map((entry) => {
                  const Icon = entry.icon;
                  return (
                    <button
                      key={entry.mode}
                      type="button"
                      onClick={() => setViewMode(entry.mode)}
                      className="rounded-md p-2 text-left transition-opacity hover:opacity-90"
                      style={{
                        background: viewMode === entry.mode ? 'rgba(96,165,250,0.18)' : visualStyleTokens.controlBackground,
                        border: viewMode === entry.mode ? '1px solid rgba(96,165,250,0.45)' : visualStyleTokens.controlBorder,
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold flex items-center gap-1.5" style={{ color: 'var(--text-primary)' }}>
                          <Icon size={14} />
                          {entry.title}
                        </div>
                        <span className="text-[11px]" style={{ color: '#34D399' }}>{entry.tag}</span>
                      </div>
                      <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                        {entry.description}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-lg p-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
              <div className="text-xs font-semibold mb-2" style={{ color: '#FBBF24' }}>规划中功能</div>
              <div className="flex flex-col gap-2">
                {FUTURE_PORTALS.map((item) => (
                  <div key={item.title} className="rounded-md p-2" style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{item.title}</div>
                      <span className="text-[11px]" style={{ color: '#FBBF24' }}>规划中</span>
                    </div>
                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{item.description}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg p-3" style={{ background: visualStyleTokens.surfaceBackground, border: visualStyleTokens.surfaceBorder }}>
              <div className="text-xs font-semibold mb-2" style={{ color: '#60A5FA' }}>提示文案</div>
              <div className="rounded-md p-2 text-xs leading-5" style={{ background: visualStyleTokens.controlBackground, border: visualStyleTokens.controlBorder, color: 'var(--text-muted)' }}>
                你当前看到的三个区域定义如下：<br />
                1）可立即使用：可直接点击进入并执行；<br />
                2）规划中功能：当前不可操作，仅用于演进预告；<br />
                3）提示文案：解释权限边界与使用方式，不是功能入口。<br />
                文件库遵循部门权限隔离：只允许维护本部门资料，跨部门操作将被拒绝。
              </div>
            </div>
          </div>
        </GlassCard>

        {viewMode === 'ask' ? askPanel : viewMode === 'library' ? libraryPanel : dashboardPanel}
      </div>
    </div>
  );
}
