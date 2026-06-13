/**
 * 产品管理智能体 — 「产品」区块（管理层总览内的产品管理：新增/修改/删除/筛选）。
 * 嵌在 SectionShell 内（自带标题与滚动），点产品进单产品视图 /product-agent/p/:id。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Pencil, Trash2, Upload, Star, LayoutGrid, List } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { systemDialog } from '@/lib/systemDialog';
import { listProducts, createProduct, updateProduct, deleteProduct, getOverviewStats } from '@/services/real/productAgent';
import { ProductImportDialog } from './ProductImportDialog';
import type { Product, ProductGrade, ProductCategory } from './types';
import { useProductCategories, categoryLabel, categoryColor } from './productCategories';
import { readFavoriteProductIds, toggleFavoriteProductId } from './productFavoriteStorage';
import { OverviewDataTable, TruncateCell } from './overviewDataTable';
import { ListCheckbox } from './listSelection';
import { SelectionActionBar, useOverviewTableSelection } from './selectableList';
import { formatListSectionTitle } from '@/lib/listSectionTitle';
import './product-cards.css';

const SEARCH_BOX =
  'flex flex-1 min-w-[280px] max-w-xl items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 transition-colors focus-within:border-cyan-500/40 focus-within:bg-white/[0.07]';

type ProductViewMode = 'card' | 'list';
const VIEW_MODE_STORAGE_KEY = 'product-agent:products-view-mode';

function readProductViewMode(): ProductViewMode {
  try {
    const raw = sessionStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return raw === 'list' ? 'list' : 'card';
  } catch {
    return 'card';
  }
}

function writeProductViewMode(mode: ProductViewMode) {
  try {
    sessionStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore quota errors
  }
}

export function ProductsSection() {
  const navigate = useNavigate();
  const { categories } = useProductCategories();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [gradeFilter, setGradeFilter] = useState<ProductGrade | ''>('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => readFavoriteProductIds());
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [canImport, setCanImport] = useState(false);
  const [viewMode, setViewMode] = useState<ProductViewMode>(() => readProductViewMode());

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listProducts({ pageSize: 200, keyword: keyword.trim() || undefined, grade: gradeFilter || undefined });
    if (res.success) setProducts(res.data.items);
    setLoading(false);
  }, [keyword, gradeFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void getOverviewStats().then((res) => {
      if (res.success) setCanImport(res.data.isAdmin);
    });
  }, []);

  const toggleFavorite = (productId: string) => {
    toggleFavoriteProductId(productId);
    setFavoriteIds(readFavoriteProductIds());
  };

  const changeViewMode = (mode: ProductViewMode) => {
    setViewMode(mode);
    writeProductViewMode(mode);
  };

  const confirmDelete = async (p: Product) => {
    const ok = await systemDialog.confirm({
      title: '删除产品',
      message: `确定删除产品「${p.name}」吗？该产品下的需求、功能、版本等关联数据将一并不可访问，此操作不可恢复。`,
      tone: 'danger',
      confirmText: '删除',
      cancelText: '取消',
    });
    if (!ok) return;
    const res = await deleteProduct(p.id);
    if (res.success) await reload();
  };

  const visibleProducts = favoritesOnly
    ? products.filter((p) => favoriteIds.has(p.id))
    : products;

  const { selection, exportSelected } = useOverviewTableSelection(visibleProducts, {
    filename: 'products.csv',
    headers: ['名称', '编号', '类型', '版本', '需求', '功能', '缺陷'],
    mapRow: (p) => [
      p.name,
      p.productNo,
      categoryLabel(categories, p.grade),
      String(p.versionCount),
      String(p.requirementCount),
      String(p.featureCount),
      String(p.defectCount),
    ],
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex min-w-0 flex-1 items-center gap-2 flex-wrap">
          <label className={SEARCH_BOX}>
            <Search size={15} className="shrink-0 text-white/40" />
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索产品名 / 编号"
              className="no-focus-ring min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30"
            />
          </label>
          <button
            type="button"
            onClick={() => { setFavoritesOnly(false); setGradeFilter(''); }}
            className={`px-2.5 py-1 rounded-md text-xs border ${!favoritesOnly && gradeFilter === '' ? 'bg-white/10 text-white border-white/20' : 'text-white/50 border-white/10 hover:bg-white/5'}`}
          >
            全部
          </button>
          <button
            type="button"
            onClick={() => { setFavoritesOnly(true); setGradeFilter(''); }}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border ${
              favoritesOnly ? 'bg-amber-500/15 text-amber-200 border-amber-500/35' : 'text-white/50 border-white/10 hover:bg-white/5'
            }`}
          >
            <Star size={12} className={favoritesOnly ? 'fill-amber-300 text-amber-300' : ''} />
            收藏
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => { setGradeFilter(c.id); setFavoritesOnly(false); }}
              className="px-2.5 py-1 rounded-md text-xs border"
              style={{
                borderColor: gradeFilter === c.id ? c.color : 'rgba(255,255,255,0.1)',
                color: gradeFilter === c.id ? c.color : 'rgba(255,255,255,0.5)',
                background: gradeFilter === c.id ? 'rgba(255,255,255,0.05)' : 'transparent',
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <ProductViewToggle viewMode={viewMode} onChange={changeViewMode} />
          {canImport && (
            <button
              onClick={() => setImportOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/15 bg-white/5 text-white/70 hover:bg-white/10 text-sm"
            >
              <Upload size={15} /> 导入产品
            </button>
          )}
          <button
            onClick={() => setEditing('new')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm"
          >
            <Plus size={15} /> 新建产品
          </button>
        </div>
      </div>

      <SelectionActionBar mode="entity" entityType="product" selection={selection} onDone={reload} onExport={exportSelected} />

      {loading ? (
        <MapSectionLoader text="正在加载产品…" />
      ) : visibleProducts.length === 0 ? (
        <div className="text-center text-white/40 text-sm py-16 px-6">
          {favoritesOnly
            ? '还没有收藏的产品。在卡片或列表中点星标即可收藏。'
            : products.length === 0
              ? '还没有产品。点「新建产品」创建第一个，开始串联版本、需求、功能与缺陷。'
              : '没有匹配的产品，试试调整搜索或筛选条件。'}
        </div>
      ) : viewMode === 'card' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
          {visibleProducts.map((p, i) => {
            const isFavorite = favoriteIds.has(p.id);
            return (
            <div
              key={p.id}
              onClick={() => navigate(`/product-agent/p/${p.id}`)}
              style={{ animationDelay: `${Math.min(i, 14) * 45}ms` }}
              className="pa-card group group/list-row cursor-pointer rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] p-4 flex flex-col gap-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <span onClick={(e) => e.stopPropagation()}>
                    <ListCheckbox checked={selection.selected.has(p.id)} onChange={() => selection.toggle(p.id)} />
                  </span>
                  <div className="min-w-0 flex-1">
                  <div className="text-white font-medium truncate">{p.name}</div>
                  <div className="text-[11px] text-white/40 mt-0.5">{p.productNo}</div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    title={isFavorite ? '取消收藏' : '收藏'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(p.id);
                    }}
                    className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                      isFavorite
                        ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                        : 'border-transparent text-white/30 opacity-0 group-hover:opacity-100 hover:border-white/15 hover:bg-white/5 hover:text-amber-200/90'
                    }`}
                  >
                    <Star size={14} className={isFavorite ? 'fill-current' : ''} />
                  </button>
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: categoryColor(categories, p.grade), background: 'rgba(255,255,255,0.06)' }}>
                    {categoryLabel(categories, p.grade)}
                  </span>
                </div>
              </div>
              {p.description && <div className="text-xs text-white/50 line-clamp-2 min-h-[2rem]">{p.description}</div>}
              <div className="grid grid-cols-4 gap-1 mt-1">
                <MiniStat label="版本" value={p.versionCount} />
                <MiniStat label="需求" value={p.requirementCount} />
                <MiniStat label="功能" value={p.featureCount} />
                <MiniStat label="缺陷" value={p.defectCount} />
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-[10px] text-white/30 truncate">{p.ownerName || ''}</span>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(p);
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-white/60 hover:text-white hover:bg-white/10"
                  >
                    <Pencil size={12} /> 修改
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void confirmDelete(p);
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-red-300/70 hover:text-red-300 hover:bg-red-500/10"
                  >
                    <Trash2 size={12} /> 删除
                  </button>
                </div>
              </div>
            </div>
          );
          })}
        </div>
      ) : (
        <OverviewDataTable
          tableKey="products"
          rows={visibleProducts}
          selection={selection.tableSelection}
          onRowClick={(p) => navigate(`/product-agent/p/${p.id}`)}
          columns={[
            {
              key: 'favorite',
              header: '',
              defaultWidth: 44,
              resizable: false,
              render: (p) => {
                const isFavorite = favoriteIds.has(p.id);
                return (
                  <button
                    type="button"
                    title={isFavorite ? '取消收藏' : '收藏'}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(p.id);
                    }}
                    className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                      isFavorite
                        ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                        : 'border-transparent text-white/35 hover:border-white/15 hover:bg-white/5 hover:text-amber-200/90'
                    }`}
                  >
                    <Star size={14} className={isFavorite ? 'fill-current' : ''} />
                  </button>
                );
              },
            },
            {
              key: 'name',
              header: formatListSectionTitle('产品名称', visibleProducts.length),
              defaultWidth: 180,
              render: (p) => <TruncateCell text={p.name} maxChars={24} className="text-white font-medium" />,
            },
            {
              key: 'productNo',
              header: '编号',
              defaultWidth: 120,
              render: (p) => <span className="font-mono text-xs text-white/50">{p.productNo}</span>,
            },
            {
              key: 'grade',
              header: '类型',
              defaultWidth: 96,
              render: (p) => (
                <span
                  className="inline-block rounded px-1.5 py-0.5 text-[10px]"
                  style={{ color: categoryColor(categories, p.grade), background: 'rgba(255,255,255,0.06)' }}
                >
                  {categoryLabel(categories, p.grade)}
                </span>
              ),
            },
            {
              key: 'description',
              header: '描述',
              defaultWidth: 220,
              render: (p) => <TruncateCell text={p.description ?? '—'} maxChars={32} className="text-xs text-white/50" />,
            },
            {
              key: 'versionCount',
              header: '版本',
              defaultWidth: 64,
              render: (p) => <span className="text-xs text-white/70 tabular-nums">{p.versionCount}</span>,
            },
            {
              key: 'requirementCount',
              header: '需求',
              defaultWidth: 64,
              render: (p) => <span className="text-xs text-white/70 tabular-nums">{p.requirementCount}</span>,
            },
            {
              key: 'featureCount',
              header: '功能',
              defaultWidth: 64,
              render: (p) => <span className="text-xs text-white/70 tabular-nums">{p.featureCount}</span>,
            },
            {
              key: 'defectCount',
              header: '缺陷',
              defaultWidth: 64,
              render: (p) => <span className="text-xs text-white/70 tabular-nums">{p.defectCount}</span>,
            },
            {
              key: 'owner',
              header: '负责人',
              defaultWidth: 100,
              render: (p) => <TruncateCell text={p.ownerName ?? '—'} maxChars={12} className="text-xs text-white/45" />,
            },
            {
              key: 'actions',
              header: '操作',
              defaultWidth: 120,
              resizable: false,
              render: (p) => (
                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/60 hover:bg-white/10 hover:text-white"
                  >
                    <Pencil size={12} /> 修改
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmDelete(p)}
                    className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-red-300/70 hover:bg-red-500/10 hover:text-red-300"
                  >
                    <Trash2 size={12} /> 删除
                  </button>
                </div>
              ),
            },
          ]}
        />
      )}

      {importOpen && (
        <ProductImportDialog
          onClose={() => setImportOpen(false)}
          onImported={async () => {
            await reload();
          }}
        />
      )}

      {editing && (
        <ProductEditModal
          product={editing === 'new' ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            if (editing === 'new' && id) navigate(`/product-agent/p/${id}`);
            else void reload();
          }}
        />
      )}
    </div>
  );
}

function ProductViewToggle({
  viewMode,
  onChange,
}: {
  viewMode: ProductViewMode;
  onChange: (mode: ProductViewMode) => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5">
      <button
        type="button"
        title="卡片视图"
        onClick={() => onChange('card')}
        className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
          viewMode === 'card' ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/70'
        }`}
      >
        <LayoutGrid size={13} /> 卡片
      </button>
      <button
        type="button"
        title="列表视图"
        onClick={() => onChange('list')}
        className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
          viewMode === 'list' ? 'bg-white/10 text-white' : 'text-white/45 hover:bg-white/5 hover:text-white/70'
        }`}
      >
        <List size={13} /> 列表
      </button>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-white/[0.03] border border-white/5 px-1.5 py-1 text-center">
      <div className="text-sm font-semibold text-white/90 leading-none">{value}</div>
      <div className="text-[9px] text-white/40 mt-0.5">{label}</div>
    </div>
  );
}

function ProductEditModal({
  product,
  categories,
  onClose,
  onSaved,
}: {
  product: Product | null;
  categories: ProductCategory[];
  onClose: () => void;
  onSaved: (id?: string) => void;
}) {
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [grade, setGrade] = useState<ProductGrade>(product?.grade ?? categories[0]?.id ?? 'normal');
  const [saving, setSaving] = useState(false);
  const isNew = !product;

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const res = isNew
      ? await createProduct({ name: name.trim(), description, grade })
      : await updateProduct(product!.id, { name: name.trim(), description, grade });
    setSaving(false);
    if (res.success) onSaved(res.data?.id);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[440px] rounded-xl border border-white/10 bg-[#16181d] p-5 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-white">{isNew ? '新建产品' : '修改产品'}</h2>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-white/50">产品名称</label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：智能客服平台"
            className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-white/50">产品描述</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="产品定位 / 简介"
            className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40 resize-none"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-white/50">产品类型</label>
          <div className="flex gap-1.5 flex-wrap">
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setGrade(c.id)}
                className="px-2.5 py-1 rounded-md text-xs border"
                style={{
                  borderColor: grade === c.id ? c.color : 'rgba(255,255,255,0.1)',
                  color: grade === c.id ? c.color : 'rgba(255,255,255,0.5)',
                  background: grade === c.id ? 'rgba(255,255,255,0.05)' : 'transparent',
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-1">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">
            取消
          </button>
          <button
            onClick={save}
            disabled={!name.trim() || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
          >
            {saving ? <MapSpinner size={14} /> : <Plus size={14} />} {isNew ? '创建' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
