// 产品管理专用视图：独立评审智能体保持原样；接口、弹框及流式组件继续复用。
import { useSmartBack } from '@/hooks/useSmartBack';
import { useReviewNavigation } from './reviewNavigation';
import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight, ArrowLeft, CheckCircle, XCircle, Clock, List, Trophy } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { SectionShell } from '@/components/agent-shell/AgentFullscreenLayout';
import { OverviewDataTable, TruncateCell } from '@/pages/product-agent/overviewDataTable';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { getAllReviewSubmissions, getReviewSubmitters } from '@/services/real/productReviewApi';
import type { ReviewSubmission } from '@/services/real/productReviewApi';
import { ReviewLeaderboardView } from './components/ReviewLeaderboardView';

function getStatusInfo(item: ReviewSubmission): { label: string; color: string; icon: React.ReactNode } {
  if (item.status === 'Done') {
    if (item.isPassed === false) return { label: '未通过', color: 'text-[color:var(--accent-fg-warning)]', icon: <XCircle className="w-3.5 h-3.5" /> };
    return { label: '已通过', color: 'text-[color:var(--accent-fg-success)]', icon: <CheckCircle className="w-3.5 h-3.5" /> };
  }
  if (item.status === 'Error') return { label: '失败', color: 'text-[color:var(--accent-fg-danger)]', icon: <XCircle className="w-3.5 h-3.5" /> };
  if (item.status === 'Running') return { label: '评审中', color: 'text-[color:var(--accent-fg-blue)]', icon: <MapSpinner size={14} /> };
  return { label: '等待评审', color: 'text-[color:var(--accent-fg-amber)]', icon: <Clock className="w-3.5 h-3.5" /> };
}

type StatusFilter = 'all' | 'passed' | 'notPassed' | 'error';
const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'passed', label: '已通过' },
  { key: 'notPassed', label: '未通过' },
  { key: 'error', label: '失败' },
];

type ViewMode = 'list' | 'leaderboard-user';
const VIEW_TABS: { key: ViewMode; label: string; icon: React.ReactNode }[] = [
  { key: 'list', label: '列表', icon: <List className="w-3.5 h-3.5" /> },
  { key: 'leaderboard-user', label: '排行榜', icon: <Trophy className="w-3.5 h-3.5" /> },
];

interface Submitter {
  id: string;
  name: string;
}

