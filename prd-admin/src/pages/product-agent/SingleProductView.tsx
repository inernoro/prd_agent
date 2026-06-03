/**
 * 产品管理智能体 — 单产品视图（IA 重构后）。
 *
 * 路由：/product-agent/p/:productId
 * 进入某个具体产品，查看该产品下的全部信息（概览 / 版本(含升级申请) / 需求 / 功能 / 缺陷 / 客户 / 知识库 / 图谱）。
 * 需求/功能 的「新建」走独立页面（/product-agent/p/:productId/:kind/new）；查看走详情页。
 * 升级申请并入「版本」tab；缺陷排在客户之前。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Boxes, Plus, Trash2, GitBranch, ListChecks, Puzzle, Users, BookOpen, Share2, LayoutGrid, List, ArrowLeft, Bug } from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { VersionRelationModal, ProductKnowledgePanel, DefectLinkerModal } from './ProductRelationModals';
import { ProductGraphCanvas } from './ProductGraphCanvas';
import { UpgradeRequestsTab } from './UpgradeRequestsTab';
import {
  getProduct,
  deleteProduct,
  listVersions,
  createVersion,
  deleteVersion,
  listRequirements,
  deleteRequirement,
  listFeatures,
  deleteFeature,
  listCustomers,
  createCustomer,
  deleteCustomer,
  listTracedDefects,
  untraceDefect,
  type TracedDefect,
} from '@/services/real/productAgent';
import type { Product, ProductVersion, Requirement, Feature, Customer, ItemGrade } from './types';
import { PRODUCT_GRADE_LABEL, ITEM_GRADE_LABEL, VERSION_LIFECYCLE_LABEL } from './types';

type DetailTab = 'overview' | 'versions' | 'requirements' | 'features' | 'defects' | 'customers' | 'knowledge' | 'graph';

const TABS: { key: DetailTab; label: string; icon: typeof GitBranch }[] = [
  { key: 'overview', label: '概览', icon: Boxes },
  { key: 'versions', label: '版本', icon: GitBranch },
  { key: 'requirements', label: '需求', icon: ListChecks },
  { key: 'features', label: '功能', icon: Puzzle },
  { key: 'defects', label: '缺陷', icon: Bug },
  { key: 'customers', label: '客户', icon: Users },
  { key: 'knowledge', label: '知识库', icon: BookOpen },
  { key: 'graph', label: '图谱', icon: Share2 },
];

export function SingleProductView() {
  const navigate = useNavigate();
  const { productId = '' } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<DetailTab>('overview');

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getProduct(productId);
    if (res.success) setProduct(res.data);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onDelete = async () => {
    const res = await deleteProduct(productId);
    if (res.success) navigate('/product-agent');
  };

  return (
    <div className="h-screen min-h-0 flex flex-col p-4 bg-[#0f1014]">
      <div className="shrink-0 flex items-center justify-between mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate('/product-agent')}
            className="flex items-center justify-center w-9 h-9 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 shrink-0"
            title="返回产品列表"
          >
            <ArrowLeft size={18} />
          </button>
          {product && (
            <div className="min-w-0">
              <div className="text-white font-medium truncate flex items-center gap-2">
                <Boxes size={18} className="text-cyan-400 shrink-0" />
                {product.name}
              </div>
              <div className="text-[11px] text-white/40 mt-0.5 truncate">
                {product.productNo} · {PRODUCT_GRADE_LABEL[product.grade]} · 版本 {product.versionCount} · 需求{' '}
                {product.requirementCount} · 功能 {product.featureCount} · 缺陷 {product.defectCount}
              </div>
            </div>
          )}
        </div>
        {product && (
          <button
            onClick={onDelete}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-300/70 hover:text-red-300 hover:bg-red-500/10 shrink-0"
          >
            <Trash2 size={13} /> 删除产品
          </button>
        )}
      </div>

      {loading ? (
        <MapSectionLoader text="正在加载产品…" />
      ) : !product ? (
        <div className="flex-1 flex items-center justify-center text-white/40 text-sm">产品不存在或无权访问</div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col rounded-xl border border-white/10 bg-white/[0.02]">
          <div className="flex gap-1 px-3 pt-2 shrink-0 flex-wrap">
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
              {tab === 'defects' && <DefectsTab productId={product.id} />}
              {tab === 'customers' && <CustomersTab productId={product.id} />}
            </div>
          )}
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

// ── 版本 tab（含大版本升级申请）──
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

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="text-xs font-medium text-white/50">版本</div>
        <QuickAdd value={name} setValue={setName} onAdd={add} saving={saving} placeholder="版本名，如 v2.0" />
        {loading ? (
          <MapSectionLoader text="正在加载版本…" />
        ) : items.length === 0 ? (
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
      </div>

      <div className="border-t border-white/10 pt-4">
        <div className="text-xs font-medium text-white/50 mb-2">大版本升级申请</div>
        <UpgradeRequestsTab productId={productId} />
      </div>

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

// ── 需求 tab（新建走独立页）──
function RequirementsTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'board'>('list');
  const openDetail = (id: string) => navigate(`/product-agent/p/${productId}/requirement/${id}`);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listRequirements(productId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <MapSectionLoader text="正在加载需求…" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <NewButton label="新建需求" onClick={() => navigate(`/product-agent/p/${productId}/requirement/new`)} />
        {items.length > 0 && (
          <div className="flex items-center gap-1">
            <ViewToggle view={view} setView={setView} />
          </div>
        )}
      </div>
      {items.length === 0 ? (
        <EmptyHint text="还没有需求。点「新建需求」打开独立页面填写，可分级并关联客户、版本、功能，被缺陷追溯。" />
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

// ── 功能 tab（新建走独立页）──
function FeaturesTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Feature[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listFeatures(productId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <MapSectionLoader text="正在加载功能…" />;
  return (
    <div className="flex flex-col gap-3">
      <NewButton label="新建功能" onClick={() => navigate(`/product-agent/p/${productId}/feature/new`)} />
      {items.length === 0 ? (
        <EmptyHint text="还没有功能。点「新建功能」打开独立页面填写。功能跨版本演进，可实现需求、被版本纳入（功能版本化）。" />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((f) => (
            <Row
              key={f.id}
              title={f.title}
              badge={ITEM_GRADE_LABEL[f.grade]}
              sub={`${f.featureNo} · 实现需求 ${f.requirementIds.length}`}
              onClick={() => navigate(`/product-agent/p/${productId}/feature/${f.id}`)}
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
              onClick={() => navigate(`/product-agent/p/${productId}/defect/${d.id}`)}
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
        <DefectLinkerModal productId={productId} onClose={() => setShowLinker(false)} onLinked={() => void reload()} />
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

// ════════════════════════ 复用小组件 ════════════════════════

function NewButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm"
    >
      <Plus size={15} /> {label}
    </button>
  );
}

function ViewToggle({ view, setView }: { view: 'list' | 'board'; setView: (v: 'list' | 'board') => void }) {
  return (
    <>
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
    </>
  );
}

function QuickAdd({
  value,
  setValue,
  onAdd,
  saving,
  placeholder,
}: {
  value: string;
  setValue: (v: string) => void;
  onAdd: () => void;
  saving: boolean;
  placeholder: string;
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
