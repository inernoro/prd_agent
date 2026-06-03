/**
 * 产品管理智能体 — 单产品视图（IA 重构后）。
 *
 * 路由：/product-agent/p/:productId
 * 进入某个具体产品，查看该产品下的全部信息（概览 / 版本(含升级申请) / 需求 / 功能 / 缺陷 / 客户 / 知识库 / 图谱）。
 * 需求/功能 的「新建」走独立页面（/product-agent/p/:productId/:kind/new）；查看走详情页。
 * 升级申请并入「版本」tab；缺陷排在客户之前。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { EChartsOption } from 'echarts';
import { Plus, Trash2, GitBranch, ListChecks, Puzzle, Users, BookOpen, Share2, LayoutGrid, List, ArrowLeft, Bug, LayoutDashboard } from 'lucide-react';
import { EChart } from '@/components/charts/EChart';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { ProductAgentLayout, SectionShell, type NavItem } from './ProductAgentLayout';
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
  createProductDefect,
  transition,
  type TracedDefect,
} from '@/services/real/productAgent';
import type { Product, ProductVersion, Requirement, Feature, Customer, ItemGrade, WorkflowDefinition } from './types';
import { PRODUCT_GRADE_LABEL, ITEM_GRADE_LABEL, VERSION_LIFECYCLE_LABEL } from './types';
import { useEffectiveWorkflow } from './DynamicForm';

type Section = 'overview' | 'versions' | 'requirements' | 'features' | 'defects' | 'customers' | 'knowledge' | 'graph';

const CHART_COLORS = ['#22D3EE', '#FBBF24', '#A78BFA', '#4ADE80', '#F87171', '#60A5FA'];

const NAV: NavItem<Section>[] = [
  { key: 'overview', label: '概览', icon: LayoutDashboard },
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
  const [active, setActive] = useState<Section>('overview');

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

  if (loading) {
    return (
      <div className="h-screen min-h-0 flex items-center justify-center bg-[#0f1014]">
        <MapSectionLoader text="正在加载产品…" />
      </div>
    );
  }
  if (!product) {
    return (
      <div className="h-screen min-h-0 flex items-center justify-center bg-[#0f1014] text-white/40 text-sm">产品不存在或无权访问</div>
    );
  }

  const SECTION_TITLE: Record<Section, string> = {
    overview: '概览', versions: '版本（含升级申请）', requirements: '需求', features: '功能',
    defects: '缺陷', customers: '客户', knowledge: '知识库', graph: '图谱',
  };

  return (
    <ProductAgentLayout
      title={product.name}
      subtitle={`${product.productNo} · ${PRODUCT_GRADE_LABEL[product.grade]}`}
      topSlot={
        <div className="flex items-center justify-between mb-2">
          <button onClick={() => navigate('/product-agent')} className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white">
            <ArrowLeft size={13} /> 产品列表
          </button>
          <button onClick={onDelete} className="text-[11px] text-red-300/60 hover:text-red-300" title="删除产品">
            <Trash2 size={13} />
          </button>
        </div>
      }
      items={NAV}
      active={active}
      onSelect={setActive}
    >
      {active === 'knowledge' ? (
        <div className="flex-1 min-h-0">
          <ProductKnowledgePanel productId={product.id} />
        </div>
      ) : active === 'graph' ? (
        <div className="flex-1 min-h-0">
          <ProductGraphCanvas productId={product.id} />
        </div>
      ) : (
        <SectionShell title={SECTION_TITLE[active]}>
          {active === 'overview' && <ProductDashboard product={product} />}
          {active === 'versions' && <VersionsTab productId={product.id} />}
          {active === 'requirements' && <RequirementsTab productId={product.id} />}
          {active === 'features' && <FeaturesTab productId={product.id} />}
          {active === 'defects' && <DefectsTab productId={product.id} />}
          {active === 'customers' && <CustomersTab productId={product.id} />}
        </SectionShell>
      )}
    </ProductAgentLayout>
  );
}

// ── 产品概览仪表盘 ──
function ProductDashboard({ product }: { product: Product }) {
  const [reqs, setReqs] = useState<Requirement[]>([]);
  const [defects, setDefects] = useState<TracedDefect[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [r, d, v] = await Promise.all([
        listRequirements(product.id),
        listTracedDefects(product.id),
        listVersions(product.id),
      ]);
      if (!alive) return;
      if (r.success) setReqs(r.data.items);
      if (d.success) setDefects(d.data.items);
      if (v.success) setVersions(v.data.items);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [product.id]);

  const reqGradePie = useMemo<EChartsOption>(() => {
    const grades: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];
    const data = grades.map((g) => ({ name: ITEM_GRADE_LABEL[g], value: reqs.filter((r) => r.grade === g).length })).filter((x) => x.value > 0);
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 11 } },
      series: [{ type: 'pie', radius: ['40%', '68%'], center: ['50%', '44%'], data, label: { color: 'rgba(255,255,255,0.7)', fontSize: 11 }, itemStyle: { borderColor: '#0f1014', borderWidth: 2 } }],
      color: CHART_COLORS,
    };
  }, [reqs]);

  const defectStatusBar = useMemo<EChartsOption>(() => {
    const map = new Map<string, number>();
    defects.forEach((d) => map.set(d.status, (map.get(d.status) ?? 0) + 1));
    const entries = Array.from(map.entries());
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: entries.map(([k]) => k), axisLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: 'rgba(255,255,255,0.4)' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
      series: [{ type: 'bar', data: entries.map(([, v]) => v), itemStyle: { color: '#F87171', borderRadius: [4, 4, 0, 0] }, barMaxWidth: 32 }],
    };
  }, [defects]);

  const versionLifecycle = useMemo<EChartsOption>(() => {
    const data = ['planning', 'developing', 'testing', 'released', 'deprecated']
      .map((l) => ({ name: VERSION_LIFECYCLE_LABEL[l as keyof typeof VERSION_LIFECYCLE_LABEL], value: versions.filter((v) => v.lifecycle === l).length }))
      .filter((x) => x.value > 0);
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 11 } },
      series: [{ type: 'funnel', left: '10%', right: '10%', top: 10, bottom: 30, minSize: '14%', label: { color: 'rgba(255,255,255,0.7)', fontSize: 11 }, data }],
      color: CHART_COLORS,
    };
  }, [versions]);

  const kpis = [
    { label: '版本', value: product.versionCount, color: '#60A5FA' },
    { label: '需求', value: product.requirementCount, color: '#FBBF24' },
    { label: '功能', value: product.featureCount, color: '#A78BFA' },
    { label: '缺陷', value: product.defectCount, color: '#F87171' },
  ];

  return (
    <div className="flex flex-col gap-5">
      {product.description && <div className="text-sm text-white/60 max-w-3xl">{product.description}</div>}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="text-2xl font-semibold" style={{ color: k.color }}>{k.value}</div>
            <div className="text-xs text-white/50 mt-1">{k.label}</div>
          </div>
        ))}
      </div>
      {loading ? (
        <MapSectionLoader text="正在统计…" />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <DashChart title="需求分级分布" empty={reqs.length === 0} option={reqGradePie} />
          <DashChart title="缺陷状态分布" empty={defects.length === 0} option={defectStatusBar} />
          <DashChart title="版本生命周期" empty={versions.length === 0} option={versionLifecycle} />
        </div>
      )}
    </div>
  );
}

function DashChart({ title, option, empty }: { title: string; option: EChartsOption; empty: boolean }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="text-sm font-medium text-white/70 mb-2">{title}</div>
      {empty ? <div className="h-[240px] flex items-center justify-center text-xs text-white/35">暂无数据</div> : <EChart option={option} height={240} />}
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
  const { workflow } = useEffectiveWorkflow('requirement', productId);
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
      ) : view === 'board' && workflow && workflow.states.length > 0 ? (
        <StateBoard items={items} workflow={workflow} onCardClick={(r) => openDetail(r.id)} onChanged={reload} />
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
  const [creating, setCreating] = useState(false);

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
      <div className="flex items-center gap-2">
        <button
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm"
        >
          <Plus size={15} /> 新建缺陷
        </button>
        <button
          onClick={() => setShowLinker(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 text-sm"
        >
          关联已有缺陷
        </button>
      </div>
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
      {creating && (
        <NewDefectModal
          productId={productId}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function NewDefectModal({ productId, onClose, onCreated }: { productId: string; onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('');
  const [saving, setSaving] = useState(false);
  const create = async () => {
    if (!title.trim()) return;
    setSaving(true);
    const res = await createProductDefect(productId, { title: title.trim(), description: description.trim() || undefined, severity: severity || undefined });
    setSaving(false);
    if (res.success) onCreated();
  };
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[440px] rounded-xl border border-white/10 bg-[#16181d] p-5 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-white">新建缺陷</h2>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="缺陷标题" className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="复现步骤 / 描述" className="px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-cyan-500/40 resize-none" />
        <div className="flex items-center gap-2">
          <span className="text-xs text-white/50">严重度</span>
          {['blocker', 'critical', 'major', 'minor', 'trivial'].map((s) => (
            <button key={s} onClick={() => setSeverity(severity === s ? '' : s)} className={`px-2 py-1 rounded-md text-xs border ${severity === s ? 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40' : 'text-white/40 border-white/10 hover:bg-white/5'}`}>{s}</button>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-white/60 hover:bg-white/5">取消</button>
          <button onClick={create} disabled={!title.trim() || saving} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-sm disabled:opacity-50">
            {saving ? <MapSpinner size={14} /> : <Plus size={14} />} 创建
          </button>
        </div>
        <p className="text-[11px] text-white/35">缺陷写入缺陷管理智能体，并自动追溯到本产品。</p>
      </div>
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

/** 按工作流状态分列的看板，支持拖拽卡片改状态（走合法流转）。 */
function StateBoard({
  items,
  workflow,
  onCardClick,
  onChanged,
}: {
  items: Requirement[];
  workflow: WorkflowDefinition;
  onCardClick: (r: Requirement) => void;
  onChanged: () => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overState, setOverState] = useState<string | null>(null);
  const states = [...workflow.states].sort((a, b) => a.sortOrder - b.sortOrder);
  const initial = states.find((s) => s.isInitial)?.key ?? states[0]?.key;

  const drop = async (toState: string) => {
    const r = items.find((x) => x.id === dragId);
    setDragId(null);
    setOverState(null);
    if (!r) return;
    const from = r.currentState ?? initial;
    if (from === toState) return;
    const t = workflow.transitions.find((tr) => tr.toState === toState && (!tr.fromState || tr.fromState === from));
    if (!t) return; // 没有合法流转
    const res = await transition({ entityType: 'requirement', entityId: r.id, transitionKey: t.key, comment: t.requireComment ? '看板拖拽流转' : undefined });
    if (res.success) onChanged();
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-2" style={{ overscrollBehavior: 'contain' }}>
      {states.map((s) => {
        const list = items.filter((r) => (r.currentState ?? initial) === s.key);
        return (
          <div
            key={s.key}
            onDragOver={(e) => {
              e.preventDefault();
              setOverState(s.key);
            }}
            onDrop={() => void drop(s.key)}
            className={`w-56 shrink-0 rounded-lg border bg-white/[0.02] p-2 flex flex-col gap-2 ${overState === s.key ? 'border-cyan-500/50' : 'border-white/10'}`}
            style={{ minHeight: 160 }}
          >
            <div className="text-xs font-medium flex items-center justify-between px-0.5" style={{ color: s.color ?? '#e8e8ec' }}>
              <span>{s.label || s.key}</span>
              <span className="text-white/30">{list.length}</span>
            </div>
            {list.map((r) => (
              <div
                key={r.id}
                draggable
                onDragStart={() => setDragId(r.id)}
                onClick={() => onCardClick(r)}
                className="cursor-grab active:cursor-grabbing rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] px-1 py-0.5 rounded bg-white/10 text-white/60">{ITEM_GRADE_LABEL[r.grade]}</span>
                  <span className="text-xs text-white/85 truncate">{r.title}</span>
                </div>
                <div className="text-[10px] text-white/40 mt-0.5 truncate">{r.requirementNo}</div>
              </div>
            ))}
            {list.length === 0 && <div className="text-[10px] text-white/25 text-center py-2">拖到此列</div>}
          </div>
        );
      })}
    </div>
  );
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
