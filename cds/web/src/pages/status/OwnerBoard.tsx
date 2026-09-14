/*
 * 项目负责人的第一屏。
 *
 * 主语是「我的业务」，不是「CDS 的探测目标」。一屏四块，从上到下：
 *   项目 + 环境      我在看谁、看哪几个环境（选择存浏览器，账号是共享的）
 *   结论横幅         一句判断：谁坏了、在哪个环境、什么值不对
 *   业务卡片网格     异常置顶；同一条业务的多个环境并排，对比即归因
 *   基础设施折叠     容器与端口塌了要知道，但那不是「我的业务」
 *
 * 判据全在 lib/ownerBoard.ts，这里只负责摆放与着色。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, ArrowRight, BellRing, Cable, CheckCircle2, ChevronRight, Globe, Info, Waves } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DiscoveryStrip } from './DiscoveryStrip';
import { AvailabilityBar } from './primitives';
import { formatRelative } from '@/lib/monitorCenter';
import type { AlarmChannelView, MonitorEnvironment, UptimeTargetSummary } from '@/lib/monitorCenter';
import {
  buildOwnerBoard,
  describeEvidence,
  describeRow,
  shortPredicate,
  listEnvironments,
  listProjects,
  scopeTargets,
  type BusinessRow,
  type CellHealth,
  type OwnerScope,
  type ProjectOption,
} from '@/lib/ownerBoard';

const HEALTH_CELL: Record<CellHealth, string> = {
  down: 'border-destructive/50 bg-destructive/15 text-destructive',
  // 逾期与零样本同色系（都是「绿灯不作数」），但它排在更前面——见 SEVERITY 注释。
  overdue: 'border-warn/50 bg-warn-soft text-warn',
  stale: 'border-warn/50 bg-warn-soft text-warn',
  unknown: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
  up: 'border-ok/40 bg-ok-soft text-ok',
};

const CARD_TONE: Record<CellHealth, string> = {
  overdue: 'border-warn/40 bg-warn-soft/40',
  down: 'border-destructive/45 bg-destructive/5',
  stale: 'border-warn/40 bg-warn-soft/40',
  unknown: 'border-[hsl(var(--hairline))]',
  up: 'border-[hsl(var(--hairline))]',
};

const BANNER_TONE = {
  danger: 'border-destructive/40 bg-destructive/10 text-destructive',
  warn: 'border-warn/40 bg-warn-soft text-warn',
  ok: 'border-ok/40 bg-ok-soft text-ok',
  empty: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-foreground',
} as const;

const BANNER_ICON = {
  danger: AlertTriangle,
  warn: Activity,
  ok: CheckCircle2,
  empty: Info,
} as const;

/** 一个数字 + 一个标签。数字大而实，标签小而淡——扫读靠的是这个落差。 */
function Stat({ value, label, tone }: { value: string; label: string; tone?: string }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col leading-none">
      <span className={cn('font-mono text-[0.9375rem] tabular-nums tracking-tight', tone || 'text-foreground')}>{value}</span>
      <span className="mt-1 text-[0.625rem] text-muted-foreground">{label}</span>
    </div>
  );
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(v >= 1 ? 0 : 2)}%`);
const ms = (v: number | null): string => (v === null ? '—' : `${Math.round(v)} ms`);

/**
 * 一条业务的卡片。
 *
 * 2026-09-14 重做。原先它是：一个 56px 的纯装饰图标框 + 一句「N 个环境都通过判据」
 * + 一整条 `GET https://…` 长地址，六张卡长得一模一样、没有一个数字，用户的原话是
 * 「死里死气的，不太专业」。
 *
 * 病根不是配色，是**卡片上没有信息**：可用率、平均响应、采样次数、24 小时柱条
 * 这几样一直都在 target 上，只是没端出来（和之前「对照层」那次同一个病）。
 * 监控卡之所以看着专业，靠的就是这几样——密度、真实数字、一条会动的条带。
 */
