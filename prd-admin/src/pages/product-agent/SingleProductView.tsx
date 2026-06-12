/**
 * 产品管理智能体 — 单产品视图（IA 重构后）。
 *
 * 路由：/product-agent/p/:productId
 * 进入某个具体产品，查看该产品下的全部信息（工作台 / 版本(含升级申请) / 需求 / 功能 / 缺陷 / 客户 / 知识库 / 图谱）。
 * 工作台 = AI助手内嵌主区（70%）+ 右栏「我的待办 + 快捷操作」（30%）；统计图表都在「报表」tab。
 * 需求/功能 的「新建」走独立页面（/product-agent/p/:productId/:kind/new）；查看走详情页。
 * 升级申请并入「版本」tab；缺陷排在客户之前。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Plus, Trash2, GitBranch, ListChecks, Puzzle, UserCog, BookOpen, Share2, LayoutGrid, List, ArrowLeft, Bug, LayoutDashboard, Table2, BarChart3, Download, Upload } from 'lucide-react';
import { ProductAssistantPanel } from './ProductAssistantPanel';
import { QuickActionsCard } from './QuickActionsCard';
import { RequirementRtfImportDialog } from './RequirementRtfImportDialog';
import { requirementSourceLabel } from './requirementSource';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { ProductAgentLayout, SectionShell, type NavItem } from './ProductAgentLayout';
import { KnowledgeModule } from './knowledge/KnowledgeModule';
import { ProductGraphCanvas } from './ProductGraphCanvas';
import { KanbanBoard } from './KanbanBoard';
import { RtmMatrix } from './RtmMatrix';
import { ProductTeamTab } from './ProductTeamSection';
import { ReportsTab } from './ReportsTab';
import { BatchBar } from './BatchBar';
import { UpgradeRequestsTab } from './UpgradeRequestsTab';
import './product-cards.css';
import { VersionWorkflowTab } from './VersionWorkflowTab';
import {
  getProduct,
  listVersions,
  createVersion,
  deleteVersion,
  listRequirements,
  deleteRequirement,
  listFeatures,
  deleteFeature,
  listReleases,
  listInitiations,
  listTracedDefects,
  listCustomers,
  untraceDefect,
  transition,
  getMyTodos,
  type TracedDefect,
  type MyTodoItem,
} from '@/services/real/productAgent';
import { searchDirectoryUsers } from '@/services';
import { FEATURE_CHANGE_LABEL } from './ReleaseWorkflowDetail';
import type { Product, ProductVersion, Requirement, Feature, ItemGrade, WorkflowDefinition, Customer, ProductRelease } from './types';
import { ITEM_GRADE_LABEL, VERSION_LIFECYCLE_LABEL, defectStatusLabel, effectiveDefectGrade } from './types';
import { useListFilter, distinctOptions, distinctMultiOptions, TIME_PRESETS, inTimeRange, type FilterFieldDef } from './listFilter';
import { toCSV, downloadCSV } from '@/lib/csv';
import { useProductCategories, categoryLabel } from './productCategories';
import { useEffectiveWorkflow } from './DynamicForm';
import { normalizeRequirementStateKey, resolveRequirementStateLabel } from './requirementWorkflowUtils';
import { useAuthStore } from '@/stores/authStore';
import { WorkflowTransitionDialog } from './WorkflowTransitionDialog';
import {
  canExecuteWorkflowTransition,
  isGlobalProductAdmin,
  transitionNeedsDialog,
} from './workflowTransitionGuard';
import type { WorkflowTransition } from './types';

type Section = 'overview' | 'versions' | 'requirements' | 'features' | 'board' | 'rtm' | 'reports' | 'defects' | 'team' | 'knowledge' | 'graph';

/** 按 parentId 把扁平列表排成父子层级顺序（深度优先），返回每项 + 缩进深度。 */
function orderByHierarchy<T extends { id: string; parentId?: string | null }>(items: T[]): { item: T; depth: number }[] {
  const ids = new Set(items.map((i) => i.id));
  const byParent = new Map<string, T[]>();
  for (const it of items) {
    const pid = it.parentId && ids.has(it.parentId) ? it.parentId : '__root__';
    (byParent.get(pid) ?? byParent.set(pid, []).get(pid)!).push(it);
  }
  const out: { item: T; depth: number }[] = [];
  const walk = (pid: string, depth: number) => {
    for (const it of byParent.get(pid) ?? []) {
      out.push({ item: it, depth });
      walk(it.id, depth + 1);
    }
  };
  walk('__root__', 0);
  return out;
}

