import { useEffect, useRef, useState } from 'react';
import { Copy, Star } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  TRACKED_RECORDS_CHANGED_EVENT,
  buildProductRecordHref,
  isTrackedRecord,
  toggleTrackedRecord,
  type ProductRecordKind,
} from './productRecordTrackStorage';

async function copyText(text: string, successMessage: string) {
  const value = text.trim();
  if (!value) {
    toast.error('复制失败', '内容为空');
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast.success('已复制', successMessage);
  } catch {
    toast.error('复制失败', '浏览器未授权剪贴板');
  }
}

export function DetailRecordActions({
  kind,
  productId,
  recordId,
  title,
  recordNo,
}: {
  kind: ProductRecordKind;
  productId: string;
  recordId: string;
  title: string;
  recordNo: string;
}) {
  const [tracked, setTracked] = useState(() => isTrackedRecord(kind, productId, recordId));
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = () => setTracked(isTrackedRecord(kind, productId, recordId));
    sync();
    window.addEventListener(TRACKED_RECORDS_CHANGED_EVENT, sync);
    return () => window.removeEventListener(TRACKED_RECORDS_CHANGED_EVENT, sync);
  }, [kind, productId, recordId]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [menuOpen]);

  const href = buildProductRecordHref(kind, productId, recordId);
  const displayTitle = title.trim() || recordNo || '未命名';
  const displayId = recordNo.trim() || recordId;

  const onToggleTrack = () => {
    const added = toggleTrackedRecord({
      kind,
      productId,
      recordId,
      title: displayTitle,
      recordNo: displayId,
    });
    setTracked(added);
    toast.success(added ? '已加入追踪' : '已取消追踪', added ? displayTitle : '');
  };

  const menuItems = [
    { label: '复制标题', run: () => void copyText(displayTitle, '标题已复制') },
    { label: '复制 ID', run: () => void copyText(displayId, 'ID 已复制') },
    { label: '复制链接', run: () => void copyText(href, '链接已复制') },
    {
      label: '复制标题和链接',
      run: () => void copyText(`${displayTitle}\n${href}`, '标题与链接已复制'),
    },
  ];

  return (
    <div ref={rootRef} className="relative flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        title={tracked ? '取消追踪' : '追踪此记录'}
        onClick={onToggleTrack}
        className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
          tracked
            ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
            : 'border-white/10 bg-white/5 text-white/45 hover:border-amber-500/30 hover:text-amber-200'
        }`}
      >
        <Star size={15} className={tracked ? 'fill-current' : ''} />
      </button>
      <button
        type="button"
        title="复制"
        onClick={() => setMenuOpen((open) => !open)}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/45 hover:border-cyan-500/35 hover:text-cyan-200"
      >
        <Copy size={15} />
      </button>
      {menuOpen && (
        <div className="absolute right-0 top-full z-30 mt-1 min-w-[168px] rounded-lg border border-white/12 bg-[#181a22] py-1 shadow-xl">
          {menuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                item.run();
                setMenuOpen(false);
              }}
              className="block w-full px-3 py-2 text-left text-xs text-white/75 hover:bg-white/5 hover:text-white"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
