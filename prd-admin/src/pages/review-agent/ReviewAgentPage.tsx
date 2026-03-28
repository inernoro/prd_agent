import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, Plus, Search, ChevronRight, ChevronLeft, CheckCircle, XCircle, Clock, Loader2, Users } from 'lucide-react';
import { getMyReviewSubmissions } from '@/services';
import { useAuthStore } from '@/stores/authStore';
import type { ReviewSubmission } from '@/services';

function getStatusDisplay(item: ReviewSubmission): { label: string; color: string; icon: React.ReactNode } {
  if (item.status === 'Done') {
    if (item.isPassed === true) return { label: '已通过', color: 'text-emerald-400/80', icon: <CheckCircle className="w-3.5 h-3.5" /> };
    if (item.isPassed === false) return { label: '未通过', color: 'text-orange-400/80', icon: <XCircle className="w-3.5 h-3.5" /> };
    return { label: '已完成', color: 'text-emerald-400/80', icon: <CheckCircle className="w-3.5 h-3.5" /> };
  }
  if (item.status === 'Error') return { label: '失败', color: 'text-red-400/80', icon: <XCircle className="w-3.5 h-3.5" /> };
  if (item.status === 'Running') return { label: '评审中', color: 'text-blue-400/80', icon: <Loader2 className="w-3.5 h-3.5 animate-spin" /> };
  return { label: '等待评审', color: 'text-amber-400/80', icon: <Clock className="w-3.5 h-3.5" /> };
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
  const permissions = useAuthStore(s => s.permissions ?? []);
  const canViewAll = permissions.includes('review-agent.view-all') || permissions.includes('super');

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
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* 页头 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center">
            <ClipboardCheck className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-white">产品评审员</h1>
            <p className="text-sm text-white/40 mt-0.5">上传产品方案，AI 多维度评审打分</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canViewAll && (
            <button
              onClick={() => navigate('/review-agent/all')}
              className="flex items-center gap-1.5 text-sm text-white/50 hover:text-white/80 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-2 transition-colors"
            >
              <Users className="w-3.5 h-3.5" />
              全部提交
            </button>
          )}
          <button
            onClick={() => navigate('/review-agent/submit')}
            className="flex items-center gap-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg px-4 py-2 transition-colors"
          >
            <Plus className="w-4 h-4" />
            提交方案
          </button>
        </div>
      </div>

      {/* 筛选 Tab + 搜索 */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex gap-1 p-1 bg-white/5 rounded-lg border border-white/8">
          {FILTER_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => handleTabChange(tab.key)}
              className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                activeTab === tab.key
                  ? 'bg-indigo-600 text-white'
                  : 'text-white/50 hover:text-white/80'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索方案标题..."
            className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-4 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-indigo-500/50 transition-colors"
          />
        </div>
      </div>

      {/* 提交列表 */}
      <div>
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16 space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-white/3 flex items-center justify-center mx-auto">
              <ClipboardCheck className="w-7 h-7 text-white/20" />
            </div>
            <div>
              <p className="text-white/40 text-sm">
                {activeTab === 'all' ? '还没有提交记录' : activeTab === 'passed' ? '暂无通过的记录' : activeTab === 'notPassed' ? '暂无未通过的记录' : '暂无失败的记录'}
              </p>
              {activeTab === 'all' && (
                <p className="text-white/25 text-xs mt-1">上传产品方案，AI 将帮助你预先发现评审问题</p>
              )}
            </div>
            {activeTab === 'all' && (
              <button
                onClick={() => navigate('/review-agent/submit')}
                className="inline-flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
              >
                <Plus className="w-4 h-4" />
                提交第一个方案
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(item => {
              const statusInfo = getStatusDisplay(item);
              return (
                <button
                  key={item.id}
                  onClick={() => navigate(`/review-agent/submissions/${item.id}`)}
                  className="w-full flex items-center gap-4 bg-white/3 hover:bg-white/5 border border-white/8 rounded-xl px-5 py-4 text-left transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate group-hover:text-indigo-200 transition-colors">
                      {item.title}
                    </p>
                    <div className="flex items-center gap-3 text-xs text-white/35 mt-1">
                      <span>{item.fileName}</span>
                      <span>·</span>
                      <span>{new Date(item.submittedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  </div>
                  <div className={`flex items-center gap-1.5 text-xs flex-shrink-0 ${statusInfo.color}`}>
                    {statusInfo.icon}
                    {statusInfo.label}
                  </div>
                  <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/40 transition-colors flex-shrink-0" />
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
            className="p-2 rounded-lg bg-white/5 border border-white/10 disabled:opacity-30 hover:bg-white/10 transition-colors"
          >
            <ChevronLeft className="w-4 h-4 text-white/70" />
          </button>
          <span className="text-sm text-white/50">第 {page} / {totalPages} 页</span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
            className="p-2 rounded-lg bg-white/5 border border-white/10 disabled:opacity-30 hover:bg-white/10 transition-colors"
          >
            <ChevronRight className="w-4 h-4 text-white/70" />
          </button>
        </div>
      )}
    </div>
  );
}