function BusinessCard({ row, now, onOpen }: { row: BusinessRow; now: number; onOpen: (targetId: string) => void }): JSX.Element {
  const worstCell = row.cells.find((c) => c.health === row.worst) ?? row.cells[0];
  const ModeIcon = row.observeMode === 'passive' ? Waves : ArrowRight;
  const predicate = row.probe ? shortPredicate(row.probe) : '';
  const tone = row.worst === 'down' ? 'text-destructive'
    : row.worst === 'overdue' || row.worst === 'stale' ? 'text-warn'
      : 'text-ok';

  return (
    <button
      type="button"
      onClick={() => onOpen(worstCell?.targetId ?? row.cells[0]?.targetId ?? '')}
      className={cn(
        'group flex min-w-0 flex-col gap-2.5 rounded-lg border p-3 text-left transition-all',
        'hover:-translate-y-px hover:shadow-sm',
        CARD_TONE[row.worst],
      )}
    >
      {/* 标题行：状态点 + 名字 + 环境格子。装饰性的大图标框已删——它占四分之一宽度只承载一位信息。 */}
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT_TONE[row.worst])} />
        <ModeIcon
          className={cn('h-3 w-3 shrink-0', row.observeMode === 'passive' ? 'text-info' : 'text-primary-ink')}
          aria-label={row.observeMode === 'passive' ? '被动观测' : '主动观测'}
        />
        <span className="truncate text-[0.8125rem] font-medium text-foreground">{row.name}</span>
        <div className="ml-auto flex shrink-0 gap-1">
          {row.cells.map((cell) => (
            <span
              key={cell.environment}
              title={`${cell.label}：${cell.reason || '正常'}`}
              className={cn('rounded border px-1 font-mono text-[0.625rem] leading-4', HEALTH_CELL[cell.health])}
            >
              {cell.short}
            </span>
          ))}
        </div>
      </div>

      {/* 数字行：可用率 / 平均响应 / 采样次数。null 一律显示「—」，不补 0——
          0 的意思是「全挂」，不是「不知道」。 */}
      <div className="flex items-start gap-5">
        <Stat value={pct(worstCell?.availability24h ?? null)} label="24h 可用率" tone={tone} />
        <Stat value={ms(worstCell?.avgLatencyMs24h ?? null)} label="平均响应" />
        <Stat
          value={row.observeMode === 'passive' && worstCell?.sampleCount !== undefined
            ? `${worstCell.sampleCount}`
            : `${worstCell?.sampleCount24h ?? 0}`}
          label={row.observeMode === 'passive' ? '窗口内调用' : '24h 采样'}
        />
      </div>

      {/* 24 小时柱条：让这一屏活起来的那一条，也是「他干活了吗」最直观的答案。 */}
      {worstCell && worstCell.buckets.length > 0 ? (
        <AvailabilityBar
          buckets={worstCell.buckets}
          segments={48}
          compact
          className="opacity-80 transition-opacity group-hover:opacity-100"
          label={`${row.name} 最近 24 小时可用率分布`}
        />
      ) : null}

      {/* 状态那一句：坏的时候说原因，好的时候说证据。 */}
      <div className={cn(
        'truncate text-[0.6875rem]',
        row.worst === 'down' ? 'text-destructive'
          : row.worst === 'overdue' || row.worst === 'stale' ? 'text-warn'
            : 'text-muted-foreground',
      )}>
        {describeRow(row)}
      </div>

      {/* 判据 + 证据。地址退到悬停里——它是查证时才要的东西，不该每天占八成宽度。 */}
      <div className="flex min-w-0 items-center gap-2 border-t border-[hsl(var(--hairline))] pt-2">
        {predicate ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted-foreground" title={row.probe}>
            {predicate}
          </span>
        ) : <span className="flex-1" />}
        <span className={cn(
          'shrink-0 font-mono text-[0.625rem]',
          row.worst === 'overdue' ? 'text-warn' : 'text-muted-foreground/80',
        )}>
          {describeEvidence(row, now)}
        </span>
      </div>
    </button>
  );
}

/**
 * 需要先选项目才能用的那两块（自检端点、公开面板）在「全部项目」下的占位。
 *
 * 之前这里直接 `: null`——功能对默认进来的人**等于不存在**：
 * 编译过、测试过、通读也挑不出，只有真人冷启动走一遍才会发现死胡同
 * （2026-09-11 角色验收：后端工程师和对外 PM 两个角色同时卡在这里）。
 * 条件渲染是一种静默的功能消失，所以不许留空，要留一句话说清怎么把它打开。
 */
