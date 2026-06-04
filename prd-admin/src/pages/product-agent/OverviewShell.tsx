/**
 * 产品管理智能体 — 管理层总览 shell（默认着陆，公司层视角）。
 *
 * 路由：/product-agent
 * 左侧持久导航：概览 / 产品 / 需求 / 功能 / 缺陷 / 知识库 / 图谱 / 设置(限 admin)。
 * 概览仪表盘：KPI 卡片 + ECharts 图表 + 最近活动流。需求/功能/缺陷为跨产品数据表。
 * 数据按可访问范围（admin 看全部），后端 /api/product/overview/*。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { EChartsOption } from 'echarts';
import {
  LayoutDashboard,
  Boxes,
  ListChecks,
  Puzzle,
  Bug,
  BookOpen,
  Share2,
  Settings,
  ArrowLeft,
  Search,
} from 'lucide-react';
import { EChart } from '@/components/charts/EChart';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { ProductAgentLayout, SectionShell, type NavItem } from './ProductAgentLayout';
import { GlobalSearch } from './GlobalSearch';
import { ProductsSection } from './ProductsSection';
import { SettingsSection } from './SettingsSection';
import { ProductGraphCanvas } from './ProductGraphCanvas';
import {
  getOverviewStats,
  getOverviewRequirements,
  getOverviewFeatures,
  getOverviewDefects,
  getOverviewKnowledge,
  type OverviewStats,
  type OverviewRequirementRow,
  type OverviewFeatureRow,
  type OverviewDefectRow,
  type OverviewKnowledgeRow,
} from '@/services/real/productAgent';
import { ITEM_GRADE_LABEL, VERSION_LIFECYCLE_LABEL } from './types';

type Section = 'dashboard' | 'products' | 'requirements' | 'features' | 'defects' | 'knowledge' | 'graph' | 'settings';

const CHART_COLORS = ['#22D3EE', '#FBBF24', '#A78BFA', '#4ADE80', '#F87171', '#60A5FA'];

export function OverviewShell() {
  const navigate = useNavigate();
  const [active, setActive] = useState<Section>('dashboard');
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    const res = await getOverviewStats();
    if (res.success) setStats(res.data);
    setStatsLoading(false);
  }, []);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const isAdmin = stats?.isAdmin ?? false;

  const navItems: NavItem<Section>[] = [
    { key: 'dashboard', label: '概览', icon: LayoutDashboard },
    { key: 'products', label: '产品', icon: Boxes },
    { key: 'requirements', label: '需求', icon: ListChecks },
    { key: 'features', label: '功能', icon: Puzzle },
    { key: 'defects', label: '缺陷', icon: Bug },
    { key: 'knowledge', label: '知识库', icon: BookOpen },
    { key: 'graph', label: '图谱', icon: Share2 },
    { key: 'settings', label: '设置', icon: Settings, hidden: !isAdmin, dividerBefore: true },
  ];

  return (
    <ProductAgentLayout
      title="产品管理"
      subtitle="全局总览"
      topSlot={
        <div className="flex flex-col gap-2 mb-2">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 text-[11px] text-white/40 hover:text-white"
          >
            <ArrowLeft size={13} /> 返回首页
          </button>
          <GlobalSearch />
        </div>
      }
      items={navItems}
      active={active}
      onSelect={setActive}
    >
      {active === 'dashboard' && (
        <SectionShell title="概览仪表盘" desc={isAdmin ? '全局视角，跨全部产品' : '全局视角，跨我参与的产品'}>
          <DashboardSection stats={stats} loading={statsLoading} onGoto={(s) => setActive(s)} />
        </SectionShell>
      )}
      {active === 'products' && (
        <SectionShell title="产品" desc="新增 / 修改 / 删除 / 筛选，点击进入单产品视图">
          <ProductsSection />
        </SectionShell>
      )}
      {active === 'requirements' && (
        <SectionShell title="需求（跨产品）" desc="所有产品的需求汇总，点击进入需求详情">
          <RequirementsTable />
        </SectionShell>
      )}
      {active === 'features' && (
        <SectionShell title="功能（跨产品）" desc="所有产品的功能汇总，点击进入功能详情">
          <FeaturesTable />
        </SectionShell>
      )}
      {active === 'defects' && (
        <SectionShell title="缺陷（跨产品）" desc="追溯到产品的缺陷汇总，点击进入缺陷详情">
          <DefectsTable />
        </SectionShell>
      )}
      {active === 'knowledge' && (
        <SectionShell title="知识库一览" desc="所有产品的知识库（含 MRD/SRS/PRD）">
          <KnowledgeSection />
        </SectionShell>
      )}
      {active === 'graph' && (
        <div className="h-full min-h-0 flex flex-col">
          <div className="shrink-0 px-6 py-3 border-b border-white/10">
            <h2 className="text-base font-semibold text-white">图谱</h2>
            <p className="text-xs text-white/40 mt-0.5">跨全部产品的完整关系图（产品/版本/需求/功能/缺陷/客户 + 全部关系，点对象看详情、点产品可下钻）</p>
          </div>
          <div className="flex-1 min-h-0">
            <ProductGraphCanvas overview />
          </div>
        </div>
      )}
      {active === 'settings' && (
        <SectionShell title="全局设置" desc="表单模板 + 流程模板，所有产品共用，可按产品覆盖（管理层）">
          <SettingsSection />
        </SectionShell>
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
      legend: { bottom: 0, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 11 } },
      series: [{ type: 'pie', radius: ['40%', '68%'], center: ['50%', '44%'], data, label: { color: 'rgba(255,255,255,0.7)', fontSize: 11 }, itemStyle: { borderColor: '#0f1014', borderWidth: 2 } }],
      color: CHART_COLORS,
    };
  }, [stats]);

  const defectBar = useMemo<EChartsOption | null>(() => {
    if (!stats) return null;
    const entries = Object.entries(stats.defectsByStatus);
    return {
      tooltip: { trigger: 'axis' },
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      xAxis: { type: 'category', data: entries.map(([k]) => k), axisLabel: { color: 'rgba(255,255,255,0.5)', fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: 'rgba(255,255,255,0.4)' }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } } },
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
      legend: { bottom: 0, textStyle: { color: 'rgba(255,255,255,0.5)', fontSize: 11 } },
      series: [{ type: 'funnel', left: '10%', right: '10%', top: 10, bottom: 30, minSize: '14%', label: { color: 'rgba(255,255,255,0.7)', fontSize: 11 }, data }],
      color: CHART_COLORS,
    };
  }, [stats]);

  if (loading) return <MapSectionLoader text="正在加载仪表盘…" />;
  if (!stats) return <div className="text-white/40 text-sm text-center py-10">暂无数据</div>;

  const kpis: { label: string; value: number; color: string; section: Section }[] = [
    { label: '产品', value: stats.counts.products, color: '#22D3EE', section: 'products' },
    { label: '需求', value: stats.counts.requirements, color: '#FBBF24', section: 'requirements' },
    { label: '功能', value: stats.counts.features, color: '#A78BFA', section: 'features' },
    { label: '缺陷', value: stats.counts.defects, color: '#F87171', section: 'defects' },
    { label: '版本', value: stats.counts.versions, color: '#60A5FA', section: 'products' },
    { label: '客户', value: stats.counts.customers, color: '#4ADE80', section: 'products' },
  ];

  return (
    <div className="flex flex-col gap-5">
      {/* KPI */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map((k) => (
          <button
            key={k.label}
            onClick={() => onGoto(k.section)}
            className="text-left rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] p-4 transition-colors"
          >
            <div className="text-2xl font-semibold" style={{ color: k.color }}>{k.value}</div>
            <div className="text-xs text-white/50 mt-1">{k.label}</div>
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
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="text-sm font-medium text-white/70 mb-3">最近活动</div>
        {stats.recent.length === 0 ? (
          <div className="text-xs text-white/40 py-4 text-center">暂无活动</div>
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
                className="text-left flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-white/5"
              >
                <span className="text-[10px] px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(255,255,255,0.06)', color: typeColor(r.type) }}>
                  {typeLabel(r.type)}
                </span>
                <span className="text-sm text-white/80 truncate flex-1">{r.title}</span>
                <span className="text-[11px] text-white/35 shrink-0">{r.productName}</span>
                <span className="text-[11px] text-white/30 shrink-0">{relTime(r.at)}</span>
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
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="text-sm font-medium text-white/70 mb-2">{title}</div>
      {children}
    </div>
  );
}
function EmptyChart({ text }: { text: string }) {
  return <div className="h-[240px] flex items-center justify-center text-xs text-white/35">{text}</div>;
}

// ════════════════════════ 跨产品数据表 ════════════════════════

interface Column<T> {
  header: string;
  render: (row: T) => React.ReactNode;
  className?: string;
}

function DataTable<T extends { id: string }>({
  columns,
  rows,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
}) {
  return (
    <div className="rounded-xl border border-white/10 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-white/[0.03] text-white/45 text-[11px]">
            {columns.map((c, i) => (
              <th key={i} className={`text-left font-medium px-3 py-2 ${c.className ?? ''}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => onRowClick?.(row)}
              className={`border-t border-white/5 ${onRowClick ? 'cursor-pointer hover:bg-white/[0.03]' : ''}`}
            >
              {columns.map((c, i) => (
                <td key={i} className={`px-3 py-2 text-white/80 ${c.className ?? ''}`}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableToolbar({
  keyword,
  setKeyword,
  filterLabel,
  filters,
  filterValue,
  setFilterValue,
  extra,
}: {
  keyword: string;
  setKeyword: (v: string) => void;
  filterLabel?: string;
  filters?: { value: string; label: string }[];
  filterValue?: string;
  setFilterValue?: (v: string) => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-3 flex-wrap">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/10">
        <Search size={14} className="text-white/40" />
        <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索标题 / 编号" className="bg-transparent text-sm text-white outline-none w-44" />
      </div>
      {filters && setFilterValue && (
        <>
          <button
            onClick={() => setFilterValue('')}
            className={`px-2.5 py-1 rounded-md text-xs border ${!filterValue ? 'bg-white/10 text-white border-white/20' : 'text-white/50 border-white/10 hover:bg-white/5'}`}
          >
            {filterLabel ?? '全部'}
          </button>
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilterValue(f.value)}
              className={`px-2.5 py-1 rounded-md text-xs border ${filterValue === f.value ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/40' : 'text-white/50 border-white/10 hover:bg-white/5'}`}
            >
              {f.label}
            </button>
          ))}
        </>
      )}
      {extra && <div className="ml-auto flex items-center gap-2">{extra}</div>}
    </div>
  );
}

/** 「我负责的」过滤开关。 */
function MineToggle({ mine, setMine }: { mine: boolean; setMine: (v: boolean) => void }) {
  return (
    <button
      onClick={() => setMine(!mine)}
      className={`px-2.5 py-1 rounded-md text-xs border ${mine ? 'bg-cyan-500/15 text-cyan-200 border-cyan-500/40' : 'text-white/50 border-white/10 hover:bg-white/5'}`}
    >
      我负责的
    </button>
  );
}

const GRADE_BADGE = (g: string) => (
  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/70">{ITEM_GRADE_LABEL[g as keyof typeof ITEM_GRADE_LABEL] ?? g}</span>
);
const ITEM_GRADE_FILTERS = ['p0', 'p1', 'p2', 'p3'].map((g) => ({ value: g, label: ITEM_GRADE_LABEL[g as keyof typeof ITEM_GRADE_LABEL] }));

function RequirementsTable() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<OverviewRequirementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [grade, setGrade] = useState('');
  const [mine, setMine] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getOverviewRequirements({ keyword: keyword.trim() || undefined, grade: grade || undefined, mine: mine || undefined });
    if (res.success) setRows(res.data.items);
    setLoading(false);
  }, [keyword, grade, mine]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <MapSectionLoader text="正在加载需求…" />;
  return (
    <div>
      <TableToolbar keyword={keyword} setKeyword={setKeyword} filterLabel="全部分级" filters={ITEM_GRADE_FILTERS} filterValue={grade} setFilterValue={setGrade} extra={<MineToggle mine={mine} setMine={setMine} />} />
      {rows.length === 0 ? (
        <div className="text-center text-white/40 text-sm py-12">{mine ? '没有指派给你的需求' : '没有需求'}</div>
      ) : (
        <DataTable
          rows={rows}
          onRowClick={(r) => navigate(`/product-agent/p/${r.productId}/requirement/${r.id}`)}
          columns={[
            { header: '编号', render: (r) => <span className="text-white/40 text-xs">{r.requirementNo}</span> },
            { header: '标题', render: (r) => <span className="text-white/90">{r.title}</span> },
            { header: '产品', render: (r) => <span className="text-white/55 text-xs">{r.productName}</span> },
            { header: '分级', render: (r) => GRADE_BADGE(r.grade) },
            { header: '状态', render: (r) => <span className="text-white/55 text-xs">{r.currentState || '-'}</span> },
            { header: '处理人', render: (r) => <span className="text-white/55 text-xs">{r.assigneeName || '-'}</span> },
            { header: '版本', render: (r) => <span className="text-white/55 text-xs">{r.versionCount}</span> },
            { header: '客户', render: (r) => <span className="text-white/55 text-xs">{r.customerCount}</span> },
            { header: '更新', render: (r) => <span className="text-white/35 text-xs">{relTime(r.updatedAt)}</span> },
          ]}
        />
      )}
    </div>
  );
}