const SECTION_KEYS = new Set<Section>(['overview', 'versions', 'requirements', 'features', 'board', 'rtm', 'reports', 'defects', 'team', 'knowledge', 'graph']);

const NAV: NavItem<Section>[] = [
  { key: 'overview', label: '工作台', icon: LayoutDashboard },
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
  // 当前 tab 记录在 URL（?tab=），从对象详情页返回时能停在原 tab，而不是回弹到工作台。
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const active: Section = (tabParam && SECTION_KEYS.has(tabParam as Section)) ? (tabParam as Section) : 'overview';
  const setActive = (key: Section) => {
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
  }, [reload]);

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
    overview: '工作台', versions: '版本', requirements: '需求', features: '功能', board: '看板', rtm: '追溯矩阵', reports: '报表',
    defects: '缺陷', team: '团队', knowledge: '知识库', graph: '图谱',
  };

  return (
    <ProductAgentLayout
      title={product.name}
      subtitle={`${product.productNo} · ${categoryLabel(categories, product.grade)}`}
      topSlot={
        <div className="mb-2">
          <button onClick={() => navigate('/product-agent')} className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white">
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
          <div className="h-full min-h-0 min-w-0 flex flex-col border-r border-white/10" style={{ width: '70%' }}>
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
          {active === 'versions' && <VersionsTab productId={product.id} />}
          {active === 'requirements' && <RequirementsTab productId={product.id} />}
          {active === 'features' && <FeaturesTab productId={product.id} />}
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
        <h2 className="text-sm font-semibold text-white/80">需求看板</h2>
        <span className="text-[11px] text-white/35">拖拽卡片到目标列即可流转需求状态；功能状态请查看所属版本</span>
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
    <div className="min-h-0 flex flex-col rounded-xl border border-white/10 bg-white/[0.02] p-4" style={{ flexGrow: 7, flexBasis: 0 }}>
      <div className="shrink-0 flex items-center gap-2 mb-1">
        <ListChecks size={15} className="text-cyan-400" />
        <span className="text-sm font-semibold text-white/80">我的待办</span>
        <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">{total}</span>
      </div>
      <div className="shrink-0 text-[11px] text-white/40 mb-3">只显示当前需要我处理的需求 / 功能 / 缺陷，已处理或流转走的自动消失</div>
      {loading ? (
        <div className="flex-1 flex items-center justify-center"><MapSpinner size={18} /></div>
      ) : total === 0 ? (
        <div className="text-[12px] text-white/35 py-6 text-center">暂无待办，保持清爽。</div>
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
    <button onClick={onClick} className="pa-row shrink-0 text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-white/5">
      <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ color, background: `${color}1a` }}>{kind}</span>
      <span className="text-[11px] font-mono text-white/35 shrink-0">{no}</span>
      <span className="text-sm text-white/85 truncate flex-1">{title}</span>
      {state && <span className="text-[11px] px-1.5 py-0.5 rounded bg-white/8 text-white/55 border border-white/10 shrink-0">{state}</span>}
    </button>
  );
}

// ── 版本 tab（含大版本升级申请）──
function VersionsTab({ productId }: { productId: string }) {
  return <VersionWorkflowTab productId={productId} />;
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

      <div className="border-t border-white/10 pt-4">
        <div className="text-xs font-medium text-white/50 mb-2">大版本升级申请</div>
        <UpgradeRequestsTab productId={productId} />
      </div>
    </div>
  );
}

// 目录用户名解析（处理人/负责人显示名），仅需登录可用。
function useDirectoryNames() {
  const [map, setMap] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    void searchDirectoryUsers('', 200).then((res) => {
      if (res.success) setMap(new Map(res.data.items.map((u) => [u.userId, u.displayName || u.username])));
    });
  }, []);
  return useCallback((id?: string | null) => (id ? map.get(id) ?? id : '未指派'), [map]);
}

