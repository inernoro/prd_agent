import { useState } from 'react';
import { X, Download, Copy, Check, FileText, Code, Eye } from 'lucide-react';
import type { ExecutionArtifact } from '@/services/contracts/workflowAgent';

interface ArtifactPreviewModalProps {
  artifact: ExecutionArtifact;
  onClose: () => void;
}

export function ArtifactPreviewModal({ artifact, onClose }: ArtifactPreviewModalProps) {
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');

  const content = artifact.inlineContent || '';
  const isMarkdown = artifact.mimeType === 'text/markdown' || artifact.name.endsWith('.md');
  const isHtml = artifact.mimeType === 'text/html';
  const isJson = artifact.mimeType === 'application/json';

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (artifact.cosUrl) {
      window.open(artifact.cosUrl, '_blank');
      return;
    }
    // Inline download
    const ext = artifact.mimeType === 'text/markdown' ? '.md'
      : artifact.mimeType === 'text/html' ? '.html'
      : artifact.mimeType === 'application/json' ? '.json'
      : artifact.mimeType === 'text/csv' ? '.csv'
      : '.txt';
    const fileName = artifact.name.includes('.') ? artifact.name : `${artifact.name}${ext}`;
    const blob = new Blob([content], { type: artifact.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Simple markdown → HTML rendering (headings, bold, lists, code blocks, tables)
  function renderMarkdown(md: string): string {
    let html = md
      // Code blocks
      .replace(/```[\s\S]*?```/g, (m) => {
        const code = m.replace(/```\w*\n?/, '').replace(/\n?```$/, '');
        return `<pre style="background:rgba(0,0,0,0.3);padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.5;border:1px solid rgba(255,255,255,0.08)"><code>${escapeHtml(code)}</code></pre>`;
      })
      // Inline code
      .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:2px 6px;border-radius:4px;font-size:12px">$1</code>')
      // Headers
      .replace(/^#### (.+)$/gm, '<h4 style="font-size:14px;font-weight:600;margin:16px 0 8px;color:var(--text-primary)">$1</h4>')
      .replace(/^### (.+)$/gm, '<h3 style="font-size:15px;font-weight:600;margin:20px 0 8px;color:var(--text-primary)">$1</h3>')
      .replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:700;margin:24px 0 10px;color:var(--text-primary)">$1</h2>')
      .replace(/^# (.+)$/gm, '<h1 style="font-size:18px;font-weight:700;margin:24px 0 12px;color:var(--text-primary)">$1</h1>')
      // Bold
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      // Unordered lists
      .replace(/^- (.+)$/gm, '<li style="margin-left:16px;list-style:disc;margin-bottom:4px">$1</li>')
      // Ordered lists
      .replace(/^\d+\. (.+)$/gm, '<li style="margin-left:16px;list-style:decimal;margin-bottom:4px">$1</li>')
      // Horizontal rules
      .replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid rgba(255,255,255,0.1);margin:16px 0">')
      // Paragraphs (double newline)
      .replace(/\n\n/g, '</p><p style="margin:8px 0;line-height:1.7">')
      // Single newlines inside content
      .replace(/\n/g, '<br>');

    return `<p style="margin:8px 0;line-height:1.7">${html}</p>`;
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatJson(s: string): string {
    try {
      return JSON.stringify(JSON.parse(s), null, 2);
    } catch {
      return s;
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <div
        className="relative w-[90vw] max-w-4xl max-h-[85vh] rounded-2xl flex flex-col overflow-hidden"
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
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            {(isMarkdown || isHtml) && (
              <button
                onClick={() => setViewMode(viewMode === 'preview' ? 'raw' : 'preview')}
                className="p-1.5 rounded-lg transition-colors"
                style={{
                  background: viewMode === 'preview' ? 'rgba(255,255,255,0.1)' : 'transparent',
                  color: 'var(--text-muted)',
                }}
                title={viewMode === 'preview' ? '查看源码' : '查看预览'}
              >
                {viewMode === 'preview' ? <Code className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            )}
            <button
              onClick={handleCopy}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: copied ? 'rgba(34,197,94,0.9)' : 'var(--text-muted)' }}
              title="复制内容"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
            <button
              onClick={handleDownload}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: 'var(--text-muted)' }}
              title="下载文件"
            >
              <Download className="w-4 h-4" />
            </button>
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

          {content && viewMode === 'preview' && isJson && (
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

          {content && (viewMode === 'raw' || (!isMarkdown && !isHtml && !isJson)) && (
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
