import { FileText } from 'lucide-react';
import type { HostedSite } from '@/services/real/webPages';

export function isPdfSite(site: Pick<HostedSite, 'files'>): boolean {
  if (!site.files || site.files.length === 0) return false;
  return site.files.some(f => f.path?.toLowerCase().endsWith('.pdf'));
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
          background: 'linear-gradient(135deg, #dc2626 0%, #991b1b 100%)',
        }}
      >
        <FileText size={20} color="#fff" strokeWidth={2.2} />
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
        background:
          'radial-gradient(120% 80% at 50% 0%, rgba(220, 38, 38, 0.18) 0%, rgba(127, 29, 29, 0.06) 60%, transparent 100%), linear-gradient(180deg, #1a1216 0%, #0f0a0c 100%)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: 56,
          height: 68,
          borderRadius: 8,
          background: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 8px 24px rgba(220, 38, 38, 0.35), inset 0 1px 0 rgba(255,255,255,0.15)',
          position: 'relative',
        }}
      >
        <span
          style={{
            color: '#fff',
            fontSize: 13,
            fontWeight: 800,
            letterSpacing: 1,
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}
        >
          PDF
        </span>
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 14,
            height: 14,
            background: 'rgba(255,255,255,0.18)',
            borderBottomLeftRadius: 6,
            borderTopRightRadius: 8,
          }}
        />
      </div>
      {sizeMb && (
        <span
          style={{
            color: 'rgba(255,255,255,0.55)',
            fontSize: 11,
            fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          }}
        >
          {sizeMb} MB · PDF 文档
        </span>
      )}
    </div>
  );
}
