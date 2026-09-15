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
import { Activity, AlertTriangle, ArrowRight, BellRing, Cable, CheckCircle2, ChevronRight, FlaskConical, Globe, Info, Waves } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DiscoveryStrip } from './DiscoveryStrip';
import { AlarmChannelsPanel } from '../cds-settings/AlarmChannelsPanel';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AvailabilityBar } from './primitives';
import { formatDuration, formatRelative } from '@/lib/monitorCenter';
import type { AlarmChannelView, MonitorEnvironment, UptimeTargetSummary } from '@/lib/monitorCenter';
import {
  ENVIRONMENT_SHORT,
  buildGlobalBoard,
  buildOwnerBoard,
  describeEvidence,
  describeRow,
  shortPredicate,
  shouldDrawBar,
  listEnvironments,
  listProjects,
  scopeTargets,
  type BusinessRow,
  type CellHealth,
  type GlobalBoard,
  type OwnerBoard as OwnerBoardModel,
  type OwnerBoardContext,
  type OwnerScope,
  type ProjectRow,
  type ProjectOption,
} from '@/lib/ownerBoard';
import { REHEARSALS, applyRehearsal, rehearsalById, type RehearsalId } from '@/lib/rehearsal';

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

/** 「此刻真实结论」那一句的着色。不复用 BANNER_TONE：那套带底色，套在嵌套小条上会糊。 */
const LIVE_TONE: Record<'danger' | 'warn' | 'ok' | 'empty', string> = {
  danger: 'text-destructive',
  warn: 'text-warn',
  ok: 'text-ok',
  empty: 'text-muted-foreground',
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
/** 演练标。小、但每张被扰动的卡上都有——截图裁出来也认得出这不是真的。 */
function RehearsalMark(): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-primary/40 bg-primary-soft px-1 font-mono text-[0.625rem] leading-4 text-primary-ink">
      <FlaskConical className="h-2.5 w-2.5" />演练
    </span>
  );
}

/**
 * 一次完整的「收窄 → 判定」。
 *
 * 抽出来是因为演练要跑**两遍**：一遍喂扰动过的输入（屏幕上看到的），一遍喂真实输入
 * （横幅里那句「真实结论」）。两遍必须走同一条链，否则「演练时真实结论显示成什么」
 * 会变成第二份判据，跟着漂（形状 3）。而那句真实结论恰恰是演练不掩盖真实故障的唯一保证。
 */
interface BoardBundle {
  projectTargets: ReadonlyArray<UptimeTargetSummary>;
  scoped: ReadonlyArray<UptimeTargetSummary>;
  board: OwnerBoardModel;
  global_: GlobalBoard | null;
  headline: Pick<OwnerBoardModel, 'headline' | 'detail' | 'tone'>;
}

function buildBundle(
  targets: ReadonlyArray<UptimeTargetSummary>,
  ctx: OwnerBoardContext,
  scope: OwnerScope,
): BoardBundle {
  const projectTargets = scopeTargets(targets, { projectId: scope.projectId, environments: null });
  const scoped = scopeTargets(projectTargets, { projectId: null, environments: scope.environments });
  const board = buildOwnerBoard(scoped, projectTargets, ctx);
  // 没选项目 = 全局视角。同一个选择器，选了看业务、没选看项目。
  const global_ = scope.projectId ? null : buildGlobalBoard(scoped, ctx);
  return { projectTargets, scoped, board, global_, headline: global_ ?? board };
}