// ── 需求 tab（新建走独立页）──
function RequirementsTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'board'>('list');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rtfImportFiles, setRtfImportFiles] = useState<File[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const { workflow } = useEffectiveWorkflow('requirement', productId);
  const nameOf = useDirectoryNames();
  const openDetail = (id: string) => navigate(`/product-agent/p/${productId}/requirement/${id}`);
  const toggleSel = (id: string) => setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  useEffect(() => {
    void listVersions(productId).then((r) => { if (r.success) setVersions(r.data.items); });
    void listCustomers().then((r) => { if (r.success) setCustomers(r.data.items); });
  }, [productId]);

  const stateLabel = useCallback((key: string) => resolveRequirementStateLabel(key, workflow), [workflow]);
  const versionName = useMemo(() => new Map(versions.map((v) => [v.id, v.versionName])), [versions]);
  const customerName = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const fields = useMemo<FilterFieldDef<Requirement>[]>(() => [
    { key: 'grade', label: '等级', defaultVisible: true, options: () => (['p0', 'p1', 'p2', 'p3'] as const).map((g) => ({ value: g, label: ITEM_GRADE_LABEL[g] })), test: (r, v) => r.grade === v },
    { key: 'state', label: '状态', defaultVisible: true, options: (its) => distinctOptions(its, (r) => r.currentState ?? '', stateLabel), test: (r, v) => (r.currentState ?? '') === v },
    { key: 'assignee', label: '处理人', defaultVisible: true, options: (its) => distinctOptions(its, (r) => r.assigneeId ?? '', nameOf), test: (r, v) => (r.assigneeId ?? '') === v },
    { key: 'owner', label: '负责人', options: (its) => distinctOptions(its, (r) => r.ownerId ?? '', nameOf), test: (r, v) => (r.ownerId ?? '') === v },
    { key: 'source', label: '数据来源', options: (its) => distinctOptions(its, (r) => r.sourceSystem ?? '', requirementSourceLabel), test: (r, v) => (r.sourceSystem ?? '') === v },
    { key: 'version', label: '关联版本', options: (its) => distinctMultiOptions(its, (r) => r.versionIds, (id) => versionName.get(id) ?? id), test: (r, v) => r.versionIds.includes(v) },
    { key: 'customer', label: '关联客户', options: (its) => distinctMultiOptions(its, (r) => r.customerIds, (id) => customerName.get(id) ?? id), test: (r, v) => r.customerIds.includes(v) },
    { key: 'created', label: '创建时间', options: () => TIME_PRESETS, test: (r, v) => inTimeRange(r.createdAt, v) },
  ], [stateLabel, nameOf, versionName, customerName]);
  const { bar, filtered } = useListFilter({
    items,
    storageKey: 'pa-list-filters:requirement',
    fields,
    keywordOf: (r) => `${r.requirementNo} ${r.externalId ?? ''} ${r.title} ${r.description ?? ''} ${Object.values(r.sourceSnapshot?.fields ?? {}).join(' ')}`,
    keywordPlaceholder: '搜索编号、标题、描述',
  });

  const exportCsv = () => {
    const rows = items.map((r) => [r.requirementNo, r.externalId ?? '', r.title, ITEM_GRADE_LABEL[r.grade] ?? r.grade, stateLabel(r.currentState ?? ''), r.sourceSnapshot?.status ?? '', r.description ?? '']);
    downloadCSV(`需求-${productId}.csv`, toCSV(['编号', '需求ID', '标题', '分级', '状态', '描述'], rows));
  };

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
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <NewButton label="新建需求" onClick={() => navigate(`/product-agent/p/${productId}/requirement/new`)} />
        <div className="flex items-center gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept=".rtf,application/rtf,text/rtf"
            multiple
            className="hidden"
            onChange={(e) => {
              const rtfFiles = Array.from(e.target.files ?? []).filter((file) => file.name.toLowerCase().endsWith('.rtf'));
              if (rtfFiles.length > 0) setRtfImportFiles(rtfFiles);
              e.target.value = '';
            }}
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 text-xs"
          >
            <Upload size={13} /> 导入 RTF
          </button>
          <button onClick={exportCsv} disabled={items.length === 0} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-white/10 text-white/60 hover:text-white hover:bg-white/5 text-xs disabled:opacity-40">
            <Download size={13} /> 导出CSV
          </button>
          {items.length > 0 && <ViewToggle view={view} setView={setView} />}
        </div>
      </div>
      {items.length === 0 ? (
        <EmptyHint text="还没有需求。点「新建需求」打开独立页面填写，可分级并关联客户、版本、功能，被缺陷追溯。" />
      ) : (
        <>
        {bar}
        {filtered.length === 0 ? (
          <div className="text-center text-white/35 text-sm py-10">没有匹配的需求，调整筛选条件试试。</div>
        ) : view === 'board' && workflow && workflow.states.length > 0 ? (
        <StateBoard items={filtered} productId={productId} workflow={workflow} onCardClick={(r) => openDetail(r.id)} onChanged={reload} />
      ) : view === 'board' ? (
        <GradeBoard
          items={filtered}
          onCardClick={(r) => openDetail(r.id)}
          renderSub={(r) => `${r.requirementNo}${r.externalId ? ` · ${r.externalId}` : ''} · 客户 ${r.customerIds.length} · 版本 ${r.versionIds.length}`}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {selected.size > 0 && (
            <BatchBar entityType="requirement" ids={[...selected]} onDone={reload} onClear={() => setSelected(new Set())} />
          )}
          <RequirementDataTable
            items={filtered}
            selected={selected}
            toggleSelected={toggleSel}
            openDetail={openDetail}
            stateLabel={stateLabel}
            nameOf={nameOf}
            versionName={versionName}
            customerName={customerName}
            onDelete={async (id) => {
              await deleteRequirement(id);
              await reload();
            }}
          />
        </div>
      )}
        </>
      )}
      {rtfImportFiles.length > 0 && (
        <RequirementRtfImportDialog
          productId={productId}
          files={rtfImportFiles}
          onClose={() => setRtfImportFiles([])}
          onImported={reload}
        />
      )}
    </div>
  );
}

