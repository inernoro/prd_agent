/*
 * StatusPage — CDS 监控中心（/status）。2026-09-08 重做。
 *
 * 一屏三块：
 *   顶部  结论横幅 + 六个关键数（点数字 = 切筛选）
 *   左栏  可搜索、可按状态 / 来源筛选的目标列表，按来源分组（自定义 / 生产 / 分支）
 *   右栏  选中目标的详情（可用率、响应曲线、故障、配置、操作）或全实例故障时间线
 *
 * 目标有三类来源：自定义监控（人在这里添加）、生产发布目标（发布中心推导）、
 * 分支预览服务（分支台账推导）。三者可用率含义完全不同，分组 + 来源标 + 探测方式
 * 三重区分，绝不能让读者以为看的是同一种东西。
 *
 * 落地的几条项目纪律：
 *   - 颜色只走 token / Tailwind 语义类，双主题都可读（cds-theme-tokens）；
 *   - 加载态是三块布局形状的骨架屏，不是静止 spinner（禁止空白等待）；
 *   - 加载 / 有数据 / 失败三态互斥（lib/statusView 的 resolveStatusViewPhase）：
 *     首次加载失败只渲染错误卡片，绝不再让骨架屏一直转着说「正在读取」；
 *   - 桌面填满画布（content-fills-canvas），< lg 退化为自然流并在列表 / 详情间切换
 *     （mobile-layout-fallback）；
 *   - 结论先于数字（conclusion-before-numbers）：横幅先说「谁坏了、多久了」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { AppShell, Crumb, PaletteHint, TopBar, Workspace } from '@/components/layout/AppShell';
import { Button } from '@/components/ui/button';
import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  buildMonitorHeadline,
  filterTargets,
  formatLatency,
  groupBranchesByProject,
  mainSiteTargets,
  pickDefaultTargetId,
  type BranchView,
  type CustomMonitor,
  type ProjectBranchGroup,
  type StatusFilter,
  type TargetFilter,
  type UptimeIncidentView,
  type UptimeSample,
  type UptimeSummary,
  type UptimeTargetSummary,
} from '@/lib/monitorCenter';
import { resolveStatusViewPhase } from '@/lib/statusView';
import { BranchModal } from './status/BranchModal';
import { CoverageDialog } from './status/CoverageDialog';
import { IncidentTimeline, type IncidentFilter } from './status/IncidentTimeline';
import { MonitorEditorDialog } from './status/MonitorEditorDialog';
import { OverviewStrip } from './status/OverviewStrip';
import { TargetDetail, type TargetActions } from './status/TargetDetail';
import { TargetList } from './status/TargetList';
import { MonitorCenterErrorCard, MonitorCenterSkeleton, SegmentedControl } from './status/primitives';

const SEGMENTS = 90;
const POLL_INTERVAL_MS = 30_000;
const NOTICE_TTL_MS = 6_000;

type RightTab = 'detail' | 'incidents';

interface Notice {
  tone: 'ok' | 'danger' | 'neutral';
  text: string;
}

function describeProbeResult(target: UptimeTargetSummary, sample: UptimeSample, status: string): Notice {
  const head = `${target.name}：${sample.up ? '探测成功' : '探测失败'} · ${formatLatency(sample.ms)}${sample.code ? ` · HTTP ${sample.code}` : ''}`;
  const tail = sample.up
    ? (status === 'up' ? '' : '（状态仍待确认，连续成功后转正常）')
    : `（${sample.err || '无原因'}；连续失败达阈值才判定故障，当前 ${status === 'down' ? '已判定故障' : '仍在观察'}）`;
  return { tone: sample.up ? 'ok' : 'danger', text: `${head}${tail}` };
}

export function StatusPage(): JSX.Element {
  const [summary, setSummary] = useState<UptimeSummary | null>(null);
  const [incidents, setIncidents] = useState<UptimeIncidentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<TargetFilter>({ query: '', status: 'all', source: 'all' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>('detail');
  const [incidentFilter, setIncidentFilter] = useState<IncidentFilter>('all');
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [editor, setEditor] = useState<{ open: boolean; monitor: CustomMonitor | null }>({ open: false, monitor: null });
  const [busy, setBusy] = useState<'probe' | 'toggle' | 'remove' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [branchModalProject, setBranchModalProject] = useState<string | null>(null);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const mounted = useRef(true);

  // 必须在 setup 里把 ref 置回 true：React.StrictMode（dev）会跑
  // setup → cleanup → setup 一整轮。只在 cleanup 里置 false 的话，第二次
  // setup 之后 mounted 永远是 false，所有 /api/uptime/* 响应都被丢弃，
  // 页面永远停在骨架屏上（Codex PR #1273 P2）。
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const [next, incidentPayload] = await Promise.all([
        apiRequest<UptimeSummary>(`/api/uptime/summary?segments=${SEGMENTS}`),
        apiRequest<{ incidents: UptimeIncidentView[] }>('/api/uptime/incidents?limit=100'),
      ]);
      if (!mounted.current) return;
      setSummary(next);
      setIncidents(incidentPayload.incidents || []);
      setNow(Date.now());
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const targets = summary?.targets ?? [];
  // 主列表只放主站（自定义 + 生产）；分支按项目折成汇总行，明细进模态窗。
  const filtered = useMemo(() => filterTargets(mainSiteTargets(targets), filter), [targets, filter]);
  const branchGroups = useMemo(() => {
    const groups = groupBranchesByProject(targets, now);
    if (filter.status === 'all' && !filter.query.trim()) return groups;
    // 状态 / 搜索筛选也作用到分支汇总：只留有命中分支的项目
    return groups.filter((g) => g.branches.some((b) => {
      const q = filter.query.trim().toLowerCase();
      const hit = !q || b.branchName.toLowerCase().includes(q) || b.projectName.toLowerCase().includes(q);
      const st = filter.status === 'all' ? true
        : filter.status === 'down' ? b.tone === 'bad'
          : filter.status === 'up' ? b.tone === 'ok'
            : filter.status === 'paused' ? b.bucket === 'idle'
              : b.bucket === 'unmeasured';
      return hit && st;
    }));
  }, [targets, filter, now]);
  const branchModalGroup = useMemo(
    () => (branchModalProject ? groupBranchesByProject(targets, now).find((g) => g.projectId === branchModalProject) ?? null : null),
    [targets, now, branchModalProject],
  );
  // 选中项优先在全量里找（筛选掉了也不丢详情）；没有选中时按「故障优先」挑一个。
  const selected = useMemo(() => {
    const current = selectedId ? targets.find((t) => t.id === selectedId) : undefined;
    if (current) return current;
    const fallbackId = pickDefaultTargetId(filtered.length > 0 ? filtered : targets.filter((t) => t.status === 'down' || t.source !== 'branch'), null)
      ?? pickDefaultTargetId(targets, null);
    return fallbackId ? targets.find((t) => t.id === fallbackId) ?? null : null;
  }, [targets, filtered, selectedId]);
  const headline = useMemo(() => (summary ? buildMonitorHeadline(summary, incidents, now) : null), [summary, incidents, now]);
  const ongoingCount = incidents.filter((i) => i.ongoing).length;

  const openTarget = useCallback((id: string): void => {
    setSelectedId(id);
    setRightTab('detail');
    setMobileView('detail');
  }, []);
  const openBranch = useCallback((branch: BranchView): void => { openTarget(branch.primary.id); }, [openTarget]);
  const openBranches = useCallback((group: ProjectBranchGroup): void => { setBranchModalProject(group.projectId); }, []);

  const probeTarget = useCallback(async (targetId: string): Promise<{ sample: UptimeSample; status: string } | null> => {
    try {
      const res = await apiRequest<{ ok: boolean; sample: UptimeSample; status: string }>(
        `/api/uptime/targets/${encodeURIComponent(targetId)}/probe`,
        { method: 'POST' },
      );
      return { sample: res.sample, status: res.status };
    } catch (err) {
      // 409 = 目标此刻不该探（刚被暂停），台账已经标好档，不算失败。
      if (err instanceof ApiError && err.status === 409) return null;
      throw err;
    }
  }, []);

  const actions: TargetActions = useMemo(() => ({
    probeNow: async (target) => {
      setBusy('probe');
      try {
        const result = await probeTarget(target.id);
        if (result) setNotice(describeProbeResult(target, result.sample, result.status));
        await load();
      } catch (err) {
        setNotice({ tone: 'danger', text: `立即探测失败：${err instanceof ApiError ? err.message : String(err)}` });
      } finally {
        setBusy(null);
      }
    },
    toggleEnabled: async (target) => {
      if (!target.monitorId) return;
      setBusy('toggle');
      try {
        const enabled = target.enabled === false;
        await apiRequest(`/api/uptime/monitors/${encodeURIComponent(target.monitorId)}`, { method: 'PUT', body: { enabled } });
        await probeTarget(target.id);
        setNotice({ tone: 'neutral', text: enabled ? `${target.name} 已恢复探测，刚刚探过一次` : `${target.name} 已暂停，不再探测、不计故障` });
        await load();
      } catch (err) {
        setNotice({ tone: 'danger', text: `操作失败：${err instanceof ApiError ? err.message : String(err)}` });
      } finally {
        setBusy(null);
      }
    },
    edit: (target) => {
      if (!target.monitorId) return;
      const id = target.monitorId;
      apiRequest<{ monitors: CustomMonitor[] }>('/api/uptime/monitors')
        .then((res) => {
          const monitor = (res.monitors || []).find((m) => m.id === id);
          if (!monitor) {
            setNotice({ tone: 'danger', text: '这条监控的定义已不存在，可能刚被别人删掉；刷新后再试。' });
            return;
          }
          setEditor({ open: true, monitor });
        })
        .catch((err) => setNotice({ tone: 'danger', text: `读取监控定义失败：${err instanceof ApiError ? err.message : String(err)}` }));
    },
    remove: async (target) => {
      if (!target.monitorId) return;
      setBusy('remove');
      try {
        await apiRequest(`/api/uptime/monitors/${encodeURIComponent(target.monitorId)}`, { method: 'DELETE' });
        setNotice({ tone: 'neutral', text: `已删除监控「${target.name}」` });
        setSelectedId(null);
        setMobileView('list');
        await load();
      } catch (err) {
        setNotice({ tone: 'danger', text: `删除失败：${err instanceof ApiError ? err.message : String(err)}` });
      } finally {
        setBusy(null);
      }
    },
  }), [load, probeTarget]);

  const onSaved = useCallback(async (monitor: CustomMonitor): Promise<void> => {
    const targetId = `monitor@${monitor.id}`;
    // 保存即探：不让用户对着「下一轮 60 秒后才出现」发呆。
    try {
      const result = await probeTarget(targetId);
      setNotice(result
        ? { tone: result.sample.up ? 'ok' : 'danger', text: `${monitor.name}：已保存并探测一次，${result.sample.up ? '成功' : '失败'} · ${formatLatency(result.sample.ms)}${result.sample.err ? ` · ${result.sample.err}` : ''}` }
        : { tone: 'neutral', text: `${monitor.name}：已保存（当前为暂停状态）` });
    } catch (err) {
      setNotice({ tone: 'danger', text: `已保存，但首次探测失败：${err instanceof ApiError ? err.message : String(err)}` });
    }
    await load();
    openTarget(targetId);
  }, [load, openTarget, probeTarget]);

  // 三态互斥：只有 loading 才允许出现骨架，error（且无数据）走引导式错误卡片。
  const phase = resolveStatusViewPhase({ hasSummary: summary !== null, error });
  const onStatusFilter = (status: StatusFilter): void => {
    setFilter((prev) => ({ ...prev, status }));
    setMobileView('list');
  };

  return (
    <AppShell
      active="status"
      topbar={(
        <TopBar
          left={<Crumb items={[{ label: 'CDS', href: '/project-list' }, { label: '监控中心' }]} />}
          right={(
            <>
              <PaletteHint />
              <Button variant="outline" size="sm" onClick={() => void load()} disabled={refreshing}>
                <RefreshCw className={refreshing ? 'animate-spin' : undefined} />
                {refreshing ? '刷新中' : '刷新'}
              </Button>
              <Button size="sm" onClick={() => setEditor({ open: true, monitor: null })} disabled={phase !== 'ready'}>
                <Plus />
                添加监控
              </Button>
            </>
          )}
        />
      )}
    >
      <Workspace fluid className="cds-workspace--fill">
        <div className="flex flex-col gap-3 lg:h-full lg:min-h-0">
          {/* 有数据时本次轮询失败只做顶部提示，保留旧数据；无数据时交给错误卡片 */}
          {phase === 'ready' && error ? (
            <div className="shrink-0 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              最近一次刷新失败（显示的是上一次成功的数据）：{error}
            </div>
          ) : null}
          {notice ? (
            <div
              role="status"
              className={cn(
                'shrink-0 rounded-lg border px-3 py-2 text-xs leading-5',
                notice.tone === 'ok' ? 'border-ok/40 bg-ok-soft text-ok' : notice.tone === 'danger' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
              )}
            >
              {notice.text}
            </div>
          ) : null}

          {phase === 'loading' ? (
            <MonitorCenterSkeleton />
          ) : phase === 'error' || !summary || !headline ? (
            <MonitorCenterErrorCard message={error || '未知错误'} onRetry={() => void load()} retrying={refreshing} pollSeconds={POLL_INTERVAL_MS / 1000} />
          ) : (
            <>
              <div className="shrink-0">
                <OverviewStrip summary={summary} incidents={incidents} headline={headline} statusFilter={filter.status} onStatusFilter={onStatusFilter} onOpenCoverage={() => setCoverageOpen(true)} now={now} />
              </div>

              <div className="flex flex-col gap-3 lg:grid lg:min-h-0 lg:flex-1 lg:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[380px_minmax(0,1fr)]">
                <div className={cn('min-h-0 lg:h-full', mobileView === 'detail' ? 'hidden lg:block' : 'block')}>
                  <div className="h-[60vh] min-h-0 lg:h-full">
                    <TargetList
                      targets={filtered}
                      allTargets={targets}
                      branchGroups={branchGroups}
                      filter={filter}
                      onFilter={setFilter}
                      selectedId={selected?.id ?? null}
                      onSelect={openTarget}
                      onOpenBranches={openBranches}
                    />
                  </div>
                </div>

                <div className={cn('flex min-h-0 flex-col gap-2 lg:h-full', mobileView === 'list' ? 'hidden lg:flex' : 'flex')}>
                  <div className="flex shrink-0 items-center justify-between gap-2">
                    <SegmentedControl<RightTab>
                      value={rightTab}
                      options={[
                        { value: 'detail', label: '目标详情' },
                        { value: 'incidents', label: '故障时间线', count: ongoingCount > 0 ? ongoingCount : undefined },
                      ]}
                      onChange={setRightTab}
                      ariaLabel="右栏内容"
                    />
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">
                      分支服务直连容器宿主端口（不经预览代理，不影响空闲降温）；生产与自定义目标请求其地址
                    </span>
                  </div>
                  <div className="min-h-0 flex-1">
                    {rightTab === 'incidents' ? (
                      <IncidentTimeline incidents={incidents} filter={incidentFilter} onFilter={setIncidentFilter} onOpenTarget={openTarget} />
                    ) : selected ? (
                      <TargetDetail
                        target={selected}
                        incidents={incidents}
                        generatedAt={summary.generatedAt}
                        now={now}
                        actions={actions}
                        busy={busy}
                        onBack={() => setMobileView('list')}
                      />
                    ) : (
                      <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-raised))] px-6 py-10 text-center">
                        <div className="text-sm font-medium">还没有可监控的目标</div>
                        <div className="max-w-md text-xs leading-5 text-muted-foreground">
                          监控中心盯三类对象：你在这里添加的自定义监控（任意网址、关键字或 TCP 端口）、
                          发布中心里配好上线地址（healthcheckUrl）的生产发布目标，以及正在运行的分支服务。
                          探测器每 {summary.intervalSeconds} 秒跑一轮，首批数据约 {summary.firstDataEtaSeconds} 秒后出现。
                        </div>
                        <div className="flex flex-wrap justify-center gap-2">
                          <Button size="sm" onClick={() => setEditor({ open: true, monitor: null })}>
                            <Plus />
                            添加第一个监控
                          </Button>
                          <Button variant="outline" size="sm" asChild>
                            <a href="/project-list">去项目列表部署分支</a>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </Workspace>

      <BranchModal
        group={branchModalGroup}
        open={branchModalProject !== null}
        onOpenChange={(open) => { if (!open) setBranchModalProject(null); }}
        onSelectBranch={openBranch}
      />
      <CoverageDialog open={coverageOpen} onOpenChange={setCoverageOpen} coverage={summary?.coverage} prober={summary?.prober} />
      <MonitorEditorDialog
        open={editor.open}
        monitor={editor.monitor}
        onOpenChange={(open) => setEditor((prev) => ({ ...prev, open }))}
        onSaved={onSaved}
      />
    </AppShell>
  );
}
