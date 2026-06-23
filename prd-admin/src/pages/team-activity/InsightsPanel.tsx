/**
 * 行为洞察面板：把「沉默的行为信号」聚合成带证据的改进方向，并支持处理闭环。
 * 每条洞察：是什么行为 / 发生在哪 / 涉及多少人多少次 / 影响多大 / 建议改什么，
 * 操作：转为缺陷（接入 defect-agent 修复流水线）/ 标记已修复 / 忽略（指纹级持久化，不再打扰）。
 * 数据源：apirequestlogs（报错/慢端点，历史即有）+ behavior_events（路由信号，自采集上线起累积）。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, BookOpen, Bug, Check, CheckCircle2, ClipboardList, EyeOff as IgnoreIcon, LayoutGrid, Megaphone, Microscope, Network, Radar, RotateCcw, ScrollText, TrendingUp, Users, X, type LucideIcon } from 'lucide-react';
import { GlassCard } from '@/components/design';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { StreamingText } from '@/components/streaming/StreamingText';
import { useSseStream } from '@/lib/useSseStream';
import { toast } from '@/lib/toast';
import { useGlobalDefectStore } from '@/stores/globalDefectStore';
import {
  addDocumentEntry,
  createDocumentStore,
  getTeamActivityExperienceMap,
  getTeamActivityInsights,
  insightToRequirement,
  listDocumentEntries,
  listDocumentStores,
  setTeamActivityInsightState,
  updateDocumentContent,
} from '@/services';
import type { BehaviorInsight, TeamActivityExperienceMapData, TeamActivityInsightsData } from '@/services/contracts/teamActivity';
import { getInsightKindMeta } from './insightKinds';
import { ExperienceMap } from './ExperienceMap';
import { ExperienceRibbon } from './ExperienceRibbon';
import { ExperienceStats } from './ExperienceStats';
import { ExperienceDrill } from './ExperienceDrill';
import { ExperienceTrend } from './ExperienceTrend';
import { ExperienceSiteMap } from './ExperienceSiteMap';
import { ExperienceBoard } from './ExperienceBoard';
import { RequirementConvertModal, type RequirementConvertDraft } from './RequirementConvertModal';

// 转需求弹窗上下文：草稿 + 回写用的 kind/target
type RequirementModalState = { kind: string; target: string; draft: RequirementConvertDraft };

function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const STATUS_LABEL: Record<string, string> = {
  confirmed: '已确认',
  resolved: '已修复',
  ignored: '已忽略',
};

// 移动端单图视图切换：同一份体验信号的不同可视化模式（桌面端走四图仪表盘，不用切换器）
type HeroView = 'heatmap' | 'trend' | 'stats' | 'board';
const HERO_VIEWS: { key: HeroView; label: string; icon: LucideIcon }[] = [
  { key: 'heatmap', label: '热力图', icon: LayoutGrid },
  { key: 'trend', label: '趋势爆点', icon: TrendingUp },
  { key: 'stats', label: '痛点指数', icon: BarChart3 },
  { key: 'board', label: '声道看板', icon: Megaphone },
];

function buildDefectContent(item: BehaviorInsight, window: string): string {
  return [
    '## 行为洞察转报（自动生成）',
    '',
    `- 信号类型：${item.kindLabel}`,
    `- 发生位置：${item.target}`,
    `- 量化指标：${item.metric}`,
    `- 影响范围：${item.userCount} 人 / ${item.eventCount} 次`,
    `- 分析窗口：${window}`,
    '',
    '### 证据',
    ...item.evidence.map((e) => `- ${e}`),
    '',
    '### 改进建议',
    item.suggestion,
    '',
    '> 来源：团队动态 - 行为洞察面板',
  ].join('\n');
}

export function InsightsPanel({ from, to }: { from?: string; to?: string }) {
  const [data, setData] = useState<TeamActivityInsightsData | null>(null);
  const [mapData, setMapData] = useState<TeamActivityExperienceMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeIgnored, setIncludeIgnored] = useState(false);
  // 移动端单图切换：默认体验全景热力图，可切到趋势/痛点指数/声道看板（桌面端不用此切换，走四图仪表盘）
  const [heroView, setHeroView] = useState<HeroView>('heatmap');
  // 端点地图格子内子切换：热力图 ⇄ 站点地图（两者都是端点地图，共用一格，不单独占格）
  const [mapMode, setMapMode] = useState<'heatmap' | 'sitemap'>('heatmap');
  // 趋势爆点是否无可绘制数据：桌面四图仪表盘据此把趋势格移出布局，其余格自适应铺满（自由融合）。
  const [trendEmpty, setTrendEmpty] = useState(false);
  // 全屏热力图浮层开关（createPortal 到 body）
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  // 下钻抽屉：从右侧滑入的浮层 drawer（createPortal 到 body），target 非空即展开。
  // kind 记录下钻入口的叶子类型（api-error 红/报错 · slow 琥珀/等待过久），保证转缺陷/转需求时
  // kind|target 指纹与真实痛点一致（slow-only 痛点不会被误标成 api-error）。
  const [drillTarget, setDrillTarget] = useState<{ target: string; label: string; kind?: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // 转缺陷：复用真实缺陷面板（GlobalDefectSubmitDialog），通过全局 store 携预填打开
  const openDefectDialog = useGlobalDefectStore((s) => s.openDialog);
  // 转需求弹窗：打开时持有预填草稿 + 回写上下文，确认时才真正流转
  const [reqModal, setReqModal] = useState<RequirementModalState | null>(null);
  const [reqSubmitting, setReqSubmitting] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefModel, setBriefModel] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishedTitle, setPublishedTitle] = useState<string | null>(null);
  // 收到后端显式 done 事件才算完整；流自然断开（代理掐线/超长截断）不会触发 onDone
  const [briefComplete, setBriefComplete] = useState(false);
  const fetchIdRef = useRef(0);

  // AI 简报：SSE 流式生成（model/delta/done/error 事件由后端 insights/brief 推送）
  const brief = useSseStream({
    url: '/api/team-activity/insights/brief',
    typingEvent: 'delta',
    onEvent: {
      model: (data) => {
        const d = data as { model?: string; platform?: string };
        setBriefModel(d.model ? `${d.model}${d.platform ? ` · ${d.platform}` : ''}` : null);
      },
    },
    onError: (msg) => toast.error(msg),
    onDone: () => setBriefComplete(true),
  });

  const startBrief = useCallback(() => {
    setBriefOpen(true);
    setBriefModel(null);
    setPublishedTitle(null);
    setBriefComplete(false);
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    void brief.start({ url: `/api/team-activity/insights/brief${qs ? `?${qs}` : ''}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  const publishBrief = useCallback(async () => {
    const markdown = brief.typing.trim();
    if (!markdown || publishing || publishedTitle) return;
    setPublishing(true);
    const storeName = '行为洞察简报';
    let storeId: string | null = null;
    const list = await listDocumentStores(1, 100);
    if (list.success) storeId = list.data.items.find((st) => st.name === storeName)?.id ?? null;
    if (!storeId) {
      const created = await createDocumentStore({ name: storeName, description: '团队动态 - 行为洞察自动生成的 AI 简报存档' });
      if (created.success) storeId = created.data.id;
    }
    if (!storeId) {
      setPublishing(false);
      toast.error('知识库创建失败，请稍后重试');
      return;
    }
    const now = new Date();
    const title = `行为洞察简报 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // 幂等发布：当日已有同名简报则更新内容，不再新建重复文档
    let entryId: string | null = null;
    let isUpdate = false;
    const existing = await listDocumentEntries(storeId, 1, 200);
    if (existing.success) {
      const hit = existing.data.items.find((e) => e.title === title);
      if (hit) {
        entryId = hit.id;
        isUpdate = true;
      }
    }
    if (!entryId) {
      const entry = await addDocumentEntry(storeId, {
        title,
        sourceType: 'import',
        contentType: 'text/markdown',
        summary: markdown.slice(0, 200),
      });
      if (!entry.success) {
        setPublishing(false);
        toast.error(entry.error?.message ?? '创建文档失败');
        return;
      }
      entryId = entry.data.id;
    }
    const content = await updateDocumentContent(entryId, markdown);
    setPublishing(false);
    if (content.success) {
      setPublishedTitle(title);
      toast.success(`${isUpdate ? '已更新' : '已发布'}《${title}》到知识库「${storeName}」`);
    } else {
      toast.error(content.error?.message ?? '写入文档内容失败');
    }
  }, [brief.typing, publishing, publishedTitle]);

  const reload = useCallback(() => {
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    void getTeamActivityInsights({ from, to, includeIgnored: includeIgnored || undefined }).then((res) => {
      if (fetchIdRef.current !== fetchId) return;
      if (res.success) {
        setData(res.data);
        setError(null);
      } else {
        // 失败清空旧数据（与并行的 mapData 失败清空对称），避免痛点榜/ribbon/stats 残留上个时间窗、与已清空的热力图打架
        setData(null);
        setError(res.error?.message ?? '加载失败，请重试');
      }
      setLoading(false);
    });
    // 体验全景热力图与痛点榜同源（apirequestlogs），并行拉取，互不阻塞
    void getTeamActivityExperienceMap({ from, to }).then((res) => {
      if (fetchIdRef.current !== fetchId) return;
      // 失败时清空旧窗口数据（treemap 显示空/加载态），避免新选择下还残留上一个时间窗的热力图
      if (res.success) setMapData(res.data);
      else setMapData(null);
    });
  }, [from, to, includeIgnored]);

  // 点击热力图痛点块 / 痛点榜「AI 诊断」→ 打开右侧浮层下钻抽屉（查真实明细 + AI 根因诊断，未上榜也能下钻）
  // kind 可选：来自叶子健康（红=api-error / 琥珀=slow）或痛点榜行的 item.kind，用于转缺陷/转需求时回写正确指纹。
  const openDrill = useCallback((target: string, label: string, kind?: string) => {
    setDrillTarget({ target, label, kind });
  }, []);

  const handleSelectTarget = useCallback(
    (target: string, fallback?: { label: string; metric: string; kind?: string }) => {
      openDrill(target, fallback?.label ?? target, fallback?.kind);
    },
    [openDrill]
  );

  const closeDrill = useCallback(() => {
    setDrillTarget(null);
  }, []);

  // 各 Hero 视图空数据引导的统一出口：一键切回体验全景热力图
  const switchToHeatmap = useCallback(() => setHeroView('heatmap'), []);

  useEffect(() => {
    reload();
  }, [reload]);

  // 浮层 ESC 关闭：全屏 > 下钻抽屉 > AI 用户分析抽屉（栈式关闭）
  useEffect(() => {
    if (!fullscreenOpen && !drillTarget && !briefOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (fullscreenOpen) setFullscreenOpen(false);
      else if (drillTarget) closeDrill();
      else {
        brief.abort();
        setBriefOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreenOpen, drillTarget, briefOpen, closeDrill, brief]);

  const setState = useCallback(
    async (item: BehaviorInsight, status: 'confirmed' | 'resolved' | 'ignored' | 'open') => {
      const key = `${item.kind}|${item.target}`;
      setBusyKey(key);
      // 标记 resolved 时上报当前坏请求数作为复测回落基线：报错/慢请求类的 eventCount 即坏请求数
      const badCount =
        status === 'resolved' && (item.kind === 'api-error' || item.kind === 'slow-endpoint')
          ? item.eventCount
          : undefined;
      const res = await setTeamActivityInsightState({ kind: item.kind, target: item.target, status, badCount });
      setBusyKey(null);
      if (!res.success) {
        toast.error(res.error?.message ?? '操作失败');
        return;
      }
      reload();
    },
    [reload]
  );

  // 「转为缺陷」统一出口：打开真实缺陷面板（GlobalDefectSubmitDialog）携预填，创建成功后回写洞察状态。
  // 复用是第一目标——不再自造缺陷表单。回写仍走 setTeamActivityInsightState 保持闭环 ribbon / 行内 chip 联动。
  const openDefectDialogForInsight = useCallback(
    (item: BehaviorInsight) => {
      const window = data ? `${fmtDate(data.windowFrom)} ~ ${fmtDate(data.windowTo)}` : '';
      openDefectDialog({
        prefill: {
          title: `[行为洞察] ${item.kindLabel}：${item.target}`,
          content: buildDefectContent(item, window),
          severity: item.kind === 'api-error' ? 'major' : 'minor',
        },
        onCreated: (defect) => {
          void setTeamActivityInsightState({
            kind: item.kind,
            target: item.target,
            status: 'confirmed',
            defectId: defect.id,
            defectTitle: defect.title,
          }).then(() => reload());
        },
      });
    },
    [data, openDefectDialog, reload]
  );

  // 下钻抽屉「转为缺陷」：优先复用痛点榜上同 target 的富洞察（证据更全），未上榜则用下钻信息建最小草稿。
  const openDefectDialogForDrill = useCallback(() => {
    if (!drillTarget) return;
    const hit = data?.items.find((i) => i.target === drillTarget.target && i.kind === 'api-error')
      ?? data?.items.find((i) => i.target === drillTarget.target);
    if (hit) {
      openDefectDialogForInsight(hit);
      return;
    }
    const window = data ? `${fmtDate(data.windowFrom)} ~ ${fmtDate(data.windowTo)}` : '';
    const dt = drillTarget;
    // 走到这里说明未命中痛点榜（hit 必为空），指纹 kind 取下钻入口叶子类型，兜底 api-error
    const kind = drillTarget.kind ?? 'api-error';
    openDefectDialog({
      prefill: {
        title: `[体验下钻] ${dt.label}：${dt.target}`,
        content: [
          '## 体验下钻转报（自动生成）',
          '',
          `- 端点：${dt.target}`,
          `- 来源：团队动态 - 体验全景热力图下钻`,
          `- 分析窗口：${window}`,
          '',
          '> 该端点尚未进入痛点榜（信号偏弱），但被手动下钻识别为需关注项，请结合「AI 根因诊断」与真实请求样本核查。',
        ].join('\n'),
        severity: 'minor',
      },
      onCreated: (defect) => {
        void setTeamActivityInsightState({
          kind,
          target: dt.target,
          status: 'confirmed',
          defectId: defect.id,
          defectTitle: defect.title,
        }).then(() => reload());
      },
    });
  }, [drillTarget, data, openDefectDialog, openDefectDialogForInsight, reload]);

  // 下钻抽屉「转需求」：不再就地展开直接发送，改为生成预填草稿并打开步骤向导弹窗。
  // 优先复用同 target 的富洞察（指标/证据更全），未上榜则用下钻展示名兜底。
  const openRequirementModalForDrill = useCallback(() => {
    if (!drillTarget) return;
    const hit = data?.items.find((i) => i.target === drillTarget.target && i.kind === 'api-error')
      ?? data?.items.find((i) => i.target === drillTarget.target);
    const window = data ? `${fmtDate(data.windowFrom)} ~ ${fmtDate(data.windowTo)}` : '';
    // 指纹 kind 取下钻入口叶子类型（slow-only 痛点不被误标 api-error），兜底 hit?.kind / api-error
    const kind = drillTarget.kind ?? hit?.kind ?? 'api-error';
    const title = hit
      ? `[用户体验之声] ${hit.kindLabel}：${hit.target}`
      : `[用户体验之声] ${drillTarget.label}`;
    const description = hit
      ? [
          '## 用户体验之声转需求（自动生成）',
          '',
          `- 信号类型：${hit.kindLabel}`,
          `- 发生位置：${hit.target}`,
          `- 量化指标：${hit.metric}`,
          `- 影响范围：${hit.userCount} 人 / ${hit.eventCount} 次`,
          `- 分析窗口：${window}`,
          '',
          '### 证据',
          ...hit.evidence.map((e) => `- ${e}`),
          '',
          '### 改进建议',
          hit.suggestion,
          '',
          '> 来源：团队动态 - 行为洞察（痛点流转需求池）',
        ].join('\n')
      : [
          '## 用户体验之声转需求（自动生成）',
          '',
          `- 端点：${drillTarget.target}`,
          `- 分析窗口：${window}`,
          '',
          '> 该端点尚未进入痛点榜（信号偏弱），但被手动下钻识别为需关注项。',
          '> 来源：团队动态 - 体验全景热力图下钻',
        ].join('\n');
    setReqModal({ kind, target: drillTarget.target, draft: { title, description } });
  }, [drillTarget, data]);

  // 需求弹窗确认：用所选产品 + 用户核对后的草稿流转需求（沿用原直接执行逻辑与 toast/reload）。
  const confirmRequirement = useCallback(
    async (productId: string, draft: RequirementConvertDraft) => {
      if (!reqModal) return;
      const { kind, target } = reqModal;
      setReqSubmitting(true);
      const res = await insightToRequirement({ kind, target, title: draft.title, description: draft.description, productId });
      setReqSubmitting(false);
      if (!res.success) {
        toast.error(res.error?.message ?? '流转需求失败');
        return;
      }
      setReqModal(null);
      toast.success(
        res.data.alreadyExists
          ? `该痛点已转为需求 #${res.data.requirementNo}`
          : `已流转为产品需求 #${res.data.requirementNo}，可在产品管理需求池跟进`
      );
      reload();
    },
    [reqModal, reload]
  );

  if (loading && !data) {
    return (
      <GlassCard className="flex-1" style={{ minHeight: 0 }}>
        <div className="h-full flex items-center justify-center">
          <MapSectionLoader text="正在从行为信号中聚合洞察…" />
        </div>
      </GlassCard>
    );
  }

  // 端点地图格头部右侧：热力图 ⇄ 站点地图 子切换器（端点地图的两种铺法，共用一格，不单独占格）
  const mapModeSwitcher = (
    <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
      {([
        { key: 'heatmap' as const, label: '热力图', icon: LayoutGrid },
        { key: 'sitemap' as const, label: '站点地图', icon: Network },
      ]).map((m) => {
        const MIcon = m.icon;
        const active = mapMode === m.key;
        return (
          <button
            key={m.key}
            type="button"
            onClick={() => setMapMode(m.key)}
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] whitespace-nowrap transition-colors cursor-pointer ${active ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/45 hover:text-white/75'}`}
          >
            <MIcon size={11} />
            {m.label}
          </button>
        );
      })}
    </div>
  );

  // 端点地图格（热力图 ⇄ 站点地图）。两者都是端点地图，共用同一格，靠 headerExtra 注入子切换器。
  // compact=true（桌面格内/移动单图）时给热力图挂全屏按钮，格里小、全屏看大。
  const renderMapTile = () =>
    mapMode === 'heatmap' ? (
      <ExperienceMap
        data={mapData}
        loading={loading}
        onSelectTarget={handleSelectTarget}
        onRequestFullscreen={() => setFullscreenOpen(true)}
        headerExtra={mapModeSwitcher}
      />
    ) : (
      <ExperienceSiteMap mapData={mapData} onSelectTarget={handleSelectTarget} onSwitchHeatmap={switchToHeatmap} headerExtra={mapModeSwitcher} />
    );

  // 趋势格：桌面四图仪表盘传 hideWhenEmpty（无数据直接 null，让 grid 自适应铺满剩余格 + 上报空态）；
  // 移动单图不传 hideWhenEmpty，保留空状态引导（一键切回热力图）。
  const renderTrendTile = (forDashboard: boolean) => (
    <ExperienceTrend
      from={from}
      to={to}
      onSwitchHeatmap={switchToHeatmap}
      onEmptyChange={forDashboard ? setTrendEmpty : undefined}
      hideWhenEmpty={forDashboard}
    />
  );
  const renderStatsTile = () => (data ? <ExperienceStats items={data.items} /> : null);
  const renderBoardTile = () => <ExperienceBoard items={data?.items ?? []} onSelectTarget={handleSelectTarget} onSwitchHeatmap={switchToHeatmap} from={from} to={to} />;

  // 桌面端（lg+）Bento 看板：全景热力图为绝对主角。
  // 12 列 grid + 固定行高，热力图占 9 列（约 3/4）× 2 行满高；其余仪表盘压在右 3 列（约 1/4）竖排：
  //   - 热力图 hero：col-span-9 / row-span-2（左侧大块当主角，越大越好）
  //   - 右 1/4 竖排：趋势爆点 / 痛点指数 / 声道看板，各 flex-1 平分右列高度
  // 「自由融合」：趋势无数据时整块移出，痛点指数 + 声道看板平分右列剩余高度，热力图主角不变。
  // 布局关键尺寸（gridColumn/gridRow span、grid-template）一律走 inline style（frontend-modal 习惯，
  //   避免 Tailwind arbitrary span 在某些构建路径不生效）。
  const renderDesktopDashboard = () => {
    const span = (col: number, row: number): CSSProperties => ({
      gridColumn: `span ${col}`,
      gridRow: `span ${row}`,
      minHeight: 0,
    });

    return (
      <div className="hidden lg:block h-full">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
            gridTemplateRows: '1fr 1fr',
            gap: '12px',
            height: '100%',
            minHeight: 0,
            transition: 'grid-template-rows .4s',
          }}
        >
          {/* 热力图 hero（8 列 × 2 行主角，约占 2/3）：内部 voc-hero-swap 入场 + 子切换 morph */}
          <div style={span(8, 2)}>
            <div key={mapMode} className="h-full" style={{ animation: 'voc-hero-swap .3s cubic-bezier(.22,1,.36,1) both', minHeight: 0 }}>
              {renderMapTile()}
            </div>
          </div>
          {/* 右 1/3 列（4 列 × 2 行）：还原图2排布——趋势在上整宽，痛点指数 + 声道在下并排。
              填满整屏后每格高度足够，痛点指数仪表盘与声道卡片都能完整渲染（不再被压扁裁掉）。
              趋势无数据时整块移出，痛点指数 + 声道上下各占一行吸收其高度。 */}
          {trendEmpty ? (
            <>
              <div style={span(4, 1)} className="voc-bento-tile">{renderStatsTile()}</div>
              <div style={span(4, 1)} className="voc-bento-tile">{renderBoardTile()}</div>
            </>
          ) : (
            <>
              <div style={span(4, 1)} className="voc-bento-tile">{renderTrendTile(true)}</div>
              <div style={span(2, 1)} className="voc-bento-tile">{renderStatsTile()}</div>
              <div style={span(2, 1)} className="voc-bento-tile">{renderBoardTile()}</div>
            </>
          )}
        </div>
        {/* 趋势隐藏时的持续挂载点：不占布局，仅维持订阅 + 空态上报，使窗口切到有数据时本格能复现 */}
        {trendEmpty ? <div style={{ display: 'none' }}>{renderTrendTile(true)}</div> : null}
      </div>
    );
  };

  // 移动端：四图不适合小屏，改单图视图切换器 + 单图展示（满宽满铺，嵌套卡 GlassCard 自动去 chrome）。
  const renderMobileSingle = () => (
    <div className="flex flex-col gap-2 lg:hidden">
      <div className="-mx-1 px-1 overflow-x-auto" style={{ overscrollBehavior: 'contain' }}>
        <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
          {HERO_VIEWS.map((v) => {
            const VIcon = v.icon;
            const active = heroView === v.key;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => setHeroView(v.key)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] whitespace-nowrap shrink-0 transition-colors cursor-pointer ${active ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/45 hover:text-white/75'}`}
              >
                <VIcon size={12} />
                {v.label}
              </button>
            );
          })}
        </div>
      </div>
      <div key={`${heroView}-${mapMode}`} style={{ animation: 'voc-hero-swap .3s cubic-bezier(.22,1,.36,1) both', minHeight: 0 }}>
        {heroView === 'heatmap'
          ? renderMapTile()
          : heroView === 'trend'
            ? renderTrendTile(false)
            : heroView === 'stats'
              ? renderStatsTile()
              : renderBoardTile()}
      </div>
    </div>
  );

  const renderHeroView = () => (
    <>
      {renderDesktopDashboard()}
      {renderMobileSingle()}
    </>
  );

  return (
    <GlassCard className="flex-1 flex flex-col" mobileFlush style={{ minHeight: 0 }}>
      <style>{`.voc-row-flash { box-shadow: inset 0 0 0 2px rgba(45,212,191,0.7); border-radius: 6px; }
        @keyframes voc-shimmer-sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
        @keyframes voc-hero-swap { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes voc-drawer-in { from { transform: translateX(36px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        /* Bento 格：span 变化时平滑过渡（趋势吸收/补满有动效），内部卡撑满格高 */
        .voc-bento-tile { transition: grid-column .45s cubic-bezier(.2,.7,.2,1), grid-row .45s cubic-bezier(.2,.7,.2,1); min-height: 0; }
        .voc-bento-tile > * { height: 100%; min-height: 0; }`}</style>
      {/* 闭环 ribbon 作为固定头部（不随内容滚动），让下方 hero 能精确填满滚动视口首屏 */}
      <div className="px-1.5 pt-2 sm:px-5 sm:pt-4 shrink-0">
        <ExperienceRibbon mapData={mapData} insights={data} />
      </div>
      {/* 滚动区：hero 桌面填满首屏（lg:h-full），底部数据行 + 痛点明细全宽放其下方、滚动可见 */}
      <div className="flex-1 flex flex-col" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {/* Hero：桌面 2/3 热力图 + 1/3 仪表盘填满首屏 / 移动单图切换。切换时间窗(loading && data)叠「更新中」过渡态。 */}
        <div className="relative px-1.5 sm:px-5 lg:h-full lg:shrink-0">
            {renderHeroView()}
            {loading && data ? (
              <div
                className="absolute inset-0 rounded-2xl overflow-hidden flex items-center justify-center"
                style={{ background: 'rgba(16,17,19,0.35)', backdropFilter: 'blur(0.5px)' }}
              >
                {/* 顶部细横条扫光：持续变化，告知正在重聚合而非卡死 */}
                <div className="absolute top-0 left-0 right-0 h-[2px] overflow-hidden">
                  <div
                    className="h-full w-1/3"
                    style={{ background: 'linear-gradient(90deg,transparent,#5eead4,transparent)', animation: 'voc-shimmer-sweep 1.1s ease-in-out infinite' }}
                  />
                </div>
                <span className="inline-flex items-center gap-2 px-3 h-[28px] rounded-full text-[12px] text-white/75 border border-white/10" style={{ background: 'rgba(16,17,19,0.8)' }}>
                  <MapSpinner size={13} />
                  正在重新聚合数据…
                </span>
              </div>
            ) : null}
          </div>
        {/* 数据源状态行：诚实告知信号从哪来、采集到什么程度 */}
        {data ? (
          <div className="sticky top-0 z-10 flex items-center gap-3 flex-wrap px-2 sm:px-5 py-2.5 text-[11px] text-white/40 border-b border-white/[0.05] backdrop-blur-md" style={{ background: 'rgba(16,17,19,0.72)' }}>
            <span className="font-mono tabular-nums">
              {fmtDate(data.windowFrom)} ~ {fmtDate(data.windowTo)}
            </span>
            {!from ? <span className="text-amber-200/60">「全部」在洞察视图取近 30 天（更早的信号无行动价值）</span> : null}
            <span className="w-px h-3 bg-white/10" />
            <span>
              路由信号 <span className="text-white/70 font-mono tabular-nums">{data.behaviorEventCount}</span> 条
              {data.trackedSince ? `（自 ${fmtDate(data.trackedSince)} 起采集）` : '（采集器刚上线，数据从现在开始累积）'}
            </span>
            <span className="w-px h-3 bg-white/10" />
            <span>报错/等待信号来自 API 请求日志（含历史）</span>
            <button
              type="button"
              onClick={startBrief}
              className="inline-flex items-center gap-1 px-2 h-[20px] rounded text-[11px] border bg-cyan-500/10 text-cyan-200/90 border-cyan-500/25 hover:bg-cyan-500/20 transition-colors cursor-pointer"
            >
              <ScrollText size={11} />
              AI 用户分析
            </button>
            {data.ignoredCount > 0 || includeIgnored ? (
              <button
                type="button"
                onClick={() => setIncludeIgnored((v) => !v)}
                className="ml-auto inline-flex items-center gap-1 text-[11px] text-white/40 hover:text-white/70 transition-colors cursor-pointer"
              >
                <IgnoreIcon size={11} />
                {includeIgnored ? '隐藏已忽略' : `查看已忽略（${data.ignoredCount}）`}
              </button>
            ) : null}
          </div>
        ) : null}

        {error && !data ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Radar size={36} className="text-white/15" />
            <div className="text-sm text-white/60">{error}</div>
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center px-2 sm:px-5">
            <Radar size={36} className="text-white/15" />
            <div className="text-sm text-white/60">当前窗口还没有形成洞察</div>
            <div className="text-[12px] text-white/35 max-w-md leading-relaxed">
              洞察由行为信号聚合而来：频繁报错、等待过久（来自 API 日志，历史即可分析）；
              停留过久、秒退放弃、反复横跳（来自路由信号，自采集上线起累积）。
              信号达到阈值（如同一接口失败 5 次以上）才会出现在这里——没有洞察本身就是好消息。
            </div>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {data.items.map((item) => {
              const meta = getInsightKindMeta(item.kind);
              const Icon = meta.icon;
              const key = `${item.kind}|${item.target}`;
              const busy = busyKey === key;
              const status = item.status ?? null;
              return (
                <div
                  key={key}
                  data-insight-target={item.target}
                  className="relative px-2.5 sm:px-5 py-3.5 flex gap-3.5 transition-colors hover:bg-white/[0.02]"
                  style={{ opacity: status === 'ignored' ? 0.45 : 1 }}
                >
                  {/* 左缘严重度色条：扫一眼即可分辨信号类型 */}
                  <span className="absolute left-0 top-3 bottom-3 w-[2px] rounded-r" style={{ background: meta.accent }} />
                  <span
                    className="w-8 h-8 rounded-md flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: meta.soft }}
                  >
                    <Icon size={15} style={{ color: meta.accent }} />
                  </span>
                  <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="text-[11px] font-semibold" style={{ color: meta.accent }}>
                        {item.kindLabel}
                      </span>
                      <span className="text-[13px] text-white/90 font-mono break-all">{item.target}</span>
                      <span className="text-[11px] text-amber-200/80 font-mono tabular-nums">{item.metric}</span>
                      {status ? (
                        <span className="px-1.5 py-px rounded text-[10px] font-medium bg-white/[0.06] text-white/55">
                          {STATUS_LABEL[status] ?? status}
                        </span>
                      ) : null}
                      {item.defectTitle ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-rose-200/70">
                          <Bug size={11} />
                          {item.defectTitle}
                        </span>
                      ) : null}
                      {item.requirementNo ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-cyan-200/80">
                          <ClipboardList size={11} />
                          需求 #{item.requirementNo}
                        </span>
                      ) : null}
                      {typeof item.reboundPct === 'number' ? <ReboundBadge pct={item.reboundPct} /> : null}
                      <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-white/35 font-mono tabular-nums shrink-0">
                        <Users size={11} />
                        {item.userCount} 人 · {item.eventCount} 次
                      </span>
                    </div>
                    <div className="text-[12px] text-white/65 leading-relaxed">{item.suggestion}</div>
                    <div className="flex items-center gap-x-4 gap-y-0.5 flex-wrap">
                      {item.evidence.map((line, i) => (
                        <span key={i} className="text-[11px] text-white/35">
                          {line}
                        </span>
                      ))}
                    </div>
                    {/* 处理闭环：洞察不该只能看 */}
                    <div className="flex items-center gap-1.5 pt-1">
                      {busy ? (
                        <MapSpinner size={13} />
                      ) : status === 'ignored' || status === 'resolved' ? (
                        <ActionButton onClick={() => void setState(item, 'open')} icon={RotateCcw} label="恢复待处理" />
                      ) : (
                        <>
                          {item.kind === 'api-error' || item.kind === 'slow-endpoint' ? (
                            <ActionButton
                              onClick={() => openDrill(item.target, `${item.kindLabel} · ${item.target}`, item.kind)}
                              icon={Microscope}
                              label="AI 诊断"
                            />
                          ) : null}
                          {!item.defectId ? (
                            <ActionButton onClick={() => openDefectDialogForInsight(item)} icon={Bug} label="转为缺陷" emphasis />
                          ) : null}
                          {status !== 'confirmed' ? (
                            <ActionButton onClick={() => void setState(item, 'confirmed')} icon={Check} label="确认待改" />
                          ) : null}
                          <ActionButton onClick={() => void setState(item, 'resolved')} icon={CheckCircle2} label="已修复" />
                          <ActionButton onClick={() => void setState(item, 'ignored')} icon={IgnoreIcon} label="忽略" />
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 下钻浮层抽屉：从右侧滑入，createPortal 到 body（遵守 frontend-modal.md：
          createPortal + 布局尺寸走 inline style + 滚动区 min-h-0 + overscrollBehavior contain + z-[100]+ + ESC/遮罩关闭）。
          复用 ExperienceDrill 全部 props/回调，不再挤占 Hero 宽度。 */}
      {drillTarget
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex justify-end"
              style={{ background: 'rgba(0,0,0,0.5)' }}
              onClick={closeDrill}
            >
              {/* 右侧整高 drawer：从右边缘滑入，桌面 ~440px、手机 min(440px,94vw)，整高。
                  遵守 frontend-modal.md：关键尺寸 inline style + 滚动区由 ExperienceDrill 内部 min-h:0 + overscroll contain。 */}
              <div
                className="flex flex-col border-l border-white/10"
                style={{
                  width: 'min(440px, 94vw)',
                  height: '100vh',
                  background: '#16171b',
                  boxShadow: '-24px 0 80px rgba(0,0,0,0.5)',
                  animation: 'voc-drawer-in .26s cubic-bezier(.22,1,.36,1)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <ExperienceDrill
                  target={drillTarget.target}
                  label={drillTarget.label}
                  from={from}
                  to={to}
                  convertingRequirement={reqSubmitting && reqModal?.target === drillTarget.target}
                  requirementNo={data?.items.find((i) => i.target === drillTarget.target && i.requirementNo)?.requirementNo ?? null}
                  onRequestDefectModal={openDefectDialogForDrill}
                  onRequestRequirementModal={openRequirementModalForDrill}
                  onClose={closeDrill}
                />
              </div>
              <style>{`@keyframes voc-drawer-in { from { transform: translateX(36px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
            </div>,
            document.body
          )
        : null}

      {/* AI 用户分析抽屉：从行为信号聚合的用户画像/处境简报。由数据源行「AI 用户分析」按钮点击触发，
          右侧滑入浮层（与端点下钻同一种抽屉，不挤占热力图、不常驻空跑）。遵守 frontend-modal.md：
          createPortal + 关键尺寸 inline style + 滚动区 min-h:0 + overscroll contain + z-[100] + ESC/遮罩关闭。 */}
      {briefOpen
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex justify-end"
              style={{ background: 'rgba(0,0,0,0.5)' }}
              onClick={() => {
                brief.abort();
                setBriefOpen(false);
              }}
            >
              <div
                className="flex flex-col border-l border-white/10"
                style={{
                  width: 'min(440px, 94vw)',
                  height: '100vh',
                  background: '#16171b',
                  boxShadow: '-24px 0 80px rgba(0,0,0,0.5)',
                  animation: 'voc-drawer-in .26s cubic-bezier(.22,1,.36,1)',
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* 头部：标题 + 模型可见（ai-model-visibility）+ 关闭 */}
                <div className="flex items-center gap-2.5 px-4 pt-4 pb-3 border-b border-white/[0.06] shrink-0">
                  <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(45,212,191,0.12)' }}>
                    <ScrollText size={15} className="text-cyan-300/90" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-white/85">AI 用户分析</div>
                    <div className="text-[10px] text-white/35 truncate font-mono">
                      {briefModel ?? '从行为信号读懂用户此刻的处境'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      brief.abort();
                      setBriefOpen(false);
                    }}
                    title="关闭（ESC）"
                    className="ml-auto inline-flex items-center justify-center w-7 h-7 rounded-md border border-white/10 bg-white/[0.03] text-white/55 hover:text-white/90 hover:border-white/25 transition-colors cursor-pointer"
                  >
                    <X size={14} />
                  </button>
                </div>
                {/* 阶段状态行：禁止空白等待——连接/生成期有持续反馈 */}
                {brief.phase === 'connecting' || brief.phase === 'streaming' ? (
                  <div className="flex items-center gap-1.5 px-4 pt-3 text-[11px] text-white/45 shrink-0">
                    <MapSpinner size={12} />
                    {brief.phaseMessage || '正在从行为信号中聚合用户画像…'}
                  </div>
                ) : null}
                {brief.phase === 'done' && !briefComplete ? (
                  <div className="px-4 pt-3 text-[11px] text-amber-200/80 shrink-0">
                    生成被中断（连接断开或超长截断），建议重新生成
                  </div>
                ) : null}
                {/* 正文：流式逐字 / 完成态 markdown；未出字时给加载态过渡（artifact-is-experience） */}
                <div className="flex-1 min-h-0 px-4 py-3.5" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
                  {brief.typing ? (
                    brief.phase === 'done' ? (
                      <MarkdownContent content={brief.typing} variant="reading" />
                    ) : (
                      <div className="text-[12.5px] leading-relaxed text-white/80">
                        <StreamingText text={brief.typing} streaming mode="blur" />
                      </div>
                    )
                  ) : (
                    <MapSectionLoader text="正在聚合用户画像…" />
                  )}
                </div>
                {/* 底部操作：重新生成 / 发布到知识库（与原内联面板等价） */}
                <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-t border-white/[0.06]" style={{ background: 'rgba(0,0,0,0.18)' }}>
                  {brief.phase === 'done' ? (
                    <ActionButton onClick={startBrief} icon={RotateCcw} label="重新生成" />
                  ) : null}
                  {brief.phase === 'done' && briefComplete && brief.typing.trim() ? (
                    publishedTitle ? (
                      <span className="inline-flex items-center gap-1 px-2 h-[22px] rounded text-[11px] bg-emerald-500/10 text-emerald-200/80 border border-emerald-500/25">
                        <CheckCircle2 size={11} />
                        已发布
                      </span>
                    ) : (
                      <ActionButton
                        onClick={() => void publishBrief()}
                        icon={BookOpen}
                        label={publishing ? '发布中…' : '发布到知识库'}
                        emphasis
                        disabled={publishing}
                      />
                    )
                  ) : null}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}

      {/* 全屏热力图浮层：createPortal 到 body，从中心放大入场（哇塞感），ESC/关闭退出。
          全屏内复用同一个 ExperienceMap（fullscreen 放大视口 + 更多标签层级）。 */}
      {fullscreenOpen
        ? createPortal(
            <div
              className="fixed inset-0 z-[100] flex flex-col"
              style={{ background: 'rgba(8,9,11,0.92)', backdropFilter: 'blur(3px)' }}
              onClick={() => setFullscreenOpen(false)}
            >
              <div
                className="flex-1 flex flex-col"
                style={{ minHeight: 0, padding: '3vh 3vw', animation: 'voc-fs-in .42s cubic-bezier(.16,1,.3,1) both', transformOrigin: 'center' }}
                onClick={(e) => e.stopPropagation()}
              >
                <ExperienceMap
                  data={mapData}
                  loading={loading}
                  onSelectTarget={(t, fb) => {
                    handleSelectTarget(t, fb);
                    setFullscreenOpen(false);
                  }}
                  fullscreen
                  onExitFullscreen={() => setFullscreenOpen(false)}
                />
              </div>
              {/* 从中心放大入场（哇塞感）：从 0.78 缩放 + 透明渐入，cubic-bezier 带轻微过冲感 */}
              <style>{`@keyframes voc-fs-in { from { transform: scale(.78); opacity: 0; } to { transform: scale(1); opacity: 1; } }`}</style>
            </div>,
            document.body
          )
        : null}

      {/* 转为缺陷复用真实缺陷面板（GlobalDefectSubmitDialog，挂在 AppShell 根），通过全局 store 携预填打开，此处无需渲染 */}

      {/* 转需求弹窗（3 步向导）：选产品 → 核对内容 → 确认流转，确认后才流转需求 */}
      {reqModal ? (
        <RequirementConvertModal
          draft={reqModal.draft}
          submitting={reqSubmitting}
          onConfirm={(productId, draft) => void confirmRequirement(productId, draft)}
          onClose={() => {
            if (!reqSubmitting) setReqModal(null);
          }}
        />
      ) : null}
    </GlassCard>
  );
}

/**
 * 复测回落徽章：修复后对比坏请求基线。
 * pct<=-20 已回落（绿，好）/ pct>=20 复发（警告色，坏）/ 之间基本持平（中性）。
 */
function ReboundBadge({ pct }: { pct: number }) {
  const isDown = pct <= -20;
  const isUp = pct >= 20;
  const style = isDown
    ? { background: 'rgba(52,211,153,0.12)', color: '#34d399', border: '1px solid rgba(52,211,153,0.3)' }
    : isUp
      ? { background: 'rgba(248,113,122,0.12)', color: '#f8717a', border: '1px solid rgba(248,113,122,0.3)' }
      : { background: 'rgba(255,255,255,0.05)', color: 'rgba(236,236,239,0.55)', border: '1px solid rgba(255,255,255,0.1)' };
  const text = isDown ? `已回落 ${Math.abs(pct)}%` : isUp ? `复发 +${pct}%` : '基本持平';
  return (
    <span className="inline-flex items-center px-1.5 py-px rounded text-[10px] font-medium tabular-nums" style={style}>
      {text}
    </span>
  );
}

function ActionButton({
  onClick,
  icon: Icon,
  label,
  emphasis,
  disabled,
}: {
  onClick: () => void;
  icon: typeof Bug;
  label: string;
  emphasis?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 h-[22px] rounded text-[11px] border transition-colors cursor-pointer ${
        emphasis
          ? 'bg-amber-500/15 text-amber-200 border-amber-500/30 hover:bg-amber-500/25'
          : 'bg-white/[0.03] text-white/50 border-white/10 hover:text-white/80 hover:border-white/25'
      }`}
    >
      <Icon size={11} />
      {label}
    </button>
  );
}
