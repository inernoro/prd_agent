/**
 * 产品管理智能体 — 管理层总览 shell（默认着陆，公司层视角）。
 *
 * 路由：/product-agent
 * 左侧持久导航：概览 / 产品 / … / 图谱 / 应用 / 设置（后两项限 admin）。
 * 概览仪表盘：KPI 卡片 + ECharts 图表 + 最近活动流。需求/功能/缺陷为跨产品数据表。
 * 数据按可访问范围（admin 看全部），后端 /api/product/overview/*。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useProductListScope } from '@/lib/productListScope';
import type { EChartsOption } from 'echarts';
import {
  LayoutDashboard,
  Boxes,
  ListChecks,
  Puzzle,
  Bug,
  Users,
  BookOpen,
  Share2,
  Settings,
  Upload,
  Download,
  ArrowLeft,
  Plus,
  ClipboardCheck,
  ListOrdered,
} from 'lucide-react';
import { EChart } from '@/components/charts/EChart';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { ItemSearchSelect } from '@/components/ItemSearchSelect';
import { toProductOptions } from './comboboxOptions';
import { ProductAgentLayout, SectionShell, type NavItem } from './ProductAgentLayout';
import { ProductsSection } from './ProductsSection';
import { CustomerModule } from './CustomerModule';
import { ProductSettingsHub } from './ProductSettingsHub';
import { ProductGraphCanvas } from './ProductGraphCanvas';
import { OverviewKnowledgeList } from './knowledge/OverviewKnowledgeList';
import { ProductHistoryImportDialog } from './ProductHistoryImportDialog';
import { VersionWorkflowTab } from './VersionWorkflowTab';
import { FeatureCatalogTab } from './FeatureCatalogTab';
import { OverviewDataTable, TruncateCell } from './overviewDataTable';
import { SelectionActionBar, useOverviewTableSelection } from './selectableList';
import { downloadListCsv } from './listExport';
import './product-cards.css';
import {
  getOverviewStats,
  listProducts,
  getOverviewRequirements,
  getOverviewDefects,
  type OverviewStats,
  type OverviewRequirementRow,
  type OverviewDefectRow,
} from '@/services/real/productAgent';
import type { Product } from './types';
import { ITEM_GRADE_LABEL, VERSION_LIFECYCLE_LABEL, defectSeverityTierLabel, defectStatusLabel, readDefectPriorityGrade, readDefectSeverityLevel } from './types';
import { resolveRequirementStateLabel } from './requirementWorkflowUtils';
import { formatListSectionTitle } from '@/lib/listSectionTitle';
import { useListFilter, distinctOptions, OVERVIEW_LIST_SEARCH_BOX, type FilterFieldDef } from './listFilter';
import { TrackedFilterToggle } from './TrackedFilterToggle';
import { filterByTracked } from './productRecordTrackStorage';
import { useAuthStore } from '@/stores/authStore';
import { hasEffectivePermission } from '@/lib/permissionAccess';
import { ReviewAgentPage } from '@/pages/review-agent';

type Section = 'dashboard' | 'products' | 'requirements' | 'review' | 'features' | 'defects' | 'versions' | 'customers' | 'knowledge' | 'graph' | 'settings';

const SECTION_KEYS = new Set<Section>(['dashboard', 'products', 'requirements', 'review', 'features', 'defects', 'versions', 'customers', 'knowledge', 'graph', 'settings']);

function parseOverviewSection(value: string | null): Section {
  if (value && SECTION_KEYS.has(value as Section)) return value as Section;
  return 'dashboard';
}

const CHART_COLORS = ['#22D3EE', '#FBBF24', '#A78BFA', '#4ADE80', '#F87171', '#60A5FA'];

export function OverviewShell({ sectionOverride, children }: { sectionOverride?: Section; children?: ReactNode }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const permissions = useAuthStore((state) => state.permissions ?? []);
  const isRoot = useAuthStore((state) => state.isRoot);
  const canUseProduct = hasEffectivePermission(permissions, 'product-agent.use', isRoot);
  const canUseReview = hasEffectivePermission(permissions, 'review-agent.use', isRoot);
  // 与 SingleProductView 一致：分区由 URL ?section= 派生，避免 state 与地址栏不同步
  const active: Section = canUseProduct ? (sectionOverride ?? parseOverviewSection(searchParams.get('section'))) : 'versions';

  const selectSection = useCallback((section: Section) => {
    if (sectionOverride) {
      navigate(section === 'dashboard' ? '/product-agent' : `/product-agent?section=${section}`);
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (section === 'dashboard') next.delete('section');
      else next.set('section', section);
      return next;
    }, { replace: true });
  }, [navigate, sectionOverride, setSearchParams]);
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsError, setProductsError] = useState('');

  const loadProducts = useCallback(async () => {
    setProductsError('');
    const all: Product[] = [];
    for (let page = 1; ; page += 1) {
      const result = await listProducts({ page, pageSize: 100 });
      if (!result.success) {
        setProductsError('产品筛选选项未能完整加载，请重试。');
        return;
      }
      all.push(...result.data.items);
      if (all.length >= result.data.total || result.data.items.length === 0) break;
    }
    setProducts(all);
  }, []);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    const res = await getOverviewStats();
    if (res.success) setStats(res.data);
    setStatsLoading(false);
  }, []);

  useEffect(() => {
    if (canUseProduct) {
      void loadStats();
      void loadProducts();
    } else {
      setStatsLoading(false);
    }
  }, [canUseProduct, loadStats, loadProducts]);

  const isAdmin = stats?.isAdmin ?? false;

  const navItems: NavItem<Section>[] = canUseProduct ? [
    { key: 'dashboard', label: '概览', icon: LayoutDashboard },
    { key: 'products', label: '产品', icon: Boxes },
    { key: 'requirements', label: '需求', icon: ListChecks },
    { key: 'review', label: '评审', icon: ClipboardCheck, hidden: !canUseReview },
    { key: 'features', label: '功能', icon: Puzzle },
    { key: 'defects', label: '缺陷', icon: Bug },
    { key: 'versions', label: '版本', icon: Boxes },
    { key: 'customers', label: '客户', icon: Users },
    { key: 'knowledge', label: '知识库', icon: BookOpen },
    { key: 'graph', label: '图谱', icon: Share2 },
    { key: 'settings', label: '设置', icon: Settings, hidden: !isAdmin, dividerBefore: true },
  ] : [{ key: 'versions', label: '版本', icon: Boxes }];

  return (
    <ProductAgentLayout
      title={canUseProduct ? '产品管理' : '版本号申领'}
      subtitle={canUseProduct ? '全局总览' : '内部版本与正式版本'}
      topSlot={
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 text-[11px] text-token-muted hover-text-primary mb-2"
        >
          <ArrowLeft size={13} /> 返回首页
        </button>
      }
      items={navItems}
      active={active}
      onSelect={selectSection}
    >
      {children ? (
        <div className="h-full min-h-0 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>{children}</div>
      ) : (
      <>
      {active === 'dashboard' && (
        <SectionShell title="概览仪表盘" desc={isAdmin ? '全局视角，跨全部产品' : '全局视角，跨我参与的产品'}>
          <DashboardSection stats={stats} loading={statsLoading} onGoto={selectSection} />
        </SectionShell>
      )}
      {active === 'products' && (
        <SectionShell title="产品" desc="新增 / 修改 / 删除 / 筛选，点击进入单产品视图">
          <ProductsSection />
        </SectionShell>
      )}
      {active === 'requirements' && (
        <SectionShell title="需求" desc="全部产品的需求汇总；可按产品和处理人筛选，点击进入详情">
          <RequirementsTable isAdmin={isAdmin} products={products} canUseReview={canUseReview} productsError={productsError} onRetryProducts={() => void loadProducts()} />
        </SectionShell>
      )}
      {active === 'review' && (
        <div className="h-full min-h-0">
          {canUseReview ? <ReviewAgentPage /> : <div className="p-6 text-sm text-token-muted">暂无评审权限，请联系管理员。</div>}
        </div>
      )}
      {active === 'features' && (
        <div className="flex h-full min-h-0 flex-col">
          <div className="shrink-0 border-b border-token-subtle px-6 py-3">
            <h2 className="text-base font-semibold text-token-primary">功能</h2>
            <p className="mt-0.5 text-xs text-token-muted">按产品查看功能目录；功能清单归属正式版本。管理员可先选择产品与正式版本，再导入目录结构或新建功能。</p>
          </div>
          <div className="min-h-0 flex-1">
            <OverviewFeaturesPanel products={products} isAdmin={isAdmin} />
          </div>
        </div>
      )}
      {active === 'defects' && (
        <SectionShell title="缺陷" desc="全部产品追溯到产品的缺陷汇总，点击进入缺陷详情">
          <DefectsTable isAdmin={isAdmin} products={products} />
        </SectionShell>
      )}
      {active === 'versions' && (
        <SectionShell title="版本">
          <VersionWorkflowTab isAdmin={isAdmin} />
        </SectionShell>
      )}
      {active === 'customers' && (
        <SectionShell title="客户" desc="客户管理（列表 + 详情：基本信息 / 动态跟进）与营销问策两个子模块；需求可关联客户">
          <CustomerModule isAdmin={isAdmin} />
        </SectionShell>
      )}
      {active === 'knowledge' && (
        <SectionShell title="知识库" desc="所有可访问产品的知识聚合列表，点击查看详情；新建 / 治理进入具体产品">
          <KnowledgeSection />
        </SectionShell>
      )}
      {active === 'graph' && (
        <div className="h-full min-h-0 flex flex-col">
          <div className="shrink-0 px-6 py-3 border-b border-token-subtle">
            <h2 className="text-base font-semibold text-token-primary">图谱</h2>
            <p className="text-xs text-token-muted mt-0.5">跨全部产品的完整关系图（产品/版本/需求/功能/缺陷/客户 + 全部关系，点对象看详情、点产品可下钻）</p>
          </div>
          <div className="flex-1 min-h-0">
            <ProductGraphCanvas overview />
          </div>
        </div>
      )}
      {active === 'settings' && <ProductSettingsHub />}
      </>
      )}
    </ProductAgentLayout>
  );
}

// ════════════════════════ 概览仪表盘 ════════════════════════

function DashboardSection({ stats, loading, onGoto }: { stats: OverviewStats | null; loading: boolean; onGoto: (s: Section) => void }) {
  const navigate = useNavigate();
  const gradePie = useMemo<EChartsOption | null>(() => {
    if (!stats) return null;
    const data = Object.entries(stats.requirementsByGrade)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ name: ITEM_GRADE_LABEL[k as keyof typeof ITEM_GRADE_LABEL] ?? k, value: v }));
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: 'var(--text-secondary)', fontSize: 11 } },
      series: [{ type: 'pie', radius: ['40%', '68%'], center: ['50%', '44%'], data, label: { color: 'var(--text-secondary)', fontSize: 11 }, itemStyle: { borderColor: '#0f1014', borderWidth: 2 } }],
      color: CHART_COLORS,
    };
  }, [stats]);

  const defectBar = useMemo<EChartsOption | null>(() => {
    if (!stats) return null;
    const entries = Object.entries(stats.defectsByStatus);
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: entries.map(([k]) => k), axisLabel: { color: 'var(--text-secondary)', fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: 'var(--text-muted)' }, splitLine: { lineStyle: { color: 'var(--text-muted)' } } },
      series: [{ type: 'bar', data: entries.map(([, v]) => v), itemStyle: { color: '#F87171', borderRadius: [4, 4, 0, 0] }, barMaxWidth: 32 }],
    };
  }, [stats]);

  const lifecycleFunnel = useMemo<EChartsOption | null>(() => {
    if (!stats) return null;
    const data = Object.entries(stats.versionsByLifecycle)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ name: VERSION_LIFECYCLE_LABEL[k as keyof typeof VERSION_LIFECYCLE_LABEL] ?? k, value: v }));
    return {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: 'var(--text-secondary)', fontSize: 11 } },
      series: [{ type: 'funnel', left: '10%', right: '10%', top: 10, bottom: 30, minSize: '14%', label: { color: 'var(--text-secondary)', fontSize: 11 }, data }],
      color: CHART_COLORS,
    };
  }, [stats]);

  if (loading) return <MapSectionLoader text="正在加载仪表盘…" />;
  if (!stats) return <div className="text-token-muted text-sm text-center py-10">暂无数据</div>;

  const kpis: { label: string; value: number; color: string; section: Section }[] = [
    { label: '产品', value: stats.counts.products, color: '#22D3EE', section: 'products' },
    { label: '需求', value: stats.counts.requirements, color: '#FBBF24', section: 'requirements' },
    { label: '功能', value: stats.counts.features, color: '#A78BFA', section: 'features' },
    { label: '缺陷', value: stats.counts.defects, color: '#F87171', section: 'defects' },
            { label: '版本', value: stats.counts.versions, color: '#60A5FA', section: 'versions' },
    { label: '客户', value: stats.counts.customers, color: '#4ADE80', section: 'customers' },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* KPI */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map((k, i) => (
          <button
            key={k.label}
            onClick={() => onGoto(k.section)}
            style={{ animationDelay: `${Math.min(i, 14) * 45}ms` }}
            className="pa-card text-left rounded-xl border border-token-subtle bg-token-nested hover-bg-soft p-4"
          >
            <div className="text-2xl font-semibold" style={{ color: k.color }}>{k.value}</div>
            <div className="text-xs text-token-secondary mt-1">{k.label}</div>
          </button>
        ))}
      </div>

      {/* 图表 */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <ChartCard title="需求分级分布">{gradePie && <EChart option={gradePie} height={240} />}</ChartCard>
        <ChartCard title="缺陷状态分布">
          {Object.keys(stats.defectsByStatus).length > 0 && defectBar ? (
            <EChart option={defectBar} height={240} />
          ) : (
            <EmptyChart text="暂无追溯缺陷" />
          )}
        </ChartCard>
        <ChartCard title="版本生命周期">{lifecycleFunnel && <EChart option={lifecycleFunnel} height={240} />}</ChartCard>
      </div>

      {/* 最近活动 */}
      <div className="pa-row rounded-xl border border-token-subtle bg-token-nested p-4">
        <div className="text-sm font-medium text-token-secondary mb-3">最近活动</div>
        {stats.recent.length === 0 ? (
          <div className="text-xs text-token-muted py-4 text-center">暂无活动</div>
        ) : (
          <div className="flex flex-col gap-1">
            {stats.recent.map((r) => (
              <button
                key={`${r.type}:${r.id}`}
                onClick={() => {
                  if (r.type === 'requirement') navigate(`/product-agent/p/${r.productId}/requirement/${r.id}`);
                  else if (r.type === 'feature') navigate(`/product-agent/p/${r.productId}/feature/${r.id}`);
                  else navigate(`/product-agent/p/${r.productId}`);
                }}
                className="text-left flex items-center gap-3 px-2 py-1.5 rounded-lg hover-bg-soft"
              >
                <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'var(--nested-block-bg)', color: typeColor(r.type) }}>
                  {typeLabel(r.type)}
                </span>
                <span className="text-sm text-token-primary truncate flex-1">{r.title}</span>
                <span className="text-[11px] text-token-muted shrink-0">{r.productName}</span>
                <span className="text-[11px] text-token-muted shrink-0">{relTime(r.at)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pa-card rounded-xl border border-token-subtle bg-token-nested p-4">
      <div className="text-sm font-medium text-token-secondary mb-2">{title}</div>
      {children}
    </div>
  );
}
function EmptyChart({ text }: { text: string }) {
  return <div className="h-[240px] flex items-center justify-center text-xs text-token-muted">{text}</div>;
}

// ════════════════════════ 跨产品数据表 ════════════════════════


const GRADE_BADGE = (g: string) => (
  <span className="text-[10px] px-1.5 py-0.5 rounded bg-token-nested text-token-secondary">{ITEM_GRADE_LABEL[g as keyof typeof ITEM_GRADE_LABEL] ?? g}</span>
);
const SEVERITY_BADGE = (label: string) => (
  <span className="text-[10px] px-1.5 py-0.5 rounded bg-token-nested text-token-secondary">{label}</span>
);
function AdminImportButton({ onClick, label = '导入历史数据' }: { onClick: () => void; label?: string }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 rounded-md border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs text-[color:var(--accent-fg-blue)] hover:bg-cyan-500/20">
      <Upload size={13} /> {label}
    </button>
  );
}

function RequirementsTable({
  isAdmin,
  products,
  canUseReview,
  productsError,
  onRetryProducts,
}: {
  isAdmin: boolean;
  products: Product[];
  canUseReview: boolean;
  productsError: string;
  onRetryProducts: () => void;
}) {
  const navigate = useNavigate();
  const { productId, setProductId } = useProductListScope();
  const [rows, setRows] = useState<OverviewRequirementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);

  const productOptions = useMemo(() => {
    const options = new Map(toProductOptions(products).map((option) => [option.id, option]));
    rows.forEach((row) => {
      if (!options.has(row.productId)) options.set(row.productId, { id: row.productId, label: row.productName });
    });
    return [...options.values()];
  }, [products, rows]);
  const scopedRows = useMemo(() => rows.filter((row) => !productId || row.productId === productId), [rows, productId]);
  const fields = useMemo<FilterFieldDef<OverviewRequirementRow>[]>(() => [
    {
      key: 'grade',
      label: '分级',
      defaultVisible: true,
      options: () => (['p0', 'p1', 'p2', 'p3'] as const).map((g) => ({ value: g, label: ITEM_GRADE_LABEL[g] })),
      test: (r, v) => r.grade === v,
    },
    {
      key: 'assignee',
      label: '处理人',
      defaultVisible: true,
      options: (its) => distinctOptions(
        its,
        (r) => r.assigneeId ?? '',
        (id) => its.find((r) => r.assigneeId === id)?.assigneeName ?? id,
      ),
      test: (r, v) => (r.assigneeId ?? '') === v,
    },
    {
      key: 'state',
      label: '状态',
      defaultVisible: true,
      options: (its) => distinctOptions(
        its,
        (r) => r.currentState ?? '',
        (id) => {
          const hit = its.find((r) => (r.currentState ?? '') === id);
          return hit?.stateLabel ?? (resolveRequirementStateLabel(id) || id);
        },
      ),
      test: (r, v) => (r.currentState ?? '') === v,
    },
  ], []);

  const { bar, filtered: filterBarFiltered } = useListFilter({
    items: scopedRows,
    storageKey: 'pa-list-filters:overview-requirement',
    fields,
    keywordOf: (r) => `${r.requirementNo} ${r.title} ${r.productName}`,
    keywordPlaceholder: '搜索标题 / 编号',
    showFilterSettings: false,
    searchBoxClassName: OVERVIEW_LIST_SEARCH_BOX,
    trailing: <TrackedFilterToggle active={trackedOnly} onChange={setTrackedOnly} />,
  });
  const filtered = useMemo(
    () => filterByTracked(filterBarFiltered, trackedOnly, 'requirement', (r) => ({ productId: r.productId, recordId: r.id })),
    [filterBarFiltered, trackedOnly],
  );

  const reload = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError('');
    const res = await getOverviewRequirements();
    if (sequence !== requestSequence.current) return;
    if (res.success) setRows(res.data.items);
    else setError(res.error?.message ?? '需求加载失败，请重试。');
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
    return () => { requestSequence.current += 1; };
  }, [reload]);

  const { selection, exportSelected, tableSelection } = useOverviewTableSelection(filtered, {
    filename: 'overview-requirements.csv',
    headers: ['ID', '标题', '产品', '分级', '状态', '处理人'],
    mapRow: (r) => [
      r.requirementNo,
      r.title,
      r.productName,
      r.grade,
      r.stateLabel ?? resolveRequirementStateLabel(r.currentState) ?? '',
      r.assigneeName ?? '',
    ],
  });

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-2 flex-wrap">
        <div role="group" aria-label="按产品筛选需求" className="w-56">
          <ItemSearchSelect value={productId} onChange={setProductId} options={productOptions}
            placeholder="输入产品名称或编号搜索" clearOptionLabel="全部产品" uiSize="sm" countUnit="个产品" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 flex-wrap">{bar}</div>
        <div className="flex shrink-0 items-center gap-2">
          {canUseReview && (
            <button type="button" onClick={() => navigate('/product-agent/requirements/assessments')} className="flex items-center gap-1 rounded-md border border-token-subtle bg-token-nested px-2.5 py-1 text-xs text-token-primary hover-bg-soft">
              <ListOrdered size={13} />需求评估
            </button>
          )}
          <button type="button" disabled={!productId} title={productId ? '在所选产品中新建需求' : '请先选择需求所属产品'} onClick={() => navigate(`/product-agent/p/${productId}/requirement/new`)} className="inline-flex items-center gap-1 rounded-md border border-token-subtle bg-token-nested px-2.5 py-1 text-xs text-token-primary hover-bg-soft disabled:opacity-40"><Plus size={13} />新建需求</button>
          <button type="button" disabled={loading || Boolean(error) || filtered.length === 0} onClick={() => downloadListCsv('需求-筛选结果.csv', ['ID', '标题', '产品', '分级', '状态', '处理人'], filtered.map((row) => [row.requirementNo, row.title, row.productName, row.grade, row.stateLabel ?? resolveRequirementStateLabel(row.currentState) ?? '', row.assigneeName ?? '']))} className="inline-flex items-center gap-1 rounded-md border border-token-subtle bg-token-nested px-2.5 py-1 text-xs text-token-secondary hover-bg-soft disabled:opacity-40"><Download size={13} />导出需求</button>
          {isAdmin && <AdminImportButton onClick={() => setShowImport(true)} />}
        </div>
      </div>
      {(error || productsError) && <div role="alert" className="shrink-0 rounded-lg border border-token-subtle bg-token-nested p-3 text-sm text-token-secondary">{error || productsError}<button type="button" onClick={() => error ? void reload() : onRetryProducts()} className="ml-3 hover:underline">重试</button></div>}
      <div className="min-h-0 flex-1 overflow-auto" style={{ overscrollBehavior: 'contain' }}>
      {loading ? <MapSectionLoader text="正在加载需求…" /> : error ? null : <>
      <SelectionActionBar mode="entity" entityType="requirement" selection={selection} onDone={reload} onExport={exportSelected} />
      {filtered.length === 0 ? (
        <div className="text-center text-token-muted text-sm py-12">
          {trackedOnly ? '还没有追踪的需求。打开详情页标题右侧星标即可追踪。' : rows.length === 0 ? '没有需求' : '没有符合筛选条件的需求'}
        </div>
      ) : (
        <OverviewDataTable
          tableKey="requirements"
          rows={filtered}
          selection={tableSelection}
          onRowClick={(r) => navigate(`/product-agent/p/${r.productId}/requirement/${r.id}`)}
          columns={[
            { key: 'id', header: 'ID', defaultWidth: 88, render: (r) => <span className="text-token-muted text-xs font-mono">{r.requirementNo}</span> },
            { key: 'title', header: formatListSectionTitle('标题', filtered.length), defaultWidth: 360, render: (r) => <TruncateCell text={r.title} className="text-token-primary" /> },
            { key: 'product', header: '产品', defaultWidth: 112, render: (r) => <TruncateCell text={r.productName} maxChars={16} className="text-token-secondary text-xs" /> },
            { key: 'grade', header: '分级', defaultWidth: 72, resizable: false, render: (r) => GRADE_BADGE(r.grade) },
            { key: 'state', header: '状态', defaultWidth: 96, render: (r) => <TruncateCell text={(r.stateLabel ?? resolveRequirementStateLabel(r.currentState)) || '-'} maxChars={12} className="text-token-secondary text-xs" /> },
            { key: 'assignee', header: '处理人', defaultWidth: 96, render: (r) => <TruncateCell text={r.assigneeName || '-'} maxChars={10} className="text-token-secondary text-xs" /> },
            { key: 'versions', header: '版本', defaultWidth: 64, resizable: false, render: (r) => <span className="text-token-secondary text-xs">{r.versionCount}</span> },
            { key: 'customers', header: '客户', defaultWidth: 64, resizable: false, render: (r) => <span className="text-token-secondary text-xs">{r.customerCount}</span> },
            { key: 'updated', header: '更新', defaultWidth: 80, resizable: false, render: (r) => <span className="text-token-muted text-xs">{relTime(r.updatedAt)}</span> },
          ]}
        />
      )}
      </>}
      </div>
      {showImport && <ProductHistoryImportDialog type="requirement" products={productId ? products.filter((product) => product.id === productId) : products} crossProductRoute onClose={() => setShowImport(false)} onImported={reload} />}
    </div>
  );
}

