import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ListOrdered, Upload, ChevronRight, ChevronLeft, CheckCircle, XCircle, Clock, FileSpreadsheet } from 'lucide-react';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { listAssessments, parseAssessmentExcel } from '@/services';
import type { RequirementAssessmentRun } from '@/services';

const PAGE_SIZE = 20;

function getStatusDisplay(run: RequirementAssessmentRun): { label: string; color: string; icon: React.ReactNode } {
  switch (run.status) {
    case 'Done':
      return { label: '已完成', color: 'text-emerald-400/80', icon: <CheckCircle className="w-3.5 h-3.5" /> };
    case 'Error':
      return { label: '失败', color: 'text-red-400/80', icon: <XCircle className="w-3.5 h-3.5" /> };
    case 'Running':
      return { label: '评估中', color: 'text-blue-400/80', icon: <MapSpinner size={14} /> };
    case 'Queued':
      return { label: '等待评估', color: 'text-amber-400/80', icon: <Clock className="w-3.5 h-3.5" /> };
    default:
      return { label: '待确认映射', color: 'text-indigo-400/80', icon: <FileSpreadsheet className="w-3.5 h-3.5" /> };
  }
}

export function ReviewAssessmentListPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<RequirementAssessmentRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    const res = await listAssessments(page, PAGE_SIZE);
    if (res.success && res.data) {
      setItems(res.data.items);
      setTotal(res.data.total);
    }
    setLoading(false);
  }, [page]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleFile = async (file: File | undefined) => {
    if (!file || uploading) return;
    const ext = file.name.toLowerCase();
    if (!ext.endsWith('.xls') && !ext.endsWith('.xlsx')) {
      setUploadError('仅支持 .xls / .xlsx 格式的需求表');
      return;
    }
    setUploading(true);
    setUploadError(null);
    const res = await parseAssessmentExcel(file);
    setUploading(false);
    if (res.success && res.data) {
      navigate(`/review-agent/assessments/${res.data.run.id}`);
    } else {
      setUploadError(res.error?.message ?? '上传解析失败，请重试');
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      {/* 页头 */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/review-agent')}
            className="p-2 rounded-lg bg-token-nested border border-token-subtle hover-bg-soft transition-colors"
            title="返回产品评审"
          >
            <ArrowLeft className="w-4 h-4 text-token-secondary" />
          </button>
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center">
            <ListOrdered className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-token-primary">需求评估</h1>
            <p className="text-sm text-token-muted mt-0.5">上传 Excel 需求表，AI 按八因子规则评估并给出优先级排序</p>
          </div>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 rounded-lg px-4 py-2 transition-colors"
        >
          {uploading ? <MapSpinner size={14} /> : <Upload className="w-4 h-4" />}
          {uploading ? '正在解析...' : '上传需求表'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xls,.xlsx"
          className="hidden"
          onChange={e => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
        />
      </div>

      {uploadError && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400">
          {uploadError}
        </div>
      )}

      {/* 拖拽上传区（空列表时作为主引导） */}
      {!loading && items.length === 0 && (
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]); }}
          onClick={() => fileInputRef.current?.click()}
          className={`cursor-pointer text-center py-14 rounded-2xl border-2 border-dashed transition-colors ${
            dragOver ? 'border-indigo-500/60 bg-indigo-500/5' : 'border-token-subtle bg-token-nested'
          }`}
        >
          <div className="w-14 h-14 rounded-2xl bg-indigo-500/10 flex items-center justify-center mx-auto mb-4">
            <FileSpreadsheet className="w-7 h-7 text-indigo-400" />
          </div>
          <p className="text-sm text-token-primary font-medium">点击或拖拽上传需求表（.xls / .xlsx）</p>
          <p className="text-xs text-token-muted mt-2 max-w-md mx-auto">
            表格建议包含：需求名称、需求描述、反馈客户/次数、客户等级、是否签约、期望时间等列，
            信息越全评估依据越充分；上传后可确认各列与评估因子的对应关系
          </p>
        </div>
      )}

      {/* 任务列表 */}
      {loading ? (
        <MapSectionLoader />
      ) : items.length > 0 && (
        <div className="space-y-2">
          {items.map(run => {
            const statusInfo = getStatusDisplay(run);
            return (
              <button
                key={run.id}
                onClick={() => navigate(`/review-agent/assessments/${run.id}`)}
                className="w-full flex items-center gap-4 bg-token-nested hover-bg-soft border border-token-subtle rounded-xl px-5 py-4 text-left transition-colors group"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-token-primary truncate group-hover:text-indigo-200 transition-colors">
                    {run.title}
                  </p>
                  <div className="flex items-center gap-3 text-xs text-token-muted mt-1">
                    <span>{run.fileName}</span>
                    <span>·</span>
                    <span>{run.itemCount > 0 ? `${run.itemCount} 条需求` : `${run.totalRowCount} 行数据`}</span>
                    <span>·</span>
                    <span>{new Date(run.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
                {run.status === 'Running' && run.itemCount > 0 && (
                  <span className="text-xs text-token-muted flex-shrink-0">{run.scoredCount}/{run.itemCount}</span>
                )}
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

      {/* 分页 */}
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
  );
}
