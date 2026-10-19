import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, Plus, Search, ChevronRight, ChevronLeft, CheckCircle, XCircle, Clock, Users, Settings2, Bell, ListOrdered, BookOpenCheck } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { getMyReviewSubmissions } from '@/services';
import { useAuthStore } from '@/stores/authStore';
import type { ReviewSubmission } from '@/services';
import { ReviewAgentDimensionsModal } from './ReviewAgentDimensionsModal';
import { ReviewAgentWebhookModal } from './ReviewAgentWebhookModal';
import { useReviewNavigation } from './reviewNavigation';
import { TipsEntryButton } from '@/components/daily-tips/TipsEntryButton';

function getStatusDisplay(item: ReviewSubmission): { label: string; color: string; icon: React.ReactNode } {
  if (item.status === 'Done') {
    if (item.isPassed === false) return { label: '未通过', color: 'text-[color:var(--accent-fg-warning)]', icon: <XCircle className="w-3.5 h-3.5" /> };
    return { label: '已通过', color: 'text-[color:var(--accent-fg-success)]', icon: <CheckCircle className="w-3.5 h-3.5" /> };
  }
  if (item.status === 'Error') return { label: '失败', color: 'text-[color:var(--accent-fg-danger)]', icon: <XCircle className="w-3.5 h-3.5" /> };
  if (item.status === 'Running') return { label: '评审中', color: 'text-[color:var(--accent-fg-blue)]', icon: <MapSpinner size={14} /> };
  return { label: '等待评审', color: 'text-[color:var(--accent-fg-amber)]', icon: <Clock className="w-3.5 h-3.5" /> };
}

type FilterTab = 'all' | 'passed' | 'notPassed' | 'error';

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: '全部提交' },
  { key: 'passed', label: '已通过' },
  { key: 'notPassed', label: '未通过' },
  { key: 'error', label: '失败' },
];

const PAGE_SIZE = 50;