function BusinessCard({ row, now, onOpen, rehearsing }: { row: BusinessRow; now: number; onOpen: (targetId: string) => void; rehearsing: boolean }): JSX.Element {
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
        {/* 演练标长在卡片上，不只在横幅上：单张卡被裁出来当证据是这个功能唯一的危险。 */}
        {rehearsing ? <RehearsalMark /> : null}
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
      {worstCell && shouldDrawBar(worstCell.buckets) ? (
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

/**
 * 全局视角的一张项目卡。
 *
 * 与业务卡的分工：业务卡回答「这条业务怎么样」，项目卡回答「这个项目要不要我管」。
 * 所以它端出来的是**计数与短板**，不是某一条的可用率——把六条业务的可用率平均成
 * 一个数是没有意义的（一条挂了九条好着，平均数只会把那一条藏起来）。
 */
function ProjectCard({ row, now, onOpen, rehearsing }: { row: ProjectRow; now: number; onOpen: (projectId: string) => void; rehearsing: boolean }): JSX.Element {
  const trouble = row.down + row.overdue + row.stale;
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      className={cn(
        'group flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-left transition-all hover:-translate-y-px hover:shadow-sm',
        CARD_TONE[row.worst],
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {rehearsing ? <RehearsalMark /> : null}
        <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT_TONE[row.worst])} />
        <span className="truncate text-[0.8125rem] font-medium text-foreground">{row.name}</span>
        <div className="ml-auto flex shrink-0 gap-1">
          {row.environments.map((env) => (
            <span key={env} className="rounded border border-[hsl(var(--hairline))] px-1 font-mono text-[0.625rem] leading-4 text-muted-foreground">
              {ENVIRONMENT_SHORT[env]}
            </span>
          ))}
        </div>
      </div>

      <div className="flex items-start gap-5">
        <Stat value={`${row.businessCount}`} label="业务监控" />
        <Stat
          value={`${trouble}`}
          label="要处理"
          tone={trouble > 0 ? (row.down > 0 ? 'text-destructive' : 'text-warn') : 'text-muted-foreground'}
        />
      </div>

      <div className={cn(
        'truncate text-[0.6875rem]',
        row.worst === 'down' ? 'text-destructive' : row.worst === 'up' ? 'text-muted-foreground' : 'text-warn',
      )}>
        {row.down > 0 ? `${row.down} 项挂了`
          : row.overdue > 0 ? `${row.overdue} 项早该检查却没有`
            : row.stale > 0 ? `${row.stale} 项窗口内没人用过`
              : `${row.businessCount} 项都通过判据`}
      </div>

      <div className="truncate border-t border-[hsl(var(--hairline))] pt-2 font-mono text-[0.625rem] text-muted-foreground/80">
        {row.evidence ? `最旧一条在 ${formatDuration(now - row.evidence.at)}前检查过（${row.evidence.name}）` : '还没有检查记录'}
      </div>
    </button>
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
  /**
   * 演练：只读地把面板推到它该变红的那几档。
   *
   * 判据一个字不动，只换喂给它的输入——这是它作为取证手段成立的全部理由，
   * 理由写在 lib/rehearsal.ts 顶部。默认 `live`，刷新页面即回真实。
   */
  const [rehearsal, setRehearsal] = useState<RehearsalId>('live');
  /** 通知设置。开在这一屏而不是让人去翻系统设置——「会不会有人被通知」是这一屏的问题。 */
  const [notifyOpen, setNotifyOpen] = useState(false);
  const rehearsing = rehearsal !== 'live';
  const stage = useMemo(
    () => applyRehearsal(rehearsal, { targets, ctx: { now, prober } }),
    [rehearsal, targets, now, prober],
  );

  const projects = useMemo(() => listProjects(stage.targets, now), [stage.targets, now]);
  const bundle = useMemo(() => buildBundle(stage.targets, stage.ctx, scope), [stage.targets, stage.ctx, scope]);
  /**
   * 真实那一份。演练期间它仍然算、仍然摆在横幅里。
   *
   * 少了它，演练就成了一块能盖住真实故障的幕布：有人在演练「一切正常」的时候，
   * 线上真的挂了，而屏幕上什么都看不出来。
   */
  const live = useMemo(
    () => (rehearsing ? buildBundle(targets, { now, prober }, scope) : null),
    [rehearsing, targets, now, prober, scope],
  );
  const { projectTargets, scoped, board, global_, headline } = bundle;
  const environments = useMemo(() => listEnvironments(projectTargets), [projectTargets]);

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

  const BannerIcon = BANNER_ICON[global_?.tone ?? board.tone];
  const rehearsalNote = rehearsalById(rehearsal);

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

        {/* 主动操作靠右（左上是「我在哪」，右上是「我要做什么」）。
            通知排在演练前面：出问题会不会有人被通知，比演练更常被问起。 */}
        <button
          type="button"
          onClick={() => setNotifyOpen(true)}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-[hsl(var(--hairline))] px-2 py-1 text-[0.6875rem] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <BellRing className="h-3 w-3" />通知设置
        </button>
        <div className="inline-flex flex-wrap items-center gap-1">
          <FlaskConical className="h-3 w-3 text-muted-foreground" />
          <span className="mr-0.5 text-[0.6875rem] text-muted-foreground">演练</span>
          {REHEARSALS.map((item) => (
            <button
              key={item.id}
              type="button"
              title={item.proves}
              onClick={() => setRehearsal(item.id)}
              aria-pressed={rehearsal === item.id}
              className={cn(
                'rounded-md border px-2 py-1 text-[0.6875rem] transition-colors',
                rehearsal === item.id
                  ? 'border-primary/50 bg-primary-soft text-primary-ink'
                  : 'border-[hsl(var(--hairline))] text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* 演练挂牌。整屏一条 + 每张卡一个小标，两处都不能少：
          横幅解释这是什么，卡上的标保证单张截图裁出来也认得出。 */}
      {rehearsing ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-primary/45 bg-primary-soft px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <FlaskConical className="h-4 w-4 shrink-0 text-primary-ink" />
            <span className="text-sm font-semibold text-primary-ink">
              演练中 —— 下面这一屏的数据是假的，不是线上现在的样子
            </span>
            <div className="flex-grow" />
            <button
              type="button"
              onClick={() => setRehearsal('live')}
              className="rounded-md border border-primary/45 bg-[hsl(var(--surface-raised))] px-2 py-1 text-[0.6875rem] text-primary-ink transition-colors hover:border-primary/70"
            >
              回到真实
            </button>
          </div>
          <div className="text-xs leading-5 text-foreground">
            这一档要证明的：{rehearsalNote.proves}
          </div>
          {/* 演练动了什么，逐条说清。说不清就等于在造一份没人能复核的证据。 */}
          {stage.changed ? (
            <div className="text-[0.6875rem] leading-5 text-muted-foreground">动了什么：{stage.changed}</div>
          ) : null}
          {stage.blocked ? (
            <div className="text-[0.6875rem] leading-5 text-warn">演不了：{stage.blocked}</div>
          ) : null}
          {/* 真实结论始终摆着：演练不许盖住此刻真的出了事这件事。 */}
          {live ? (
            <div className="mt-0.5 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-2.5 py-1.5 text-[0.6875rem] leading-5">
              <span className="text-muted-foreground">此刻真实结论：</span>
              <span className={cn('font-medium', LIVE_TONE[live.headline.tone])}>{live.headline.headline}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 结论：只说要不要管 */}
      <div className={cn('flex items-start gap-3 rounded-lg border px-3.5 py-3', BANNER_TONE[headline.tone])}>
        <BannerIcon className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm font-semibold leading-5">{headline.headline}</div>
          {headline.detail ? <div className="text-xs leading-5 opacity-90">{headline.detail}</div> : null}
        </div>
      </div>

      {/* 业务网格 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[0.8125rem] font-medium">{global_ ? '我盯的项目' : '我盯的业务'}</span>
        <span className="inline-flex items-center gap-1 text-[0.6875rem] text-primary-ink">
          <ArrowRight className="h-3 w-3" />主动
          <span className="text-muted-foreground">定时真发一次，有产物</span>
        </span>
        <span className="inline-flex items-center gap-1 text-[0.6875rem] text-info">
          <Waves className="h-3 w-3" />被动
          <span className="text-muted-foreground">读真实流量的窗口，无产物</span>
        </span>
        {/* 演练中禁用一切真实写操作：面板上是假数据，此时点下去的每一步都在对着假前提做真事。 */}
        <button
          type="button"
          disabled={rehearsing}
          title={rehearsing ? '演练中不能改真实配置 —— 先点「回到真实」' : undefined}
          className="ml-auto text-[0.6875rem] text-primary-ink hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
          onClick={onAddMonitor}
        >
          加一条业务监控
        </button>
      </div>

      {global_ ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto">
          {global_.rows.length > 0 ? (
            <div className="grid auto-rows-min gap-2.5 md:grid-cols-2 xl:grid-cols-3">
              {global_.rows.map((row) => (
                <ProjectCard key={row.id} row={row} now={now} rehearsing={rehearsing} onOpen={(id) => onScope({ ...scope, projectId: id })} />
              ))}
            </div>
          ) : null}
          {/* 没人盯的项目单独一块，而且不许用绿色壳子装 —— 它们不是「好着」，是「不知道」。
              这是全局视角存在的理由：站在某一个项目里永远看不见这件事。 */}
          {global_.unwatched.length > 0 ? (
            <div className="rounded-lg border border-dashed border-warn/40 bg-warn-soft/20 p-3">
              <div className="text-[0.8125rem] font-medium text-foreground">
                {global_.unwatched.length} 个项目还没有业务监控
              </div>
              <div className="mt-1 text-[0.6875rem] leading-5 text-muted-foreground">
                它们只盯着容器与端口 —— 全绿只说明服务活着，不说明业务还能用。点一个项目进去就能给它加第一条。
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {global_.unwatched.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    onClick={() => onScope({ ...scope, projectId: row.id })}
                    className="rounded-md border border-[hsl(var(--hairline-strong))] px-2 py-1 text-[0.6875rem] text-foreground transition-colors hover:border-warn/60"
                  >
                    {row.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : board.rows.length > 0 ? (
        <div className="grid min-h-0 flex-1 auto-rows-min gap-2.5 overflow-y-auto md:grid-cols-2 xl:grid-cols-3">
          {board.rows.map((row) => <BusinessCard key={row.key} row={row} now={now} rehearsing={rehearsing} onOpen={onOpenTarget} />)}
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
            disabled={statusPageBusy || rehearsing}
            title={rehearsing ? '演练中不能改真实配置 —— 先点「回到真实」' : undefined}
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

      <Dialog open={notifyOpen} onOpenChange={setNotifyOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>通知设置 —— 哪些出问题、通知谁</DialogTitle>
          </DialogHeader>
          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <AlarmChannelsPanel projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
          </div>
        </DialogContent>
      </Dialog>

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
