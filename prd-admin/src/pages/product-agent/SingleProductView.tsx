/**
 * 产品管理智能体 — 单产品视图（IA 重构后）。
 *
 * 路由：/product-agent/p/:productId
 * 进入某个具体产品，查看该产品下的全部信息（工作台 / 版本(含升级申请) / 需求 / 功能 / 缺陷 / 客户 / 知识库 / 图谱）。
 * 工作台 = AI助手内嵌主区（70%）+ 右栏「我的待办 + 快捷操作」（30%）；统计图表都在「报表」tab。
 * 需求/功能 的「新建」走独立页面（/product-agent/p/:productId/:kind/new）；查看走详情页。
 * 升级申请并入「版本」tab；缺陷排在客户之前。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Trash2, GitBranch, ListChecks, Puzzle, UserCog, BookOpen, Share2, LayoutGrid, ArrowLeft, Bug, LayoutDashboard, Table2, BarChart3, LayoutTemplate } from 'lucide-react';
import { productListPath } from '@/lib/productListScope';
import { ProductAssistantPanel } from './ProductAssistantPanel';
import { QuickActionsCard } from './QuickActionsCard';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { formatListSectionTitle } from '@/lib/listSectionTitle';
import { ProductAgentLayout, SectionShell, type NavItem } from './ProductAgentLayout';
import { KnowledgeModule } from './knowledge/KnowledgeModule';
import { ProductBlueprintTab } from './ProductBlueprintTab';
import { ProductGraphCanvas } from './ProductGraphCanvas';
import { KanbanBoard } from './KanbanBoard';
import { RtmMatrix } from './RtmMatrix';
import { ProductTeamTab } from './ProductTeamSection';
import { ReportsTab } from './ReportsTab';
import {
  SelectionActionBar,
  SelectableRow,
  useOverviewTableSelection,
} from './selectableList';
import { UpgradeRequestsTab } from './UpgradeRequestsTab';
import './product-cards.css';
import { FeatureCatalogTab } from './FeatureCatalogTab';
import {
  getProduct,
  getOverviewStats,
  listVersions,
  createVersion,
  deleteVersion,
  listFeatures,
  listTracedDefects,
  untraceDefect,
  getMyTodos,
  type TracedDefect,
  type MyTodoItem,
} from '@/services/real/productAgent';
import type { Product, ProductVersion, Feature } from './types';
import { ITEM_GRADE_LABEL, VERSION_LIFECYCLE_LABEL, defectStatusLabel, readDefectPriorityGrade, readDefectSeverityLevel } from './types';
import { useListFilter, distinctOptions, TIME_PRESETS, inTimeRange, OVERVIEW_LIST_SEARCH_BOX, type FilterFieldDef } from './listFilter';
import { useProductCategories, categoryLabel } from './productCategories';
import { TrackedFilterToggle } from './TrackedFilterToggle';
import { filterByTracked } from './productRecordTrackStorage';

type Section = 'overview' | 'blueprint' | 'versions' | 'requirements' | 'features' | 'board' | 'rtm' | 'reports' | 'defects' | 'team' | 'knowledge' | 'graph';


const SECTION_KEYS = new Set<Section>(['overview', 'blueprint', 'versions', 'requirements', 'features', 'board', 'rtm', 'reports', 'defects', 'team', 'knowledge', 'graph']);

const NAV: NavItem<Section>[] = [
  { key: 'overview', label: '工作台', icon: LayoutDashboard },
  { key: 'blueprint', label: '产品蓝图', icon: LayoutTemplate },
  { key: 'reports', label: '报表', icon: BarChart3 },
  { key: 'board', label: '看板', icon: LayoutGrid },
  { key: 'versions', label: '版本', icon: GitBranch },
  { key: 'requirements', label: '需求', icon: ListChecks },
  { key: 'rtm', label: '追溯矩阵', icon: Table2 },
  { key: 'features', label: '功能', icon: Puzzle },
  { key: 'defects', label: '缺陷', icon: Bug },
  { key: 'team', label: '团队', icon: UserCog },
  { key: 'knowledge', label: '知识库', icon: BookOpen },
  { key: 'graph', label: '图谱', icon: Share2 },
];

export function SingleProductView() {
  const navigate = useNavigate();
  const { productId = '' } = useParams();
  const { categories } = useProductCategories();
  const [product, setProduct] = useState<Product | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  // 当前 tab 记录在 URL（?tab=），从对象详情页返回时能停在原 tab，而不是回弹到工作台。
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const active: Section = (tabParam && SECTION_KEYS.has(tabParam as Section)) ? (tabParam as Section) : 'overview';
  const setActive = (key: Section) => {
    if (key === 'requirements' || key === 'versions') {
      navigate(productListPath(key, productId));
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', key);
      return next;
    }, { replace: true });
  };

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getProduct(productId);
    if (res.success) setProduct(res.data);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
    void getOverviewStats().then((res) => {
      if (res.success) setIsAdmin(res.data.isAdmin);
    });
  }, [reload]);

  if (loading) {
    return (
      <div className="h-screen min-h-0 flex items-center justify-center bg-token-card">
        <MapSectionLoader text="正在加载产品…" />
      </div>
    );
  }
  if (!product) {
    return (
      <div className="h-screen min-h-0 flex items-center justify-center bg-token-card text-token-muted text-sm">产品不存在或无权访问</div>
    );
  }

  const SECTION_TITLE: Record<Section, string> = {
    overview: '工作台', blueprint: '产品蓝图', versions: '版本', requirements: '需求', features: '功能', board: '看板', rtm: '追溯矩阵', reports: '报表',
    defects: '缺陷', team: '团队', knowledge: '知识库', graph: '图谱',
  };

  return (
    <ProductAgentLayout
      title={product.name}
      subtitle={`${product.productNo} · ${categoryLabel(categories, product.grade)}`}
      topSlot={
        <div className="mb-2">
          <button onClick={() => navigate('/product-agent')} className="flex items-center gap-1.5 text-[11px] text-token-muted hover-text-primary">
            <ArrowLeft size={13} /> 产品列表
          </button>
        </div>
      }
      items={NAV}
      active={active}
      onSelect={setActive}
    >
      {active === 'overview' ? (
        // 工作台：AI助手主区（70%）+ 右栏待办/快捷操作（30%），撑满高度各自滚动
        <div className="flex-1 min-h-0 flex">
          <div className="h-full min-h-0 min-w-0 flex flex-col border-r border-token-subtle" style={{ width: '70%' }}>
            <ProductAssistantPanel productId={product.id} productName={product.name} />
          </div>
          <aside className="h-full min-h-0 min-w-0 flex flex-col gap-4 p-4" style={{ width: '30%' }}>
            <MyTodos product={product} />
            <QuickActionsCard productId={product.id} gotoTab={(t) => setActive(t as Section)} />
          </aside>
        </div>
      ) : active === 'knowledge' ? (
        <div className="flex-1 min-h-0">
          <KnowledgeModule productId={product.id} />
        </div>
      ) : active === 'graph' ? (
        <div className="flex-1 min-h-0">
          <ProductGraphCanvas productId={product.id} />
        </div>
      ) : active === 'blueprint' ? (
        <div className="flex-1 min-h-0">
          <ProductBlueprintTab productId={product.id} isAdmin={isAdmin} />
        </div>
      ) : active === 'features' ? (
        <div className="flex h-full min-h-0 flex-1 flex-col">
          <FeatureCatalogTab productId={product.id} showImport={isAdmin} />
        </div>
      ) : active === 'requirements' ? (
        <Navigate to={productListPath('requirements', product.id)} replace />
      ) : active === 'board' ? (
        <div className="flex-1 min-h-0 p-4">
          <BoardTab productId={product.id} />
        </div>
      ) : active === 'rtm' ? (
        <div className="flex-1 min-h-0 p-4">
          <RtmMatrix productId={product.id} />
        </div>
      ) : (
        <SectionShell title={SECTION_TITLE[active]}>
          {active === 'versions' && <Navigate to={productListPath('versions', product.id, searchParams)} replace />}
          {active === 'reports' && <ReportsTab productId={product.id} />}
          {active === 'defects' && <DefectsTab productId={product.id} />}
          {active === 'team' && <ProductTeamTab productId={product.id} />}
        </SectionShell>
      )}
    </ProductAgentLayout>
  );
}

// ── 看板（需求按状态分列拖拽流转；功能无独立流转，跟随所属版本）──
function BoardTab({ productId }: { productId: string }) {
  return (
    <div className="h-full min-h-0 flex flex-col gap-3">
      <div className="shrink-0 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-token-primary">需求看板</h2>
        <span className="text-[11px] text-token-muted-faint">拖拽卡片到目标列即可流转需求状态；功能状态请查看所属版本</span>
      </div>
      <div className="flex-1 min-h-0">
        <KanbanBoard productId={productId} entityType="requirement" />
      </div>
    </div>
  );
}

// ── 工作台「我的待办」：只显示当前用户现在需要处理的项 ──
// 过滤口径由后端 GET /products/{id}/my-todos 闭环（状态责任人 + 未到终态/未完成）；
// 需求/功能流转给他人或到终态、缺陷已完成后，会自动从这里消失。
const TODO_KIND_META: Record<MyTodoItem['kind'], { label: string; color: string }> = {
  requirement: { label: '需求', color: '#FBBF24' },
  feature: { label: '功能', color: '#A78BFA' },
  defect: { label: '缺陷', color: '#F87171' },
};

function MyTodos({ product }: { product: Product }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<MyTodoItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getMyTodos(product.id);
      if (!alive) return;
      if (res.success) setItems(res.data.items);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [product.id]);

  const total = items.length;
  // 状态标签：缺陷用前端 SSOT 映射，需求/功能用后端已解析的工作流状态名
  const stateOf = (it: MyTodoItem) => (it.kind === 'defect' ? defectStatusLabel(it.state) : it.stateLabel || undefined);

  // 工作台右栏窄卡片：与快捷操作按 7:3 分高（flexGrow），列表内部滚动
  return (
    <div className="min-h-0 flex flex-col rounded-xl border border-token-subtle bg-token-nested p-4" style={{ flexGrow: 7, flexBasis: 0 }}>
      <div className="shrink-0 flex items-center gap-2 mb-1">
        <ListChecks size={15} className="text-cyan-400" />
        <span className="text-sm font-semibold text-token-primary">我的待办</span>
        <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-cyan-500/15 text-[color:var(--accent-fg-blue)] border border-cyan-500/30">{total}</span>
      </div>
      <div className="shrink-0 text-[11px] text-token-muted mb-3">只显示当前需要我处理的需求 / 功能 / 缺陷，已处理或流转走的自动消失</div>
      {loading ? (
        <div className="flex-1 flex items-center justify-center"><MapSpinner size={18} /></div>
      ) : total === 0 ? (
        <div className="text-[12px] text-token-muted-faint py-6 text-center">暂无待办，保持清爽。</div>
      ) : (
        <div className="flex-1 flex flex-col gap-1.5" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {items.map((it) => (
            <TodoRow key={`${it.kind}-${it.id}`} kind={TODO_KIND_META[it.kind].label} color={TODO_KIND_META[it.kind].color}
              no={it.no} title={it.title || '(无标题)'} state={stateOf(it)}
              onClick={() => navigate(`/product-agent/p/${product.id}/${it.kind}/${it.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TodoRow({ kind, color, no, title, state, onClick }: { kind: string; color: string; no: string; title: string; state?: string | null; onClick: () => void }) {
  return (
    <button onClick={onClick} className="pa-row shrink-0 text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-token-subtle">
      <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ color, background: `${color}1a` }}>{kind}</span>
      <span className="text-[11px] font-mono text-token-muted-faint shrink-0">{no}</span>
      <span className="text-sm text-token-primary truncate flex-1">{title}</span>
      {state && <span className="text-[11px] px-1.5 py-0.5 rounded bg-token-nested text-token-secondary border border-token-subtle shrink-0">{state}</span>}
    </button>
  );
}


export function LegacyVersionsTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<ProductVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

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
        <div className="text-xs font-medium text-token-secondary">版本</div>
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
                onClick={() => navigate(`/product-agent/p/${productId}/version/${v.id}`)}
                actionLabel="查看版本详情"
                onDelete={async () => {
                  await deleteVersion(v.id);
                  await reload();
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-token-subtle pt-4">
        <div className="text-xs font-medium text-token-secondary mb-2">大版本升级申请</div>
        <UpgradeRequestsTab productId={productId} />
      </div>
    </div>
  );
}


// ── 缺陷 tab（产品级追溯缺陷一览）──
function DefectsTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<TracedDefect[]>([]);
  const [loading, setLoading] = useState(true);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listTracedDefects(productId, { mine: true });
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    void listFeatures(productId).then((r) => { if (r.success) setFeatures(r.data.items); });
    void listVersions(productId).then((r) => { if (r.success) setVersions(r.data.items); });
  }, [productId]);

  const featureName = useMemo(() => new Map(features.map((f) => [f.id, f.title])), [features]);
  const versionName = useMemo(() => new Map(versions.map((v) => [v.id, v.versionName])), [versions]);
  const personName = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of items) {
      if (d.assigneeId) m.set(d.assigneeId, d.assigneeName || d.assigneeId);
      if (d.reporterId) m.set(d.reporterId, d.reporterName || d.reporterId);
    }
    return m;
  }, [items]);
  const fields = useMemo<FilterFieldDef<TracedDefect>[]>(() => [
    { key: 'severity', label: '严重程度', defaultVisible: true, options: () => (['致命', '严重', '一般', '轻微'] as const).map((label) => ({ value: label, label })), test: (d, v) => readDefectSeverityLevel(d) === v },
    { key: 'priority', label: '优先级', defaultVisible: true, options: () => (['p0', 'p1', 'p2', 'p3'] as const).map((g) => ({ value: g, label: ITEM_GRADE_LABEL[g] })), test: (d, v) => readDefectPriorityGrade(d) === v },
    { key: 'status', label: '状态', defaultVisible: true, options: (its) => distinctOptions(its, (d) => d.status, defectStatusLabel), test: (d, v) => d.status === v },
    { key: 'assignee', label: '处理人', defaultVisible: true, options: (its) => distinctOptions(its, (d) => d.assigneeId ?? '', (id) => personName.get(id) ?? id), test: (d, v) => (d.assigneeId ?? '') === v },
    { key: 'reporter', label: '上报人', options: (its) => distinctOptions(its, (d) => d.reporterId ?? '', (id) => personName.get(id) ?? id), test: (d, v) => (d.reporterId ?? '') === v },
    { key: 'feature', label: '关联功能', options: (its) => distinctOptions(its, (d) => d.tracedFeatureId ?? '', (id) => featureName.get(id) ?? id), test: (d, v) => (d.tracedFeatureId ?? '') === v },
    { key: 'version', label: '关联版本', options: (its) => distinctOptions(its, (d) => d.tracedVersionId ?? '', (id) => versionName.get(id) ?? id), test: (d, v) => (d.tracedVersionId ?? '') === v },
    { key: 'created', label: '提交时间', options: () => TIME_PRESETS, test: (d, v) => inTimeRange(d.createdAt, v) },
  ], [personName, featureName, versionName]);
  const { bar, filtered: filterBarFiltered } = useListFilter({
    items,
    storageKey: 'pa-list-filters:defect',
    fields,
    keywordOf: (d) => `${d.defectNo} ${d.title ?? ''} ${d.rawContent ?? ''}`,
    keywordPlaceholder: '搜索 ID、标题、描述',
    searchBoxClassName: OVERVIEW_LIST_SEARCH_BOX,
    trailing: <TrackedFilterToggle active={trackedOnly} onChange={setTrackedOnly} />,
  });
  const filtered = useMemo(
    () => filterByTracked(filterBarFiltered, trackedOnly, 'defect', (d) => ({ productId, recordId: d.id })),
    [filterBarFiltered, trackedOnly, productId],
  );

  const { selection, exportSelected } = useOverviewTableSelection(filtered, {
    filename: `defects-${productId}.csv`,
    headers: ['ID', '标题', '状态', '严重程度'],
    mapRow: (d) => [d.defectNo, d.title ?? '', defectStatusLabel(d.status), readDefectSeverityLevel(d) ?? ''],
  });

  if (loading) return <MapSectionLoader text="正在加载缺陷…" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate(`/product-agent/p/${productId}/defect/new`)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-[color:var(--accent-fg-blue)] border border-cyan-500/30 hover:bg-cyan-500/25 text-sm"
        >
          <Plus size={15} /> 新建缺陷
        </button>
      </div>
      <p className="text-xs text-token-muted-faint">仅显示你作为处理人或上报人的缺陷。</p>
      {items.length === 0 ? (
        <EmptyHint text="没有与你相关的缺陷。你是处理人或上报人的缺陷会出现在这里；点「新建缺陷」可创建新条目。" />
      ) : (
        <>
        <div className="flex w-full min-w-0 items-center gap-2 flex-wrap">
          <div className="flex min-w-0 flex-1 items-center gap-2 flex-wrap">{bar}</div>
        </div>
        <SelectionActionBar mode="entity" entityType="defect" selection={selection} onDone={reload} onExport={exportSelected} />
        {filtered.length === 0 ? (
          <div className="text-center text-token-muted-faint text-sm py-10">
            {trackedOnly ? '还没有追踪的缺陷。打开详情页标题右侧星标即可追踪。' : '没有匹配的缺陷，调整筛选条件试试。'}
          </div>
        ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 px-3 py-2 text-[11px] font-medium text-token-muted border-b border-token-subtle">
            <span className="w-24 shrink-0">ID</span>
            <span className="min-w-0 flex-1">{formatListSectionTitle('标题', filtered.length)}</span>
            <span className="w-16 shrink-0 text-right">状态</span>
          </div>
          {filtered.map((d) => (
            <SelectableRow
              key={d.id}
              id={d.id}
              selection={selection}
              onClick={() => navigate(`/product-agent/p/${productId}/defect/${d.id}`)}
              className="pa-row group flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-token-subtle bg-token-nested"
              trailing={
                <div className="flex items-center gap-2 shrink-0">
                  <span className="opacity-0 group-hover:opacity-100 text-[11px] text-cyan-300/70 transition-opacity">查看详情</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); void untraceDefect(d.id).then(reload); }}
                    className="opacity-0 group-hover:opacity-100 text-token-muted-faint hover:text-red-300 transition-opacity"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              }
            >
              <div className="min-w-0 text-left flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-token-primary truncate">{d.title || '(无标题)'}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-token-nested text-token-secondary shrink-0">{defectStatusLabel(d.status)}</span>
                </div>
                <div className="text-[11px] text-token-muted mt-0.5 truncate">
                  {`${d.defectNo}${d.tracedRequirementId ? ' · 已追溯到需求' : d.tracedVersionId ? ' · 已追溯到版本' : ' · 仅追溯到产品'}`}
                </div>
              </div>
            </SelectableRow>
          ))}
        </div>
        )}
        </>
      )}
    </div>
  );
}

// ════════════════════════ 复用小组件 ════════════════════════

function NewButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-[color:var(--accent-fg-blue)] border border-cyan-500/30 hover:bg-cyan-500/25 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <Plus size={15} /> {label}
    </button>
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
        className="flex-1 px-3 py-2 rounded-lg bg-token-nested border border-token-subtle text-sm text-token-primary outline-none focus:border-cyan-500/40"
      />
      <button
        onClick={onAdd}
        disabled={!value.trim() || saving}
        className="flex items-center gap-1 px-3 py-2 rounded-lg bg-cyan-500/15 text-[color:var(--accent-fg-blue)] border border-cyan-500/30 text-sm disabled:opacity-50"
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
  onDelete?: () => void;
  onClick?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="pa-row group flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-token-subtle bg-token-nested">
      <button
        onClick={onClick}
        disabled={!onClick}
        className={`min-w-0 text-left flex-1 ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-token-primary truncate">{title}</span>
          {badge && <span className="text-[10px] px-1.5 py-0.5 rounded bg-token-nested text-token-secondary shrink-0">{badge}</span>}
        </div>
        {sub && <div className="text-[11px] text-token-muted mt-0.5 truncate">{sub}</div>}
      </button>
      <div className="flex items-center gap-2 shrink-0">
        {onClick && actionLabel && (
          <span className="opacity-0 group-hover:opacity-100 text-[11px] text-cyan-300/70 transition-opacity">{actionLabel}</span>
        )}
        {onDelete && (
          <button
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100 text-token-muted-faint hover:text-red-300 transition-opacity"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="text-center text-token-muted text-xs py-10 px-6">{text}</div>;
}
