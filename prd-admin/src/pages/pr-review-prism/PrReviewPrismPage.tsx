import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ScanSearch,
  ArrowLeft,
  Plus,
  RefreshCw,
  Trash2,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  Clock3,
  HelpCircle,
  Loader2,
  Search,
  CircleDot,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  createPrReviewPrismSubmission,
  deletePrReviewPrismSubmission,
  getPrReviewPrismStatus,
  getPrReviewPrismSetupStatus,
  listPrReviewPrismSubmissions,
  batchRefreshPrReviewPrismSubmissions,
  refreshPrReviewPrismSubmission,
  type PrReviewPrismGateStatus,
  type PrReviewPrismSubmission,
  type PrReviewPrismBatchRefreshFailure,
  type PrReviewPrismSetupStatus,
} from '@/services';

const bootstrapInitCommand = 'bash scripts/bootstrap-pr-prism.sh';
const bootstrapGuidePath = 'doc/guide.pr-prism-bootstrap-package.md';
const topDesignBasisTemplateText = `# doc/top-design/main.md
# Top Design Baseline

## Bounded Context
- engineering-governance

## Core Anchor
- ANCHOR-CORE-01

# doc/top-design/anchors.yml
version: 1
anchors:
  - id: "ANCHOR-CORE-01"
    title: "Core governance anchor"
    description: "Keep PR review metadata, boundary and evidence consistent."

# doc/top-design/contexts.yml
version: 1
contexts:
  - id: "engineering-governance"
    name: "engineering-governance"
    description: "Primary governance bounded context for this repository."

# doc/top-design/slices.yml
version: 1
slices:
  - id: "slice-governance-core"
    owner: "architect"
    context: "engineering-governance"
    description: "Initial slice for governance baseline."
`;

function parseRepoFromPrUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const match = text.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/i);
  if (!match) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

