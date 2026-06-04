/**
 * 产品管理智能体 — 全局搜索（跨产品/需求/功能/客户/缺陷，P1）。
 *
 * 顶部搜索框 + 分组结果下拉，300ms 防抖。点结果直达对应详情/单产品视图。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Boxes, ListChecks, Puzzle, Users, Bug, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { globalSearch, type GlobalSearchResult } from '@/services/real/productAgent';

const EMPTY: GlobalSearchResult = { products: [], requirements: [], features: [], customers: [], defects: [] };

export function GlobalSearch() {
  const navigate = useNavigate();
  const [kw, setKw] = useState('');
  const [res, setRes] = useState<GlobalSearchResult>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(async (q: string) => {
    if (q.trim().length === 0) {
      setRes(EMPTY);
      setLoading(false);
      return;
    }
    setLoading(true);
    const r = await globalSearch(q.trim());
    if (r.success) setRes(r.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(kw), 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [kw, run]);

  const total = res.products.length + res.requirements.length + res.features.length + res.customers.length + res.defects.length;
  const go = (path: string) => {
    setOpen(false);
    setKw('');
    navigate(path);
  };

  return (
    <div className="relative w-full max-w-md">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10">
        <Search size={14} className="text-white/40 shrink-0" />
        <input
          value={kw}
          onChange={(e) => { setKw(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="搜索产品 / 需求 / 功能 / 客户 / 缺陷"
          className="bg-transparent text-sm text-white outline-none flex-1 min-w-0"
        />
        {loading ? <MapSpinner size={13} /> : kw ? <X size={13} className="text-white/40 hover:text-white cursor-pointer shrink-0" onClick={() => { setKw(''); setRes(EMPTY); }} /> : null}
      </div>

      {open && kw.trim() && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 top-10 z-30 max-h-[60vh] overflow-y-auto rounded-xl border border-white/10 bg-[#1b1d22] shadow-2xl p-1.5" style={{ overscrollBehavior: 'contain' }}>
            {loading && total === 0 ? (
              <div className="text-[11px] text-white/40 text-center py-4">搜索中…</div>
            ) : total === 0 ? (
              <div className="text-[11px] text-white/30 text-center py-4">没有匹配的结果</div>
            ) : (
              <>
                <Group icon={Boxes} label="产品" items={res.products.map((p) => ({ key: p.id, no: p.no, text: p.name, onClick: () => go(`/product-agent/p/${p.id}`) }))} />
                <Group icon={ListChecks} label="需求" items={res.requirements.map((r) => ({ key: r.id, no: r.no, text: r.title, onClick: () => go(`/product-agent/p/${r.productId}/requirement/${r.id}`) }))} />
                <Group icon={Puzzle} label="功能" items={res.features.map((f) => ({ key: f.id, no: f.no, text: f.title, onClick: () => go(`/product-agent/p/${f.productId}/feature/${f.id}`) }))} />
                <Group icon={Users} label="客户" items={res.customers.map((c) => ({ key: c.id, no: '', text: c.name, onClick: () => go(`/product-agent/p/${c.productId}`) }))} />
                <Group icon={Bug} label="缺陷" items={res.defects.map((d) => ({ key: d.id, no: d.no, text: d.title || '(无标题)', onClick: () => go(`/product-agent/p/${d.productId}/defect/${d.id}`) }))} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Group({ icon: Icon, label, items }: { icon: typeof Boxes; label: string; items: { key: string; no: string; text: string; onClick: () => void }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-1 last:mb-0">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] text-white/40">
        <Icon size={11} /> {label} · {items.length}
      </div>
      {items.map((it) => (
        <button key={it.key} onClick={it.onClick} className="w-full text-left px-2.5 py-1.5 rounded-md hover:bg-white/5 flex items-center gap-2">
          {it.no && <span className="text-[10px] font-mono text-white/35 shrink-0">{it.no}</span>}
          <span className="text-sm text-white/85 truncate">{it.text}</span>
        </button>
      ))}
    </div>
  );
}
