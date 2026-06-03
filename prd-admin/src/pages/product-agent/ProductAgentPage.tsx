/**
 * 产品管理智能体 — 主页面（P0 骨架）。
 *
 * 左侧产品列表 + 右侧详情（概览 / 版本 / 需求 / 功能 / 客户 五个 tab）。
 * 串起 产品-版本-需求-功能-客户 的关系网；缺陷追溯、知识图谱、自定义表单引擎为后续波次。
 *
 * 布局遵循 .claude/rules/full-height-layout.md：根 h-full min-h-0 flex flex-col。
 * 空状态遵循 .claude/rules/guided-exploration.md：给说明 + 主操作 CTA。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, Plus, Trash2, GitBranch, ListChecks, Puzzle, Users, BookOpen, Share2, ArrowUpCircle, LayoutGrid, List, ArrowLeft, Bug } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { VersionRelationModal, ProductKnowledgePanel, DefectLinkerModal } from './ProductRelationModals';
import { ProductGraphCanvas } from './ProductGraphCanvas';
import { UpgradeRequestsTab } from './UpgradeRequestsTab';
import {
  listProducts,
  createProduct,
  deleteProduct,
  listVersions,
  createVersion,
  deleteVersion,
  listRequirements,
  createRequirement,
  deleteRequirement,
  listFeatures,
  createFeature,
  deleteFeature,
  listCustomers,
  createCustomer,
  deleteCustomer,
  listTracedDefects,
  untraceDefect,
  type TracedDefect,
} from '@/services/real/productAgent';
import type {
  Product,
  ProductVersion,
  Requirement,
  Feature,
  Customer,
  ProductGrade,
  ItemGrade,
} from './types';
import { PRODUCT_GRADE_LABEL, ITEM_GRADE_LABEL, VERSION_LIFECYCLE_LABEL } from './types';

type DetailTab = 'overview' | 'versions' | 'requirements' | 'features' | 'customers' | 'defects' | 'upgrade' | 'knowledge' | 'graph';

const PRODUCT_GRADES: ProductGrade[] = ['core', 'important', 'normal', 'experimental'];
const ITEM_GRADES: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];

export function ProductAgentPage() {
  const navigate = useNavigate();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [newName, setNewName] = useState('');
  const [newGrade, setNewGrade] = useState<ProductGrade>('normal');
  const [saving, setSaving] = useState(false);

  const reloadProducts = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listProducts({ pageSize: 100 });
    if (res.success) {
      setProducts(res.data.items);
      setSelectedId((prev) => prev ?? res.data.items[0]?.id ?? null);
    } else {
      setError(res.error?.message ?? '加载产品列表失败');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reloadProducts();
  }, [reloadProducts]);

  const handleCreateProduct = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    const res = await createProduct({ name: newName.trim(), grade: newGrade });
    setSaving(false);
    if (res.success) {
      setNewName('');
      setNewGrade('normal');
      setCreatingProduct(false);
      setSelectedId(res.data.id);
      await reloadProducts();
    } else {
      setError(res.error?.message ?? '创建产品失败');
    }
  };

  const handleDeleteProduct = async (id: string) => {
    const res = await deleteProduct(id);
    if (res.success) {
      if (selectedId === id) setSelectedId(null);
      await reloadProducts();
    } else {
      setError(res.error?.message ?? '删除产品失败');
    }
  };

  const selected = products.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-4 h-screen min-h-0 p-4 bg-[#0f1014]">
      {/* 头部 */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="flex items-center justify-center w-9 h-9 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 transition-colors shrink-0"
            title="返回首页"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-lg font-semibold text-white flex items-center gap-2">
              <Boxes size={20} className="text-cyan-400" />
              产品管理智能体
            </h1>
            <p className="text-xs text-white/40 mt-0.5">
              产品 - 版本 - 需求 - 功能 - 缺陷 - 客户 全链路串联，版本化管理与分级追溯
            </p>
          </div>
        </div>
        <button
          onClick={() => setCreatingProduct(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm transition-colors"
        >
          <Plus size={15} /> 新建产品
        </button>
      </div>

      {error && (
        <div className="shrink-0 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* 主体：左列表 + 右详情 */}
      <div className="flex-1 min-h-0 flex gap-4">
        {/* 左：产品列表 */}
        <div className="w-64 shrink-0 flex flex-col min-h-0 rounded-xl border border-white/10 bg-white/[0.02]">
          <div className="px-3 py-2 text-xs font-medium text-white/50 border-b border-white/10 shrink-0">
            产品（{products.length}）
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-2" style={{ overscrollBehavior: 'contain' }}>
            {loading ? (
              <MapSectionLoader text="正在加载产品…" />
            ) : products.length === 0 ? (
              <div className="text-center text-white/40 text-xs py-8 px-3">
                还没有产品。点击右上角「新建产品」创建第一个，开始串联版本、需求与功能。
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                {products.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSelectedId(p.id);
                      setTab('overview');
                    }}
                    className={`group text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                      selectedId === p.id
                        ? 'bg-cyan-500/15 text-white border border-cyan-500/30'
                        : 'text-white/70 hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{p.name}</span>
                      <span className="text-[10px] text-white/40 shrink-0">{PRODUCT_GRADE_LABEL[p.grade]}</span>
                    </div>
                    <div className="text-[10px] text-white/30 mt-0.5">{p.productNo}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 右：详情 */}
        <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-white/10 bg-white/[0.02]">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center text-white/40 text-sm px-6 text-center">
              选择左侧的产品查看详情，或新建一个产品。每个产品下可管理版本、需求、功能与客户，并把它们关联成知识图谱。
            </div>
          ) : (
            <ProductDetail key={selected.id} product={selected} tab={tab} setTab={setTab} onDeleteProduct={handleDeleteProduct} />
          )}
        </div>
      </div>

      {/* 新建产品弹层（轻量内联） */}
      {creatingProduct && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => setCreatingProduct(false)}>
          <div
            className="w-[420px] rounded-xl border border-white/10 bg-[#16181d] p-5 flex flex-col gap-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-white">新建产品</h2>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-white/50">产品名称</label>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="如：智能客服平台"
                className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-white/50">产品分级</label>
              <div className="flex gap-1.5">
                {PRODUCT_GRADES.map((g) => (
                  <button
                    key={g}
                    onClick={() => setNewGrade(g)}
                    className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${
                      newGrade === g
                        ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40'
                        : 'text-white/50 border-white/10 hover:bg-white/5'
                    }`}
                  >
                    {PRODUCT_GRADE_LABEL[g]}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-1">
              <button onClick={() => setCreatingProduct(false)} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">
                取消
              </button>
              <button
                onClick={handleCreateProduct}
                disabled={!newName.trim() || saving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50"
              >
                {saving ? <MapSpinner size={14} /> : <Plus size={14} />} 创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════ 产品详情 ════════════════════════

const TABS: { key: DetailTab; label: string; icon: typeof GitBranch }[] = [
  { key: 'overview', label: '概览', icon: Boxes },
  { key: 'versions', label: '版本', icon: GitBranch },
  { key: 'requirements', label: '需求', icon: ListChecks },
  { key: 'features', label: '功能', icon: Puzzle },
  { key: 'customers', label: '客户', icon: Users },
  { key: 'defects', label: '缺陷', icon: Bug },
  { key: 'upgrade', label: '升级申请', icon: ArrowUpCircle },
  { key: 'knowledge', label: '知识库', icon: BookOpen },
  { key: 'graph', label: '图谱', icon: Share2 },
];

function ProductDetail({
  product,
  tab,
  setTab,
  onDeleteProduct,
}: {
  product: Product;
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  onDeleteProduct: (id: string) => void;
}) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-3 border-b border-white/10 shrink-0 flex items-center justify-between">
        <div>
          <div className="text-white font-medium">{product.name}</div>
          <div className="text-[11px] text-white/40 mt-0.5">
            {product.productNo} · {PRODUCT_GRADE_LABEL[product.grade]} · 版本 {product.versionCount} · 需求{' '}
            {product.requirementCount} · 功能 {product.featureCount}
          </div>
        </div>
        <button
          onClick={() => onDeleteProduct(product.id)}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-300/70 hover:text-red-300 hover:bg-red-500/10"
        >
          <Trash2 size={13} /> 删除产品
        </button>
      </div>

      <div className="flex gap-1 px-3 pt-2 shrink-0">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                tab === t.key ? 'bg-white/10 text-white' : 'text-white/50 hover:bg-white/5'
              }`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'knowledge' ? (
        <div className="flex-1 min-h-0">
          <ProductKnowledgePanel productId={product.id} />
        </div>
      ) : tab === 'graph' ? (
        <div className="flex-1 min-h-0">
          <ProductGraphCanvas productId={product.id} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-4" style={{ overscrollBehavior: 'contain' }}>
          {tab === 'overview' && <OverviewTab product={product} />}
          {tab === 'versions' && <VersionsTab productId={product.id} />}
          {tab === 'requirements' && <RequirementsTab productId={product.id} />}
          {tab === 'features' && <FeaturesTab productId={product.id} />}
          {tab === 'customers' && <CustomersTab productId={product.id} />}
          {tab === 'defects' && <DefectsTab productId={product.id} />}
          {tab === 'upgrade' && <UpgradeRequestsTab productId={product.id} />}
        </div>
      )}
    </div>
  );
}

function OverviewTab({ product }: { product: Product }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <Stat label="产品编号" value={product.productNo} />
      <Stat label="分级" value={PRODUCT_GRADE_LABEL[product.grade]} />
      <Stat label="描述" value={product.description || '（未填写）'} />
      <div className="grid grid-cols-4 gap-3 mt-2">
        <CountCard label="版本" value={product.versionCount} />
        <CountCard label="需求" value={product.requirementCount} />
        <CountCard label="功能" value={product.featureCount} />
        <CountCard label="缺陷" value={product.defectCount} />
      </div>
      <p className="text-xs text-white/30 mt-2">
        知识库挂载、缺陷追溯、知识图谱可视化将在后续波次开放。
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="text-white/40 w-16 shrink-0">{label}</span>
      <span className="text-white/80">{value}</span>
    </div>
  );
}

function CountCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-center">
      <div className="text-lg font-semibold text-white">{value}</div>
      <div className="text-[11px] text-white/40">{label}</div>
    </div>
  );
}

// ── 版本 tab ──
function VersionsTab({ productId }: { productId: string }) {
  const [items, setItems] = useState<ProductVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [relVersion, setRelVersion] = useState<ProductVersion | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listVersions(productId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const res = await createVersion(productId, { versionName: name.trim() });
    setSaving(false);
    if (res.success) {
      setName('');
      await reload();
    }
  };

  if (loading) return <MapSectionLoader text="正在加载版本…" />;
  return (
    <div className="flex flex-col gap-3">
      <QuickAdd value={name} setValue={setName} onAdd={add} saving={saving} placeholder="版本名，如 v2.0" />
      {items.length === 0 ? (
        <EmptyHint text="还没有版本。新建一个版本，把需求和功能归集到版本下，实现版本化管理。" />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((v) => (
            <Row
              key={v.id}
              title={v.versionName}
              sub={`${VERSION_LIFECYCLE_LABEL[v.lifecycle]} · 需求 ${v.requirementIds.length} · 功能 ${v.featureVersionIds.length}${v.isMajor ? ' · 大版本' : ''}`}
              onClick={() => setRelVersion(v)}
              actionLabel="关联需求/功能 · 知识库"
              onDelete={async () => {
                await deleteVersion(v.id);
                await reload();
              }}
            />
          ))}
        </div>
      )}
      {relVersion && (
        <VersionRelationModal
          productId={productId}
          version={relVersion}
          onClose={() => setRelVersion(null)}
          onSaved={() => void reload()}
        />
      )}
    </div>
  );
}

// ── 需求 tab ──
function RequirementsTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState<'list' | 'board'>('list');
  const openDetail = (id: string) => navigate(`/product-agent/${productId}/requirement/${id}`);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listRequirements(productId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const res = await createRequirement(productId, { title: title.trim(), grade });
    setSaving(false);
    if (res.success) {
      setTitle('');
      await reload();
    }
  };

  if (loading) return <MapSectionLoader text="正在加载需求…" />;
  return (
    <div className="flex flex-col gap-3">
      <QuickAdd value={title} setValue={setTitle} onAdd={add} saving={saving} placeholder="需求标题" grade={grade} setGrade={setGrade} />
      {items.length > 0 && (
        <div className="flex items-center gap-1 self-end">
          <button
            onClick={() => setView('list')}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs ${view === 'list' ? 'bg-white/10 text-white' : 'text-white/40 hover:bg-white/5'}`}
          >
            <List size={13} /> 列表
          </button>
          <button
            onClick={() => setView('board')}
            className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs ${view === 'board' ? 'bg-white/10 text-white' : 'text-white/40 hover:bg-white/5'}`}
          >
            <LayoutGrid size={13} /> 看板
          </button>
        </div>
      )}
      {items.length === 0 ? (
        <EmptyHint text="还没有需求。新建需求并分级，后续可关联客户、版本与功能，被缺陷追溯。" />
      ) : view === 'board' ? (
        <GradeBoard
          items={items}
          onCardClick={(r) => openDetail(r.id)}
          renderSub={(r) => `${r.requirementNo} · 客户 ${r.customerIds.length} · 版本 ${r.versionIds.length}`}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((r) => (
            <Row
              key={r.id}
              title={r.title}
              badge={ITEM_GRADE_LABEL[r.grade]}
              sub={`${r.requirementNo} · 客户 ${r.customerIds.length} · 版本 ${r.versionIds.length}`}
              onClick={() => openDetail(r.id)}
              actionLabel="查看详情"
              onDelete={async () => {
                await deleteRequirement(r.id);
                await reload();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 功能 tab ──
function FeaturesTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [grade, setGrade] = useState<ItemGrade>('p2');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listFeatures(productId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const res = await createFeature(productId, { title: title.trim(), grade });
    setSaving(false);
    if (res.success) {
      setTitle('');
      await reload();
    }
  };

  if (loading) return <MapSectionLoader text="正在加载功能…" />;
  return (
    <div className="flex flex-col gap-3">
      <QuickAdd value={title} setValue={setTitle} onAdd={add} saving={saving} placeholder="功能名称" grade={grade} setGrade={setGrade} />
      {items.length === 0 ? (
        <EmptyHint text="还没有功能。功能是跨版本演进的持久实体，可实现需求、被版本纳入（功能版本化）。" />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((f) => (
            <Row
              key={f.id}
              title={f.title}
              badge={ITEM_GRADE_LABEL[f.grade]}
              sub={`${f.featureNo} · 实现需求 ${f.requirementIds.length}`}
              onClick={() => navigate(`/product-agent/${productId}/feature/${f.id}`)}
              actionLabel="查看详情"
              onDelete={async () => {
                await deleteFeature(f.id);
                await reload();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 客户 tab ──
function CustomersTab({ productId }: { productId: string }) {
  const [items, setItems] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listCustomers(productId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const res = await createCustomer(productId, { name: name.trim() });
    setSaving(false);
    if (res.success) {
      setName('');
      await reload();
    }
  };

  if (loading) return <MapSectionLoader text="正在加载客户…" />;
  return (
    <div className="flex flex-col gap-3">
      <QuickAdd value={name} setValue={setName} onAdd={add} saving={saving} placeholder="客户名称" />
      {items.length === 0 ? (
        <EmptyHint text="还没有客户。录入客户后，可在需求上关联客户，回答“这个需求是哪些客户提的”。" />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((c) => (
            <Row
              key={c.id}
              title={c.name}
              sub={[c.company, c.contact].filter(Boolean).join(' · ') || '（无联系方式）'}
              onDelete={async () => {
                await deleteCustomer(c.id);
                await reload();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── 缺陷 tab（产品级追溯缺陷一览）──
function DefectsTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<TracedDefect[]>([]);
  const [loading, setLoading] = useState(true);
  const [showLinker, setShowLinker] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listTracedDefects(productId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <MapSectionLoader text="正在加载缺陷…" />;
  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={() => setShowLinker(true)}
        className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm"
      >
        <Plus size={15} /> 关联缺陷到本产品
      </button>
      {items.length === 0 ? (
        <EmptyHint text="还没有缺陷追溯到本产品。点上方关联已有缺陷，或在需求详情页里把缺陷追溯到具体需求。缺陷本体在「缺陷管理智能体」里维护。" />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((d) => (
            <Row
              key={d.id}
              title={d.title || '(无标题)'}
              badge={d.status}
              sub={`${d.defectNo}${d.tracedRequirementId ? ' · 已追溯到需求' : d.tracedVersionId ? ' · 已追溯到版本' : ' · 仅追溯到产品'}`}
              onClick={() => navigate(`/product-agent/${productId}/defect/${d.id}`)}
              actionLabel="查看详情"
              onDelete={async () => {
                await untraceDefect(d.id);
                await reload();
              }}
            />
          ))}
        </div>
      )}
      {showLinker && (
        <DefectLinkerModal
          productId={productId}
          onClose={() => setShowLinker(false)}
          onLinked={() => void reload()}
        />
      )}
    </div>
  );
}

// ════════════════════════ 复用小组件 ════════════════════════

function QuickAdd({
  value,
  setValue,
  onAdd,
  saving,
  placeholder,
  grade,
  setGrade,
}: {
  value: string;
  setValue: (v: string) => void;
  onAdd: () => void;
  saving: boolean;
  placeholder: string;
  grade?: ItemGrade;
  setGrade?: (g: ItemGrade) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onAdd();
        }}
        placeholder={placeholder}
        className="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40"
      />
      {grade && setGrade && (
        <div className="flex gap-1">
          {ITEM_GRADES.map((g) => (
            <button
              key={g}
              onClick={() => setGrade(g)}
              className={`px-2 py-1 rounded-md text-xs border transition-colors ${
                grade === g ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/40 border-white/10 hover:bg-white/5'
              }`}
            >
              {g.toUpperCase()}
            </button>
          ))}
        </div>
      )}
      <button
        onClick={onAdd}
        disabled={!value.trim() || saving}
        className="flex items-center gap-1 px-3 py-2 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-sm disabled:opacity-50"
      >
        {saving ? <MapSpinner size={14} /> : <Plus size={14} />} 新建
      </button>
    </div>
  );
}

function Row({
  title,
  sub,
  badge,
  onDelete,
  onClick,
  actionLabel,
}: {
  title: string;
  sub?: string;
  badge?: string;
  onDelete: () => void;
  onClick?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="group flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.04]">
      <button
        onClick={onClick}
        disabled={!onClick}
        className={`min-w-0 text-left flex-1 ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-white/90 truncate">{title}</span>
          {badge && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/60 shrink-0">{badge}</span>}
        </div>
        {sub && <div className="text-[11px] text-white/40 mt-0.5 truncate">{sub}</div>}
      </button>
      <div className="flex items-center gap-2 shrink-0">
        {onClick && actionLabel && (
          <span className="opacity-0 group-hover:opacity-100 text-[11px] text-cyan-300/70 transition-opacity">{actionLabel}</span>
        )}
        <button
          onClick={onDelete}
          className="opacity-0 group-hover:opacity-100 text-white/30 hover:text-red-300 transition-opacity"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="text-center text-white/40 text-xs py-10 px-6">{text}</div>;
}

/** 按分级（P0-P3）分列的看板 */
function GradeBoard({
  items,
  onCardClick,
  renderSub,
}: {
  items: Requirement[];
  onCardClick: (r: Requirement) => void;
  renderSub: (r: Requirement) => string;
}) {
  const cols: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];
  return (
    <div className="grid grid-cols-4 gap-3">
      {cols.map((g) => {
        const list = items.filter((i) => i.grade === g);
        return (
          <div key={g} className="rounded-lg border border-white/10 bg-white/[0.02] p-2 flex flex-col gap-2" style={{ minHeight: 140 }}>
            <div className="text-xs font-medium text-white/50 flex items-center justify-between px-0.5">
              <span>{ITEM_GRADE_LABEL[g]}</span>
              <span className="text-white/30">{list.length}</span>
            </div>
            {list.map((r) => (
              <button
                key={r.id}
                onClick={() => onCardClick(r)}
                className="text-left rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] px-2 py-1.5 transition-colors"
              >
                <div className="text-xs text-white/85 truncate">{r.title}</div>
                <div className="text-[10px] text-white/40 mt-0.5 truncate">{renderSub(r)}</div>
              </button>
            ))}
            {list.length === 0 && <div className="text-[10px] text-white/25 text-center py-2">空</div>}
          </div>
        );
      })}
    </div>
  );
}
