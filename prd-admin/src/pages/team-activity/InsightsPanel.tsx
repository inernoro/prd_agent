/**
 * 行为洞察面板：把「沉默的行为信号」聚合成带证据的改进方向，并支持处理闭环。
 * 每条洞察：是什么行为 / 发生在哪 / 涉及多少人多少次 / 影响多大 / 建议改什么，
 * 操作：转为缺陷（接入 defect-agent 修复流水线）/ 标记已修复 / 忽略（指纹级持久化，不再打扰）。
 * 数据源：apirequestlogs（报错/慢端点，历史即有）+ behavior_events（路由信号，自采集上线起累积）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, BookOpen, Bug, Check, CheckCircle2, ClipboardList, EyeOff as IgnoreIcon, Microscope, Radar, RotateCcw, ScrollText, Users, X } from 'lucide-react';
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
  // 右栏二态：stats=痛点指数面板 / drill=端点下钻诊断（点痛点块或痛点榜「AI 诊断」进入）
  const [rightMode, setRightMode] = useState<'stats' | 'drill'>('stats');
  const [drillTarget, setDrillTarget] = useState<{ target: string; label: string } | null>(null);
  const [drillConverting, setDrillConverting] = useState(false);
  const [drillConvertingReq, setDrillConvertingReq] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
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

  // 点击热力图痛点块 / 痛点榜「AI 诊断」→ 右栏切到下钻抽屉（查真实明细 + AI 根因诊断，未上榜也能下钻）
  const openDrill = useCallback((target: string, label: string) => {
    setDrillTarget({ target, label });
    setRightMode('drill');
    setStatsOpen(true); // 折叠态时点下钻自动展开右栏，否则抽屉无处可渲染
  }, []);

  const handleSelectTarget = useCallback(
    (target: string, fallback?: { label: string; metric: string }) => {
      openDrill(target, fallback?.label ?? target);
    },
    [openDrill]
  );

  const closeDrill = useCallback(() => {
    setRightMode('stats');
    setDrillTarget(null);
    setDrillConverting(false);
    setDrillConvertingReq(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

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

  const convertToDefect = useCallback(
    async (item: BehaviorInsight) => {
      const key = `${item.kind}|${item.target}`;
      setBusyKey(key);
      const window = data ? `${fmtDate(data.windowFrom)} ~ ${fmtDate(data.windowTo)}` : '';
      const res = await createDefect({
        title: `[行为洞察] ${item.kindLabel}：${item.target}`,
        content: buildDefectContent(item, window),
        assigneeUserId: '',
        severity: item.kind === 'api-error' ? 'major' : 'minor',
      });
      if (!res.success) {
        setBusyKey(null);
        toast.error(res.error?.message ?? '创建缺陷失败');
        return;
      }
      const defect = res.data.defect;
      await setTeamActivityInsightState({
        kind: item.kind,
        target: item.target,
        status: 'confirmed',
        defectId: defect.id,
        defectTitle: defect.title,
      });
      setBusyKey(null);
      toast.success(`已创建缺陷《${defect.title}》，可在缺陷管理中跟进`);
      reload();
    },
    [data, reload]
  );

  // 下钻抽屉里「转为缺陷」：优先复用痛点榜上同 target 的富洞察（证据更全），未上榜则建一条最小缺陷
  const convertDrillToDefect = useCallback(async () => {
    if (!drillTarget) return;
    const hit = data?.items.find((i) => i.target === drillTarget.target && i.kind === 'api-error')
      ?? data?.items.find((i) => i.target === drillTarget.target);
    if (hit) {
      await convertToDefect(hit);
      return;
    }
    setDrillConverting(true);
    const window = data ? `${fmtDate(data.windowFrom)} ~ ${fmtDate(data.windowTo)}` : '';
    const res = await createDefect({
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
    });
    if (!res.success) {
      setDrillConverting(false);
      toast.error(res.error?.message ?? '创建缺陷失败');
      return;
    }
    const defect = res.data.defect;
    await setTeamActivityInsightState({
      kind: 'api-error',
      target: drillTarget.target,
      status: 'confirmed',
      defectId: defect.id,
      defectTitle: defect.title,
    });
    setDrillConverting(false);
    toast.success(`已创建缺陷《${defect.title}》，可在缺陷管理中跟进`);
    reload();
  }, [drillTarget, data, convertToDefect, reload]);

  // 下钻抽屉里「转需求」：把痛点落进所选产品的需求池（VOC 闭环收口）。
  // 优先复用同 target 的富洞察（指标/证据更全），未上榜则用下钻展示名兜底。
  const convertDrillToRequirement = useCallback(
    async (productId: string) => {
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
      setDrillConvertingReq(true);
      const res = await insightToRequirement({ kind, target: drillTarget.target, title, description, productId });
      setDrillConvertingReq(false);
      if (!res.success) {
        toast.error(res.error?.message ?? '流转需求失败');
        return;
      }
      toast.success(
        res.data.alreadyExists
          ? `该痛点已转为需求 #${res.data.requirementNo}`
          : `已流转为产品需求 #${res.data.requirementNo}，可在产品管理需求池跟进`
      );
      reload();
    },
    [drillTarget, data, reload]
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

  return (
    <GlassCard className="flex-1 flex flex-col" style={{ minHeight: 0 }}>
      <div className="flex-1" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        <style>{`.voc-row-flash { box-shadow: inset 0 0 0 2px rgba(45,212,191,0.7); border-radius: 6px; }`}</style>
        {/* 体验全景热力图（主视觉）+ 体验痛点指数（右侧可折叠）：点痛点块下钻到下方痛点榜 */}
        <div className="px-5 pt-4">
          {/* 闭环 ribbon：监测 → 预警 → AI 根因 → 转缺陷 → 修复追踪 → 复测回落，从热力图/洞察现算 */}
          <ExperienceRibbon mapData={mapData} insights={data} />
          <div className="flex gap-3 items-start">
            <div className="flex-1 min-w-0">
              <ExperienceMap data={mapData} loading={loading} onSelectTarget={handleSelectTarget} />
            </div>
            {statsOpen && rightMode === 'drill' && drillTarget ? (
              <div className="w-[340px] shrink-0">
                <ExperienceDrill
                  target={drillTarget.target}
                  label={drillTarget.label}
                  from={from}
                  converting={drillConverting || busyKey === `api-error|${drillTarget.target}`}
                  convertingRequirement={drillConvertingReq}
                  requirementNo={data?.items.find((i) => i.target === drillTarget.target && i.requirementNo)?.requirementNo ?? null}
                  onConvertDefect={() => void convertDrillToDefect()}
                  onConvertRequirement={(productId) => void convertDrillToRequirement(productId)}
                  onClose={closeDrill}
                />
              </div>
            ) : statsOpen && data ? (
              <div className="w-[290px] shrink-0">
                <ExperienceStats items={data.items} onCollapse={() => setStatsOpen(false)} />
              </div>
            ) : !statsOpen ? (
              <button
                type="button"
                onClick={() => setStatsOpen(true)}
                title="展开痛点指数面板"
                className="shrink-0 w-9 self-stretch flex flex-col items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] text-white/45 hover:text-white/80 hover:border-white/25 transition-colors cursor-pointer"
              >
                <BarChart3 size={15} />
                <span className="text-[11px]" style={{ writingMode: 'vertical-rl' }}>
                  痛点指数
                </span>
              </button>
            ) : null}
          </div>
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
                            <ActionButton onClick={() => void convertToDefect(item)} icon={Bug} label="转为缺陷" emphasis />
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
