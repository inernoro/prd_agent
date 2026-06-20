/**
 * 行为洞察面板：把「沉默的行为信号」聚合成带证据的改进方向，并支持处理闭环。
 * 每条洞察：是什么行为 / 发生在哪 / 涉及多少人多少次 / 影响多大 / 建议改什么，
 * 操作：转为缺陷（接入 defect-agent 修复流水线）/ 标记已修复 / 忽略（指纹级持久化，不再打扰）。
 * 数据源：apirequestlogs（报错/慢端点，历史即有）+ behavior_events（路由信号，自采集上线起累积）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, BookOpen, Bug, Check, CheckCircle2, ClipboardList, EyeOff as IgnoreIcon, LayoutGrid, Megaphone, Microscope, Network, Radar, RotateCcw, ScrollText, TrendingUp, Users, X, type LucideIcon } from 'lucide-react';
import { GlassCard } from '@/components/design';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { StreamingText } from '@/components/streaming/StreamingText';
import { useSseStream } from '@/lib/useSseStream';
import { toast } from '@/lib/toast';
import {
  addDocumentEntry,
  createDefect,
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
import { ExperienceRadar } from './ExperienceRadar';
import { ExperienceSiteMap } from './ExperienceSiteMap';
import { ExperienceBoard } from './ExperienceBoard';
import { DefectConvertModal, type DefectConvertDraft } from './DefectConvertModal';
import { RequirementConvertModal, type RequirementConvertDraft } from './RequirementConvertModal';

// 转缺陷弹窗上下文：除草稿外，还需要回写洞察状态用的 kind/target
type DefectModalState = { kind: string; target: string; draft: DefectConvertDraft };
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

// Hero 多视角：同一份体验信号的不同可视化模式（不是页头的 动态流/行为洞察 tab）
type HeroView = 'heatmap' | 'trend' | 'radar' | 'sitemap' | 'board';
const HERO_VIEWS: { key: HeroView; label: string; icon: LucideIcon }[] = [
  { key: 'heatmap', label: '热力图', icon: LayoutGrid },
  { key: 'trend', label: '趋势爆点', icon: TrendingUp },
  { key: 'radar', label: '痛点雷达', icon: Radar },
  { key: 'sitemap', label: '站点地图', icon: Network },
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

export function InsightsPanel({ from }: { from?: string }) {
  const [data, setData] = useState<TeamActivityInsightsData | null>(null);
  const [mapData, setMapData] = useState<TeamActivityExperienceMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [statsOpen, setStatsOpen] = useState(true);
  // Hero 可视化模式：默认体验全景热力图，可切到趋势/雷达/站点地图/看板
  const [heroView, setHeroView] = useState<HeroView>('heatmap');
  // 全屏热力图浮层开关（createPortal 到 body）
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  // 下钻抽屉：从右侧滑入的浮层 drawer（createPortal 到 body），target 非空即展开
  const [drillTarget, setDrillTarget] = useState<{ target: string; label: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // 转缺陷 / 转需求弹窗：打开时持有预填草稿 + 回写上下文，确认时才真正创建
  const [defectModal, setDefectModal] = useState<DefectModalState | null>(null);
  const [defectSubmitting, setDefectSubmitting] = useState(false);
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
    void brief.start({ url: `/api/team-activity/insights/brief${from ? `?from=${encodeURIComponent(from)}` : ''}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);

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
    void getTeamActivityInsights({ from, includeIgnored: includeIgnored || undefined }).then((res) => {
      if (fetchIdRef.current !== fetchId) return;
      if (res.success) {
        setData(res.data);
        setError(null);
      } else {
        setError(res.error?.message ?? '加载失败，请重试');
      }
      setLoading(false);
    });
    // 体验全景热力图与痛点榜同源（apirequestlogs），并行拉取，互不阻塞
    void getTeamActivityExperienceMap({ from }).then((res) => {
      if (fetchIdRef.current !== fetchId) return;
      if (res.success) setMapData(res.data);
    });
  }, [from, includeIgnored]);

  // 点击热力图痛点块 / 痛点榜「AI 诊断」→ 打开右侧浮层下钻抽屉（查真实明细 + AI 根因诊断，未上榜也能下钻）
  const openDrill = useCallback((target: string, label: string) => {
    setDrillTarget({ target, label });
  }, []);

  const handleSelectTarget = useCallback(
    (target: string, fallback?: { label: string; metric: string }) => {
      openDrill(target, fallback?.label ?? target);
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

  // 浮层 ESC 关闭：全屏优先于下钻抽屉（栈式关闭）
  useEffect(() => {
    if (!fullscreenOpen && !drillTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (fullscreenOpen) setFullscreenOpen(false);
      else closeDrill();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreenOpen, drillTarget, closeDrill]);

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

  // 痛点榜「转为缺陷」：不再直接创建，改为按当前洞察生成预填草稿并打开弹窗，确认后才发送。
  const openDefectModalForInsight = useCallback(
    (item: BehaviorInsight) => {
      const window = data ? `${fmtDate(data.windowFrom)} ~ ${fmtDate(data.windowTo)}` : '';
      setDefectModal({
        kind: item.kind,
        target: item.target,
        draft: {
          title: `[行为洞察] ${item.kindLabel}：${item.target}`,
          content: buildDefectContent(item, window),
          assigneeUserId: '',
          severity: item.kind === 'api-error' ? 'major' : 'minor',
        },
      });
    },
    [data]
  );

  // 下钻抽屉「转为缺陷」：优先复用痛点榜上同 target 的富洞察（证据更全），未上榜则用下钻信息建最小草稿。
  const openDefectModalForDrill = useCallback(() => {
    if (!drillTarget) return;
    const hit = data?.items.find((i) => i.target === drillTarget.target && i.kind === 'api-error')
      ?? data?.items.find((i) => i.target === drillTarget.target);
    if (hit) {
      openDefectModalForInsight(hit);
      return;
    }
    const window = data ? `${fmtDate(data.windowFrom)} ~ ${fmtDate(data.windowTo)}` : '';
    setDefectModal({
      kind: 'api-error',
      target: drillTarget.target,
      draft: {
        title: `[体验下钻] ${drillTarget.label}：${drillTarget.target}`,
        content: [
          '## 体验下钻转报（自动生成）',
          '',
          `- 端点：${drillTarget.target}`,
          `- 来源：团队动态 - 体验全景热力图下钻`,
          `- 分析窗口：${window}`,
          '',
          '> 该端点尚未进入痛点榜（信号偏弱），但被手动下钻识别为需关注项，请结合「AI 根因诊断」与真实请求样本核查。',
        ].join('\n'),
        assigneeUserId: '',
        severity: 'minor',
      },
    });
  }, [drillTarget, data, openDefectModalForInsight]);

  // 缺陷弹窗确认：用用户核对/编辑后的草稿真正创建缺陷 + 回写洞察状态（沿用原直接执行逻辑）。
  const confirmDefect = useCallback(
    async (draft: DefectConvertDraft) => {
      if (!defectModal) return;
      const { kind, target } = defectModal;
      setDefectSubmitting(true);
      const res = await createDefect({
        title: draft.title,
        content: draft.content,
        assigneeUserId: draft.assigneeUserId,
        severity: draft.severity,
      });
      if (!res.success) {
        setDefectSubmitting(false);
        toast.error(res.error?.message ?? '创建缺陷失败');
        return;
      }
      const defect = res.data.defect;
      await setTeamActivityInsightState({
        kind,
        target,
        status: 'confirmed',
        defectId: defect.id,
        defectTitle: defect.title,
      });
      setDefectSubmitting(false);
      setDefectModal(null);
      toast.success(`已创建缺陷《${defect.title}》，可在缺陷管理中跟进`);
      reload();
    },
    [defectModal, reload]
  );

  // 下钻抽屉「转需求」：不再就地展开直接发送，改为生成预填草稿并打开步骤向导弹窗。
  // 优先复用同 target 的富洞察（指标/证据更全），未上榜则用下钻展示名兜底。
  const openRequirementModalForDrill = useCallback(() => {
    if (!drillTarget) return;
    const hit = data?.items.find((i) => i.target === drillTarget.target && i.kind === 'api-error')
      ?? data?.items.find((i) => i.target === drillTarget.target);
    const window = data ? `${fmtDate(data.windowFrom)} ~ ${fmtDate(data.windowTo)}` : '';
    const kind = hit?.kind ?? 'api-error';
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

  // Hero 视图渲染槽：多视角可切换（Wave B）。顶部 segmented 切换器 + 按选中视图条件渲染。
  // 热力图保留原样接线（下钻 + 全屏）；趋势图自取数据；雷达/站点地图/看板复用 mapData/insights 现算。
  // 切视图时给一层轻过渡（淡入 + 微上移），符合「变化可感知」；切回热力图作为各视图空数据引导出口。
  const renderHeroBody = () => {
    switch (heroView) {
      case 'trend':
        return <ExperienceTrend from={from} onSwitchHeatmap={switchToHeatmap} />;
      case 'radar':
        return <ExperienceRadar items={data?.items ?? []} mapData={mapData} onSwitchHeatmap={switchToHeatmap} />;
      case 'sitemap':
        return <ExperienceSiteMap mapData={mapData} onSelectTarget={handleSelectTarget} onSwitchHeatmap={switchToHeatmap} />;
      case 'board':
        return <ExperienceBoard items={data?.items ?? []} onSelectTarget={handleSelectTarget} onSwitchHeatmap={switchToHeatmap} />;
      case 'heatmap':
      default:
        return (
          <ExperienceMap
            data={mapData}
            loading={loading}
            onSelectTarget={handleSelectTarget}
            onRequestFullscreen={() => setFullscreenOpen(true)}
          />
        );
    }
  };

  const renderHeroView = () => (
    <div className="flex flex-col gap-2">
      {/* 视图切换器（segmented）：体验信号的多种可视化模式，冷色海主题，与热力图内 全域/痛点 同款 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
          {HERO_VIEWS.map((v) => {
            const VIcon = v.icon;
            const active = heroView === v.key;
            return (
              <button
                key={v.key}
                type="button"
                onClick={() => setHeroView(v.key)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] transition-colors cursor-pointer ${active ? 'bg-cyan-500/15 text-cyan-200' : 'text-white/45 hover:text-white/75'}`}
              >
                <VIcon size={12} />
                {v.label}
              </button>
            );
          })}
        </div>
      </div>
      {/* key=heroView 触发重挂载 → 走入场过渡（淡入 + 微上移） */}
      <div key={heroView} style={{ animation: 'voc-hero-swap .3s cubic-bezier(.22,1,.36,1) both', minHeight: 0 }}>
        {renderHeroBody()}
      </div>
    </div>
  );

  return (
    <GlassCard className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
      <div className="flex-1" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        <style>{`.voc-row-flash { box-shadow: inset 0 0 0 2px rgba(45,212,191,0.7); border-radius: 6px; }
          @keyframes voc-shimmer-sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
          @keyframes voc-hero-swap { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
        {/* 闭环 ribbon：监测 → 预警 → AI 根因 → 转缺陷 → 修复追踪 → 复测回落，从热力图/洞察现算 */}
        <div className="px-5 pt-4">
          <ExperienceRibbon mapData={mapData} insights={data} />
          {/* Hero：体验全景热力图占满整宽做主视觉。切换时间窗(loading && data)时叠一层「更新中」过渡态，
              旧内容保持可见，数据到达后 ExperienceMap 走 morph 几何补间平滑过渡。 */}
          <div className="relative">
            {renderHeroView()}
            {loading && data && heroView === 'heatmap' ? (
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
          {/* 痛点指数：从右侧竖栏下放到热力图下方的一整块（可折叠） */}
          {data ? (
            statsOpen ? (
              <div className="mt-3">
                <ExperienceStats items={data.items} onCollapse={() => setStatsOpen(false)} />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setStatsOpen(true)}
                title="展开痛点指数面板"
                className="mt-3 w-full inline-flex items-center justify-center gap-2 h-9 rounded-xl border border-white/10 bg-white/[0.03] text-white/45 hover:text-white/80 hover:border-white/25 transition-colors cursor-pointer"
              >
                <BarChart3 size={15} />
                <span className="text-[11px]">展开痛点指数</span>
              </button>
            )
          ) : null}
        </div>
        {/* 数据源状态行：诚实告知信号从哪来、采集到什么程度 */}
        {data ? (
          <div className="sticky top-0 z-10 flex items-center gap-3 flex-wrap px-5 py-2.5 text-[11px] text-white/40 border-b border-white/[0.05] backdrop-blur-md" style={{ background: 'rgba(16,17,19,0.72)' }}>
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
              AI 简报
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

        {briefOpen ? (
          <div className="px-5 py-4 border-b border-white/[0.05] flex flex-col gap-2.5">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-[11px] font-semibold text-cyan-200/90">AI 洞察简报</span>
              {briefModel ? <span className="text-[10px] text-white/30 font-mono">{briefModel}</span> : null}
              {brief.phase === 'connecting' || brief.phase === 'streaming' ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-white/40">
                  <MapSpinner size={12} />
                  {brief.phaseMessage || '生成中…'}
                </span>
              ) : null}
              {brief.phase === 'done' && !briefComplete ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-200/80">
                  生成被中断（连接断开或超长截断），建议重新生成
                </span>
              ) : null}
              <span className="ml-auto flex items-center gap-1.5">
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
                <ActionButton
                  onClick={() => {
                    brief.abort();
                    setBriefOpen(false);
                  }}
                  icon={X}
                  label="关闭"
                />
              </span>
            </div>
            {brief.typing ? (
              <div className="rounded-md px-3.5 py-3 bg-white/[0.02] border border-white/[0.05] text-[12.5px] leading-relaxed text-white/75 max-h-[360px]" style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}>
                {brief.phase === 'done' ? (
                  <MarkdownContent content={brief.typing} variant="reading" />
                ) : (
                  <StreamingText text={brief.typing} streaming mode="blur" />
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {error && !data ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Radar size={36} className="text-white/15" />
            <div className="text-sm text-white/60">{error}</div>
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center px-5">
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
                  className="relative px-5 py-3.5 flex gap-3.5 transition-colors hover:bg-white/[0.02]"
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
                              onClick={() => openDrill(item.target, `${item.kindLabel} · ${item.target}`)}
                              icon={Microscope}
                              label="AI 诊断"
                            />
                          ) : null}
                          {!item.defectId ? (
                            <ActionButton onClick={() => openDefectModalForInsight(item)} icon={Bug} label="转为缺陷" emphasis />
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
              <div
                className="flex flex-col"
                style={{ width: 'min(420px, 94vw)', height: '100vh', animation: 'voc-drawer-in .26s cubic-bezier(.22,1,.36,1)' }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex-1 px-3 py-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                  <ExperienceDrill
                    target={drillTarget.target}
                    label={drillTarget.label}
                    from={from}
                    converting={(defectSubmitting && defectModal?.target === drillTarget.target) || busyKey === `api-error|${drillTarget.target}`}
                    convertingRequirement={reqSubmitting && reqModal?.target === drillTarget.target}
                    requirementNo={data?.items.find((i) => i.target === drillTarget.target && i.requirementNo)?.requirementNo ?? null}
                    onRequestDefectModal={openDefectModalForDrill}
                    onRequestRequirementModal={openRequirementModalForDrill}
                    onClose={closeDrill}
                  />
                </div>
              </div>
              <style>{`@keyframes voc-drawer-in { from { transform: translateX(36px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
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
                style={{ minHeight: 0, padding: '3vh 3vw', animation: 'voc-fs-in .34s cubic-bezier(.16,1,.3,1)', transformOrigin: 'center' }}
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
              <style>{`@keyframes voc-fs-in { from { transform: scale(.86); opacity: 0; } to { transform: scale(1); opacity: 1; } }`}</style>
            </div>,
            document.body
          )
        : null}

      {/* 转为缺陷弹窗：预填可编辑标题/正文 + 指派人（发给谁）+ 严重度，确认后才创建并回写洞察状态 */}
      {defectModal ? (
        <DefectConvertModal
          draft={defectModal.draft}
          submitting={defectSubmitting}
          onConfirm={(draft) => void confirmDefect(draft)}
          onClose={() => {
            if (!defectSubmitting) setDefectModal(null);
          }}
        />
      ) : null}

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
