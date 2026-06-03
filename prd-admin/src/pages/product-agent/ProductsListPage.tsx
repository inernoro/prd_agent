/**
 * 产品管理智能体 — 产品管理列表页（IA 重构后的顶层着陆页）。
 *
 * 路由：/product-agent
 * 职责：产品的新增 / 修改 / 删除 / 筛选；点击产品进入单产品视图 /product-agent/p/:id。
 * 管理层总览（跨产品 + 全局设置）是另一个独立入口 /product-agent/overview（P1）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, Plus, Search, ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { listProducts, createProduct, updateProduct, deleteProduct } from '@/services/real/productAgent';
import type { Product, ProductGrade } from './types';
import { PRODUCT_GRADE_LABEL } from './types';

const PRODUCT_GRADES: ProductGrade[] = ['core', 'important', 'normal', 'experimental'];
const GRADE_COLOR: Record<ProductGrade, string> = {
  core: '#22D3EE',
  important: '#FBBF24',
  normal: '#94A3B8',
  experimental: '#A78BFA',
};

export function ProductsListPage() {
  const navigate = useNavigate();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [gradeFilter, setGradeFilter] = useState<ProductGrade | ''>('');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listProducts({ pageSize: 200, keyword: keyword.trim() || undefined, grade: gradeFilter || undefined });
    if (res.success) setProducts(res.data.items);
    else setError(res.error?.message ?? '加载产品列表失败');
    setLoading(false);
  }, [keyword, gradeFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="h-screen min-h-0 flex flex-col p-4 bg-[#0f1014]">
      {/* 头部 */}
      <div className="shrink-0 flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="flex items-center justify-center w-9 h-9 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 shrink-0"
            title="返回首页"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-lg font-semibold text-white flex items-center gap-2">
              <Boxes size={20} className="text-cyan-400" />
              产品管理
            </h1>
            <p className="text-xs text-white/40 mt-0.5">管理所有产品，点击产品进入查看版本 / 需求 / 功能 / 缺陷 / 知识库 / 图谱</p>
          </div>
        </div>
        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm"
        >
          <Plus size={15} /> 新建产品
        </button>
      </div>

      {/* 筛选栏 */}
      <div className="shrink-0 flex items-center gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10">
          <Search size={14} className="text-white/40" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索产品名 / 编号"
            className="bg-transparent text-sm text-white outline-none w-40"
          />
        </div>
        <button
          onClick={() => setGradeFilter('')}
          className={`px-2.5 py-1 rounded-md text-xs border ${gradeFilter === '' ? 'bg-white/10 text-white border-white/20' : 'text-white/50 border-white/10 hover:bg-white/5'}`}
        >
          全部
        </button>
        {PRODUCT_GRADES.map((g) => (
          <button
            key={g}
            onClick={() => setGradeFilter(g)}
            className="px-2.5 py-1 rounded-md text-xs border"
            style={{
              borderColor: gradeFilter === g ? GRADE_COLOR[g] : 'rgba(255,255,255,0.1)',
              color: gradeFilter === g ? GRADE_COLOR[g] : 'rgba(255,255,255,0.5)',
              background: gradeFilter === g ? 'rgba(255,255,255,0.05)' : 'transparent',
            }}
          >
            {PRODUCT_GRADE_LABEL[g]}
          </button>
        ))}
      </div>

      {error && (
        <div className="shrink-0 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 mb-3">{error}</div>
      )}

      {/* 产品卡片网格 */}
      <div className="flex-1 min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
        {loading ? (
          <MapSectionLoader text="正在加载产品…" />
        ) : products.length === 0 ? (
          <div className="text-center text-white/40 text-sm py-16 px-6">
            还没有产品。点右上角「新建产品」创建第一个，开始串联版本、需求、功能与缺陷。
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {products.map((p) => (
              <div
                key={p.id}
                onClick={() => navigate(`/product-agent/p/${p.id}`)}
                className="group cursor-pointer rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/20 p-4 transition-colors flex flex-col gap-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-white font-medium truncate">{p.name}</div>
                    <div className="text-[11px] text-white/40 mt-0.5">{p.productNo}</div>
                  </div>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                    style={{ color: GRADE_COLOR[p.grade], background: 'rgba(255,255,255,0.06)' }}
                  >
                    {PRODUCT_GRADE_LABEL[p.grade]}
                  </span>
                </div>
                {p.description && <div className="text-xs text-white/50 line-clamp-2">{p.description}</div>}
                <div className="text-[11px] text-white/40 mt-1">
                  版本 {p.versionCount} · 需求 {p.requirementCount} · 功能 {p.featureCount} · 缺陷 {p.defectCount}
                </div>
                <div className="flex items-center justify-end gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
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
                    onClick={async (e) => {
                      e.stopPropagation();
                      const res = await deleteProduct(p.id);
                      if (res.success) await reload();
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-red-300/70 hover:text-red-300 hover:bg-red-500/10"
                  >
                    <Trash2 size={12} /> 删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <ProductEditModal
          product={editing === 'new' ? null : editing}
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

function ProductEditModal({
  product,
  onClose,
  onSaved,
}: {
  product: Product | null;
  onClose: () => void;
  onSaved: (id?: string) => void;
}) {
  const [name, setName] = useState(product?.name ?? '');
  const [description, setDescription] = useState(product?.description ?? '');
  const [grade, setGrade] = useState<ProductGrade>(product?.grade ?? 'normal');
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
          <label className="text-xs text-white/50">产品分级</label>
          <div className="flex gap-1.5">
            {PRODUCT_GRADES.map((g) => (
              <button
                key={g}
                onClick={() => setGrade(g)}
                className={`px-2.5 py-1 rounded-md text-xs border ${grade === g ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/50 border-white/10 hover:bg-white/5'}`}
              >
                {PRODUCT_GRADE_LABEL[g]}
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
