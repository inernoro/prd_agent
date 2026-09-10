/*
 * ownerBoard —— 项目负责人第一屏的纯函数层。
 *
 * 这一屏要回答的问题只有一个：**我负责的业务，今天有没有出事。**
 * 十秒钟看完，看不完就没人每天看；没人看的监控等于不存在——那正是
 * 2026-09-09 那次 500 能穿过全部验收的同一个病。
 *
 * 所以它的主语是「我的业务」，不是「CDS 的探测目标」：
 *
 *   - 第一行是**判断**（谁坏了、在哪个环境、什么值不对），不是一排让人自己算的数；
 *   - 同一条业务在多个环境的红绿并排摆着，**对比本身就是归因**：
 *     只有预发红 = 那个环境的配置问题；四个都红 = 这次改动的问题；
 *   - 容器与端口折叠成一行——它们塌了确实要知道，但那不是「我的业务」；
 *   - 被动监控样本为 0 时**不算绿**：那不是「一切正常」，是「没人用过」。
 *
 * 页面组件只负责摆放，判据全在这里，测试跑真值断言。
 */

import type { MonitorEnvironment, ObserveMode, UptimeTargetSummary } from './monitorCenter';

/**
 * 环境展示顺序。必须与后端 monitor-environment.ts 的 MONITOR_ENVIRONMENT_ORDER
 * 逐项相等——守卫 tests/web/owner-board.test.ts 同时 import 两边做断言，
 * 谁先漂了谁红（判据分裂，形状 3）。
 */
export const ENVIRONMENT_ORDER: readonly MonitorEnvironment[] = [
  'production',
  'staging',
  'other',
  'preview',
];

/** 一个字的环境缩写，业务卡上那排小格子用。 */
export const ENVIRONMENT_SHORT: Record<MonitorEnvironment, string> = {
  production: '正',
  staging: '预',
  other: '他',
  preview: '支',
};

/**
 * 一格的健康档位。比 UptimeStatus 多一档 `stale`——
 * 「判据通过但窗口里没有真实调用」既不是正常也不是故障，混进任何一边都是撒谎。
 */
export type CellHealth = 'down' | 'stale' | 'unknown' | 'up';

/** 严重度：排序与「最差档」都只认这一张表。 */
const SEVERITY: Record<CellHealth, number> = { down: 0, stale: 1, unknown: 2, up: 3 };

export interface EnvironmentCell {
  environment: MonitorEnvironment;
  label: string;
  short: string;
  health: CellHealth;
  targetId: string;
  /** 被动监控这一格的样本量；undefined = 不是被动监控或没读到 */
  sampleCount?: number;
  /** 这一格为什么不好：故障原因 / 判据没过的实际值。好的时候没有。 */
  reason?: string;
}

export interface BusinessRow {
  /** 合并键 = 监控名：同名的监控视为「同一条业务的不同环境」 */
  key: string;
  name: string;
  observeMode: ObserveMode;
  cells: EnvironmentCell[];
  worst: CellHealth;
  /** 最新一次产物（生图这类功能监控才有），卡片上直接摆缩略图 */
  artifactUrl?: string;
  /**
   * 归因提示：坏的那几格与好的那几格摆在一起能说出什么。
   * 说不出来（全坏 / 只有一个环境）就没有这一句，不硬凑。
   */
  attribution?: string;
}

export interface InfraSummary {
  total: number;
  down: number;
  /** 覆盖到几个环境——「4 个环境 × 14 项」比「56 项」好读 */
  environments: number;
}

export interface OwnerBoard {
  /** 第一行的判断句。永远有一句，包括「一条业务监控都还没有」。 */
  headline: string;
  /** 第二行：归因 / 数字支撑。说不出来就没有。 */
  detail?: string;
  tone: 'danger' | 'warn' | 'ok' | 'empty';
  rows: BusinessRow[];
  infra: InfraSummary;
}

/** 这条目标算「我的业务」还是「基础设施」。 */
export function isBusinessTarget(target: UptimeTargetSummary): boolean {
  return target.source === 'custom';
}

/**
 * 一格的档位判定。
 *
 * `stale` 那一条是这套东西里最容易被写漏的：被动监控读的是真实流量的窗口统计，
 * 窗口里一次调用都没有时，「零错误」与「全部成功」长得一模一样。判成绿就是假绿。
 */
export function assessCell(target: UptimeTargetSummary): CellHealth {
  if (target.enabled === false || target.status === 'paused' || target.excluded) return 'unknown';
  if (target.status === 'down') return 'down';
  if (target.observeMode === 'passive' && target.sampleCount === 0) return 'stale';
  if (target.status === 'up' && target.measured) return 'up';
  return 'unknown';
}