export function ReviewAgentPage() {
  const navigate = useNavigate();
  const reviewNav = useReviewNavigation();
  const permissions = useAuthStore(s => s.permissions ?? []);
  const canViewAll = permissions.includes('review-agent.view-all') || permissions.includes('super');
  const canManage = permissions.includes('review-agent.manage') || permissions.includes('super');
  const [dimsModalOpen, setDimsModalOpen] = useState(false);
  const [webhookModalOpen, setWebhookModalOpen] = useState(false);
  const canUseProduct = permissions.includes('product-agent.use') || permissions.includes('product-agent.version-apply') || permissions.includes('super');

  const [items, setItems] = useState<ReviewSubmission[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    const filterParam = activeTab !== 'all' ? activeTab : undefined;
    const res = await getMyReviewSubmissions(page, PAGE_SIZE, filterParam);
    if (res.success && res.data) {
      setItems(res.data.items);
      setTotal(res.data.total);
    }
    setLoading(false);
  }, [page, activeTab]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleTabChange = (tab: FilterTab) => {
    setActiveTab(tab);
    setPage(1);
  };

  const filtered = search
    ? items.filter(i => i.title.toLowerCase().includes(search.toLowerCase()))
    : items;

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <>
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-token-subtle px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-token-primary">方案评审</h1>
            <p className="mt-0.5 text-xs text-token-muted">上传产品方案，AI 多维度评审打分</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
              {!reviewNav.inProductManagement && (
                <>
                  {canUseProduct && <button onClick={() => navigate('/product-agent?section=versions')} className="flex items-center gap-1.5 rounded-lg border border-token-subtle bg-token-nested px-3 py-1.5 text-sm text-token-secondary hover-bg-soft" title="在产品管理的内部与正式版本页申领">
                    <BookOpenCheck className="w-3.5 h-3.5" />到产品管理申领版本号
                  </button>}
                  <button onClick={() => navigate(reviewNav.assessments)} className="flex items-center gap-1.5 rounded-lg border border-token-subtle bg-token-nested px-3 py-1.5 text-sm text-token-secondary hover-bg-soft" title="上传 Excel 需求表并进行优先级评估">
                    <ListOrdered className="w-3.5 h-3.5" />需求评估
                  </button>
                </>
              )}
              <TipsEntryButton compact />
              {canManage && (
                <>
                  <button
                    onClick={() => setWebhookModalOpen(true)}
                    className="flex items-center gap-1.5 rounded-lg border border-token-subtle bg-token-nested px-3 py-1.5 text-sm text-token-secondary hover-bg-soft transition-colors"
                    title="Webhook 通知配置"
                  >
                    <Bell className="w-3.5 h-3.5" />
                    通知配置
                  </button>
                  <button
                    onClick={() => setDimsModalOpen(true)}
                    className="flex items-center gap-1.5 rounded-lg border border-token-subtle bg-token-nested px-3 py-1.5 text-sm text-token-secondary hover-bg-soft transition-colors"
                    title="评审维度配置"
                  >
                    <Settings2 className="w-3.5 h-3.5" />
                    维度配置
                  </button>
                </>
              )}
              {canViewAll && (
                <button
                  onClick={() => navigate(reviewNav.all)}
                  className="flex items-center gap-1.5 rounded-lg border border-token-subtle bg-token-nested px-3 py-1.5 text-sm text-token-secondary hover-bg-soft transition-colors"
                >
                  <Users className="w-3.5 h-3.5" />
                  全部提交
                </button>
              )}
              <button
                onClick={() => navigate(reviewNav.submit)}
                className="flex items-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/15 px-3 py-1.5 text-sm font-medium text-[color:var(--accent-fg-blue)] hover:bg-cyan-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/60 transition-colors"
              >
                <Plus className="w-4 h-4" />
                提交方案
              </button>
            </div>
          </div>
        </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" style={{ overscrollBehavior: 'contain' }}>
      {/* 筛选 Tab + 搜索 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap border-b border-token-subtle">
          {FILTER_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => handleTabChange(tab.key)}
              className={`border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500/60 ${
                activeTab === tab.key
                  ? 'border-cyan-400 text-[color:var(--accent-fg-blue)]'
                  : 'border-transparent text-token-muted hover-text-primary'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-token-muted" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索方案标题..."
            className="w-full rounded-lg border border-token-subtle bg-token-nested py-2 pl-9 pr-4 text-sm text-token-primary placeholder-token-muted outline-none focus:border-cyan-500/40 transition-colors"
          />
        </div>
      </div>

      {/* 提交列表 */}
      <div>
        {loading ? (
          <MapSectionLoader />
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-token-nested flex items-center justify-center mx-auto">
              <ClipboardCheck className="w-7 h-7 text-token-muted" />
            </div>
            <div>
              <p className="text-token-muted text-sm">
                {activeTab === 'all' ? '还没有提交记录' : activeTab === 'passed' ? '暂无通过的记录' : activeTab === 'notPassed' ? '暂无未通过的记录' : '暂无失败的记录'}
              </p>
              {activeTab === 'all' && (
                <p className="text-token-muted text-xs mt-1">上传产品方案，AI 将帮助你预先发现评审问题</p>
              )}
            </div>
            {activeTab === 'all' && (
              <button
                onClick={() => navigate(reviewNav.submit)}
                className="inline-flex items-center gap-1.5 text-sm text-[color:var(--accent-fg-blue)] hover:text-[color:var(--accent-fg-blue)] transition-colors"
              >
                <Plus className="w-4 h-4" />
                提交第一个方案
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-token-subtle bg-token-nested">
            {filtered.map(item => {
              const statusInfo = getStatusDisplay(item);
              return (
                <button
                  key={item.id}
                  onClick={() => navigate(reviewNav.submission(item.id))}
                  className="group flex w-full items-center gap-4 border-b border-token-subtle px-4 py-3.5 text-left transition-colors last:border-b-0 hover-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500/60"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-token-primary truncate group-hover:text-[color:var(--accent-fg-blue)] transition-colors">
                      {item.title}
                    </p>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-token-muted">
                      <span className="max-w-full truncate">{item.fileName}</span>
                      <span>·</span>
                      <span>{new Date(item.submittedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  </div>
                  <div className={`flex items-center gap-1.5 text-xs flex-shrink-0 ${statusInfo.color}`}>
                    {statusInfo.icon}
                    {statusInfo.label}
                  </div>
                  <ChevronRight className="w-4 h-4 text-token-muted group-hover:text-[var(--text-primary)] transition-colors flex-shrink-0" />
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* 分页（超过50条时显示） */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <button
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
            className="p-2 rounded-lg bg-token-nested border border-token-subtle disabled:opacity-30 hover-bg-soft transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-token-secondary" />
          </button>
          <span className="text-sm text-token-secondary">第 {page} / {totalPages} 页</span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="p-2 rounded-lg bg-token-nested border border-token-subtle disabled:opacity-30 hover-bg-soft transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-token-secondary" />
          </button>
        </div>
      )}
    </div>
    </div>
      <ReviewAgentDimensionsModal open={dimsModalOpen} onClose={() => setDimsModalOpen(false)} />
      <ReviewAgentWebhookModal open={webhookModalOpen} onClose={() => setWebhookModalOpen(false)} />
    </>
  );
}
