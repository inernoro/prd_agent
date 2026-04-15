import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Search, ChevronLeft, ChevronRight, ArrowLeft, ChevronDown, ChevronUp, CheckCircle, XCircle, Clock } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { getAllReviewSubmissions, getReviewSubmitters } from '@/services';
import type { ReviewSubmission } from '@/services';

function getStatusInfo(item: ReviewSubmission): { label: string; color: string; icon: React.ReactNode } {
  if (item.status === 'Done') {
    if (item.isPassed === false) return { label: '未通过', color: 'text-orange-400/80', icon: <XCircle className="w-3.5 h-3.5" /> };
    return { label: '已通过', color: 'text-emerald-400/80', icon: <CheckCircle className="w-3.5 h-3.5" /> };
  }
  if (item.status === 'Error') return { label: '失败', color: 'text-red-400/80', icon: <XCircle className="w-3.5 h-3.5" /> };
  if (item.status === 'Running') return { label: '评审中', color: 'text-blue-400/80', icon: <MapSpinner size={14} /> };
  return { label: '等待评审', color: 'text-amber-400/80', icon: <Clock className="w-3.5 h-3.5" /> };
}

type StatusFilter = 'all' | 'passed' | 'notPassed' | 'error';
const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'passed', label: '已通过' },
  { key: 'notPassed', label: '未通过' },
  { key: 'error', label: '失败' },
];

interface Submitter {
  id: string;
  name: string;
}

export function ReviewAgentAllPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<ReviewSubmission[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedSubmitterId, setSelectedSubmitterId] = useState('');
  const [submitters, setSubmitters] = useState<Submitter[]>([]);
  const [tagsExpanded, setTagsExpanded] = useState(false);

  const pageSize = 20;

  useEffect(() => {
    getReviewSubmitters().then(res => {
      if (res.success && res.data) setSubmitters(res.data.submitters);
    });
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    const filterParam = statusFilter !== 'all' ? statusFilter : undefined;
    const res = await getAllReviewSubmissions(page, pageSize, selectedSubmitterId || undefined, filterParam);
    if (res.success && res.data) {
      setItems(res.data.items);
      setTotal(res.data.total);
    }
    setLoading(false);
  }, [page, statusFilter, selectedSubmitterId]);

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = search
    ? items.filter(i =>
        i.title.toLowerCase().includes(search.toLowerCase()) ||
        i.submitterName.toLowerCase().includes(search.toLowerCase())
      )
    : items;

  const totalPages = Math.ceil(total / pageSize);

  const TAG_COLLAPSED_COUNT = 10;
  const visibleSubmitters = tagsExpanded ? submitters : submitters.slice(0, TAG_COLLAPSED_COUNT);
  const hasMoreTags = submitters.length > TAG_COLLAPSED_COUNT;

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      {/* 返回按钮 */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-sm text-white/40 hover:text-white/70 mb-5 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        返回
      </button>

      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 rounded-lg bg-indigo-500/10 flex items-center justify-center">
          <ClipboardList className="w-4 h-4 text-indigo-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-white">全部评审提交</h1>
          <p className="text-xs text-white/40 mt-0.5">共 {total} 条提交记录</p>
        </div>
      </div>

      {/* 搜索框 */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="搜索方案标题或提交人..."
          className="w-full bg-white/5 border border-white/10 rounded-lg pl-9 pr-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-indigo-500/50 transition-colors"
        />
      </div>

      {/* 状态筛选 Tabs */}
      <div className="flex gap-1 mb-3">
        {STATUS_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setStatusFilter(tab.key); setPage(1); }}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
              statusFilter === tab.key
                ? 'bg-indigo-600 border-indigo-600 text-white'
                : 'bg-white/5 border-white/10 text-white/50 hover:text-white/80 hover:border-white/20'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 用户标签筛选 */}
      {submitters.length > 0 && (
        <div className="mb-5">
          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => { setSelectedSubmitterId(''); setPage(1); }}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                !selectedSubmitterId
                  ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                  : 'bg-white/5 border-white/10 text-white/50 hover:border-white/20 hover:text-white/70'
              }`}
            >
              全部
            </button>
            {visibleSubmitters.map(s => (
              <button
                key={s.id}
                onClick={() => { setSelectedSubmitterId(prev => prev === s.id ? '' : s.id); setPage(1); }}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  selectedSubmitterId === s.id
                    ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300'
                    : 'bg-white/5 border-white/10 text-white/50 hover:border-white/20 hover:text-white/70'
                }`}
              >
                {s.name}
              </button>
            ))}
            {hasMoreTags && (
              <button
                onClick={() => setTagsExpanded(v => !v)}
                className="text-xs px-2.5 py-1 rounded-full border border-white/10 text-white/30 hover:text-white/60 transition-colors flex items-center gap-0.5"
              >
                {tagsExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {tagsExpanded ? '收起' : `+${submitters.length - TAG_COLLAPSED_COUNT} 人`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 列表 */}
      {loading ? (
        <MapSectionLoader />
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-white/30 text-sm">暂无提交记录</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(item => {
            const statusInfo = getStatusInfo(item);
            return (
              <button
                key={item.id}
                onClick={() => navigate(`/review-agent/submissions/${item.id}`)}
                className="w-full flex items-center gap-4 bg-white/3 hover:bg-white/5 border border-white/8 rounded-lg px-5 py-4 text-left transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-white truncate">{item.title}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-white/40">
                    <span>{item.submitterName}</span>
                    <span>·</span>
                    <span>{item.fileName}</span>
                    <span>·</span>
                    <span>{new Date(item.submittedAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                </div>
                <div className={`flex items-center gap-1.5 text-xs flex-shrink-0 ${statusInfo.color}`}>
                  {statusInfo.icon}
                  {statusInfo.label}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* 分页 */}
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