function NeedsProjectRow({ icon: Icon, title, what, projects, onPick }: {
  icon: LucideIcon;
  title: string;
  what: string;
  projects: ReadonlyArray<ProjectOption>;
  onPick: (projectId: string) => void;
}): JSX.Element {
  // 只有一个项目时不该让人再去上面找一遍——直接给那一个的按钮（用户输入最小原则）。
  const only = projects.length === 1 ? projects[0] : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[hsl(var(--hairline-strong))] px-3.5 py-2.5">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{title}</span>
      <span className="text-[0.6875rem] text-muted-foreground">
        {what} —— 它是按项目走的，先选一个项目才能用
      </span>
      <div className="flex-grow" />
      {only ? (
        <button
          type="button"
          onClick={() => onPick(only.id)}
          className="rounded-md border border-[hsl(var(--hairline-strong))] px-2 py-1 text-[0.6875rem] text-foreground transition-colors hover:border-primary/50"
        >
          选「{only.name}」
        </button>
      ) : (
        <span className="text-[0.6875rem] text-muted-foreground">在上面「我的项目」里点一个</span>
      )}
    </div>
  );
}

const DOT_TONE: Record<CellHealth, string> = {
  down: 'bg-destructive',
  overdue: 'bg-warn',
  stale: 'bg-warn',
  unknown: 'bg-[hsl(var(--hairline-strong))]',
  up: 'bg-ok',
};

const ALARM_TONE: Record<AlarmChannelView['status'] | 'unknown', string> = {
  unconfigured: 'border-destructive/40 bg-destructive/10',
  failing: 'border-destructive/40 bg-destructive/10',
  untested: 'border-warn/40 bg-warn-soft/40',
  healthy: 'border-ok/30 bg-ok-soft/40',
  unknown: 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))]',
};

/**
 * 「出事了会不会有人告诉我」这一行。
 *
 * 四档文案各自回答同一个问题，一档都不许省成「未知」——除了服务端真没下发的那种
 * 未知，那时也要明说「不知道」，而不是假装通着。
 */
