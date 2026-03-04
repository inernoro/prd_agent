import type { AssetItem } from '../../types';

// ── Helpers ────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

const TYPE_LABELS: Record<string, string> = {
  image: '图片',
  document: '文档',
  attachment: '附件',
};

interface Props {
  asset: AssetItem;
  onClose: () => void;
}

export default function AssetDetailPanel({ asset, onClose }: Props) {
  const isImage = asset.type === 'image';

  const hasUrl = !!asset.url;

  const copyUrl = async () => {
    if (!asset.url) return;
    try {
      await navigator.clipboard.writeText(asset.url);
    } catch { /* ignore */ }
  };

  const openInBrowser = async () => {
    if (!asset.url) return;
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(asset.url);
    } catch {
      window.open(asset.url, '_blank');
    }
  };

  return (
    <div className="w-72 shrink-0 border-l border-black/8 dark:border-white/8 bg-white/50 dark:bg-white/[0.02] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-black/8 dark:border-white/8">
        <span className="text-xs font-semibold text-text-primary">详情</span>
        <button
          onClick={onClose}
          className="h-6 w-6 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-black/5 dark:hover:bg-white/5"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Preview */}
      <div className="p-3 border-b border-black/8 dark:border-white/8">
        <div className="aspect-[4/3] rounded-lg bg-black/[0.03] dark:bg-white/[0.03] overflow-hidden flex items-center justify-center">
          {isImage && asset.url ? (
            <img src={asset.url} alt={asset.title} className="w-full h-full object-contain" loading="lazy" />
          ) : asset.summary ? (
            <div className="flex flex-col items-center justify-center p-4 text-text-secondary/70 h-full">
              <p className="text-xs leading-relaxed text-center line-clamp-6">{asset.summary}</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-text-secondary/50">
              <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              {asset.mime && <span className="text-xs">{asset.mime}</span>}
            </div>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Title */}
        <div>
          <div className="text-[10px] text-text-secondary/70 mb-0.5">名称</div>
          <div className="text-sm text-text-primary break-all">{asset.title}</div>
        </div>

        {/* Summary */}
        {asset.summary && (
          <div>
            <div className="text-[10px] text-text-secondary/70 mb-0.5">摘要</div>
            <div className="text-xs text-text-secondary leading-relaxed">{asset.summary}</div>
          </div>
        )}

        {/* Type + Source */}
        <div>
          <div className="text-[10px] text-text-secondary/70 mb-0.5">类型</div>
          <div className="text-sm text-text-primary">
            {TYPE_LABELS[asset.type] || asset.type}
            {asset.source && <span className="text-text-secondary/60 ml-1.5">· {asset.source}</span>}
          </div>
        </div>

        {/* MIME */}
        {asset.mime && (
          <div>
            <div className="text-[10px] text-text-secondary/70 mb-0.5">MIME</div>
            <div className="text-sm text-text-primary font-mono text-xs">{asset.mime}</div>
          </div>
        )}

        {/* Size */}
        <div>
          <div className="text-[10px] text-text-secondary/70 mb-0.5">大小</div>
          <div className="text-sm text-text-primary">{formatBytes(asset.sizeBytes)}</div>
        </div>

        {/* Dimensions (images only) */}
        {isImage && asset.width > 0 && asset.height > 0 && (
          <div>
            <div className="text-[10px] text-text-secondary/70 mb-0.5">尺寸</div>
            <div className="text-sm text-text-primary">{asset.width} x {asset.height} px</div>
          </div>
        )}

        {/* Date */}
        <div>
          <div className="text-[10px] text-text-secondary/70 mb-0.5">创建时间</div>
          <div className="text-sm text-text-primary">{formatDateTime(asset.createdAt)}</div>
        </div>
      </div>

      {/* Actions */}
      {hasUrl && (
      <div className="p-3 border-t border-black/8 dark:border-white/8 space-y-1.5">
        <button
          onClick={copyUrl}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-text-primary hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
        >
          <svg className="w-3.5 h-3.5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
          </svg>
          复制链接
        </button>
        <button
          onClick={openInBrowser}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-text-primary hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
        >
          <svg className="w-3.5 h-3.5 text-text-secondary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
          </svg>
          在浏览器中打开
        </button>
      </div>
      )}
    </div>
  );
}