/** 主页功能面板：先选产品，再复用单产品内的 FeatureCatalogTab（目录树 + 表格） */
function OverviewFeaturesPanel({
  products,
  isAdmin,
}: {
  products: Product[];
  isAdmin: boolean;
}) {
  const [productId, setProductId] = useState('');

  useEffect(() => {
    if (products.length === 0) {
      setProductId('');
      return;
    }
    setProductId((prev) => (prev && products.some((p) => p.id === prev) ? prev : products[0].id));
  }, [products]);

  if (products.length === 0) {
    return <div className="text-center text-token-muted text-sm py-12">还没有可查看的产品，请先在「产品」中创建。</div>;
  }

  if (!productId) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center text-sm text-token-muted">
        正在加载产品列表…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <FeatureCatalogTab
        productId={productId}
        productPicker={{ products, productId, onProductIdChange: setProductId }}
        showImport={isAdmin}
        showCreate
        showReleaseLink={false}
      />
    </div>
  );
}

function DefectsTable({ isAdmin, products }: { isAdmin: boolean; products: Product[] }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<OverviewDefectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [trackedOnly, setTrackedOnly] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const productNameMap = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const fields = useMemo<FilterFieldDef<OverviewDefectRow>[]>(() => [
    {
      key: 'severity',
      label: '严重程度',
      defaultVisible: true,
      options: () => (['致命', '严重', '一般', '轻微'] as const).map((label) => ({ value: label, label })),
      test: (r, v) => readDefectSeverityLevel(r) === v,
    },
    {
      key: 'priority',
      label: '优先级',
      defaultVisible: true,
      options: () => (['p0', 'p1', 'p2', 'p3'] as const).map((g) => ({ value: g, label: ITEM_GRADE_LABEL[g] })),
      test: (r, v) => readDefectPriorityGrade(r) === v,
    },
    {
      key: 'product',
      label: '产品',
      defaultVisible: true,
      options: (its) => distinctOptions(
        its,
        (r) => r.productId,
        (id) => productNameMap.get(id) ?? its.find((r) => r.productId === id)?.productName ?? id,
      ),
      test: (r, v) => r.productId === v,
    },
    {
      key: 'assignee',
      label: '处理人',
      defaultVisible: true,
      options: (its) => distinctOptions(
        its,
        (r) => r.assigneeId ?? '',
        (id) => its.find((r) => r.assigneeId === id)?.assigneeName ?? id,
      ),
      test: (r, v) => (r.assigneeId ?? '') === v,
    },
    {
      key: 'status',
      label: '状态',
      defaultVisible: true,
      options: (its) => distinctOptions(its, (r) => r.status, defectStatusLabel),
      test: (r, v) => r.status === v,
    },
  ], [productNameMap]);

  const { bar, filtered: filterBarFiltered } = useListFilter({
    items: rows,
    storageKey: 'pa-list-filters:overview-defect',
    fields,
    keywordOf: (r) => `${r.defectNo} ${r.title ?? ''} ${r.productName}`,
    keywordPlaceholder: '搜索标题 / 编号',
    showFilterSettings: false,
    searchBoxClassName: OVERVIEW_LIST_SEARCH_BOX,
    trailing: <TrackedFilterToggle active={trackedOnly} onChange={setTrackedOnly} />,
  });
  const filtered = useMemo(
    () => filterByTracked(filterBarFiltered, trackedOnly, 'defect', (r) => ({ productId: r.productId, recordId: r.id })),
    [filterBarFiltered, trackedOnly],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getOverviewDefects();
    if (res.success) setRows(res.data.items);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const { selection, exportSelected, tableSelection } = useOverviewTableSelection(filtered, {
    filename: 'overview-defects.csv',
    headers: ['ID', '标题', '产品', '状态', '严重程度'],
    mapRow: (r) => [r.defectNo, r.title ?? '', r.productName, defectStatusLabel(r.status), defectSeverityTierLabel(r)],
  });

  if (loading) return <MapSectionLoader text="正在加载缺陷…" />;
  return (
    <div className="w-full min-w-0">
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 flex-wrap">{bar}</div>
        {isAdmin && <AdminImportButton onClick={() => setShowImport(true)} />}
      </div>
      <SelectionActionBar mode="entity" entityType="defect" selection={selection} onDone={reload} onExport={exportSelected} />
      {filtered.length === 0 ? (
        <div className="text-center text-token-muted text-sm py-12">
          {trackedOnly ? '还没有追踪的缺陷。打开详情页标题右侧星标即可追踪。' : rows.length === 0 ? '没有追溯到产品的缺陷' : '没有符合筛选条件的缺陷'}
        </div>
      ) : (
        <OverviewDataTable
          tableKey="defects"
          rows={filtered}
          selection={tableSelection}
          onRowClick={(r) => navigate(`/product-agent/p/${r.productId}/defect/${r.id}`)}
          columns={[
            { key: 'id', header: 'ID', defaultWidth: 88, render: (r) => <span className="text-token-muted text-xs font-mono">{r.defectNo}</span> },
            { key: 'title', header: formatListSectionTitle('标题', filtered.length), defaultWidth: 360, render: (r) => <TruncateCell text={r.title || '(无标题)'} className="text-token-primary" /> },
            { key: 'product', header: '产品', defaultWidth: 112, render: (r) => <TruncateCell text={r.productName} maxChars={16} className="text-token-secondary text-xs" /> },
            { key: 'status', header: '状态', defaultWidth: 88, render: (r) => <span className="text-[10px] px-1.5 py-0.5 rounded bg-token-nested text-token-secondary">{defectStatusLabel(r.status)}</span> },
            { key: 'severity', header: '严重程度', defaultWidth: 88, render: (r) => SEVERITY_BADGE(defectSeverityTierLabel(r)) },
            { key: 'trace', header: '追溯', defaultWidth: 72, resizable: false, render: (r) => <span className="text-token-secondary text-xs">{r.tracedRequirementId ? '需求' : r.tracedVersionId ? '版本' : '产品'}</span> },
            { key: 'updated', header: '更新', defaultWidth: 80, resizable: false, render: (r) => <span className="text-token-muted text-xs">{relTime(r.updatedAt)}</span> },
          ]}
        />
      )}
      {showImport && <ProductHistoryImportDialog type="defect" products={products} crossProductRoute onClose={() => setShowImport(false)} onImported={reload} />}
    </div>
  );
}


// ════════════════════════ 知识库 / 图谱 / 设置 ════════════════════════

function KnowledgeSection() {
  // 跨产品聚合知识列表（与单产品知识列表同构，多「所属产品」列；治理操作落到具体产品库）
  return <OverviewKnowledgeList />;
}

// ── 工具 ──
function typeLabel(t: string) {
  return t === 'requirement' ? '需求' : t === 'feature' ? '功能' : t === 'version' ? '版本' : t;
}
function typeColor(t: string) {
  return t === 'requirement' ? '#FBBF24' : t === 'feature' ? '#A78BFA' : t === 'version' ? '#60A5FA' : '#94A3B8';
}
function relTime(iso: string) {
  const d = new Date(iso).getTime();
  if (!d) return '';
  const diff = Date.now() - d;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const day = Math.floor(diff / 86400000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m}分钟前`;
  if (h < 24) return `${h}小时前`;
  if (day < 30) return `${day}天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}