function AlarmRow({ alarm, now }: { alarm: AlarmChannelView | undefined; now: number }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [drill, setDrill] = useState<{ ok: boolean; reason?: string } | null>(null);
  const runDrill = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiRequest<{ ok: boolean; reason?: string }>('/api/uptime/alarm-drill', { method: 'POST', body: {} });
      setDrill(r);
    } catch (err) {
      setDrill({ ok: false, reason: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }, []);

  const tone = ALARM_TONE[alarm?.status ?? 'unknown'];
  const text = !alarm
    ? '通知通道状态未知 —— 这个实例没有下发通道信息，出问题时有没有人被通知，现在说不准'
    : alarm.status === 'unconfigured'
      ? `出问题时不会有任何人被通知 —— ${alarm.channel}的凭据没配齐${alarm.missing?.length ? `（缺 ${alarm.missing.join('、')}）` : ''}`
      : alarm.status === 'failing'
        ? `上一次通知没送出去：${alarm.last?.reason || '原因不明'} —— 现在出问题也不会有人收到`
        : alarm.status === 'untested'
          ? `${alarm.channel}已接上，但这个进程还没真发过一次 —— 能不能送到仍然是未知数，点右边演练一次`
          : `${alarm.channel}通着，已成功送出 ${alarm.delivered} 次${alarm.last ? `，上一次 ${formatRelative(alarm.last.at, now)}` : ''}`;

  return (
    <div className={cn('flex flex-wrap items-center gap-2 rounded-lg border px-3.5 py-2.5', tone)}>
      <BellRing className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">通知</span>
      <span className="text-[0.6875rem] text-foreground">{text}</span>
      <div className="flex-grow" />
      {drill ? (
        <span className={cn('text-[0.6875rem]', drill.ok ? 'text-ok' : 'text-destructive')}>
          {drill.ok ? '演练已送达' : `演练失败：${drill.reason || '原因不明'}`}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void runDrill()}
        disabled={busy}
        className="shrink-0 rounded-md border border-[hsl(var(--hairline-strong))] px-2 py-1 text-[0.6875rem] text-foreground transition-colors hover:border-primary/50 disabled:opacity-60"
      >
        {busy ? '演练中' : '演练一次通知'}
      </button>
    </div>
  );
}

interface StatusPageState {
  open: boolean;
  path: string | null;
}

export function OwnerBoard({
  targets,
  scope,
  now,
  prober,
  alarm,
  onScope,
  onOpenTarget,
  onAddMonitor,
  onReload,
}: {
  targets: ReadonlyArray<UptimeTargetSummary>;
  /** 判断时刻。由页面统一给，组件不自己取 Date.now()——否则每次重渲染判据都在动。 */
  now: number;
  /**
   * 探测器自身活性（summary.prober）。拿不到就传 null。
   * **不许在这里兜一个 stalled:false**：那等于探测器一挂，面板就开始替它撒谎。
   */
  prober: { stalled: boolean; lastCycleAt: number | null } | null;
  /**
   * 通知通道状态。undefined = 服务端没下发 = **不知道**，按「未知」渲染。
   * 这里同样不许兜一个「通着」：铃哑了还替它说好话，比没有这一行更糟。
   */
  alarm: AlarmChannelView | undefined;
  scope: OwnerScope;
  onScope: (next: OwnerScope) => void;
  onOpenTarget: (targetId: string) => void;
  onAddMonitor: () => void;
  /** 插上 / 拔掉端点之后监控项会变，让页面重拉一次摘要 */
  onReload: () => void;
}): JSX.Element {
  const projects = useMemo(() => listProjects(targets, now), [targets, now]);
  const projectTargets = useMemo(
    () => scopeTargets(targets, { projectId: scope.projectId, environments: null }),
    [targets, scope.projectId],
  );
  const environments = useMemo(() => listEnvironments(projectTargets), [projectTargets]);
  const scoped = useMemo(() => scopeTargets(projectTargets, { projectId: null, environments: scope.environments }), [projectTargets, scope.environments]);
  const board = useMemo(
    () => buildOwnerBoard(scoped, projectTargets, { now, prober }),
    [scoped, projectTargets, now, prober],
  );

  const activeEnvs = new Set(scope.environments ?? environments);
  /**
   * 把被环境筛选挡住的业务监控勾回来。
   *
   * 空白第一屏必须给得出这一步：只告诉用户「它们在分支预览」而不给切换，
   * 等于让他自己去猜该点哪个 chip（本次角色验收里老板就是这么卡住的）。
   */
  const revealHidden = (): void => {
    const hidden = board.hiddenEnvironments;
    if (!hidden || hidden.length === 0) return;
    const next = new Set([...activeEnvs, ...hidden]);
    onScope({ ...scope, environments: environments.filter((e) => next.has(e)) });
  };
  const toggleEnv = (env: MonitorEnvironment): void => {
    const next = new Set(activeEnvs);
    if (next.has(env)) next.delete(env);
    else next.add(env);
    onScope({ ...scope, environments: environments.filter((e) => next.has(e)) });
  };

  // 公开面板的开关状态跟着选中的项目走：没选项目时无从谈起「公开哪个项目」。
  const [statusPage, setStatusPage] = useState<StatusPageState | null>(null);
  const [statusPageBusy, setStatusPageBusy] = useState(false);
  const [statusPageError, setStatusPageError] = useState<string | null>(null);

  useEffect(() => {
    if (!scope.projectId) { setStatusPage(null); return; }
    let alive = true;
    apiRequest<StatusPageState>(`/api/projects/${encodeURIComponent(scope.projectId)}/status-page`)
      .then((res) => { if (alive) { setStatusPage(res); setStatusPageError(null); } })
      .catch((err) => { if (alive) setStatusPageError(err instanceof ApiError ? err.message : String(err)); });
    return () => { alive = false; };
  }, [scope.projectId]);

  const toggleStatusPage = useCallback(async (): Promise<void> => {
    if (!scope.projectId || statusPageBusy) return;
    setStatusPageBusy(true);
    try {
      const next = await apiRequest<StatusPageState>(
        `/api/projects/${encodeURIComponent(scope.projectId)}/status-page`,
        { method: statusPage?.open ? 'DELETE' : 'POST' },
      );
      setStatusPage(next);
      setStatusPageError(null);
    } catch (err) {
      setStatusPageError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setStatusPageBusy(false);
    }
  }, [scope.projectId, statusPage, statusPageBusy]);

  const publicCount = useMemo(
    () => new Set(scoped.filter((t) => t.publicVisible).map((t) => t.name)).size,
    [scoped],
  );

  const BannerIcon = BANNER_ICON[board.tone];

  return (
    <div className="flex min-h-0 flex-col gap-3 lg:h-full">
      {/* 项目 + 环境：我在看谁 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.6875rem] text-muted-foreground">我的项目</span>
        <div className="inline-flex flex-wrap items-center gap-1 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-0.5">
          <button
            type="button"
            onClick={() => onScope({ ...scope, projectId: null })}
            aria-pressed={scope.projectId === null}
            className={cn(
              'rounded px-2 py-1 text-xs transition-colors',
              scope.projectId === null ? 'bg-[hsl(var(--surface-raised))] font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            全部项目
          </button>
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => onScope({ ...scope, projectId: project.id })}
              aria-pressed={scope.projectId === project.id}
              className={cn(
                'inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
                scope.projectId === project.id ? 'bg-[hsl(var(--surface-raised))] font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {project.name}
              {project.troubleCount > 0 ? (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-mono text-[0.625rem] text-destructive-foreground">
                  {project.troubleCount}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <span className="ml-2 text-[0.6875rem] text-muted-foreground">环境</span>
        <div className="flex flex-wrap items-center gap-1">
          {environments.map((env) => {
            const envTargets = projectTargets.filter((t) => t.environment === env);
            const label = envTargets[0]?.environmentLabel ?? env;
            const bad = envTargets.some((t) => t.status === 'down');
            const on = activeEnvs.has(env);
            return (
              <button
                key={env}
                type="button"
                onClick={() => toggleEnv(env)}
                aria-pressed={on}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                  on ? 'border-primary/45 bg-primary/10 text-foreground' : 'border-[hsl(var(--hairline))] text-muted-foreground hover:text-foreground',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', bad ? 'bg-destructive' : 'bg-ok')} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 结论：只说要不要管 */}
      <div className={cn('flex items-start gap-3 rounded-lg border px-3.5 py-3', BANNER_TONE[board.tone])}>
        <BannerIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm font-semibold leading-5">{board.headline}</div>
          {board.detail ? <div className="text-xs leading-5 opacity-90">{board.detail}</div> : null}
        </div>
      </div>

      {/* 业务网格 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[0.8125rem] font-medium">我盯的业务</span>
        <span className="inline-flex items-center gap-1 text-[0.6875rem] text-primary-ink">
          <ArrowRight className="h-3 w-3" />主动
          <span className="text-muted-foreground">定时真发一次，有产物</span>
        </span>
        <span className="inline-flex items-center gap-1 text-[0.6875rem] text-info">
          <Waves className="h-3 w-3" />被动
          <span className="text-muted-foreground">读真实流量的窗口，无产物</span>
        </span>
        <button type="button" className="ml-auto text-[0.6875rem] text-primary-ink hover:underline" onClick={onAddMonitor}>
          加一条业务监控
        </button>
      </div>

      {board.rows.length > 0 ? (
        <div className="grid min-h-0 flex-1 auto-rows-min gap-2.5 overflow-y-auto md:grid-cols-2 xl:grid-cols-3">
          {board.rows.map((row) => <BusinessCard key={row.key} row={row} now={now} onOpen={onOpenTarget} />)}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[hsl(var(--hairline-strong))] px-6 py-10 text-center">
          {board.hiddenEnvironments && board.hiddenEnvironments.length > 0 ? (
            <>
              <div className="max-w-xl text-xs leading-5 text-muted-foreground">
                这一屏默认只看非预览的环境——它要回答的是「线上业务今天有没有出事」，
                十几条临时分支的红黄绿会把那句话淹掉。你的业务监控现在都在预览侧。
              </div>
              <button
                type="button"
                className="rounded-md border border-primary/45 bg-primary-soft px-3 py-1.5 text-xs text-primary-ink transition-colors hover:border-primary/70"
                onClick={revealHidden}
              >
                看这些环境
              </button>
            </>
          ) : (
            <>
              <div className="max-w-xl text-xs leading-5 text-muted-foreground">
                业务监控问的是「这条业务现在还能用吗」——发一次真请求，按你的判据验收返回值。
                没有它，容器全绿也只说明服务活着。
              </div>
              <button
                type="button"
                className="rounded-md border border-primary/45 bg-primary-soft px-3 py-1.5 text-xs text-primary-ink transition-colors hover:border-primary/70"
                onClick={onAddMonitor}
              >
                加第一条业务监控
              </button>
            </>
          )}
        </div>
      )}

      {/* 自检端点：插上即可，监控项由端点自报 */}
      {scope.projectId ? (
        <DiscoveryStrip projectId={scope.projectId} onChanged={onReload} />
      ) : (
        <NeedsProjectRow
          icon={Cable}
          title="自检端点"
          what="把服务的自检地址插上，监控项由端点自己申报"
          projects={projects}
          onPick={(id) => onScope({ ...scope, projectId: id })}
        />
      )}

      {/* 公开面板：同一批观测的另一个出口，对外只出业务名与红绿 */}
      {scope.projectId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-info/25 bg-info-soft/40 px-3.5 py-2.5">
          <Globe className="h-3.5 w-3.5 text-info" />
          <span className="text-xs text-muted-foreground">公开面板</span>
          {statusPage?.open && statusPage.path ? (
            <>
              <a
                href={statusPage.path}
                target="_blank"
                rel="noreferrer"
                className="truncate font-mono text-xs text-info hover:underline"
              >
                {statusPage.path}
              </a>
              <span className="text-[0.6875rem] text-muted-foreground">
                免登录只读 · {publicCount} 条业务对外 · 只出业务名与红绿，不出地址、判据、日志
              </span>
            </>
          ) : (
            <span className="text-[0.6875rem] text-muted-foreground">
              未开启。开了之后拿到链接的人不用登录就能看到这几条业务的红绿，随时可撤销
            </span>
          )}
          <div className="flex-grow" />
          {statusPageError ? <span className="text-[0.6875rem] text-destructive">{statusPageError}</span> : null}
          <button
            type="button"
            onClick={() => void toggleStatusPage()}
            disabled={statusPageBusy}
            className="rounded-md border border-[hsl(var(--hairline-strong))] px-2 py-1 text-[0.6875rem] text-foreground transition-colors hover:border-info/50 disabled:opacity-60"
          >
            {statusPageBusy ? '处理中' : statusPage?.open ? '关闭并撤销链接' : '开启公开面板'}
          </button>
        </div>
      ) : (
        <NeedsProjectRow
          icon={Globe}
          title="公开面板"
          what="开一个免登录只读的对外地址，只出业务名与红绿"
          projects={projects}
          onPick={(id) => onScope({ ...scope, projectId: id })}
        />
      )}

      {/* 通知通道：出问题时会不会有人被通知。
          这一行是整条链上最容易静默失效的一环——没配凭据时投递是一次 no-op，
          启动日志里那句「不会有人被通知」没有任何验收会去读。所以它必须长在这一屏上。 */}
      <AlarmRow alarm={alarm} now={now} />

      {/* 基础设施：要能一眼确认没塌，但不占主视觉 */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3.5 py-2.5">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">基础设施</span>
        <span className={cn('text-xs', board.infra.down > 0 ? 'text-destructive' : 'text-ok')}>
          {board.infra.environments} 个环境 × {board.infra.total} 项
          {board.infra.down > 0 ? `，${board.infra.down} 项异常` : '，全部正常'}
        </span>
        <span className="text-[0.6875rem] text-muted-foreground">
          容器、端口、预览域名 —— 塌了这里会先红
          {board.infra.preview > 0 ? `；其中 ${board.infra.preview} 项是分支预览，不进上面的业务视角` : ''}
        </span>
      </div>

      <div className="flex items-start gap-2 text-[0.6875rem] leading-4 text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          主动看的是「能不能用」，被动看的是「有没有人用坏」。两个都绿才叫正常；
          被动绿而样本为 0，只说明没人用过。分支预览默认不在这一屏，去「全部目标」看。
        </span>
      </div>
    </div>
  );
}