function FeaturesTable() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<OverviewFeatureRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [grade, setGrade] = useState('');
  const [mine, setMine] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getOverviewFeatures({ keyword: keyword.trim() || undefined, grade: grade || undefined, mine: mine || undefined });
    if (res.success) setRows(res.data.items);
    setLoading(false);
  }, [keyword, grade, mine]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <MapSectionLoader text="正在加载功能…" />;
  return (
    <div>
      <TableToolbar keyword={keyword} setKeyword={setKeyword} filterLabel="全部分级" filters={ITEM_GRADE_FILTERS} filterValue={grade} setFilterValue={setGrade} extra={<MineToggle mine={mine} setMine={setMine} />} />
      {rows.length === 0 ? (
        <div className="text-center text-white/40 text-sm py-12">{mine ? '没有指派给你的功能' : '没有功能'}</div>
      ) : (
        <DataTable
          rows={rows}
          onRowClick={(r) => navigate(`/product-agent/p/${r.productId}/feature/${r.id}`)}
          columns={[
            { header: '编号', render: (r) => <span className="text-white/40 text-xs">{r.featureNo}</span> },
            { header: '名称', render: (r) => <span className="text-white/90">{r.title}</span> },
            { header: '产品', render: (r) => <span className="text-white/55 text-xs">{r.productName}</span> },
            { header: '分级', render: (r) => GRADE_BADGE(r.grade) },
            { header: '状态', render: (r) => <span className="text-white/55 text-xs">{r.currentState || '-'}</span> },
            { header: '处理人', render: (r) => <span className="text-white/55 text-xs">{r.assigneeName || '-'}</span> },
            { header: '实现需求', render: (r) => <span className="text-white/55 text-xs">{r.requirementCount}</span> },
            { header: '更新', render: (r) => <span className="text-white/35 text-xs">{relTime(r.updatedAt)}</span> },
          ]}
        />
      )}
    </div>
  );
}

