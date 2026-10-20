// 产品管理专用视图：独立评审智能体保持原样；接口、弹框及流式组件继续复用。
import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Upload, ChevronRight, ChevronLeft, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { SectionShell } from '@/components/agent-shell/AgentFullscreenLayout';
import { OverviewDataTable, TruncateCell } from '@/pages/product-agent/overviewDataTable';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { listAssessments, createAssessment } from '@/services';
import type { RequirementAssessmentRun } from '@/services';
import { useReviewNavigation } from './reviewNavigation';

const PAGE_SIZE = 20;

const ASSESSMENT_STATUS: Record<string, { label: string; color: string }> = {
  Done: { label: '已完成', color: 'text-[color:var(--accent-fg-success)]' },
  Error: { label: '失败', color: 'text-[color:var(--accent-fg-danger)]' },
  Running: { label: '评估中', color: 'text-[color:var(--accent-fg-blue)]' },
  Queued: { label: '等待评估', color: 'text-[color:var(--accent-fg-amber)]' },
  Draft: { label: '待评估', color: 'text-token-secondary' },
};

export function ReviewAssessmentListPage() {
  const navigate = useNavigate();
  const reviewNav = useReviewNavigation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [items, setItems] = useState<RequirementAssessmentRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [dragOver, setDragOver] = useState(false);

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await listAssessments(page, PAGE_SIZE);
      if (res.success && res.data) {
        setItems(res.data.items);
        setTotal(res.data.total);
        setLoadError('');
      } else setLoadError(res.error?.message ?? '需求评估加载失败，请重试。');
    } catch { setLoadError('需求评估加载失败，请检查网络后重试。'); }
    finally { if (!silent) setLoading(false); }
  }, [page]);

  useEffect(() => { loadData(); }, [loadData]);

  // 有进行中的任务时静默自动刷新列表，状态变化无需手动刷新
  const hasActive = items.some(i => i.status === 'Queued' || i.status === 'Running' || i.status === 'Draft');
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => { void loadData(true); }, 8000);
    return () => clearInterval(timer);
  }, [hasActive, loadData]);

  const handleFile = async (file: File | undefined) => {
    if (!file || uploading) return;
    const ext = file.name.toLowerCase();
    if (!ext.endsWith('.xls') && !ext.endsWith('.xlsx')) {
      setUploadError('仅支持 .xls / .xlsx 格式的需求表');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const res = await createAssessment(file);
      if (res.success && res.data) navigate(reviewNav.assessment(res.data.run.id));
      else setUploadError(res.error?.message ?? '上传解析失败，请重试');
    } catch { setUploadError('上传失败，请检查网络后重新上传。'); }
    finally { setUploading(false); }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <SectionShell title="需求评估" count={loading ? undefined : total} desc="上传 Excel 需求表，AI 按八因子规则评估并给出优先级排序" actions={
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => navigate(reviewNav.requirementHome)} aria-label={reviewNav.inProductManagement ? '返回需求' : '返回产品评审'}><ArrowLeft size={14} /><span className="hidden sm:inline">{reviewNav.inProductManagement ? '返回需求' : '返回产品评审'}</span></Button>
        <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploading}>{uploading ? <MapSpinner size={14} /> : <Upload size={14} />}{uploading ? '正在解析…' : '上传需求表'}</Button>
      </div>
    }>
      <div className="flex min-h-full min-w-0 flex-col gap-4">
        <input
          ref={fileInputRef}
          type="file"
          accept=".xls,.xlsx"
          className="hidden"
          onChange={e => { handleFile(e.target.files?.[0]); e.target.value = ''; }}
        />

      {uploadError && (
        <div role="alert" className="rounded-lg border border-token-subtle bg-token-nested px-4 py-3 text-sm text-[color:var(--accent-fg-danger)]">
          {uploadError}
        </div>
      )}
      {loadError && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-token-subtle bg-token-nested px-4 py-3 text-sm text-[color:var(--accent-fg-danger)]"><span>{loadError}</span><Button size="sm" onClick={() => void loadData()}>重试</Button></div>}

      {/* 拖拽上传区（空列表时作为主引导） */}
      {!loading && !loadError && items.length === 0 && (
        <button type="button" disabled={uploading}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]); }}
          onClick={() => fileInputRef.current?.click()}
          className={`flex min-h-64 w-full flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-wait ${
            dragOver ? 'border-[var(--accent-fg-blue)] bg-token-input' : 'border-token-subtle bg-token-nested hover-bg-soft'
          }`}
        >
          {uploading ? <MapSpinner size={24} /> : <FileSpreadsheet size={24} className="text-token-muted" />}
          <span className="text-sm text-token-primary font-medium">{uploading ? '正在上传并解析需求表…' : '点击或拖拽上传需求表（.xls / .xlsx）'}</span>
          <span className="max-w-xl text-xs leading-6 text-token-secondary">
            上传即自动评估，无需任何配置。表格建议包含需求名称与详细描述，
            反馈客户/次数、客户等级、是否签约、期望时间等信息越全，评估依据越充分
          </span>
        </button>
      )}

      {/* 任务列表 */}
      {loading ? (
        <MapSectionLoader text="正在加载需求评估…" />
      ) : items.length > 0 && (
        <OverviewDataTable tableKey="requirement-assessments" rows={items} onRowClick={(run) => navigate(reviewNav.assessment(run.id))} columns={[
          { key: 'title', header: '评估任务', defaultWidth: 320, render: (run) => <button type="button" className="w-full truncate text-left text-sm text-token-primary hover:underline" onClick={(event) => { event.stopPropagation(); navigate(reviewNav.assessment(run.id)); }}>{run.title}</button> },
          { key: 'file', header: '需求表', defaultWidth: 240, render: (run) => <TruncateCell text={run.fileName} className="text-xs text-token-secondary" /> },
          { key: 'count', header: '需求数量', defaultWidth: 100, render: (run) => <span className="text-xs text-token-secondary">{run.itemCount > 0 ? `${run.itemCount} 条` : `${run.totalRowCount} 行`}</span> },
          { key: 'status', header: '状态', defaultWidth: 120, render: (run) => { const status = ASSESSMENT_STATUS[run.status] ?? ASSESSMENT_STATUS.Draft; return <span className={`inline-flex items-center gap-1.5 text-xs ${status.color}`}>{run.status === 'Running' && <MapSpinner size={14} />}{status.label}</span>; } },
          { key: 'progress', header: '进度', defaultWidth: 100, render: (run) => <span className="text-xs text-token-secondary">{run.itemCount > 0 ? `${run.scoredCount} / ${run.itemCount}` : '-'}</span> },
          { key: 'created', header: '创建时间', defaultWidth: 160, render: (run) => <span className="text-xs text-token-muted">{new Date(run.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span> },
        ]} />
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
      </div>
    </SectionShell>
  );
}