/** 这一格为什么不好。好的格子没有理由，不编。 */
function cellReason(target: UptimeTargetSummary, health: CellHealth): string | undefined {
  if (health === 'stale') return '窗口内 0 次真实调用，绿灯不作数';
  if (health === 'down') {
    return target.lastObservation?.err
      || target.lastSample?.err
      || (target.lastSample?.code ? `HTTP ${target.lastSample.code}` : undefined)
      || '探测失败';
  }
  if (health === 'unknown') {
    if (target.enabled === false) return '已暂停';
    if (target.excluded) return '未纳入监控';
    if (!target.measured) return '未实测（按容器状态判定）';
    return '还在等第一次判定';
  }
  return undefined;
}

function worstOf(cells: ReadonlyArray<EnvironmentCell>): CellHealth {
  return cells.reduce<CellHealth>((acc, c) => (SEVERITY[c.health] < SEVERITY[acc] ? c.health : acc), 'up');
}

/**
 * 归因：坏的那几格与好的那几格并排，能说出什么。
 *
 * 只有「一部分环境坏、另一部分好」时才说得出话——那是最有价值的一句，
 * 它把「要不要回滚」直接变成「去看那个环境的配置」。
 * 全坏或只有一个环境时什么也说不出，就不说（conclusion-before-numbers：算不出来就不出句）。
 */
export function buildAttribution(cells: ReadonlyArray<EnvironmentCell>): string | undefined {
  const bad = cells.filter((c) => c.health === 'down');
  const good = cells.filter((c) => c.health === 'up');
  if (bad.length === 0 || good.length === 0) return undefined;
  const badNames = bad.map((c) => c.label).join('、');
  const goodNames = good.map((c) => c.label).join('、');
  return `只有${badNames}坏，${goodNames}都正常 —— 同一套代码，问题在${badNames}这一侧的配置`;
}

function environmentRank(env: MonitorEnvironment): number {
  const i = ENVIRONMENT_ORDER.indexOf(env);
  return i < 0 ? ENVIRONMENT_ORDER.length : i;
}

/** 把同名监控按环境并成一行业务。 */
export function buildBusinessRows(targets: ReadonlyArray<UptimeTargetSummary>): BusinessRow[] {
  const byName = new Map<string, UptimeTargetSummary[]>();
  for (const target of targets) {
    if (!isBusinessTarget(target)) continue;
    const list = byName.get(target.name);
    if (list) list.push(target);
    else byName.set(target.name, [target]);
  }

  const rows: BusinessRow[] = [];
  for (const [name, group] of byName) {
    const cells: EnvironmentCell[] = group
      .map((target) => {
        const health = assessCell(target);
        return {
          environment: target.environment,
          label: target.environmentLabel,
          short: ENVIRONMENT_SHORT[target.environment] ?? '?',
          health,
          targetId: target.id,
          ...(target.sampleCount === undefined ? {} : { sampleCount: target.sampleCount }),
          ...(cellReason(target, health) ? { reason: cellReason(target, health) } : {}),
        };
      })
      .sort((a, b) => environmentRank(a.environment) - environmentRank(b.environment));

    // 产物取最坏那一格的：出问题时要看的是**那张不对的图**，不是随便一张。
    const worst = worstOf(cells);
    const worstTarget = [...group].sort((a, b) => SEVERITY[assessCell(a)] - SEVERITY[assessCell(b)])[0];
    const artifactUrl = worstTarget?.lastObservation?.artifactUrl;

    rows.push({
      key: name,
      name,
      observeMode: group.some((t) => t.observeMode === 'passive') ? 'passive' : 'active',
      cells,
      worst,
      ...(artifactUrl ? { artifactUrl } : {}),
      ...(buildAttribution(cells) ? { attribution: buildAttribution(cells) } : {}),
    });
  }

  // 异常置顶；同档按名字，顺序稳定（每天打开位置不跳）。
  return rows.sort((a, b) => SEVERITY[a.worst] - SEVERITY[b.worst] || a.name.localeCompare(b.name));
}

function summarizeInfra(targets: ReadonlyArray<UptimeTargetSummary>): InfraSummary {
  const infra = targets.filter((t) => !isBusinessTarget(t));
  const environments = new Set(infra.map((t) => t.environment));
  return {
    total: infra.length,
    down: infra.filter((t) => t.status === 'down').length,
    environments: environments.size,
  };
}

/**
 * 第一屏。
 *
 * 空态是这里最要紧的一句：一条业务监控都没有时，页面绝不能说「一切正常」——
 * 那时盯着的只有容器与端口，业务坏了这里根本不会红，而那正是用户问
 * 「我那么多条验收都解决不了这种低级错误」的原因。
 */