function RequirementDataTable({
  items,
  selected,
  toggleSelected,
  openDetail,
  stateLabel,
  nameOf,
  versionName,
  customerName,
  onDelete,
}: {
  items: Requirement[];
  selected: Set<string>;
  toggleSelected: (id: string) => void;
  openDetail: (id: string) => void;
  stateLabel: (key: string) => string;
  nameOf: (id?: string | null) => string;
  versionName: Map<string, string>;
  customerName: Map<string, string>;
  onDelete: (id: string) => Promise<void>;
}) {
  const sourceFields = useMemo(() => Array.from(new Set(items.flatMap((item) => Object.keys(item.sourceSnapshot?.fields ?? {}))))
    .filter((field) => field !== 'ID')
    .sort((left, right) => left.localeCompare(right, 'zh-CN')), [items]);
  const rows = orderByHierarchy(items);
  const cell = 'max-w-56 truncate px-3 py-2 text-xs text-white/60';

  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="min-w-max whitespace-nowrap text-left text-sm">
        <thead className="sticky top-0 z-10 bg-[#181a20] text-[11px] text-white/45">
          <tr>
            <th className="w-10 px-3 py-2 font-medium">选择</th>
            <th className="px-3 py-2 font-medium">MAP 编号</th>
            <th className="px-3 py-2 font-medium">需求 ID</th>
            <th className="min-w-72 px-3 py-2 font-medium">标题</th>
            <th className="px-3 py-2 font-medium">分级</th>
            <th className="px-3 py-2 font-medium">MAP 状态</th>
            <th className="px-3 py-2 font-medium">处理人</th>
            <th className="px-3 py-2 font-medium">负责人</th>
            <th className="px-3 py-2 font-medium">关联版本</th>
            <th className="px-3 py-2 font-medium">关联客户</th>
            {sourceFields.map((field) => <th key={field} className="px-3 py-2 font-medium">{field}</th>)}
            <th className="px-3 py-2 font-medium">创建时间</th>
            <th className="px-3 py-2 font-medium">更新时间</th>
            <th className="w-16 px-3 py-2 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, depth }) => (
            <tr key={item.id} onClick={() => openDetail(item.id)} className="cursor-pointer border-t border-white/5 hover:bg-white/[0.03]">
              <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} className="accent-cyan-500" /></td>
              <td className={cell}>{item.requirementNo}</td>
              <td className={cell}>{item.externalId || '-'}</td>
              <td className="max-w-96 px-3 py-2 text-white/85"><div className="truncate" style={{ paddingLeft: depth * 20 }}>{depth > 0 && <span className="mr-1 text-white/25">└</span>}{item.title}</div></td>
              <td className={cell}>{ITEM_GRADE_LABEL[item.grade]}</td>
              <td className={cell}>{stateLabel(item.currentState ?? '') || '-'}</td>
              <td className={cell}>{nameOf(item.assigneeId)}</td>
              <td className={cell}>{nameOf(item.ownerId)}</td>
              <td className={cell}>{item.versionIds.map((id) => versionName.get(id) ?? id).join('、') || '-'}</td>
              <td className={cell}>{item.customerIds.map((id) => customerName.get(id) ?? id).join('、') || '-'}</td>
              {sourceFields.map((field) => <td key={field} className={cell} title={item.sourceSnapshot?.fields?.[field]}>{item.sourceSnapshot?.fields?.[field] || '-'}</td>)}
              <td className={cell}>{new Date(item.createdAt).toLocaleString('zh-CN')}</td>
              <td className={cell}>{new Date(item.updatedAt).toLocaleString('zh-CN')}</td>
              <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}><button onClick={() => void onDelete(item.id)} className="text-white/30 hover:text-red-300" title="删除"><Trash2 size={14} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── 功能 tab（按正式版本号组织功能清单）──
