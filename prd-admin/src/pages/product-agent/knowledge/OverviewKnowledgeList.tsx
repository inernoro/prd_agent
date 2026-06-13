/**
 * 管理层总览 — 跨产品聚合知识列表。
 * 与单产品「知识列表」同构（搜索/筛选/分页/进详情页），多一列「所属产品」；
 * 管理操作（新建/上传/分类治理）落在具体产品库，这里提供「进入产品知识库」跳转。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronLeft, ChevronRight, ArrowRight, X, BookOpen } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getOverviewKnowledgeEntries, listProducts } from '@/services/real/productAgent';
import type { OverviewKnowledgeEntryRow } from '@/services/real/productAgent';
import type { Product } from '../types';
import { fileKindOf, fmtSize, fmtTime, FOCUS_BOX } from './shared';
import { useListSelection, ListCheckbox } from '../listSelection';
import { ExportOnlyBatchBar } from '../ListBatchBar';
import { downloadListCsv } from '../listExport';
import '../product-cards.css';

const PAGE_SIZE = 20;

export function OverviewKnowledgeList() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<OverviewKnowledgeEntryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [productFilter, setProductFilter] = useState('');
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    void listProducts({ pageSize: 200 }).then((res) => {
      if (res.success) setProducts(res.data.items);
    });
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getOverviewKnowledgeEntries({
      page, pageSize: PAGE_SIZE,
      keyword: appliedKeyword || undefined,
      productId: productFilter || undefined,
    });
    if (res.success) { setRows(res.data.items); setTotal(res.data.total); }
    setLoading(false);
  }, [page, appliedKeyword, productFilter]);
  useEffect(() => { void reload(); }, [reload]);

  const applySearch = () => { setAppliedKeyword(keyword.trim()); setPage(1); };
  const clearAll = () => { setKeyword(''); setAppliedKeyword(''); setProductFilter(''); setPage(1); };
  const hasFilter = !!(appliedKeyword || productFilter);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const rowIds = useMemo(() => rows.map((r) => r.entry.id), [rows]);
  const selection = useListSelection(rowIds);
  const exportSelected = () => {
    const picked = rows.filter((r) => selection.selected.has(r.entry.id));
    downloadListCsv(
      'overview-knowledge.csv',
      ['标题', '产品', '分类', '类型', '大小'],
      picked.map((r) => [r.entry.title, r.productName ?? '', r.entry.category ?? '', fileKindOf(r.entry.contentType).label, fmtSize(r.entry.fileSize)]),
    );
  };

  const goDetail = (r: OverviewKnowledgeEntryRow) => {
    if (r.productId) navigate(`/product-agent/p/${r.productId}/knowledge/${r.entry.id}`);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className={FOCUS_BOX}>
          <Search size={14} className="text-white/40" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
            placeholder="搜索知识（标题 / 全文），回车确认"
            className="no-focus-ring bg-transparent text-sm text-white outline-none w-64"
          />
          {keyword && <button onClick={clearAll} className="text-white/30 hover:text-white"><X size={13} /></button>}
        </div>
        <select
          value={productFilter}
          onChange={(e) => { setProductFilter(e.target.value); setPage(1); }}
          className="px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-xs text-white/70 outline-none focus:border-cyan-500/40 [&>option]:bg-[#16181d]"
        >
          <option value="">全部产品</option>
          {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {hasFilter && <button onClick={clearAll} className="text-[11px] text-white/40 hover:text-white underline underline-offset-2">清除筛选</button>}
        <span className="ml-auto text-[11px] text-white/35">新建 / 上传 / 治理请进入具体产品的知识库</span>
      </div>

      <div className="flex flex-col gap-1.5">
        {selection.count > 0 && (
          <ExportOnlyBatchBar ids={selection.selectedIds} onClear={selection.clear} onExport={exportSelected} />
        )}
        {loading ? (
          <MapSectionLoader text="正在聚合各产品知识…" />
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-16 gap-2">
            <BookOpen size={32} className="text-white/20" />
            <div className="text-sm text-white/55">{hasFilter ? '没有匹配的知识' : '各产品还没有知识文档'}</div>
            <div className="text-xs text-white/35">{hasFilter ? '换个关键词或产品试试' : '进入任意产品的「知识库」tab 上传或新建'}</div>
          </div>
        ) : (
          rows.map((r) => {
            const kind = fileKindOf(r.entry.contentType);
            const Icon = kind.icon;
            return (
              <div
                key={r.entry.id}
                onClick={() => goDetail(r)}
                className="pa-row group cursor-pointer flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/10 bg-white/[0.02]"
              >
                <span onClick={(ev) => ev.stopPropagation()}>
                  <ListCheckbox checked={selection.selected.has(r.entry.id)} onChange={() => selection.toggle(r.entry.id)} />
                </span>
                <Icon size={16} className="shrink-0" style={{ color: kind.color }} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm text-white/90 truncate">{r.entry.title}</span>
                    {r.entry.category && <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300/90 border border-cyan-500/20 shrink-0">{r.entry.category}</span>}
                    {(r.entry.tags ?? []).slice(0, 2).map((t) => (
                      <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-white/55 shrink-0">{t}</span>
                    ))}
                  </div>
                  <div className="text-[11px] text-white/35 mt-0.5 truncate">
                    {kind.label} · {fmtSize(r.entry.fileSize)} · 更新于 {fmtTime(r.entry.updatedAt)}
                  </div>
                </div>
                <span className="shrink-0 text-[11px] px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-white/55">
                  {r.productName ?? '未知产品'}
                </span>
                <button
                  onClick={(ev) => { ev.stopPropagation(); if (r.productId) navigate(`/product-agent/p/${r.productId}?tab=knowledge`); }}
                  className="shrink-0 flex items-center gap-1 text-[11px] text-white/35 hover:text-cyan-300 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="进入产品知识库"
                >
                  产品知识库 <ArrowRight size={11} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-white/40">
          <span>共 {total} 篇</span>
          <div className="flex items-center gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="flex items-center gap-0.5 px-2 py-1 rounded-md border border-white/10 hover:bg-white/5 disabled:opacity-30">
              <ChevronLeft size={13} /> 上一页
            </button>
            <span className="text-white/55">{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="flex items-center gap-0.5 px-2 py-1 rounded-md border border-white/10 hover:bg-white/5 disabled:opacity-30">
              下一页 <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
