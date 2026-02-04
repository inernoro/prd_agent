import type { ToolboxArtifact } from '@/services';
import { FileText, Image, File, Download, Eye, type LucideIcon } from 'lucide-react';
import { useState } from 'react';

interface ArtifactCardProps {
  artifact: ToolboxArtifact;
}

const TYPE_ICONS: Record<string, LucideIcon> = {
  Markdown: FileText,
  Image: Image,
  Json: FileText,
  Html: FileText,
};

const TYPE_COLORS: Record<string, { bg: string; text: string }> = {
  Markdown: { bg: 'rgba(59, 130, 246, 0.1)', text: 'rgb(59, 130, 246)' },
  Image: { bg: 'rgba(236, 72, 153, 0.1)', text: 'rgb(236, 72, 153)' },
  Json: { bg: 'rgba(34, 197, 94, 0.1)', text: 'rgb(34, 197, 94)' },
  Html: { bg: 'rgba(249, 115, 22, 0.1)', text: 'rgb(249, 115, 22)' },
};

export function ArtifactCard({ artifact }: ArtifactCardProps) {
  const [showPreview, setShowPreview] = useState(false);

  const Icon = TYPE_ICONS[artifact.type] || File;
  const colors = TYPE_COLORS[artifact.type] || { bg: 'var(--bg-elevated)', text: 'var(--text-secondary)' };

  const handleDownload = () => {
    if (artifact.url) {
      window.open(artifact.url, '_blank');
      return;
    }
    if (artifact.content) {
      const blob = new Blob([artifact.content], { type: artifact.mimeType || 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = artifact.name;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  return (
    <>
      <div
        className="p-3 rounded-lg border transition-colors hover:border-[var(--accent-primary)]/50"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-default)',
        }}
      >
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: colors.bg }}
          >
            <Icon size={18} style={{ color: colors.text }} />
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div
              className="text-sm font-medium truncate"
              style={{ color: 'var(--text-primary)' }}
            >
              {artifact.name}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: colors.bg, color: colors.text }}
              >
                {artifact.type}
              </span>
              {artifact.mimeType && (
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {artifact.mimeType}
                </span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1">
            {(artifact.content || artifact.url) && (
              <button
                onClick={() => setShowPreview(true)}
                className="p-1.5 rounded transition-colors hover:bg-[var(--bg-hover)]"
                title="预览"
              >
                <Eye size={14} style={{ color: 'var(--text-muted)' }} />
              </button>
            )}
            <button
              onClick={handleDownload}
              className="p-1.5 rounded transition-colors hover:bg-[var(--bg-hover)]"
              title="下载"
            >
              <Download size={14} style={{ color: 'var(--text-muted)' }} />
            </button>
          </div>
        </div>

        {/* Image preview (small) */}
        {artifact.type === 'Image' && artifact.url && (
          <div className="mt-2">
            <img
              src={artifact.url}
              alt={artifact.name}
              className="w-full h-24 object-cover rounded cursor-pointer"
              onClick={() => setShowPreview(true)}
            />
          </div>
        )}
      </div>

      {/* Preview Modal */}
      {showPreview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0, 0, 0, 0.8)' }}
          onClick={() => setShowPreview(false)}
        >
          <div
            className="max-w-4xl max-h-[90vh] overflow-auto rounded-lg p-4"
            style={{ background: 'var(--bg-base)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                {artifact.name}
              </div>
              <button
                onClick={() => setShowPreview(false)}
                className="text-sm px-3 py-1 rounded"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
              >
                关闭
              </button>
            </div>

            {artifact.type === 'Image' && artifact.url && (
              <img src={artifact.url} alt={artifact.name} className="max-w-full rounded" />
            )}

            {artifact.type !== 'Image' && artifact.content && (
              <pre
                className="p-4 rounded text-sm whitespace-pre-wrap"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}
              >
                {artifact.content}
              </pre>
            )}
          </div>
        </div>
      )}
    </>
  );
}
