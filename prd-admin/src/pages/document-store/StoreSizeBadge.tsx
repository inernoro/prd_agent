import { useEffect, useRef, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { getStoreSize, type DocumentStoreSize } from '@/services/real/documentStore';

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0 B';
  if (n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function isDocumentStoreSize(value: DocumentStoreSize | null | undefined): value is DocumentStoreSize {
  return !!value && Number.isFinite(value.totalBytes);
}

/**
 * 知识库大小徽章：展示该库当前内容体量（正文 + 附件，图片含其中）+ 图片数量。
 * tooltip 给出明细（正文 / 附件 / 图片 / 历史版本占用），帮助用户判断知识库大小。
 * refreshKey 变化时重新拉取（如保存/恢复内容后）。
 *
 * 懒加载（IntersectionObserver）：仅当徽章滚动进入视口才发 size 请求。
 * 这样知识库列表里成百上千张卡片不会在挂载瞬间一次性打满 size 接口，
 * 只为「用户当前看得到的库」算大小（库详情头部的徽章一进页面即可见 → 立即加载）。
 */
export function StoreSizeBadge({
  storeId,
  refreshKey,
  variant = 'full',
}: {
  storeId: string;
  refreshKey?: unknown;
  /** full: 带 HardDrive 图标 + 图片数；compact: 仅总体量（列表卡副标题用） */
  variant?: 'full' | 'compact';
}) {
  const [size, setSize] = useState<DocumentStoreSize | null>(null);
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { rootMargin: '120px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void getStoreSize(storeId).then(res => {
      if (!alive) return;
      if (res.success && isDocumentStoreSize(res.data)) setSize(res.data);
      setLoaded(true);
    });
    return () => { alive = false; };
  }, [storeId, refreshKey, visible]);

  // compact（列表卡）：加载失败/无权限时不占位，直接隐藏，避免卡片上挂个永久「…」
  if (variant === 'compact' && loaded && size == null) return null;

  const tip = size
    ? [
        `正文 ${fmt(size.documentBytes)}`,
        `附件 ${fmt(size.attachmentBytes)}`,
        `图片 ${fmt(size.imageBytes)}（${size.imageCount} 张）`,
        `历史版本 ${fmt(size.versionBytes)}（${size.versionCount} 个）`,
      ].join(' · ')
    : '';

  return (
    <span
      ref={ref}
      className="inline-flex items-center gap-1 text-[11px] text-token-muted tabular-nums"
      title={size ? `知识库大小明细：${tip}` : '知识库大小'}>
      {variant === 'full' && <HardDrive size={11} />}
      {size ? fmt(size.totalBytes) : '…'}
      {variant === 'full' && size != null && size.imageCount > 0 && <span>· {size.imageCount} 图</span>}
    </span>
  );
}
