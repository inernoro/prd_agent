import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { getStoreSize, type DocumentStoreSize } from '@/services/real/documentStore';

function fmt(n: number): string {
  if (n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 知识库大小徽章：展示该库当前内容体量（正文 + 附件，图片含其中）+ 图片数量。
 * tooltip 给出明细（正文 / 附件 / 图片 / 历史版本占用），帮助用户判断知识库大小。
 * refreshKey 变化时重新拉取（如保存/恢复内容后）。
 */
export function StoreSizeBadge({ storeId, refreshKey }: { storeId: string; refreshKey?: unknown }) {
  const [size, setSize] = useState<DocumentStoreSize | null>(null);

  useEffect(() => {
    let alive = true;
    void getStoreSize(storeId).then(res => {
      if (alive && res.success && res.data) setSize(res.data);
    });
    return () => { alive = false; };
  }, [storeId, refreshKey]);

  if (!size) return null;

  const tip = [
    `正文 ${fmt(size.documentBytes)}`,
    `附件 ${fmt(size.attachmentBytes)}`,
    `图片 ${fmt(size.imageBytes)}（${size.imageCount} 张）`,
    `历史版本 ${fmt(size.versionBytes)}（${size.versionCount} 个）`,
  ].join(' · ');

  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] text-token-muted tabular-nums"
      title={`知识库大小明细：${tip}`}>
      <HardDrive size={11} />
      {fmt(size.totalBytes)}
      {size.imageCount > 0 && <span>· {size.imageCount} 图</span>}
    </span>
  );
}
