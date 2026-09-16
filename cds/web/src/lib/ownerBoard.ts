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

/**
 * 卡片上那句读数。
 *
 * 与 assessCell **共用同一个值**：文案里出现的样本量，必须就是判据用的那个。
 * 曾经这句话写在组件里、用 `sampleCount ?? 0` 兜底，于是「这一轮没读到」被
 * 显示成「0 次真实调用」——而判据把 undefined 当「没读到」判了正常。
 * 页面上白纸黑字写着 0，系统却说一切正常，两边说的不是同一件事
 * （predicate-and-wiring-discipline 形状 6：判据读的值不是显示的那个值）。
 */
export function describeRow(row: Pick<BusinessRow, 'observeMode' | 'cells' | 'worst'>): string {
  const worstCell = row.cells.find((c) => c.health === row.worst) ?? row.cells[0];
  if (worstCell?.reason) return `${worstCell.label} ${worstCell.reason}`;
  if (row.observeMode === 'passive') {
    const sample = row.cells.find((c) => c.sampleCount !== undefined)?.sampleCount;
    // 读不到就说读不到。补一个 0 上去是在替判据撒谎。
    if (sample === undefined) return '被动观测，这一轮没读到样本量';
    return `窗口内 ${sample} 次真实调用，无异常`;
  }
  return `${row.cells.length} 个环境都通过判据`;
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
  /**
   * 其中有多少条是分支预览。
   *
   * 单独拎出来是因为它们**默认不进业务视角**：一个实例里分支预览往往占九成，
   * 混进第一屏会把「我的业务今天怎么样」这句话淹掉。但也不能让它们凭空消失——
   * 用户会问「我明明有 170 个目标，这里怎么只剩 2 个」。
   */
  preview: number;
}

export interface OwnerBoard {
  /** 第一行的判断句。永远有一句，包括「一条业务监控都还没有」。 */
  headline: string;
  /** 第二行：归因 / 数字支撑。说不出来就没有。 */
  detail?: string;
  tone: 'danger' | 'warn' | 'ok' | 'empty';
  rows: BusinessRow[];
  infra: InfraSummary;
  /**
   * 当前环境筛选把业务监控**全部**挡在外面时，它们实际在哪些环境。
   *
   * 有值 = 空白第一屏不是「还没有业务监控」，而是「筛选挡住了」。UI 据此给一键切换。
   * 只在 rows 为空时可能有值；正常有行时永远 undefined（没有「部分被挡」这种半态，
   * 那会让这个字段变成一个谁都不敢信的可选提示）。
   */
  hiddenEnvironments?: MonitorEnvironment[];
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
    preview: infra.filter((t) => t.environment === 'preview').length,
  };
}

/**
 * 第一屏。
 *
 * 空态是这里最要紧的一句：一条业务监控都没有时，页面绝不能说「一切正常」——
 * 那时盯着的只有容器与端口，业务坏了这里根本不会红，而那正是用户问
 * 「我那么多条验收都解决不了这种低级错误」的原因。
 */
export function buildOwnerBoard(
  targets: ReadonlyArray<UptimeTargetSummary>,
  /**
   * **未经环境筛选**的同一批目标（调用方按项目收窄后、按环境收窄前的那一份）。
   *
   * 两个用途，都必须是这一份而不是 `targets`：
   *   - 基础设施统计：被环境筛选挡掉的分支预览仍然计入——「塌了要知道」不该被业务视角过滤掉；
   *   - 空态判真假：业务监控全被环境筛选挡住时，第一屏不许说「还没有一条业务监控」。
   */
  unfiltered: ReadonlyArray<UptimeTargetSummary> = targets,
): OwnerBoard {
  const rows = buildBusinessRows(targets);
  const infra = summarizeInfra(unfiltered);

  if (rows.length === 0) {
    // 空白第一屏有两种成因，说反了就是撒谎：真的一条都没建，还是建了但被筛选挡住。
    // 2026-09-11 角色验收现场：6 条业务监控全在分支预览，默认筛选只看生产，
    // 于是「我的业务」写着「还没有一条」，而同一页的「全部目标」正列着这 6 条。
    const hidden = buildBusinessRows(unfiltered);
    if (hidden.length > 0) {
      const cells = hidden.flatMap((r) => r.cells);
      const environments = ENVIRONMENT_ORDER.filter((env) => cells.some((c) => c.environment === env));
      const labels = environments.map((env) => cells.find((c) => c.environment === env)?.label ?? env);
      return {
        headline: `${hidden.length} 项业务监控都不在当前环境筛选里`,
        detail: `它们在「${labels.join('、')}」—— 这一屏默认只看非预览的环境，把那个环境勾上就能看到`,
        tone: 'warn',
        rows,
        infra,
        hiddenEnvironments: environments,
      };
    }
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

/**
 * 默认环境集：除分支预览外的全部。分支预览要看，去「全部目标」。
 *
 * **人口必须是业务监控，不是全部目标**（predicate-and-wiring-discipline 形状 6：
 * 判据读的值不是真正生效的那个值）。第一屏只画业务监控，那么「有没有非预览的
 * 东西可看」也只能按业务监控数。按全部目标数会被两百多个基础设施容器带偏：
 * 它们有生产实例 → 默认只勾生产 → 而业务监控全在分支预览 → 第一屏空白。
 * 兜底逻辑写得对、测试也绿，错的是它数的那批人。
 */
export function defaultEnvironments(targets: ReadonlyArray<UptimeTargetSummary>): MonitorEnvironment[] {
  const business = targets.filter(isBusinessTarget);
  // 一条业务监控都没有时退回全部目标：那一屏说的是「还没有业务监控」，
  // 环境筛选至少得落在一组有意义的值上，不能是空集。
  const population = business.length > 0 ? business : targets;
  const present = listEnvironments(population).filter((env) => env !== 'preview');
  // 一个项目如果只有分支预览（还没上过生产），那就让它看分支预览——
  // 否则第一屏会是一片空白，而它其实有东西可看。
  return present.length > 0 ? present : listEnvironments(population);
}