function DefectsTable() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<OverviewDefectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getOverviewDefects({ keyword: keyword.trim() || undefined });
    if (res.success) setRows(res.data.items);
    setLoading(false);
  }, [keyword]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) return <MapSectionLoader text="正在加载缺陷…" />;
  return (
    <div>
      <TableToolbar keyword={keyword} setKeyword={setKeyword} />
      {rows.length === 0 ? (
        <div className="text-center text-white/40 text-sm py-12">没有追溯到产品的缺陷</div>
      ) : (
        <DataTable
          rows={rows}
          onRowClick={(r) => navigate(`/product-agent/p/${r.productId}/defect/${r.id}`)}
          columns={[
            { header: '编号', render: (r) => <span className="text-white/40 text-xs">{r.defectNo}</span> },
            { header: '标题', render: (r) => <span className="text-white/90">{r.title || '(无标题)'}</span> },
            { header: '产品', render: (r) => <span className="text-white/55 text-xs">{r.productName}</span> },
            { header: '状态', render: (r) => <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/70">{r.status}</span> },
            { header: '严重度', render: (r) => <span className="text-white/55 text-xs">{r.severity || '-'}</span> },
            { header: '追溯', render: (r) => <span className="text-white/55 text-xs">{r.tracedRequirementId ? '需求' : r.tracedVersionId ? '版本' : '产品'}</span> },
            { header: '更新', render: (r) => <span className="text-white/35 text-xs">{relTime(r.updatedAt)}</span> },
          ]}
        />
      )}
    </div>
  );
}

// ════════════════════════ 知识库 / 图谱 / 设置 ════════════════════════

function KnowledgeSection() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<OverviewKnowledgeRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await getOverviewKnowledge();
      if (alive && res.success) setRows(res.data.items);
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <MapSectionLoader text="正在加载知识库…" />;
  if (rows.length === 0) return <div className="text-center text-white/40 text-sm py-12">还没有产品知识库。进入产品的「知识库」tab 即可创建。</div>;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {rows.map((r) => (
        <button
          key={r.storeId}
          onClick={() => navigate(`/product-agent/p/${r.productId}`)}
          className="text-left rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] p-4 transition-colors flex flex-col gap-1.5"
        >
          <div className="flex items-center gap-2 text-white font-medium">
            <BookOpen size={15} className="text-cyan-400 shrink-0" />
            <span className="truncate">{r.name}</span>
          </div>
          <div className="text-[11px] text-white/40">{r.productName}</div>
          <div className="text-[11px] text-white/50 mt-1">{r.documentCount} 篇文档 · 更新 {relTime(r.updatedAt)}</div>
        </button>
      ))}
    </div>
  );
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