export function ReviewAgentAllPage() {
  const navigate = useNavigate();
  const reviewNav = useReviewNavigation();
  // 智能返回：弹栈回真正的上一页；深链直达无历史时兜底回评审首页
  const goBack = useSmartBack(reviewNav.reviewHome);
  const [searchParams, setSearchParams] = useSearchParams();

  const viewParam = (searchParams.get('view') as ViewMode) || 'list';
  const view: ViewMode = VIEW_TABS.some(v => v.key === viewParam) ? viewParam : 'list';

  const setView = (next: ViewMode) => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'list') sp.delete('view'); else sp.set('view', next);
    setSearchParams(sp, { replace: true });
  };

  const [items, setItems] = useState<ReviewSubmission[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedSubmitterId, setSelectedSubmitterId] = useState('');
  const [submitters, setSubmitters] = useState<Submitter[]>([]);

  const pageSize = 20;

  useEffect(() => {
    getReviewSubmitters().then(res => {
      if (res.success && res.data) setSubmitters(res.data.submitters);
    });
  }, []);

  const loadData = useCallback(async () => {
    if (view !== 'list') return;
    setLoading(true);
    const filterParam = statusFilter !== 'all' ? statusFilter : undefined;
    const res = await getAllReviewSubmissions(page, pageSize, selectedSubmitterId || undefined, filterParam);
    if (res.success && res.data) {
      setItems(res.data.items);
      setTotal(res.data.total);
    }
    setLoading(false);
  }, [page, statusFilter, selectedSubmitterId, view]);

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = search
    ? items.filter(i =>
        i.title.toLowerCase().includes(search.toLowerCase()) ||
        i.submitterName.toLowerCase().includes(search.toLowerCase())
      )
    : items;

  const totalPages = Math.ceil(total / pageSize);

  return (
    <SectionShell
      title="全部评审提交"
      count={view === 'list' && !loading ? total : undefined}
      desc={view === 'list' ? '查看全部方案的评审结果，按状态和提交人筛选' : '按自然月查看评审排行'}
      actions={<Button size="sm" variant="ghost" onClick={goBack} aria-label="返回评审"><ArrowLeft size={14} /><span className="hidden sm:inline">返回评审</span></Button>}
    >
      <div className="flex min-h-full min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 border-b border-token-subtle pb-3" role="group" aria-label="评审视图">
            {VIEW_TABS.map(tab => (
              <Button size="sm"
                key={tab.key}
                onClick={() => setView(tab.key)}
                variant={view === tab.key ? 'secondary' : 'ghost'}
                aria-pressed={view === tab.key}
              >
                {tab.icon}
                {tab.label}
              </Button>
            ))}
          </div>

          {view === 'leaderboard-user' && <ReviewLeaderboardView groupBy="submitter" />}

          {view === 'list' && (
            <>
              <div className="flex min-w-0 flex-wrap items-center gap-3">
              <label className="flex min-w-0 basis-full items-center gap-2 rounded-lg border border-token-subtle bg-token-nested px-3 py-2 focus-within:border-[var(--accent-fg-blue)] sm:min-w-64 sm:flex-1 sm:basis-auto">
                <Search size={15} className="shrink-0 text-token-muted" />
                <input
                  type="text"
                  aria-label="搜索方案标题或提交人"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="搜索当前页的方案标题或提交人"
                  className="min-w-0 w-full bg-transparent text-sm text-token-primary placeholder-token-muted outline-none"
                />
              </label>
              <label className="flex min-w-0 items-center gap-2 text-xs text-token-secondary">
                <span className="shrink-0">提交人</span>
                <select aria-label="提交人" value={selectedSubmitterId}
                  onChange={e => { setSelectedSubmitterId(e.target.value); setPage(1); }}
                  className="min-w-0 max-w-48 rounded-lg border border-token-subtle bg-token-nested px-3 py-2 text-sm text-token-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                  <option value="">全部提交人</option>
                  {submitters.map(submitter => <option key={submitter.id} value={submitter.id}>{submitter.name}</option>)}
                </select>
              </label>
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="评审状态">
                {STATUS_TABS.map(tab => (
                  <Button size="sm"
                    key={tab.key}
                    onClick={() => { setStatusFilter(tab.key); setPage(1); }}
                    variant={statusFilter === tab.key ? 'secondary' : 'ghost'}
                    aria-pressed={statusFilter === tab.key}
                  >
                    {tab.label}
                  </Button>
                ))}
              </div>
              </div>

              {/* 列表 */}
              {loading ? (
                <MapSectionLoader />
              ) : filtered.length === 0 ? (
                <div className="text-center py-16 text-token-muted text-sm">暂无提交记录</div>
              ) : (
                <OverviewDataTable tableKey="review-all-submissions" rows={filtered}
                  onRowClick={item => navigate(reviewNav.submission(item.id))}
                  columns={[
                    { key: 'title', header: '方案标题', defaultWidth: 350, render: item => <button type="button" title={item.title} className="block w-full truncate text-left text-sm text-token-primary hover:underline focus-visible:outline focus-visible:outline-2" onClick={event => { event.stopPropagation(); navigate(reviewNav.submission(item.id)); }}>{item.title}</button> },
                    { key: 'submitter', header: '提交人', defaultWidth: 100, render: item => <TruncateCell text={item.submitterName} className="text-xs text-token-secondary" /> },
                    { key: 'file', header: '方案文件', defaultWidth: 240, render: item => <TruncateCell text={item.fileName} className="text-xs text-token-secondary" /> },
                    { key: 'date', header: '提交日期', defaultWidth: 115, render: item => <span className="text-xs text-token-muted">{new Date(item.submittedAt).toLocaleDateString('zh-CN')}</span> },
                    { key: 'status', header: '评审状态', defaultWidth: 110, render: item => {
                    const statusInfo = getStatusInfo(item);
                    return <span className={`inline-flex items-center gap-1.5 text-xs ${statusInfo.color}`}>{statusInfo.icon}{statusInfo.label}</span>;
                    } },
                    { key: 'appeal', header: '申诉状态', defaultWidth: 100, render: item => <span className="text-xs text-token-secondary">{item.appealStatus === 'Pending' ? '申诉中' : item.appealStatus === 'Approved' ? '申诉成功' : item.appealStatus ? '申诉驳回' : '—'}</span> },
                  ]}
                />
              )}

              {/* 分页 */}
              {totalPages > 1 && (
                <div className="mt-auto flex flex-wrap items-center justify-end gap-3 border-t border-token-subtle pt-4">
                  <Button size="sm" aria-label="上一页"
                    disabled={page <= 1}
                    onClick={() => setPage(p => p - 1)}
                  >
                    <ChevronLeft className="w-4 h-4 text-token-secondary" />
                  </Button>
                  <span className="text-xs text-token-secondary">共 {total} 条，第 {page} / {totalPages} 页</span>
                  <Button size="sm" aria-label="下一页"
                    disabled={page >= totalPages}
                    onClick={() => setPage(p => p + 1)}
                  >
                    <ChevronRight className="w-4 h-4 text-token-secondary" />
                  </Button>
                </div>
              )}
            </>
          )}
      </div>
    </SectionShell>
  );
}

