/**
 * 版本详情 —「本版本知识」卡：从产品库按 versionId 调取关联知识（只读引用，不在版本里新建）。
 * 「关联知识」对话框从产品库已有文档中勾选挂载/取消（写 entry.versionIds）。
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Link2, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { listKnowledgeEntriesPaged, updateDocumentEntry } from '@/services';
import type { DocumentEntry } from '@/services/contracts/documentStore';
import { getProductKnowledgeStore } from '@/services/real/productAgent';
import { fileKindOf, fmtTime } from './shared';

export function VersionKnowledgeCard({ productId, versionId }: { productId: string; versionId: string }) {
  const navigate = useNavigate();
  const [storeId, setStoreId] = useState<string | null>(null);
  const [items, setItems] = useState<DocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const reload = useCallback(async (sid: string) => {
    const res = await listKnowledgeEntriesPaged(sid, { versionId, pageSize: 100 });
    if (res.success) setItems(res.data.items);
  }, [versionId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      const res = await getProductKnowledgeStore(productId);
      if (!alive) return;
      if (res.success && res.data) {
        setStoreId(res.data.id);
        await reload(res.data.id);
      }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [productId, reload]);

  return (
    <>
      {loading ? (
        <div className="flex items-center gap-2 text-[11px] text-white/35 py-1"><MapSpinner size={12} /> 正在调取本版本知识…</div>
      ) : items.length === 0 ? (
        <div className="text-[11px] text-white/40">
          还没有知识关联到本版本。点「关联知识」从产品知识库挑选（知识统一存产品库，版本里只调取）。
        </div>
      ) : (
        <div className="flex flex-col gap-0.5 max-h-56 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
          {items.map((e) => {
            const kind = fileKindOf(e.contentType);
            const Icon = kind.icon;
            return (
              <button
                key={e.id}
                onClick={() => navigate(`/product-agent/p/${productId}/knowledge/${e.id}`)}
                className="text-left flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5"
                title="打开知识详情"
              >
                <Icon size={13} className="shrink-0" style={{ color: kind.color }} />
                <span className="text-sm text-white/80 truncate flex-1">{e.title}</span>
                {e.category && <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300/80 shrink-0">{e.category}</span>}
                <span className="text-[10px] text-white/30 shrink-0">{fmtTime(e.updatedAt)}</span>
              </button>
            );
          })}
        </div>
      )}
      {pickerOpen && storeId && (
        <KnowledgePickerDialog
          storeId={storeId}
          versionId={versionId}
          onClose={() => setPickerOpen(false)}
          onSaved={() => { setPickerOpen(false); void reload(storeId); }}
        />
      )}
      {/* 卡片标题右侧动作由父组件渲染；这里暴露打开方法供内部空态点击 */}
      {!loading && (
        <button onClick={() => setPickerOpen(true)} className="mt-2 flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200">
          <Link2 size={11} /> 关联知识
        </button>
      )}
    </>
  );
}

/** 从产品库挑选要关联到本版本的知识（勾选=挂载，取消=解除） */
function KnowledgePickerDialog({ storeId, versionId, onClose, onSaved }: {
  storeId: string;
  versionId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [docs, setDocs] = useState<DocumentEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initial, setInitial] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [kw, setKw] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await listKnowledgeEntriesPaged(storeId, { pageSize: 500 });
      if (!alive) return;
      if (res.success) {
        setDocs(res.data.items);
        const pre = new Set(res.data.items.filter((e) => (e.versionIds ?? []).includes(versionId)).map((e) => e.id));
        setSelected(new Set(pre));
        setInitial(pre);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [storeId, versionId]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    const changed = docs.filter((d) => selected.has(d.id) !== initial.has(d.id));
    for (const d of changed) {
      const cur = new Set(d.versionIds ?? []);
      if (selected.has(d.id)) cur.add(versionId); else cur.delete(versionId);
      const res = await updateDocumentEntry(d.id, { versionIds: Array.from(cur) });
      if (!res.success) toast.error(`更新失败: ${d.title}`, res.error?.message);
    }
    setSaving(false);
    toast.success('版本知识已更新', `${changed.length} 处变更`);
    onSaved();
  };

  const shown = kw.trim() ? docs.filter((d) => d.title.toLowerCase().includes(kw.trim().toLowerCase())) : docs;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="rounded-xl border border-white/10 bg-[#16181d] flex flex-col"
        style={{ width: 520, maxWidth: '92vw', height: '70vh', maxHeight: '70vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <BookOpen size={14} className="text-cyan-400" /> 关联知识到本版本
          </h2>
          <button onClick={onClose} className="text-white/40 hover:text-white"><X size={16} /></button>
        </div>
        <div className="px-4 pt-3 shrink-0">
          <input
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder="搜索产品知识库…"
            className="w-full px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40 placeholder:text-white/25"
          />
        </div>
        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-1" style={{ minHeight: 0, overscrollBehavior: 'contain' }}>
          {loading ? (
            <div className="flex items-center justify-center py-10"><MapSpinner size={18} /></div>
          ) : shown.length === 0 ? (
            <div className="text-xs text-white/35 text-center py-8">
              {docs.length === 0 ? '产品知识库还没有文档。先去「知识库」tab 新建或上传，再回来关联。' : '没有匹配的文档'}
            </div>
          ) : (
            shown.map((d) => {
              const kind = fileKindOf(d.contentType);
              const Icon = kind.icon;
              return (
                <label key={d.id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-white/[0.03] border border-white/5 cursor-pointer hover:bg-white/[0.06]">
                  <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} className="accent-cyan-500" />
                  <Icon size={13} className="shrink-0" style={{ color: kind.color }} />
                  <span className="text-sm text-white/85 flex-1 truncate">{d.title}</span>
                  {d.category && <span className="text-[10px] text-cyan-300/70 shrink-0">{d.category}</span>}
                </label>
              );
            })
          )}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/10 shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">取消</button>
          <button
            onClick={() => void save()}
            disabled={saving || loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm hover:bg-cyan-500/30 disabled:opacity-50"
          >
            {saving && <MapSpinner size={13} />} 保存（已选 {selected.size}）
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