export function buildOwnerBoard(targets: ReadonlyArray<UptimeTargetSummary>): OwnerBoard {
  const rows = buildBusinessRows(targets);
  const infra = summarizeInfra(targets);

  if (rows.length === 0) {
    return {
      headline: '还没有一条业务监控',
      detail: infra.total > 0
        ? `现在盯着的是 ${infra.total} 项容器与端口 —— 它们全绿，只说明服务活着，不说明业务还能用`
        : '这个项目还没有任何监控',
      tone: 'empty',
      rows,
      infra,
    };
  }

  const down = rows.filter((r) => r.worst === 'down');
  const stale = rows.filter((r) => r.worst === 'stale');
  const envCount = new Set(rows.flatMap((r) => r.cells.map((c) => c.environment))).size;

  if (down.length > 0) {
    const first = down[0];
    const badCell = first.cells.find((c) => c.health === 'down');
    const others = rows.length - down.length;
    const headline = down.length === 1
      ? `${first.name} 在「${badCell?.label ?? '某个环境'}」挂了，其余 ${others} 项业务正常`
      : `${down.length} 项业务有故障，其余 ${others} 项正常`;
    const detail = [badCell?.reason, first.attribution].filter(Boolean).join(' · ');
    return { headline, detail: detail || undefined, tone: 'danger', rows, infra };
  }

  if (stale.length > 0) {
    return {
      headline: `${stale.length} 项业务最近没有真实调用，它的绿灯不作数`,
      detail: `${stale.map((r) => r.name).join('、')} 读的是真实流量的窗口统计，窗口里一次调用都没有 —— 那不是正常，是没人用过`,
      tone: 'warn',
      rows,
      infra,
    };
  }

  return {
    headline: `${rows.length} 项业务在 ${envCount} 个环境都正常`,
    detail: infra.down > 0
      ? `但基础设施有 ${infra.down} 项异常 —— 业务还没受影响，先去看那一项`
      : undefined,
    tone: infra.down > 0 ? 'warn' : 'ok',
    rows,
    infra,
  };
}

// ── 作用域：项目 × 环境 ──

export interface ProjectOption {
  id: string;
  name: string;
  /** 这个项目名下有几条业务监控。0 意味着「它的业务其实没人盯」。 */
  businessCount: number;
  /** 当前有几条业务不好（故障 + 零样本），项目选择器上直接标出来 */
  troubleCount: number;
}

/**
 * 项目清单。按「有事的排前面」排序——多项目负责人打开就该先看见出事的那个，
 * 而不是按字母顺序自己找。
 */
export function listProjects(targets: ReadonlyArray<UptimeTargetSummary>): ProjectOption[] {
  const byId = new Map<string, { name: string; businessCount: number; troubleCount: number }>();
  for (const target of targets) {
    if (!target.projectId) continue;
    const entry = byId.get(target.projectId) || { name: target.projectName || target.projectId, businessCount: 0, troubleCount: 0 };
    if (!entry.name && target.projectName) entry.name = target.projectName;
    byId.set(target.projectId, entry);
  }
  for (const [id, entry] of byId) {
    const rows = buildBusinessRows(targets.filter((t) => t.projectId === id));
    entry.businessCount = rows.length;
    entry.troubleCount = rows.filter((r) => r.worst === 'down' || r.worst === 'stale').length;
  }
  return [...byId.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((a, b) => b.troubleCount - a.troubleCount || a.name.localeCompare(b.name));
}

/** 这批目标实际覆盖到哪些环境（按关注度排序）。没有的环境不摆空格子。 */
export function listEnvironments(targets: ReadonlyArray<UptimeTargetSummary>): MonitorEnvironment[] {
  const seen = new Set(targets.map((t) => t.environment));
  return ENVIRONMENT_ORDER.filter((env) => seen.has(env));
}

export interface OwnerScope {
  /** null = 不限项目（多项目负责人的总览） */
  projectId: string | null;
  /** null = 全部环境；空数组同义于 null（一个都不选没有意义，退回全部） */
  environments: ReadonlyArray<MonitorEnvironment> | null;
}

/**
 * 收窄到某个项目 / 某些环境。
 *
 * 分支预览默认在不在里面由调用方决定 —— 这一屏的默认视图**不含**分支预览：
 * 项目负责人早上打开是要确认「我的业务今天有没有出事」，
 * 十几条临时分支的红黄绿只会把那句话淹掉。
 */
export function scopeTargets(
  targets: ReadonlyArray<UptimeTargetSummary>,
  scope: OwnerScope,
): UptimeTargetSummary[] {
  const envs = scope.environments && scope.environments.length > 0 ? new Set(scope.environments) : null;
  return targets.filter((t) => {
    if (scope.projectId && t.projectId !== scope.projectId) return false;
    if (envs && !envs.has(t.environment)) return false;
    return true;
  });
}

/** 默认环境集：除分支预览外的全部。分支预览要看，去「全部目标」。 */
export function defaultEnvironments(targets: ReadonlyArray<UptimeTargetSummary>): MonitorEnvironment[] {
  const present = listEnvironments(targets).filter((env) => env !== 'preview');
  // 一个项目如果只有分支预览（还没上过生产），那就让它看分支预览——
  // 否则第一屏会是一片空白，而它其实有东西可看。
  return present.length > 0 ? present : listEnvironments(targets);
}
