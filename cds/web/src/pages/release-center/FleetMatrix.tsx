/**
 * 全环境矩阵——发布中心的第一屏主体。
 *
 * 视角与发布控制台相反：控制台一次看一个目标，这里**横着比所有环境**。
 * 谁停在哪个版本、谁落后主干多少、谁没接健康检查、谁最近失败了没人管，
 * 一行扫下来就完。
 *
 * 列宽、行高、圆角、字号照设计稿 design_handoff_release_center 的标注取值。
 * 三条纪律来自设计稿「硬性约束」，判据都在 lib/releaseFleet.ts 里（可单测）：
 *   - 缺数据明说缺什么，绝不渲染成 0 或 100%
 *   - 极端值换量纲
 *   - 发布中心不执行发布，所有动作都跳发布控制台
 */

import { ArrowUpCircle, ListChecks, RotateCcw, Rocket } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  FLEET_SORTS,
  fleetAvailabilityText,
  fleetBehindText,
  fleetHealthText,
  fleetTypeText,
  formatFleetAgo,
  formatFleetDuration,
  formatFleetMinutes,
  formatFleetPercent,
  sortFleet,
  type FleetEnv,
  type FleetSortKey,
} from '@/lib/releaseFleet';

export interface FleetMatrixProps {
  envs: FleetEnv[];
  sort: FleetSortKey;
  onSort: (key: FleetSortKey) => void;
  nowMs: number;
  /** 宽屏（≥1264px 实测宽度）走表格，窄屏走单列卡片。 */
  wide: boolean;
  /** 下钻到「环境与配置」。 */
  onInspect: (envId: string) => void;
  /** 跳发布控制台执行。intent 让控制台知道是发布还是回滚。 */
  onExecute: (envId: string, intent: 'deploy' | 'promote' | 'rollback') => void;
}

const TYPE_CLASS: Record<FleetEnv['type'], string> = {
  production: 'text-bad',
  staging: 'text-warn',
  other: 'text-muted-foreground',
};

const HEALTH_DOT: Record<FleetEnv['health'], string> = {
  healthy: 'bg-ok',
  failed: 'bg-bad',
  unmonitored: 'bg-[hsl(var(--hairline-strong))]',
};

const HEALTH_TEXT: Record<FleetEnv['health'], string> = {
  healthy: 'text-ok font-medium',
  failed: 'text-bad font-bold',
  unmonitored: 'text-muted-foreground',
};

/** 表头与单元格共用同一套列宽，改一处就够——两处各写一份必然漂移。 */
const COLUMNS = 'minmax(200px,1fr) 76px 104px 92px 92px 116px 170px 170px 110px 192px';

function LastReleaseCell({ env, nowMs }: { env: FleetEnv; nowMs: number }): JSX.Element {
  if (!env.lastRelease) return <span className="text-muted-foreground">从未发布</span>;
  const duration = formatFleetDuration(env.lastRelease.durationSec);
  return (
    <span className="block min-w-0">
      <span className="block truncate text-xs">
        {formatFleetAgo(env.lastRelease.atMs, nowMs)} · {env.lastRelease.by}
      </span>
      <span className={`block truncate cds-ident text-[10.5px] ${env.lastRelease.ok ? 'text-muted-foreground' : 'text-bad'}`}>
        {duration ? `${duration} · ` : ''}{env.lastRelease.ok ? '成功' : '失败'}
      </span>
    </span>
  );
}

function DoraCell({ env }: { env: FleetEnv }): JSX.Element {
  if (!env.dora) {
    return (
      <span className="block min-w-0">
        <span className="block text-xs text-muted-foreground">样本不足</span>
        <span className="block truncate text-[10.5px] text-muted-foreground">近 30 天不足 3 次发布</span>
      </span>
    );
  }
  const cfr = env.dora.changeFailureRatio === null
    ? '样本不足'
    : formatFleetPercent(Math.round(env.dora.changeFailureRatio * 10000) / 100);
  const mttr = formatFleetMinutes(env.dora.medianRecoveryMin) || '样本不足';
  return (
    <span className="block min-w-0">
      <span className="block truncate cds-ident text-xs">{env.dora.deploys} 次 / {cfr} / {mttr}</span>
      <span className="block truncate text-[10.5px] text-muted-foreground">发布 / 变更失败率 / 恢复</span>
    </span>
  );
}

