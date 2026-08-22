import { FileText } from 'lucide-react';
import type { HostedSite } from '@/services/real/webPages';

// 只看后端 marker 字段，不靠 ZIP 文件形状——避免把"用户上传的 index.html + report.pdf"
// 这种 2 文件普通 ZIP 误判为系统自动包装的 PDF 站（Codex P2 反复抓到，PR #612）。
export function isPdfSite(site: Pick<HostedSite, 'wrappedAssetType'>): boolean {
  return site.wrappedAssetType?.toLowerCase() === 'pdf';
}

export function PdfThumbnail({
  sizeBytes,
  className,
  compact = false,
}: {
  /** 优先用 PDF 文件本身大小；公开页等场景没有文件清单时用站点总大小（误差可忽略） */
  sizeBytes?: number;
  className?: string;
  compact?: boolean;
}) {
  const sizeMb = typeof sizeBytes === 'number' && sizeBytes > 0
    ? (sizeBytes / 1024 / 1024).toFixed(1)
    : null;

  if (compact) {
    return (
      <div
        className={className}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-well)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <FileText size={20} style={{ color: 'var(--accent-fg-danger)' }} strokeWidth={2.2} />
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        // 设计稿的缩略图两态都是中性深色井底 + 假页渐变，没有任何红色整卡；
        // 红只保留在中间那枚 PDF 图标上，作为形态标识
        background: 'var(--thumb-gradient)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: 44,
          height: 54,
          borderRadius: 6,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
        }}
      >
        {/* 设计稿的 PDF 卡与其它形态同构：中性纸片 + 一枚小图标，形态由左上角徽章负责说明。
            原来那块大红渐变让 PDF 卡在列表里像个报错块，设计稿里根本没有红色整卡。 */}
        <FileText size={20} style={{ color: 'var(--accent-fg-danger)' }} strokeWidth={1.8} />
      </div>
      {sizeMb && (
        <span
          style={{
            color: 'var(--text-tertiary)',
            fontSize: 10,
            fontFamily: 'var(--font-code)',
          }}
        >
          {sizeMb} MB · PDF 文档
        </span>
      )}
    </div>
  );
}
