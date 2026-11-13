import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { listDocumentTrash, restoreDocumentTrash, resumeDocumentTrash, type DocumentTrashItem } from '@/services/real/documentStore';
import { toast } from '@/lib/toast';

export function DocumentTrashButton({ storeId, onRestored }: { storeId?: string; onRestored: () => void | Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DocumentTrashItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listDocumentTrash(storeId);
      if (res.success) setItems(res.data.items);
      else setError(res.error?.message ?? '回收站读取失败');
    } catch { setError('回收站读取失败，请重试'); }
    finally { setLoading(false); }
  }, [storeId]);
  useEffect(() => {
    if (!open) return;
    void load();
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, load]);

  const restore = async (item: DocumentTrashItem) => {
    setBusy(item.id);
    setError(null);
    try {
      const res = await (item.pending ? resumeDocumentTrash(item) : restoreDocumentTrash(item));
      if (!res.success) { setError(res.error?.message ?? '操作失败，请重试'); return; }
      toast.success(item.pending ? '已移入回收站' : '已恢复', item.pending ? '现在可以恢复内容' : '内容及原目录关系已保留');
      await load();
      await onRestored();
    } catch { setError('操作结果暂未确认，请刷新回收站后重试'); }
    finally { setBusy(null); }
  };

  return <>
    <Button variant="secondary" size="xs" onClick={() => setOpen(true)}><Trash2 size={14} /> 回收站</Button>
    {open && createPortal(
      <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: 'var(--dialog-overlay)' }} onClick={() => setOpen(false)}>
        <section role="dialog" aria-modal="true" aria-label="知识库回收站" className="prd-dialog-content w-full max-w-2xl rounded-2xl border flex flex-col p-5 gap-4" style={{ height: 'min(80vh, 640px)', background: 'var(--bg-elevated)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }} onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between shrink-0"><h2 className="text-lg font-semibold">知识库回收站</h2><Button variant="ghost" size="xs" onClick={() => setOpen(false)} aria-label="关闭回收站"><X size={18} /></Button></div>
          <p className="text-xs shrink-0" style={{ color: 'var(--text-secondary)' }}>删除后 30 天内可恢复。条目由当前可编辑此库的成员恢复，整库仅创建者可恢复。恢复前请先恢复原目录。本期不提供永久删除或到期自动清理。</p>
          {error && <div role="alert" className="text-sm shrink-0" style={{ color: 'var(--text-primary)' }}>{error}</div>}
          <div className="flex-1 min-h-0 flex flex-col gap-2" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
            {loading ? <div role="status" className="flex items-center gap-2"><MapSpinner size={16} /> 正在读取回收站…</div> : items.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>暂无可恢复内容。误删后可在这里找回知识库、文件夹和文档。</p> : items.map(item => <div key={`${item.kind}:${item.id}`} className="flex items-center gap-3 rounded-lg border p-3" style={{ borderColor: 'var(--border-default)' }}>
              <div className="min-w-0 flex-1"><p className="truncate font-medium" title={item.title}>{item.title}</p><p className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{item.kind === 'store' ? '知识库' : item.storeName} · {new Date(item.deletedAt).toLocaleString()} 删除</p><p className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.pending ? '删除中断，请继续回收后恢复' : item.canRestore ? `可恢复至 ${new Date(item.expiresAt).toLocaleString()}` : '已超过恢复期限'}</p></div>
              <Button variant="secondary" size="xs" disabled={(!item.canRestore && !item.pending) || busy !== null} onClick={() => void restore(item)}>{busy === item.id ? <MapSpinner size={14} /> : <RotateCcw size={14} />} {busy === item.id ? '正在处理…' : item.pending ? '继续回收' : '恢复'}</Button>
            </div>)}
          </div>
          <div className="shrink-0 flex justify-end"><Button variant="secondary" size="xs" disabled={loading || busy !== null} onClick={() => void load()}>刷新</Button></div>
        </section>
      </div>, document.body)}
  </>;
}
