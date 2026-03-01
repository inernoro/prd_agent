import { useMemo, useState } from 'react';
import { X, Download, Copy, Check, FileText, Code, Eye, Table2, ChevronDown } from 'lucide-react';
import type { ExecutionArtifact } from '@/services/contracts/workflowAgent';

interface ArtifactPreviewModalProps {
  artifact: ExecutionArtifact;
  onClose: () => void;
}

export function ArtifactPreviewModal({ artifact, onClose }: ArtifactPreviewModalProps) {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);

  const content = artifact.inlineContent || '';
  const isMarkdown = artifact.mimeType === 'text/markdown' || artifact.name.endsWith('.md');
  const isHtml = artifact.mimeType === 'text/html';
  const isJson = artifact.mimeType === 'application/json';

  // 检测是否为 JSON 数组（TAPD bugs 等表格数据），不依赖 mimeType
  const jsonArray = useMemo<Record<string, unknown>[] | null>(() => {
    if (!content) return null;
    const trimmed = content.trimStart();
    // 快速检测：内容必须以 [ 开头才可能是 JSON 数组
    if (!trimmed.startsWith('[')) return null;
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
        return parsed as Record<string, unknown>[];
      }
    } catch { /* ignore */ }
    return null;
  }, [content]);

  // 表格列：从数据中提取所有 key
  const columns = useMemo(() => {
    if (!jsonArray) return [];
    const keySet = new Set<string>();
    for (const row of jsonArray.slice(0, 100)) {
      for (const k of Object.keys(row)) keySet.add(k);
    }
    return Array.from(keySet);
  }, [jsonArray]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // 通用下载
  function downloadBlob(data: string, fileName: string, mime: string) {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  const baseName = artifact.name.replace(/\.[^.]+$/, '') || 'export';

  function handleDownloadJson() {
    if (artifact.cosUrl) { window.open(artifact.cosUrl, '_blank'); return; }
    downloadBlob(formatJson(content), `${baseName}.json`, 'application/json');
  }

  function handleDownloadCsv() {
    if (!jsonArray) return;
    const csvContent = arrayToCsv(jsonArray, columns);
    downloadBlob(csvContent, `${baseName}.csv`, 'text/csv');
  }

  function handleDownloadMd() {
    if (!jsonArray) return;
    const mdContent = arrayToMdTable(jsonArray, columns);
    downloadBlob(mdContent, `${baseName}.md`, 'text/markdown');
  }

  const handleDownloadDefault = () => {
    if (artifact.cosUrl) { window.open(artifact.cosUrl, '_blank'); return; }
    const ext = artifact.mimeType === 'text/markdown' ? '.md'
      : artifact.mimeType === 'text/html' ? '.html'
      : artifact.mimeType === 'application/json' ? '.json'
      : artifact.mimeType === 'text/csv' ? '.csv'
      : '.txt';
    const fileName = artifact.name.includes('.') ? artifact.name : `${artifact.name}${ext}`;
    downloadBlob(content, fileName, artifact.mimeType);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        className="relative w-[90vw] max-w-5xl max-h-[85vh] rounded-2xl flex flex-col overflow-hidden"
        style={{
          background: 'var(--glass-bg, rgba(30,30,40,0.95))',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <FileText className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent-gold)' }} />
          <div className="flex-1 min-w-0">
            <h2 className="text-[14px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
              {artifact.name}
            </h2>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {artifact.mimeType} &middot; {formatBytes(artifact.sizeBytes)}
              {jsonArray && ` · ${jsonArray.length} 条记录`}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {/* 视图切换 */}
            {(isMarkdown || isHtml || jsonArray) && (
              <button
                onClick={() => setViewMode(viewMode === 'preview' ? 'raw' : 'preview')}
                className="p-1.5 rounded-lg transition-colors"
                style={{
                  background: viewMode === 'preview' ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: 'var(--text-muted)',
                }}
                title={viewMode === 'preview'
                  ? (jsonArray ? '切换为 JSON' : '查看源码')
                  : (jsonArray ? '切换为表格' : '查看预览')
                }
              >
                {viewMode === 'preview'
                  ? (jsonArray ? <Code className="w-4 h-4" /> : <Code className="w-4 h-4" />)
                  : (jsonArray ? <Table2 className="w-4 h-4" /> : <Eye className="w-4 h-4" />)
                }
              </button>
            )}
            {/* 复制 */}
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: copied ? 'rgba(34,197,94,0.9)' : 'var(--text-muted)' }}
              title="复制内容"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
            {/* 下载 */}
            {jsonArray ? (
              <div className="relative">
                <button
                  onClick={() => setDownloadMenuOpen(!downloadMenuOpen)}
                  className="p-1.5 rounded-lg transition-colors flex items-center gap-0.5"
                  style={{ color: 'var(--text-muted)' }}
                  title="下载文件"
                >
                  <Download className="w-4 h-4" />
                  <ChevronDown className="w-3 h-3" />
                </button>
                {downloadMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setDownloadMenuOpen(false)} />
                    <div
                      className="absolute right-0 top-full mt-1 z-20 rounded-lg py-1 min-w-[140px]"
                      style={{
                        background: 'var(--glass-bg, rgba(30,30,40,0.98))',
                        border: '1px solid rgba(255,255,255,0.12)',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                      }}
                    >
                      {[
                        { label: 'CSV 表格', onClick: handleDownloadCsv, desc: '.csv' },
                        { label: 'Markdown 表格', onClick: handleDownloadMd, desc: '.md' },
                        { label: 'JSON 原始数据', onClick: handleDownloadJson, desc: '.json' },
                      ].map((item) => (
                        <button
                          key={item.label}
                          onClick={() => { item.onClick(); setDownloadMenuOpen(false); }}
                          className="w-full px-3 py-1.5 text-left flex items-center justify-between transition-colors hover:bg-white/5"
                        >
                          <span className="text-[12px]" style={{ color: 'var(--text-primary)' }}>{item.label}</span>
                          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.desc}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button
                onClick={handleDownloadDefault}
                className="p-1.5 rounded-lg transition-colors"
                style={{ color: 'var(--text-muted)' }}
                title="下载文件"
              >
                <Download className="w-4 h-4" />
              </button>
            )}
            {/* 关闭 */}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
              style={{ color: 'var(--text-muted)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-5">
          {!content && (
            <div className="text-center py-12 text-[13px]" style={{ color: 'var(--text-muted)' }}>
              产物内容为空
            </div>
          )}

          {/* JSON 数组 → 表格视图（默认） */}
          {content && viewMode === 'preview' && jsonArray && (
            <div className="overflow-auto rounded-xl" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
              <table className="w-full text-[11px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.06)' }}>
                    <th
                      className="text-left px-3 py-2 font-semibold sticky top-0"
                      style={{ color: 'var(--text-muted)', background: 'rgba(30,30,40,0.98)', borderBottom: '1px solid rgba(255,255,255,0.1)', minWidth: 32 }}
                    >
                      #
                    </th>
                    {columns.map((col) => (
                      <th
                        key={col}
                        className="text-left px-3 py-2 font-semibold sticky top-0 whitespace-nowrap"
                        style={{ color: 'var(--text-muted)', background: 'rgba(30,30,40,0.98)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {jsonArray.map((row, rowIdx) => (
                    <tr
                      key={rowIdx}
                      className="transition-colors hover:bg-white/[0.02]"
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                    >
                      <td className="px-3 py-1.5" style={{ color: 'var(--text-muted)' }}>{rowIdx + 1}</td>
                      {columns.map((col) => (
                        <td
                          key={col}
                          className="px-3 py-1.5 max-w-[300px] truncate"
                          style={{ color: 'var(--text-secondary)' }}
                          title={String(row[col] ?? '')}
                        >
                          {formatCellValue(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* JSON 数组 → raw JSON 视图 */}
          {content && viewMode === 'raw' && jsonArray && (
            <pre
              className="text-[12px] font-mono leading-relaxed p-4 rounded-xl overflow-auto"
              style={{
                background: 'rgba(0,0,0,0.3)',
                color: 'var(--text-secondary)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {formatJson(content)}
            </pre>
          )}

          {/* JSON 非数组 → 格式化 JSON */}
          {content && viewMode === 'preview' && isJson && !jsonArray && (
            <pre
              className="text-[12px] font-mono leading-relaxed p-4 rounded-xl overflow-auto"
              style={{
                background: 'rgba(0,0,0,0.3)',
                color: 'var(--text-secondary)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {formatJson(content)}
            </pre>
          )}

          {content && viewMode === 'preview' && isMarkdown && (
            <div
              className="prose-sm text-[13px] leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
            />
          )}

          {content && viewMode === 'preview' && isHtml && (
            <div
              className="text-[13px] leading-relaxed"
              style={{ color: 'var(--text-secondary)' }}
              dangerouslySetInnerHTML={{ __html: content }}
            />
          )}

          {content && viewMode === 'raw' && !jsonArray && (isMarkdown || isHtml) && (
            <pre
              className="text-[12px] font-mono leading-relaxed p-4 rounded-xl overflow-auto whitespace-pre-wrap"
              style={{
                background: 'rgba(0,0,0,0.3)',
                color: 'var(--text-secondary)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {content}
            </pre>
          )}

          {content && viewMode === 'preview' && !isMarkdown && !isHtml && !isJson && !jsonArray && (
            <pre
              className="text-[12px] font-mono leading-relaxed p-4 rounded-xl overflow-auto whitespace-pre-wrap"
              style={{
                background: 'rgba(0,0,0,0.3)',
                color: 'var(--text-secondary)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {content}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ── helpers ──

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}

function formatCellValue(val: unknown): string {
  if (val == null) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(md: string): string {
  const html = md
    .replace(/```[\s\S]*?```/g, (m) => {
      const code = m.replace(/```\w*\n?/, '').replace(/\n?```$/, '');
      return `<pre style="background:rgba(0,0,0,0.3);padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.5;border:1px solid rgba(255,255,255,0.08)"><code>${escapeHtml(code)}</code></pre>`;
    })
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-size:12px">$1</code>')
    .replace(/^#### (.+)$/gm, '<h4 style="font-size:14px;font-weight:600;margin:16px 0 8px;color:var(--text-primary)">$1</h4>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:15px;font-weight:600;margin:20px 0 8px;color:var(--text-primary)">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:700;margin:24px 0 10px;color:var(--text-primary)">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 style="font-size:18px;font-weight:700;margin:24px 0 12px;color:var(--text-primary)">$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li style="margin-left:16px;list-style:disc;margin-bottom:4px">$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li style="margin-left:16px;list-style:decimal;margin-bottom:4px">$1</li>')
    .replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:16px 0">')
    .replace(/\n\n/g, '</p><p style="margin:8px 0;line-height:1.7">')
    .replace(/\n/g, '<br>');
  return `<p style="margin:8px 0;line-height:1.7">${html}</p>`;
}

/** JSON array → CSV string */
function arrayToCsv(arr: Record<string, unknown>[], columns: string[]): string {
  const escapeCsv = (val: unknown): string => {
    const s = val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = columns.map(escapeCsv).join(',');
  const rows = arr.map(row => columns.map(col => escapeCsv(row[col])).join(','));
  return [header, ...rows].join('\n');
}

/** JSON array → Markdown table */
function arrayToMdTable(arr: Record<string, unknown>[], columns: string[]): string {
  const escapeMd = (val: unknown): string => {
    const s = val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
    return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  };
  const header = `| ${columns.join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const rows = arr.map(row => `| ${columns.map(col => escapeMd(row[col])).join(' | ')} |`);
  return [header, separator, ...rows].join('\n');
}