const RELEASE_STATUS_LABEL: Record<string, string> = {
  announcement_pending: '待公告',
  released: '已上线',
};

function manifestChangeSummary(manifest: ProductRelease['featureManifest']) {
  const stats = { added: 0, modified: 0, deprecated: 0, unchanged: 0 };
  (manifest ?? []).forEach((m) => { stats[m.changeType] += 1; });
  const parts: string[] = [];
  if (stats.added) parts.push(`${FEATURE_CHANGE_LABEL.added} ${stats.added}`);
  if (stats.modified) parts.push(`${FEATURE_CHANGE_LABEL.modified} ${stats.modified}`);
  if (stats.deprecated) parts.push(`${FEATURE_CHANGE_LABEL.deprecated} ${stats.deprecated}`);
  if (stats.unchanged) parts.push(`${FEATURE_CHANGE_LABEL.unchanged} ${stats.unchanged}`);
  return parts.join(' · ') || '—';
}

function FeaturesTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [releases, setReleases] = useState<ProductRelease[]>([]);
  const [canApplyRelease, setCanApplyRelease] = useState(false);
  const [loading, setLoading] = useState(true);
  const nameOf = useDirectoryNames();

  const reload = useCallback(async () => {
    setLoading(true);
    const [relRes, initRes] = await Promise.all([
      listReleases(productId, 'all'),
      listInitiations(productId, 'mine'),
    ]);
    if (relRes.success) setReleases(relRes.data.items);
    if (initRes.success) {
      setCanApplyRelease(initRes.data.items.some((i) => i.status === 'approved' && i.tCode));
    }
    setLoading(false);
  }, [productId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const fields = useMemo<FilterFieldDef<ProductRelease>[]>(() => [
    { key: 'status', label: '状态', defaultVisible: true, options: () => Object.entries(RELEASE_STATUS_LABEL).map(([value, label]) => ({ value, label })), test: (r, v) => r.status === v },
    { key: 'owner', label: '申领人', defaultVisible: true, options: (its) => distinctOptions(its, (r) => r.ownerId ?? '', nameOf), test: (r, v) => (r.ownerId ?? '') === v },
    { key: 'scale', label: '版本类别', options: () => [{ value: 'major', label: '大版本' }, { value: 'medium', label: '中版本' }, { value: 'minor', label: '小版本' }], test: (r, v) => r.versionType === v },
    { key: 'created', label: '创建时间', options: () => TIME_PRESETS, test: (r, v) => inTimeRange(r.createdAt, v) },
  ], [nameOf]);
  const { bar, filtered } = useListFilter({
    items: releases,
    storageKey: 'pa-list-filters:release-manifest',
    fields,
    keywordOf: (r) => `${r.vCode} ${r.tCode ?? ''} ${r.planName}`,
    keywordPlaceholder: '搜索版本号/方案名称',
  });

  if (loading) return <MapSectionLoader text="正在加载功能清单…" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <NewButton
          label="申领正式版本号"
          onClick={() => navigate(`/product-agent/p/${productId}/release/new`)}
          disabled={!canApplyRelease}
        />
        <button
          type="button"
          onClick={() => navigate(`/product-agent/p/${productId}/feature/new`)}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white/55 hover:bg-white/8"
        >
          新建功能条目
        </button>
      </div>
      {!canApplyRelease && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-white/40">
          需先完成内部版本立项并取得 T 号后，才能申领正式版本号并填写功能清单。
        </div>
      )}
      {releases.length === 0 ? (
        <EmptyHint text="还没有正式版本功能清单。每个正式版对应一份功能清单，新版本默认继承上一版并标注变更。" />
      ) : (
        <>
          {bar}
          {filtered.length === 0 ? (
            <div className="text-center text-white/35 text-sm py-10">没有匹配的版本，调整筛选条件试试。</div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((r) => (
                <Row
                  key={r.id}
                  title={r.vCode}
                  badge={RELEASE_STATUS_LABEL[r.status] ?? r.status}
                  sub={`${r.planName} · 功能 ${(r.featureManifest ?? []).length} 项 · ${manifestChangeSummary(r.featureManifest)}`}
                  onClick={() => navigate(`/product-agent/p/${productId}/release/${r.id}`)}
                  actionLabel="查看清单"
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── 缺陷 tab（产品级追溯缺陷一览）──
function DefectsTab({ productId }: { productId: string }) {
  const navigate = useNavigate();
  const [items, setItems] = useState<TracedDefect[]>([]);
  const [loading, setLoading] = useState(true);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [versions, setVersions] = useState<ProductVersion[]>([]);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await listTracedDefects(productId);
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
    { key: 'grade', label: '等级', defaultVisible: true, options: () => (['p0', 'p1', 'p2', 'p3'] as const).map((g) => ({ value: g, label: ITEM_GRADE_LABEL[g] })), test: (d, v) => effectiveDefectGrade(d) === v },
    { key: 'status', label: '状态', defaultVisible: true, options: (its) => distinctOptions(its, (d) => d.status, defectStatusLabel), test: (d, v) => d.status === v },
    { key: 'assignee', label: '处理人', defaultVisible: true, options: (its) => distinctOptions(its, (d) => d.assigneeId ?? '', (id) => personName.get(id) ?? id), test: (d, v) => (d.assigneeId ?? '') === v },
    { key: 'reporter', label: '上报人', options: (its) => distinctOptions(its, (d) => d.reporterId ?? '', (id) => personName.get(id) ?? id), test: (d, v) => (d.reporterId ?? '') === v },
    { key: 'feature', label: '关联功能', options: (its) => distinctOptions(its, (d) => d.tracedFeatureId ?? '', (id) => featureName.get(id) ?? id), test: (d, v) => (d.tracedFeatureId ?? '') === v },
    { key: 'version', label: '关联版本', options: (its) => distinctOptions(its, (d) => d.tracedVersionId ?? '', (id) => versionName.get(id) ?? id), test: (d, v) => (d.tracedVersionId ?? '') === v },
    { key: 'created', label: '提交时间', options: () => TIME_PRESETS, test: (d, v) => inTimeRange(d.createdAt, v) },
  ], [personName, featureName, versionName]);
  const { bar, filtered } = useListFilter({ items, storageKey: 'pa-list-filters:defect', fields, keywordOf: (d) => `${d.defectNo} ${d.title ?? ''} ${d.rawContent ?? ''}`, keywordPlaceholder: '搜索编号/标题/描述' });

  if (loading) return <MapSectionLoader text="正在加载缺陷…" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => navigate(`/product-agent/p/${productId}/defect/new`)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm"
        >
          <Plus size={15} /> 新建缺陷
        </button>
      </div>
      {items.length === 0 ? (
        <EmptyHint text="还没有缺陷。点上方「新建缺陷」创建本产品的第一个缺陷。" />
      ) : (
        <>
        {bar}
        {filtered.length === 0 ? (
          <div className="text-center text-white/35 text-sm py-10">没有匹配的缺陷，调整筛选条件试试。</div>
        ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((d) => (
            <Row
              key={d.id}
              title={d.title || '(无标题)'}
              badge={defectStatusLabel(d.status)}
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
      className="self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/25 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
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
    <div className="pa-row group flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-white/10 bg-white/[0.02]">
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
  productId,
  workflow,
  onCardClick,
  onChanged,
}: {
  items: Requirement[];
  productId: string;
  workflow: WorkflowDefinition;
  onCardClick: (r: Requirement) => void;
  onChanged: () => void;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overState, setOverState] = useState<string | null>(null);
  const [product, setProduct] = useState<Pick<Product, 'ownerId' | 'adminIds' | 'memberIds'> | null>(null);
  const [pendingTransition, setPendingTransition] = useState<{ item: Requirement; transition: WorkflowTransition } | null>(null);
  const currentUserId = useAuthStore((s) => s.user?.userId ?? '');
  const permissions = useAuthStore((s) => s.permissions);
  const isGlobalAdmin = isGlobalProductAdmin(permissions);
  const states = [...workflow.states].sort((a, b) => a.sortOrder - b.sortOrder);
  const initial = states.find((s) => s.isInitial)?.key ?? states[0]?.key;

  useEffect(() => {
    void getProduct(productId).then((res) => {
      if (res.success) setProduct({ ownerId: res.data.ownerId, adminIds: res.data.adminIds, memberIds: res.data.memberIds });
    });
  }, [productId]);

  const drop = async (toState: string) => {
    const r = items.find((x) => x.id === dragId);
    setDragId(null);
    setOverState(null);
    if (!r) return;
    const from = normalizeRequirementStateKey(r.currentState ?? initial, workflow);
    if (from === toState) return;
    const t = workflow.transitions.find((tr) => tr.toState === toState && (!tr.fromState || tr.fromState === from));
    if (!t) return;
    const entity = { ownerId: r.ownerId, assigneeId: r.assigneeId, title: r.title, grade: r.grade, versionIds: r.versionIds };
    if (product && currentUserId && !canExecuteWorkflowTransition(currentUserId, t, product, isGlobalAdmin, entity)) return;
    if (transitionNeedsDialog(t, entity)) {
      setPendingTransition({ item: r, transition: t });
      return;
    }
    const res = await transition({ entityType: 'requirement', entityId: r.id, transitionKey: t.key });
    if (res.success) onChanged();
  };

  return (
    <>
    <div className="flex gap-3 overflow-x-auto pb-2" style={{ overscrollBehavior: 'contain' }}>
      {states.map((s) => {
        const list = items.filter((r) => normalizeRequirementStateKey(r.currentState ?? initial, workflow) === s.key);
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
                className="pa-row cursor-grab active:cursor-grabbing rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5"
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
    {pendingTransition && (
      <WorkflowTransitionDialog
        open
        productId={productId}
        workflow={workflow}
        entityType="requirement"
        entityId={pendingTransition.item.id}
        transition={pendingTransition.transition}
        entity={{
          ownerId: pendingTransition.item.ownerId,
          assigneeId: pendingTransition.item.assigneeId,
          title: pendingTransition.item.title,
          grade: pendingTransition.item.grade,
          versionIds: pendingTransition.item.versionIds,
        }}
        onClose={() => setPendingTransition(null)}
        onDone={onChanged}
      />
    )}
    </>
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
                className="pa-row text-left rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5"
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