function CapabilityCell({ env }: { env: FleetEnv }): JSX.Element {
  const chips: Array<{ text: string; className: string }> = [];
  if (env.canRollback) chips.push({ text: '可回滚', className: 'bg-[hsl(var(--surface-sunken))] text-muted-foreground' });
  if (env.promotableSha) {
    chips.push({ text: `可提升 ${env.promotableSha.slice(0, 7)}`, className: 'bg-primary/[0.12] text-primary' });
  }
  if (chips.length === 0) return <span className="text-muted-foreground">无</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <span key={chip.text} className={`rounded-[5px] px-1.5 py-0.5 cds-ident text-[10px] ${chip.className}`}>{chip.text}</span>
      ))}
    </span>
  );
}

/** 行内三个动作。全部跳发布控制台——发布中心自己不执行发布。 */
function RowActions({ env, onInspect, onExecute, tall }: {
  env: FleetEnv;
  onInspect: FleetMatrixProps['onInspect'];
  onExecute: FleetMatrixProps['onExecute'];
  tall: boolean;
}): JSX.Element {
  // 操作列 192px 要装下三个控件：发布 76 + 回滚 68 + 图标 34 + 两个 4px 间隔 = 186。
  // 之前 gap-1.5 + 默认内边距一共 200+，第三个按钮被挤到第二行。
  const size = tall ? 'h-11' : 'h-[30px]';
  const promote = Boolean(env.promotableSha);
  return (
    <span className={`flex flex-nowrap items-center justify-end gap-1 [&_button]:${size} [&_button]:rounded-lg [&_button]:px-2.5 ${tall ? 'flex-wrap' : ''}`}>
      <Button
        size="sm"
        disabled={!env.enabled}
        title={env.enabled ? undefined : '该环境已停用，启用后才能发布'}
        onClick={(event) => { event.stopPropagation(); onExecute(env.id, promote ? 'promote' : 'deploy'); }}
        className={env.enabled ? undefined : 'opacity-45'}
      >
        {promote ? <ArrowUpCircle /> : <Rocket />}
        {promote ? '提升版本' : '发布'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!env.canRollback}
        title={env.canRollback ? undefined : '这个环境没有可回滚的历史版本'}
        onClick={(event) => { event.stopPropagation(); onExecute(env.id, 'rollback'); }}
        className={env.canRollback ? undefined : 'opacity-40'}
      >
        <RotateCcw />
        回滚
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-label={`${env.name} 的环境与配置`}
        title="环境与配置"
        onClick={(event) => { event.stopPropagation(); onInspect(env.id); }}
      >
        <ListChecks />
      </Button>
    </span>
  );
}