export function PrReviewPrismPage() {
  const navigate = useNavigate();
  const [hint, setHint] = useState<string>('正在连接服务...');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [batchRefreshing, setBatchRefreshing] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    total: number;
    done: number;
    success: number;
    failed: number;
  } | null>(null);
  const [items, setItems] = useState<PrReviewPrismSubmission[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [activeGateFilter, setActiveGateFilter] = useState<'all' | PrReviewPrismGateStatus>('all');
  const [prUrl, setPrUrl] = useState('');
  const [note, setNote] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<PrReviewPrismSetupStatus | null>(null);
  const [setupActionMessage, setSetupActionMessage] = useState<string | null>(null);
  const [bindingRepoInput, setBindingRepoInput] = useState('');
  const [gateStatusCounts, setGateStatusCounts] = useState<{
    all: number;
    completed: number;
    pending: number;
    missing: number;
    error: number;
  }>({
    all: 0,
    completed: 0,
    pending: 0,
    missing: 0,
    error: 0,
  });

  const filteredItems = useMemo(() => items, [items]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const batchProgressPercent = useMemo(() => {
    if (!batchProgress || batchProgress.total <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((batchProgress.done / batchProgress.total) * 100));
  }, [batchProgress]);

  const selected = useMemo(
    () => filteredItems.find(x => x.id === selectedId) ?? null,
    [filteredItems, selectedId]
  );
  const normalizedBindingRepo = useMemo(() => {
    const raw = bindingRepoInput.trim();
    if (!raw) {
      return '';
    }
    const parsed = parseRepoFromPrUrl(raw);
    return parsed ?? raw;
  }, [bindingRepoInput]);
  const isBindingRepoValid = useMemo(() => /^[^/\s]+\/[^/\s]+$/.test(normalizedBindingRepo), [normalizedBindingRepo]);
  const repoScopedBootstrapCommand = useMemo(() => {
    if (!isBindingRepoValid) {
      return bootstrapInitCommand;
    }
    return `bash scripts/bootstrap-pr-prism.sh --repo "${normalizedBindingRepo}" --owner "your-github-id"`;
  }, [isBindingRepoValid, normalizedBindingRepo]);
  const repoBindingSnippet = useMemo(() => {
    if (!isBindingRepoValid) {
      return '';
    }
    return `- repo: "${normalizedBindingRepo}"
  enabled: true
  design_source_id: "local-ddd-anchor"
  design_source_version: "v1.0.0"
  default_owner: "your-github-id"
  default_context: "engineering-governance"
  required_checks:
    - "PR审查棱镜 L1 Gate"
    - "PR审查棱镜 Advisory"`;
  }, [isBindingRepoValid, normalizedBindingRepo]);
  const canSubmitPr = Boolean(setupStatus?.readyForFullRefresh);
  const onboardingSteps = useMemo(
    () => [
      {
        key: 'token',
        title: '配置 GitHub Token',
        done: Boolean(setupStatus?.githubTokenConfigured),
      },
      {
        key: 'repo',
        title: '绑定目标仓库',
        done: isBindingRepoValid,
      },
      {
        key: 'topDesign',
        title: '落地顶层设计依据',
        done: Boolean(setupStatus?.topDesign.ready),
      },
      {
        key: 'verify',
        title: '验证后开始审查',
        done: Boolean(setupStatus?.readyForFullRefresh),
      },
    ],
    [isBindingRepoValid, setupStatus]
  );
  const onboardingDoneCount = useMemo(
    () => onboardingSteps.filter(x => x.done).length,
    [onboardingSteps]
  );
  const onboardingProgressPercent = useMemo(
    () => Math.round((onboardingDoneCount / onboardingSteps.length) * 100),
    [onboardingDoneCount, onboardingSteps.length]
  );
  const submissionBlockReason = useMemo(() => {
    if (canSubmitPr) {
      return '';
    }
    if (!setupStatus) {
      return '配置状态加载失败，请先点击“重新检测配置”';
    }
    if (setupStatus.guidance.length > 0) {
      return setupStatus.guidance[0];
    }
    return '请先完成新仓库接入向导后再提交 PR';
  }, [canSubmitPr, setupStatus]);

  const copyToClipboard = useCallback(async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSetupActionMessage(successMessage);
    } catch {
      setSetupActionMessage('复制失败，请手动复制下方代码块内容');
    }
  }, []);

  const loadStatus = useCallback(async () => {
    const res = await getPrReviewPrismStatus();
    if (res.success && res.data?.message) {
      setHint(res.data.message);
    }
  }, []);

  const loadSetupStatus = useCallback(async () => {
    const res = await getPrReviewPrismSetupStatus();
    if (res.success && res.data) {
      setSetupStatus(res.data);
    } else {
      setSetupStatus(null);
    }
  }, []);

  const loadList = useCallback(
    async (targetPage = page, keyword?: string, targetPageSize = pageSize, gateStatus = activeGateFilter) => {
      setLoading(true);
      setListError(null);
      const res = await listPrReviewPrismSubmissions(
        targetPage,
        targetPageSize,
        keyword,
        gateStatus === 'all' ? undefined : gateStatus
      );
      if (res.success && res.data) {
        setItems(res.data.items);
        setTotal(res.data.total);
        setPage(res.data.page);
        setPageSize(res.data.pageSize);
        setGateStatusCounts({
          all:
            res.data.gateStatusCounts.completed +
            res.data.gateStatusCounts.pending +
            res.data.gateStatusCounts.missing +
            res.data.gateStatusCounts.error,
          completed: res.data.gateStatusCounts.completed,
          pending: res.data.gateStatusCounts.pending,
          missing: res.data.gateStatusCounts.missing,
          error: res.data.gateStatusCounts.error,
        });
        setSelectedId(prev => {
          if (prev && res.data.items.some(x => x.id === prev)) {
            return prev;
          }
          return res.data.items[0]?.id ?? null;
        });
      } else {
        setItems([]);
        setTotal(0);
        setGateStatusCounts({
          all: 0,
          completed: 0,
          pending: 0,
          missing: 0,
          error: 0,
        });
        setSelectedId(null);
        setListError(res.error?.message ?? '加载提交记录失败');
      }
      setLoading(false);
    },
    [activeGateFilter, page, pageSize]
  );

  useEffect(() => {
    void loadStatus();
    void loadSetupStatus();
    void loadList();
  }, [loadList, loadSetupStatus, loadStatus]);

  useEffect(() => {
    setSelectedId(prev => {
      if (prev && filteredItems.some(x => x.id === prev)) {
        return prev;
      }
      return filteredItems[0]?.id ?? null;
    });
  }, [filteredItems]);
  useEffect(() => {
    const parsed = parseRepoFromPrUrl(prUrl);
    if (parsed) {
      setBindingRepoInput(parsed);
    }
  }, [prUrl]);
  useEffect(() => {
    if (bindingRepoInput.trim()) {
      return;
    }
    if (selected?.repoOwner && selected.repoName) {
      setBindingRepoInput(`${selected.repoOwner}/${selected.repoName}`);
    }
  }, [bindingRepoInput, selected]);

  async function handleSearch() {
    await loadList(1, search.trim() || undefined, pageSize, activeGateFilter);
  }

  async function handleSubmit() {
    const normalizedUrl = prUrl.trim();
    if (!normalizedUrl) {
      setFormError('请输入 GitHub PR 链接');
      return;
    }
    if (!/^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(normalizedUrl)) {
      setFormError('PR 链接格式错误，应为 https://github.com/{owner}/{repo}/pull/{number}');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    const res = await createPrReviewPrismSubmission(normalizedUrl, note.trim() || undefined);
    if (!res.success || !res.data?.submission) {
      setFormError(res.error?.message ?? '提交失败');
      setSubmitting(false);
      return;
    }

    setPrUrl('');
    setNote('');
    await loadList(1, search.trim() || undefined, pageSize, activeGateFilter);
    await loadSetupStatus();
    setSelectedId(res.data.submission.id);
    setSubmitting(false);
  }

  async function handleRefresh(id: string) {
    if (batchRefreshing) {
      return;
    }
    setRefreshingId(id);
    const res = await refreshPrReviewPrismSubmission(id);
    if (res.success && res.data?.submission) {
      setItems(prev => prev.map(x => (x.id === id ? res.data!.submission : x)));
    } else {
      setListError(res.error?.message ?? '刷新失败');
    }
    setRefreshingId(null);
  }

  async function handleBatchRefreshCurrentFiltered() {
    if (batchRefreshing || loading) {
      return;
    }

    const targetIds = filteredItems.map(x => x.id);
    if (targetIds.length === 0) {
      return;
    }

    setBatchRefreshing(true);
    setListError(null);
    setBatchProgress({
      total: targetIds.length,
      done: 0,
      success: 0,
      failed: 0,
    });

    let success = 0;
    let failed = 0;
    let done = 0;
    const updateBatchProgress = () => {
      setBatchProgress({
        total: targetIds.length,
        done,
        success,
        failed,
      });
    };
    const appendBatchError = (id: string, message: string) => {
      setListError(prev => {
        if (!prev) {
          return `${id}: ${message}`;
        }
        if (prev.length > 800) {
          return `${prev.slice(0, 800)}...`;
        }
        return `${prev}; ${id}: ${message}`;
      });
    };

    const batchRes = await batchRefreshPrReviewPrismSubmissions(targetIds);
    if (batchRes.success && batchRes.data) {
      const refreshed = new Map(batchRes.data.submissions.map(x => [x.id, x]));
      setItems(prev => prev.map(x => refreshed.get(x.id) ?? x));
      success = batchRes.data.successCount;
      failed = batchRes.data.failureCount;
      done = batchRes.data.total;
      updateBatchProgress();
      if (failed > 0 && batchRes.data.failures.length > 0) {
        const topFailures = batchRes.data.failures
          .slice(0, 5)
          .map((x: PrReviewPrismBatchRefreshFailure) => `${x.id}: ${x.message}`)
          .join('; ');
        setListError(`批量刷新部分失败（${failed} 条）：${topFailures}`);
      }
      setBatchRefreshing(false);
      return;
    }

    // 兜底：如果批量接口不可用或失败，降级为逐条刷新，避免功能不可用
    for (const id of targetIds) {
      const res = await refreshPrReviewPrismSubmission(id);
      if (res.success && res.data?.submission) {
        success += 1;
        setItems(prev => prev.map(x => (x.id === id ? res.data!.submission : x)));
      } else {
        failed += 1;
        appendBatchError(id, res.error?.message ?? '刷新失败');
      }
      done += 1;
      updateBatchProgress();
    }

    if (failed > 0 && !batchRes.success) {
      setListError(prev => {
        const prefix = `批量接口失败（已降级逐条刷新）：${batchRes.error?.message ?? '未知错误'}`;
        return prev ? `${prefix}; ${prev}` : prefix;
      });
    } else if (failed > 0) {
      setListError(`批量刷新完成：成功 ${success}，失败 ${failed}`);
    }

    setBatchRefreshing(false);
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    const res = await deletePrReviewPrismSubmission(id);
    if (!res.success) {
      setListError(res.error?.message ?? '删除失败');
      setDeletingId(null);
      return;
    }
    const next = items.filter(x => x.id !== id);
    setItems(next);
    setTotal(Math.max(0, total - 1));
    if (selectedId === id) {
      setSelectedId(next[0]?.id ?? null);
    }
    if (next.length === 0 && page > 1) {
      await loadList(page - 1, search.trim() || undefined, pageSize, activeGateFilter);
    }
    setDeletingId(null);
  }

  function formatDateTime(value?: string | null) {
    if (!value) {
      return '-';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '-';
    }
    return date.toLocaleString('zh-CN', { hour12: false });
  }

  function gateBadge(item: PrReviewPrismSubmission) {
    if (item.gateStatus === 'completed') {
      if (item.gateConclusion === 'success') {
        return (
          <span className="inline-flex items-center gap-1 text-emerald-300 text-xs">
            <CheckCircle2 className="w-3.5 h-3.5" />
            L1 通过
          </span>
        );
      }
      return (
        <span className="inline-flex items-center gap-1 text-orange-300 text-xs">
          <AlertTriangle className="w-3.5 h-3.5" />
          L1 未通过
        </span>
      );
    }
    if (item.gateStatus === 'pending') {
      return (
        <span className="inline-flex items-center gap-1 text-amber-300 text-xs">
          <Clock3 className="w-3.5 h-3.5" />
          L1 进行中
        </span>
      );
    }
    if (item.gateStatus === 'missing') {
      return (
        <span className="inline-flex items-center gap-1 text-slate-300 text-xs">
          <HelpCircle className="w-3.5 h-3.5" />
          L1 缺失
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 text-red-300 text-xs">
        <AlertTriangle className="w-3.5 h-3.5" />
        刷新异常
      </span>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <button
        type="button"
        onClick={() => navigate('/')}
        className="flex items-center gap-1.5 text-sm text-white/50 hover:text-white/80 mb-6 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        返回首页
      </button>

      <div className="flex items-center gap-3 mb-4">
        <div className="w-12 h-12 rounded-xl bg-violet-500/15 flex items-center justify-center border border-violet-500/20">
          <ScanSearch className="w-6 h-6 text-violet-300" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-white">PR审查棱镜</h1>
          <p className="text-sm text-white/45 mt-0.5">PR / MR 变更专项审查（独立于产品评审员）</p>
        </div>
      </div>

      <div className="rounded-xl p-4 border border-white/10 bg-white/[0.03] text-sm text-white/60 mb-5">
        {hint}
      </div>

      <div className="rounded-xl p-4 border border-white/10 bg-white/[0.03] mb-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-sm font-medium text-white">新仓库接入向导</p>
          <span className="text-xs text-white/55 whitespace-nowrap">
            {onboardingDoneCount}/{onboardingSteps.length} 已完成
          </span>
        </div>
        <div className="mb-3 rounded-lg border border-white/10 bg-white/5 p-2">
          <div className="flex items-center justify-between text-[11px] text-white/55 px-1 mb-1">
            <span>接入进度</span>
            <span>{onboardingProgressPercent}%</span>
          </div>
          <div className="h-1.5 rounded bg-white/10 overflow-hidden">
            <div className="h-full bg-violet-400/80 transition-all" style={{ width: `${onboardingProgressPercent}%` }} />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3">
          {onboardingSteps.map((step, idx) => (
            <div
              key={step.key}
              className={`rounded-lg border px-3 py-2 ${
                step.done
                  ? 'border-emerald-400/30 bg-emerald-500/10'
                  : 'border-amber-400/25 bg-amber-500/10'
              }`}
            >
              <p className="text-[11px] text-white/55">步骤 {idx + 1}</p>
              <p className={`text-xs mt-0.5 ${step.done ? 'text-emerald-200' : 'text-amber-100'}`}>{step.title}</p>
            </div>
          ))}
        </div>
        {setupStatus ? (
          <div className="space-y-2 text-xs">
            <div className="flex flex-wrap gap-2">
              <span
                className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${
                  setupStatus.githubTokenConfigured
                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-red-400/30 bg-red-500/10 text-red-200'
                }`}
              >
                GitHub Token：{setupStatus.githubTokenConfigured ? '已配置' : '未配置'}
              </span>
              <span
                className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${
                  setupStatus.topDesign.ready
                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-amber-400/30 bg-amber-500/10 text-amber-200'
                }`}
              >
                顶层设计基线：{setupStatus.topDesign.ready ? '已就绪' : '待初始化'}
              </span>
              <span
                className={`inline-flex items-center gap-1 px-2 py-1 rounded border ${
                  canSubmitPr
                    ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-slate-400/30 bg-slate-500/10 text-slate-200'
                }`}
              >
                审查执行：{canSubmitPr ? '可提交 PR' : '需先完成接入'}
              </span>
            </div>

            <div className="rounded-lg border border-amber-400/20 bg-amber-500/10 p-3 text-amber-100">
              <p className="font-medium mb-1">Step 1 / 4：绑定目标仓库（每个新仓库都要配置）</p>
              <input
                type="text"
                value={bindingRepoInput}
                onChange={e => setBindingRepoInput(e.target.value)}
                placeholder="owner/repo 或 https://github.com/owner/repo/pull/123"
                className="w-full mt-1 bg-black/20 border border-white/15 rounded px-2 py-1.5 text-[11px] text-amber-50 placeholder-amber-100/40 focus:outline-none focus:border-amber-300/40"
              />
              {!isBindingRepoValid && (
                <p className="mt-1 text-[11px] text-amber-200/80">
                  请输入目标仓库（owner/repo）或粘贴该仓库 PR 链接，系统自动识别。
                </p>
              )}
              <p className="mt-2 font-medium">Step 2 / 4：执行该仓库初始化命令</p>
              <code className="block mt-1 rounded bg-black/25 px-2 py-1 whitespace-pre-wrap break-all">
                {repoScopedBootstrapCommand}
              </code>
              <p className="mt-2 font-medium">Step 3 / 4：将仓库条目写入 repo-bindings.yml</p>
              <code className="block mt-1 rounded bg-black/25 px-2 py-1 whitespace-pre-wrap break-all">
                {repoBindingSnippet || '# 先填写 owner/repo 后生成'}
              </code>
              <p className="mt-2 font-medium">Step 4 / 4：重新检测接入状态后提交 PR 审查</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void copyToClipboard(repoScopedBootstrapCommand, '已复制该仓库初始化命令')}
                  className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-white/15 whitespace-nowrap"
                >
                  复制该仓库初始化命令
                </button>
                <button
                  type="button"
                  disabled={!isBindingRepoValid}
                  onClick={() => void copyToClipboard(repoBindingSnippet, '已复制该仓库 bindings 片段')}
                  className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-white/15 whitespace-nowrap disabled:opacity-50"
                >
                  复制该仓库 bindings 片段
                </button>
                <button
                  type="button"
                  onClick={() => void copyToClipboard(topDesignBasisTemplateText, '已复制顶层设计依据模板')}
                  className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-white/15 whitespace-nowrap"
                >
                  复制顶层设计依据模板
                </button>
                <button
                  type="button"
                  onClick={() => void window.open(bootstrapGuidePath, '_blank', 'noopener,noreferrer')}
                  className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-white/15 whitespace-nowrap"
                >
                  打开接入说明
                </button>
                <button
                  type="button"
                  onClick={() => void loadSetupStatus()}
                  className="inline-flex items-center gap-1 rounded border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] text-white hover:bg-white/15 whitespace-nowrap"
                >
                  重新检测接入状态
                </button>
              </div>
              {setupActionMessage && <p className="mt-2 text-[11px] text-emerald-200">{setupActionMessage}</p>}
              {!canSubmitPr && setupStatus.guidance.length > 0 && (
                <ul className="list-disc ml-4 mt-2 space-y-1 text-[11px] text-amber-100">
                  {setupStatus.guidance.map((x, idx) => (
                    <li key={`${idx}-${x}`}>{x}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-white/40">配置状态加载失败，请稍后重试。</p>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-5">
        <div className="space-y-4">
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm font-medium text-white mb-3">提交 GitHub PR</p>
            <div className="space-y-3">
              <input
                type="text"
                value={prUrl}
                onChange={e => setPrUrl(e.target.value)}
                placeholder="https://github.com/org/repo/pull/123"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-violet-500/50"
                disabled={submitting}
              />
              <input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="备注（可选）"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-violet-500/50"
                disabled={submitting}
              />
              {formError && <p className="text-xs text-red-300">{formError}</p>}
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmitPr || submitting}
                className={`w-full inline-flex items-center justify-center gap-2 rounded-lg text-white text-sm font-medium py-2.5 transition-colors disabled:opacity-60 ${
                  canSubmitPr
                    ? 'bg-violet-600 hover:bg-violet-500'
                    : 'bg-slate-600 cursor-not-allowed'
                }`}
                title={canSubmitPr ? '提交并拉取审查结果' : '请先完成新仓库接入向导'}
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {submitting ? '提交中...' : canSubmitPr ? '提交并拉取' : '先完成接入向导'}
              </button>
              {!canSubmitPr && <p className="text-[11px] text-amber-200/85">{submissionBlockReason}</p>}
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-white">提交列表</p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-white/45 whitespace-nowrap">
                  总 {total} 条 / 当前页筛选 {filteredItems.length} 条
                </span>
                <button
                  type="button"
                  onClick={() => void handleBatchRefreshCurrentFiltered()}
                  disabled={loading || batchRefreshing || filteredItems.length === 0}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-50 whitespace-nowrap"
                  title="按当前筛选结果批量刷新"
                >
                  {batchRefreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                  {batchRefreshing
                    ? `批量刷新 ${batchProgress?.done ?? 0}/${batchProgress?.total ?? 0}`
                    : '批量刷新'}
                </button>
              </div>
            </div>
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/35" />
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      void handleSearch();
                    }
                  }}
                  placeholder="搜索 repo / 标题 / 备注"
                  className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-violet-500/50"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleSearch()}
                className="px-3 py-2 text-xs rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/70"
              >
                搜索
              </button>
            </div>
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                type="button"
                onClick={() => {
                  setActiveGateFilter('all');
                  void loadList(1, search.trim() || undefined, pageSize, 'all');
                }}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  activeGateFilter === 'all'
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                全部 ({gateStatusCounts.all})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveGateFilter('completed');
                  void loadList(1, search.trim() || undefined, pageSize, 'completed');
                }}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  activeGateFilter === 'completed'
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                completed ({gateStatusCounts.completed})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveGateFilter('pending');
                  void loadList(1, search.trim() || undefined, pageSize, 'pending');
                }}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  activeGateFilter === 'pending'
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                pending ({gateStatusCounts.pending})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveGateFilter('missing');
                  void loadList(1, search.trim() || undefined, pageSize, 'missing');
                }}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  activeGateFilter === 'missing'
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                missing ({gateStatusCounts.missing})
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveGateFilter('error');
                  void loadList(1, search.trim() || undefined, pageSize, 'error');
                }}
                className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                  activeGateFilter === 'error'
                    ? 'border-violet-400/50 bg-violet-500/15 text-violet-200'
                    : 'border-white/10 bg-white/5 text-white/65 hover:bg-white/10'
                }`}
              >
                error ({gateStatusCounts.error})
              </button>
            </div>
            {batchProgress && (
              <div className="mb-3 rounded-md border border-white/10 bg-white/5 px-3 py-2">
                <div className="flex items-center justify-between text-[11px] text-white/60">
                  <span>
                    刷新进度 {batchProgress.done}/{batchProgress.total}
                  </span>
                  <span>
                    成功 {batchProgress.success} / 失败 {batchProgress.failed}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 rounded bg-white/10 overflow-hidden">
                  <div
                    className="h-full bg-violet-400/80 transition-all"
                    style={{ width: `${batchProgressPercent}%` }}
                  />
                </div>
              </div>
            )}
            {listError && <p className="text-xs text-red-300 mb-2">{listError}</p>}
            {loading ? (
              <div className="h-28 flex items-center justify-center">
                <Loader2 className="w-5 h-5 text-violet-300 animate-spin" />
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="h-28 flex items-center justify-center text-sm text-white/35">暂无提交记录</div>
            ) : (
              <div className="space-y-2 max-h-[520px] overflow-auto pr-1">
                {filteredItems.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                      selectedId === item.id
                        ? 'border-violet-400/40 bg-violet-500/10'
                        : 'border-white/10 bg-white/5 hover:bg-white/10'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm text-white truncate">
                        {item.repoOwner}/{item.repoName}#{item.pullRequestNumber}
                      </p>
                      {selectedId === item.id && <CircleDot className="w-3.5 h-3.5 text-violet-300 shrink-0" />}
                    </div>
                    <p className="text-xs text-white/40 truncate mt-1">
                      {item.pullRequestTitle || '尚未拉取标题'}
                    </p>
                    <p className="text-[11px] text-white/35 mt-1">
                      更新时间：{formatDateTime(item.updatedAt)}
                    </p>
                    <div className="mt-2">{gateBadge(item)}</div>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between gap-2">
              <div className="text-xs text-white/45">
                第 {page} / {totalPages} 页
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={pageSize}
                  onChange={e => {
                    const nextPageSize = Number(e.target.value) || 20;
                    void loadList(1, search.trim() || undefined, nextPageSize, activeGateFilter);
                  }}
                  className="bg-white/5 border border-white/10 rounded-md px-2 py-1 text-xs text-white"
                >
                  <option value={10}>10 / 页</option>
                  <option value={20}>20 / 页</option>
                  <option value={50}>50 / 页</option>
                </select>
                <button
                  type="button"
                  disabled={page <= 1 || loading}
                  onClick={() => void loadList(page - 1, search.trim() || undefined, pageSize, activeGateFilter)}
                  className="px-2.5 py-1 text-xs rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-50"
                >
                  上一页
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages || loading}
                  onClick={() => void loadList(page + 1, search.trim() || undefined, pageSize, activeGateFilter)}
                  className="px-2.5 py-1 text-xs rounded-md border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 disabled:opacity-50"
                >
                  下一页
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 min-h-[560px]">
          {!selected ? (
            <div className="h-full min-h-[420px] flex items-center justify-center text-sm text-white/35">
              请选择一条提交记录查看详情
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-white">
                    {selected.repoOwner}/{selected.repoName}#{selected.pullRequestNumber}
                  </h2>
                  <p className="text-sm text-white/55 mt-1">
                    {selected.pullRequestTitle || '暂无标题'}
                  </p>
                  <div className="mt-2">{gateBadge(selected)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleRefresh(selected.id)}
                    disabled={refreshingId === selected.id || batchRefreshing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/75 disabled:opacity-60"
                  >
                    {refreshingId === selected.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    刷新
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(selected.id)}
                    disabled={deletingId === selected.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-red-400/30 bg-red-500/10 hover:bg-red-500/15 text-red-200 disabled:opacity-60"
                  >
                    {deletingId === selected.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    删除
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">PR 状态</p>
                  <p className="text-sm text-white mt-1">{selected.pullRequestState}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">PR 作者</p>
                  <p className="text-sm text-white mt-1">{selected.pullRequestAuthor || '-'}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">风险分</p>
                  <p className="text-sm text-white mt-1">{selected.riskScore ?? '-'}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">置信度</p>
                  <p className="text-sm text-white mt-1">
                    {selected.confidencePercent != null ? `${selected.confidencePercent}%` : '-'}
                  </p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">创建时间</p>
                  <p className="text-sm text-white mt-1">{formatDateTime(selected.createdAt)}</p>
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40">最近刷新</p>
                  <p className="text-sm text-white mt-1">{formatDateTime(selected.lastRefreshedAt)}</p>
                </div>
              </div>

              <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                <p className="text-xs text-white/40 mb-1">决策建议</p>
                <p className="text-sm text-white/85">{selected.decisionSuggestion || '暂无'}</p>
              </div>

              {selected.note && (
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40 mb-1">备注</p>
                  <p className="text-sm text-white/85">{selected.note}</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40 mb-2">阻断项</p>
                  {selected.blockers.length === 0 ? (
                    <p className="text-sm text-white/55">无</p>
                  ) : (
                    <ul className="list-disc ml-4 space-y-1 text-sm text-white/85">
                      {selected.blockers.map((x, idx) => (
                        <li key={`${idx}-${x}`}>{x}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40 mb-2">风险建议</p>
                  {selected.advisories.length === 0 ? (
                    <p className="text-sm text-white/55">无</p>
                  ) : (
                    <ul className="list-disc ml-4 space-y-1 text-sm text-white/85">
                      {selected.advisories.map((x, idx) => (
                        <li key={`${idx}-${x}`}>{x}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                  <p className="text-xs text-white/40 mb-2">架构师关注问题</p>
                  {selected.focusQuestions.length === 0 ? (
                    <p className="text-sm text-white/55">无</p>
                  ) : (
                    <ol className="list-decimal ml-4 space-y-1 text-sm text-white/85">
                      {selected.focusQuestions.map((x, idx) => (
                        <li key={`${idx}-${x}`}>{x}</li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <a
                  href={selected.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/75"
                >
                  PR 链接
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                {selected.gateDetailsUrl && (
                  <a
                    href={selected.gateDetailsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/75"
                  >
                    L1 Gate 详情
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
                {selected.decisionCardCommentUrl && (
                  <a
                    href={selected.decisionCardCommentUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/75"
                  >
                    决策卡评论
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>

              {selected.lastRefreshError && (
                <div className="rounded-lg border border-red-400/25 bg-red-500/10 p-3 text-sm text-red-200">
                  最近刷新错误：{selected.lastRefreshError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
