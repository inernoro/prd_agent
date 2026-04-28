import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Upload, FileText, Download, AlertCircle, RefreshCw } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { Button } from '@/components/design/Button';
import { toast } from '@/lib/toast';
import { systemDialog } from '@/lib/systemDialog';
import { importReportFromMarkdown } from '@/services';
import type { ReportTemplate, WeeklyReport } from '@/services/contracts/reportAgent';
import { buildSampleMarkdown, downloadSampleMarkdown } from '../lib/buildSampleMarkdown';
import { useDataTheme } from '../hooks/useDataTheme';

const MAX_BYTES = 512 * 1024; // 512KB

type Phase =
  | 'idle'             // 还没选文件
  | 'ready'            // 选完了，等点"开始导入"
  | 'uploading'        // 客户端读文件 / 传输
  | 'llm-mapping'      // 后端 LLM 映射中
  | 'saving';          // 已收到响应，前端状态回填

interface Props {
  teamId: string;
  teamName: string;
  templateId: string;
  templateName: string;
  template: ReportTemplate;
  weekYear: number;
  weekNumber: number;
  onImported: (report: WeeklyReport) => void;
  onClose: () => void;
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file, 'utf-8');
  });
}

export function MarkdownImportModal({
  teamId, teamName, templateId, templateName, template,
  weekYear, weekNumber, onImported, onClose,
}: Props) {
  const dataTheme = useDataTheme();
  const isLight = dataTheme === 'light';
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [fileText, setFileText] = useState<string>('');
  const [dragging, setDragging] = useState(false);
  const [modelLabel, setModelLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);
  const importing = phase === 'uploading' || phase === 'llm-mapping' || phase === 'saving';

  // ESC 关闭（导入进行中不允许关闭）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !importing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [importing, onClose]);

  const handleFileSelect = useCallback(async (f: File) => {
    setError(null);
    const name = f.name.toLowerCase();
    if (!name.endsWith('.md') && !name.endsWith('.markdown')) {
      setError('仅支持 .md / .markdown 文件');
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`文件过大（${(f.size / 1024).toFixed(1)}KB），上限 ${MAX_BYTES / 1024}KB`);
      return;
    }
    try {
      const text = await readFileAsText(f);
      if (!text.trim()) {
        setError('文件内容为空');
        return;
      }
      if (text.length > MAX_BYTES) {
        setError(`文件文本长度超过上限（${MAX_BYTES / 1024}KB）`);
        return;
      }
      setFile(f);
      setFileText(text);
      setPhase('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : '文件读取失败');
    }
  }, []);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleFileSelect(f);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void handleFileSelect(f);
  };

  const handleDownloadSample = () => {
    const content = buildSampleMarkdown(template, weekYear, weekNumber);
    const filename = `${templateName}-${weekYear}-W${String(weekNumber).padStart(2, '0')}-sample.md`;
    downloadSampleMarkdown(filename, content);
  };

  const doImport = useCallback(async (confirmOverwrite: boolean) => {
    if (!fileText) return;
    setError(null);
    setPhase('uploading');
    setModelLabel(null);
    // 给"LLM 映射中"留几百毫秒让 UI 过度，避免瞬切
    setTimeout(() => setPhase((p) => (p === 'uploading' ? 'llm-mapping' : p)), 250);

    const res = await importReportFromMarkdown({
      teamId,
      templateId,
      weekYear,
      weekNumber,
      markdownContent: fileText,
      confirmOverwrite,
    });

    setPhase('saving');

    if (!res.success || !res.data) {
      setError(res.error?.message || '导入失败');
      setPhase('ready');
      return;
    }

    // 覆盖确认流程
    if (res.data.needsOverwriteConfirmation) {
      setPhase('ready');
      const ok = await systemDialog.confirm({
        title: '本周已存在周报草稿',
        message: '导入将覆盖当前 draft 内容（已提交/已审阅的周报不会被覆盖）。\n是否继续？',
        tone: 'danger',
        confirmText: '覆盖导入',
        cancelText: '取消',
      });
      if (!ok) return;
      void doImport(true);
      return;
    }

    const report = res.data.report;
    if (!report) {
      setError('后端未返回周报数据');
      setPhase('ready');
      return;
    }

    // 展示模型信息（即使 LLM 失败走了规则兜底，也会返回 null model）
    if (report.autoGeneratedModelId) {
      setModelLabel(`${report.autoGeneratedModelId}${report.autoGeneratedPlatformId ? ` · ${report.autoGeneratedPlatformId}` : ''}`);
    } else {
      setModelLabel('规则兜底');
    }

    if (res.data.usedRuleFallback) {
      toast.error(`AI 映射失败，已降级为规则导入${res.data.importError ? `：${res.data.importError}` : ''}。请在编辑器中检查章节内容。`);
    } else {
      toast.success(`Markdown 已导入（${report.autoGeneratedModelId ?? 'AI'}）`);
    }

    onImported(report);
    onClose();
  }, [fileText, teamId, templateId, weekYear, weekNumber, onImported, onClose]);

  const phaseText = (() => {
    switch (phase) {
      case 'uploading': return '正在读取并上传 Markdown …';
      case 'llm-mapping': return modelLabel ? `${modelLabel} 智能映射中 …` : 'AI 智能映射中 …';
      case 'saving': return '写入草稿 …';
      default: return '';
    }
  })();

  const previewText = fileText.slice(0, 500);
  const previewTail = fileText.length > 500 ? ` …(共 ${fileText.length} 字符)` : '';

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-sm"
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, padding: '16px',
        background: isLight ? 'var(--modal-overlay)' : 'rgba(0, 0, 0, 0.7)',
      }}
      onClick={() => { if (!importing) onClose(); }}
    >
      <div
        className={`relative w-full max-w-2xl mx-4 rounded-xl border flex flex-col overflow-hidden ${isLight ? '' : 'shadow-2xl'}`}
        style={{
          height: '80vh',
          maxHeight: '80vh',
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-primary)',
          boxShadow: isLight
            ? '0 24px 48px rgba(89, 65, 50, 0.12), 0 8px 16px rgba(89, 65, 50, 0.06)'
            : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b shrink-0"
          style={{ borderColor: 'var(--border-primary)' }}>
          <FileText size={18} style={{ color: 'var(--accent-claude)' }} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              从 Markdown 导入周报
            </div>
            <div className="mt-0.5 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
              {teamName} · {templateName} · {weekYear} 年第 {weekNumber} 周
            </div>
          </div>
          <button
            type="button"
            onClick={handleDownloadSample}
            disabled={importing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition disabled:opacity-50"
            style={{
              background: 'var(--bg-secondary)',
              color: 'var(--text-secondary)',
            }}
            title="下载基于当前模板的推荐格式样本"
          >
            <Download size={12} />
            下载推荐样本
          </button>
          <button
            type="button"
            onClick={() => { if (!importing) onClose(); }}
            disabled={importing}
            className="p-2 rounded-lg transition disabled:opacity-50"
            style={{ color: 'var(--text-muted)' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div
          className="flex-1 px-5 py-4 flex flex-col gap-4"
          style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}
        >
          {/* 导入中状态 */}
          {importing && (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 py-8">
              <MapSectionLoader text={phaseText} />
              {modelLabel && (
                <div className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
                  ● {modelLabel}
                </div>
              )}
            </div>
          )}

          {/* 非导入中：展示 Dropzone + 预览 */}
          {!importing && (
            <>
              {/* Dropzone */}
              <div
                onDragEnter={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  dragCounter.current += 1;
                  if (e.dataTransfer.items?.length) setDragging(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  dragCounter.current -= 1;
                  if (dragCounter.current <= 0) setDragging(false);
                }}
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl border-2 border-dashed px-6 py-8 flex flex-col items-center justify-center gap-2 cursor-pointer transition"
                style={{
                  borderColor: dragging
                    ? 'var(--accent-claude)'
                    : 'var(--border-primary)',
                  background: dragging
                    ? 'var(--accent-claude-soft)'
                    : 'var(--bg-secondary)',
                }}
              >
                <Upload size={24} style={{ color: dragging ? 'var(--accent-claude)' : 'var(--text-muted)' }} />
                <div className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  拖拽 Markdown 文件到此处，或点击选择
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  支持 .md / .markdown，单文件上限 {MAX_BYTES / 1024}KB
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.markdown,text/markdown"
                  className="hidden"
                  onChange={onInputChange}
                />
              </div>

              {/* 预览 */}
              {file && (
                <div
                  className="rounded-lg border px-4 py-3 text-[12px]"
                  style={{
                    borderColor: 'var(--border-primary)',
                    background: 'var(--bg-secondary)',
                  }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <FileText size={14} style={{ color: 'var(--accent-claude)' }} />
                    <span className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{file.name}</span>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      · {(file.size / 1024).toFixed(1)}KB · {fileText.length} 字符
                    </span>
                  </div>
                  <pre
                    className="text-[11px] whitespace-pre-wrap font-mono leading-relaxed"
                    style={{
                      color: 'var(--text-secondary)',
                      maxHeight: '180px',
                      overflowY: 'auto',
                    }}
                  >
                    {previewText}{previewTail}
                  </pre>
                </div>
              )}

              {/* 错误提示 */}
              {error && (
                <div
                  className="flex items-start gap-2 p-3 rounded-lg border text-[12px]"
                  style={{
                    borderColor: 'rgba(239,68,68,0.3)',
                    background: 'rgba(239,68,68,0.1)',
                    color: 'rgb(252,165,165)',
                  }}
                >
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {/* 使用说明 */}
              {!file && !error && (
                <div className="text-[12px] leading-relaxed rounded-lg px-4 py-3"
                  style={{
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <div className="font-medium mb-1" style={{ color: 'var(--text-primary)' }}>使用提示</div>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>建议先点击右上角「下载推荐样本」，按样本二级标题结构填写后上传。</li>
                    <li>若本周已有 draft，导入会弹确认后覆盖；已提交/已审阅的周报不会被覆盖。</li>
                    <li>AI 映射失败时会自动降级为规则导入，请在编辑器中检查章节内容。</li>
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t shrink-0"
          style={{ borderColor: 'var(--border-primary)' }}>
          <Button variant="ghost" size="sm" onClick={() => { if (!importing) onClose(); }} disabled={importing}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => { void doImport(false); }}
            disabled={!fileText || importing}
          >
            {importing ? (
              <><MapSpinner size={13} /> 导入中…</>
            ) : (
              <><RefreshCw size={13} /> 开始导入</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
