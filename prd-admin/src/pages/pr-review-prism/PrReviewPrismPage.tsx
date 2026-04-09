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
        <p className="text-sm font-medium text-white mb-2">初始化与配置检查</p>
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
            </div>

            {!setupStatus.readyForFullRefresh && setupStatus.guidance.length > 0 && (
              <div className="rounded-lg border border-amber-400/20 bg-amber-500/10 p-3 text-amber-100">
                <p className="font-medium mb-1">当前无法完整拉取审查结果，请先完成以下配置：</p>
                <ul className="list-disc ml-4 space-y-1">
                  {setupStatus.guidance.map((x, idx) => (
                    <li key={`${idx}-${x}`}>{x}</li>
                  ))}
                </ul>
                <div className="mt-2 text-amber-100/80">
                  <p>推荐初始化命令：</p>
                  <code className="block mt-1 rounded bg-black/25 px-2 py-1 whitespace-pre-wrap break-all">
                    bash scripts/init-pr-prism-basis.sh
                  </code>
                </div>
              </div>
            )}
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
                disabled={submitting}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium py-2.5 transition-colors disabled:opacity-60"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {submitting ? '提交中...' : '提交并拉取'}
              </button>
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
