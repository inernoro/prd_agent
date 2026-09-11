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
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, ChevronRight, Globe, Info, Waves } from 'lucide-react';

import { ApiError, apiRequest } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DiscoveryStrip } from './DiscoveryStrip';
import type { MonitorEnvironment, UptimeTargetSummary } from '@/lib/monitorCenter';
import {
  buildOwnerBoard,
  describeRow,
  listEnvironments,
  listProjects,
  scopeTargets,
  type BusinessRow,
  type CellHealth,
  type OwnerScope,
} from '@/lib/ownerBoard';

const HEALTH_CELL: Record<CellHealth, string> = {
  down: 'border-destructive/50 bg-destructive/15 text-destructive',
  stale: 'border-warn/50 bg-warn-soft text-warn',
  unknown: 'border-[hsl(var(--hairline-strong))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
  up: 'border-ok/40 bg-ok-soft text-ok',
};

const CARD_TONE: Record<CellHealth, string> = {
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

function BusinessCard({ row, onOpen }: { row: BusinessRow; onOpen: (targetId: string) => void }): JSX.Element {
  const worstCell = row.cells.find((c) => c.health === row.worst) ?? row.cells[0];
  const ModeIcon = row.observeMode === 'passive' ? Waves : ArrowRight;
  return (
    <button
      type="button"
      onClick={() => onOpen(worstCell?.targetId ?? row.cells[0]?.targetId ?? '')}
      className={cn(
        'flex min-w-0 gap-3 rounded-lg border p-3 text-left transition-colors hover:border-[hsl(var(--hairline-strong))]',
        CARD_TONE[row.worst],
      )}
    >
      {row.artifactUrl ? (
        <img
          src={row.artifactUrl}
          alt=""
          className={cn(
            'h-14 w-14 shrink-0 rounded object-cover',
            row.worst === 'down' ? 'ring-2 ring-destructive' : 'ring-1 ring-[hsl(var(--hairline))]',
          )}
        />
      ) : (
        <div className={cn('flex h-14 w-14 shrink-0 items-center justify-center rounded border', HEALTH_CELL[row.worst])}>
          <ModeIcon className="h-5 w-5" />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
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

        <div className={cn('truncate font-mono text-[0.6875rem]', row.worst === 'down' ? 'text-destructive' : row.worst === 'stale' ? 'text-warn' : 'text-muted-foreground')}>
          {describeRow(row)}
        </div>

        {row.attribution ? (
          <div className="truncate text-[0.6875rem] leading-4 text-muted-foreground">{row.attribution}</div>
        ) : null}
      </div>
    </button>
  );
}

interface StatusPageState {
  open: boolean;
  path: string | null;
}

export function OwnerBoard({
  targets,
  scope,
  onScope,
  onOpenTarget,
  onAddMonitor,
  onReload,
}: {
  targets: ReadonlyArray<UptimeTargetSummary>;
  scope: OwnerScope;
  onScope: (next: OwnerScope) => void;
  onOpenTarget: (targetId: string) => void;
  onAddMonitor: () => void;
  /** 插上 / 拔掉端点之后监控项会变，让页面重拉一次摘要 */
  onReload: () => void;
}): JSX.Element {
  const projects = useMemo(() => listProjects(targets), [targets]);
  const projectTargets = useMemo(
    () => scopeTargets(targets, { projectId: scope.projectId, environments: null }),
    [targets, scope.projectId],
  );
  const environments = useMemo(() => listEnvironments(projectTargets), [projectTargets]);
  const scoped = useMemo(() => scopeTargets(projectTargets, { projectId: null, environments: scope.environments }), [projectTargets, scope.environments]);
  const board = useMemo(() => buildOwnerBoard(scoped, projectTargets), [scoped, projectTargets]);

  const activeEnvs = new Set(scope.environments ?? environments);
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
        <div className="grid min-h-0 flex-1 auto-rows-min gap-2 overflow-y-auto md:grid-cols-2">
          {board.rows.map((row) => <BusinessCard key={row.key} row={row} onOpen={onOpenTarget} />)}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[hsl(var(--hairline-strong))] px-6 py-10 text-center">
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
        </div>
      )}

      {/* 自检端点：插上即可，监控项由端点自报 */}
      {scope.projectId ? <DiscoveryStrip projectId={scope.projectId} onChanged={onReload} /> : null}

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
      ) : null}

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