export function FleetMatrix({ envs, sort, onSort, nowMs, wide, onInspect, onExecute }: FleetMatrixProps): JSX.Element {
  const sorted = sortFleet(envs, sort);
  const enabled = envs.filter((env) => env.enabled).length;
  const failing = envs.filter((env) => env.health === 'failed').length;

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden rounded-[14px] border">
      <div className="flex flex-wrap items-center justify-between gap-3 px-[18px] py-4">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-sm font-bold">全环境矩阵</h2>
          <span className="cds-ident text-[11.5px] text-muted-foreground">
            {envs.length} 个环境 · {enabled} 启用 · {failing} 失败
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] text-muted-foreground">排序</span>
          {FLEET_SORTS.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={sort === item.key}
              onClick={() => onSort(item.key)}
              className={`h-7 rounded-lg px-2.5 text-[11.5px] transition-colors duration-150 ${
                sort === item.key
                  ? 'bg-primary/[0.12] font-semibold text-primary'
                  : 'text-muted-foreground hover:bg-[hsl(var(--surface-sunken))]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {envs.length === 0 ? (
        <p className="border-t border-[hsl(var(--hairline)/0.6)] px-[18px] py-6 text-xs text-muted-foreground">
          这个项目还没有发布环境。用右上角「新建环境」加一个。
        </p>
      ) : wide ? (
        <>
          <div
            className="grid gap-3 border-y border-[hsl(var(--hairline)/0.6)] bg-[hsl(var(--surface-sunken))] px-[18px] py-2.5 cds-ident text-[11px] uppercase tracking-[0.09em] text-muted-foreground"
            style={{ gridTemplateColumns: COLUMNS }}
          >
            <span>环境</span><span>类型</span><span>健康</span><span>可用率 24H</span><span>线上 SHA</span>
            <span>落后主干</span><span>最近一次发布</span><span>DORA 30D</span><span>能力</span><span className="text-right">操作</span>
          </div>
          <div>
            {sorted.map((env) => (
              <div
                key={env.id}
                role="button"
                tabIndex={0}
                onClick={() => onInspect(env.id)}
                onKeyDown={(event) => { if (event.key === 'Enter') onInspect(env.id); }}
                className={`grid cursor-pointer items-center gap-3 border-b border-[hsl(var(--hairline)/0.6)] px-[18px] py-[13px] text-[12.5px] transition-colors duration-150 hover:bg-[hsl(var(--surface-sunken))] ${
                  env.health === 'failed' ? 'bg-bad-soft' : ''
                } ${env.enabled ? '' : 'opacity-55'}`}
                style={{ gridTemplateColumns: COLUMNS }}
              >
                <span className="block min-w-0">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-semibold">{env.name}</span>
                    {env.isPrimary ? <span className="shrink-0 rounded-[5px] bg-primary/[0.12] px-1.5 py-0.5 text-[10px] text-primary">主目标</span> : null}
                    {env.enabled ? null : <span className="shrink-0 rounded-[5px] bg-[hsl(var(--surface-sunken))] px-1.5 py-0.5 text-[10px] text-muted-foreground">未启用</span>}
                  </span>
                  <span className="block truncate cds-ident text-[11px] text-muted-foreground">{env.host}</span>
                </span>
                <span className={`text-xs font-semibold ${TYPE_CLASS[env.type]}`}>{fleetTypeText(env.type)}</span>
                <span className="flex items-center gap-1.5">
                  <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${HEALTH_DOT[env.health]}`} />
                  <span className={`text-xs ${HEALTH_TEXT[env.health]}`}>{fleetHealthText(env.health)}</span>
                </span>
                <span className={`cds-ident text-[12.5px] ${env.availability24h !== null && env.availability24h < 99 ? 'text-bad' : env.availability24h === null ? 'text-muted-foreground' : ''}`}>
                  {fleetAvailabilityText(env)}
                </span>
                <span className="cds-ident text-[12.5px]">{env.liveSha ? env.liveSha.slice(0, 7) : <span className="text-muted-foreground">未发布过</span>}</span>
                <span className={`text-xs ${
                  env.behindMain === null ? 'text-muted-foreground'
                    : env.behindMain === 0 ? 'text-ok'
                    : env.behindMain >= 12 ? 'font-bold text-bad' : ''
                }`}>
                  {fleetBehindText(env)}
                </span>
                <LastReleaseCell env={env} nowMs={nowMs} />
                <DoraCell env={env} />
                <CapabilityCell env={env} />
                <RowActions env={env} onInspect={onInspect} onExecute={onExecute} tall={false} />
              </div>
            ))}
          </div>
        </>
      ) : (
        /* 窄屏：表格塌成单列卡片（标签 + 值两列），操作按钮 44px 命中区。
           设计稿明确要求不横向滚动、不区块重叠。 */
        <div className="flex flex-col gap-3 border-t border-[hsl(var(--hairline)/0.6)] p-3.5">
          {sorted.map((env) => (
            <div
              key={env.id}
              className={`rounded-[10px] border p-3 ${
                env.health === 'failed' ? 'border-bad/30 bg-bad-soft' : 'border-[hsl(var(--hairline))]'
              } ${env.enabled ? '' : 'opacity-55'}`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="truncate text-[13.5px] font-semibold">{env.name}</span>
                {env.isPrimary ? <span className="rounded-[5px] bg-primary/[0.12] px-1.5 py-0.5 text-[10px] text-primary">主目标</span> : null}
                <span className={`text-xs font-semibold ${TYPE_CLASS[env.type]}`}>{fleetTypeText(env.type)}</span>
              </div>
              <div className="mt-0.5 truncate cds-ident text-[11px] text-muted-foreground">{env.host}</div>
              <dl className="mt-2.5 grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                <dt className="text-[11.5px] text-muted-foreground">健康</dt>
                <dd className={HEALTH_TEXT[env.health]}>{fleetHealthText(env.health)}</dd>
                <dt className="text-[11.5px] text-muted-foreground">可用率 24H</dt>
                <dd className="cds-ident">{fleetAvailabilityText(env)}</dd>
                <dt className="text-[11.5px] text-muted-foreground">线上 SHA</dt>
                <dd className="cds-ident">{env.liveSha ? env.liveSha.slice(0, 7) : '未发布过'}</dd>
                <dt className="text-[11.5px] text-muted-foreground">落后主干</dt>
                <dd>{fleetBehindText(env)}</dd>
                <dt className="text-[11.5px] text-muted-foreground">最近发布</dt>
                <dd><LastReleaseCell env={env} nowMs={nowMs} /></dd>
                <dt className="text-[11.5px] text-muted-foreground">DORA 30D</dt>
                <dd><DoraCell env={env} /></dd>
                <dt className="text-[11.5px] text-muted-foreground">能力</dt>
                <dd><CapabilityCell env={env} /></dd>
              </dl>
              <div className="mt-3">
                <RowActions env={env} onInspect={onInspect} onExecute={onExecute} tall />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
