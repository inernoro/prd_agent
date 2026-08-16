/**
 * 发布中心「全环境矩阵」的取数与判据。
 *
 * 设计稿（design_handoff_release_center）的第一屏是**一句挂着数字的判断** + 横着比
 * 所有环境的矩阵，而不是「先选一个目标再看它的详情」。这一份把那句判断、四个归因
 * 指标、排序与所有量纲规则收在一处——它们是纯函数，能单测，也不会散进 JSX 里各写一份。
 *
 * 三条贯穿始终的硬规则（设计稿「硬性约束」4/5，与仓库 conclusion-before-numbers 同源）：
 *
 * 1. **算不出就不出这句**。没有失败环境就不写失败句，没有落后环境就不写落后句。
 *    禁止「整体运行良好」这类放到任何团队都成立的空话。
 * 2. **缺数据明说缺什么**：未监测 / 样本不足 / 无法计算 / 未发布过，绝不渲染成 0 或 100%。
 * 3. **极端值换量纲**：比值超过三倍写 `×N`，时长不足 1 小时写分钟，占比小于 0.1% 写「不足 0.1%」。
 *
 * 设计稿原型里几个指标的归因是写死的示例文案（`prod-main 14 次中 1 次回滚`）。
 * 这里一律**从真实数据推**，推不出来就不给这一块——照抄示例文案等于对着用户编。
 */

import { isReleaseFailed, isReleaseTerminal, type CenterRow } from '@/pages/release-center/types';

export type FleetHealth = 'healthy' | 'failed' | 'unmonitored';
export type FleetType = 'production' | 'staging' | 'other';

export interface FleetLastRelease {
  atMs: number;
  by: string;
  durationSec: number | null;
  /**
   * 这条记录的**原始状态**，不做二分。
   *
   * 原来这里是 `ok: boolean`，等价于「不是 success 就算失败」——于是发布进行中
   * （queued / running / healthchecking / rollback_running）的环境在矩阵里全都
   * 显示成红色「失败」。每一次正常发布的过程中，生产那一行都在报假故障。
   *
   * 没有 run 记录、只有一个历史时间戳时给空串：那种情况下我们**不知道**它成没成，
   * 不许替它宣布成功（原来那一档硬写 `ok: true`）。
   */
  status: string;
}

export interface FleetDora {
  deploys: number;
  /** 0..1；样本不足时后端给 null，这里原样保留。 */
  changeFailureRatio: number | null;
  medianRecoveryMin: number | null;
}

/** 矩阵一行需要的全部字段。只从 CenterRow 取，不发明。 */
export interface FleetEnv {
  id: string;
  name: string;
  host: string;
  type: FleetType;
  isPrimary: boolean;
  enabled: boolean;
  liveSha: string;
  /** 落后主干几个提交。后端算不出时缺席（null），不是 0。 */
  behindMain: number | null;
  health: FleetHealth;
  /**
   * 近 24 小时可用率，**百分数 0..100**。没接探测时是 null。
   *
   * 后端 `ReleaseHealthProbe.availability24h` 是**比率 0..1**（见
   * release-health-snapshot.ts，shared.tsx 的 formatAvailability 也是 ×100）。
   * 这里在入口处一次换算成百分数，页面里就不用记「这个字段是哪种量纲」——
   * 记错的代价是 100% 显示成 1.00%，而且看着像个正常数字，没人会怀疑。
   */
  availability24h: number | null;
  lastRelease: FleetLastRelease | null;
  canRollback: boolean;
  /** 可提升到这个环境的候选版本 sha。 */
  promotableSha: string | null;
  /**
   * 这个候选**现在**能不能真发出去。false = 源环境那一版已经不是分支 tip，
   * 点下去必然吃一句「分支已前进…已拒绝发布」。
   *
   * 后端早就算好了（`row.promotion.executable`），概览卡也一直在用；矩阵这一层
   * 原来只取了 sha，于是同一个候选在概览里是「灰按钮 + 原因」，在矩阵里是
   * 「亮按钮 + 点了必失败」。没有候选时为 null。
   */
  promotableExecutable: boolean | null;
  /** executable=false 时的人话原因，直接给按钮当 title。 */
  promotableBlockedReason: string | null;
  dora: FleetDora | null;
}

/* ── 量纲 ──────────────────────────────────────────────────────────── */

/** 占比。小于 0.1% 不写 `0.05%`，写「不足 0.1%」——那个量级下小数点后两位是噪音。 */
export function formatFleetPercent(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (value > 0 && value < 0.1) return '不足 0.1%';
  return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(2)}%`;
}

/** 时长（分钟）。不足 1 小时写分钟，不写「0 小时」。 */
export function formatFleetMinutes(min: number | null | undefined): string | null {
  if (min === null || min === undefined || Number.isNaN(min)) return null;
  const whole = Math.round(min);
  if (whole < 60) return `${whole} 分钟`;
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 耗时（秒）。 */
export function formatFleetDuration(sec: number | null | undefined): string | null {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return null;
  const whole = Math.round(sec);
  if (whole < 60) return `${whole} 秒`;
  if (whole < 3600) {
    const m = Math.floor(whole / 60);
    const s = whole % 60;
    return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  }
  const h = Math.floor(whole / 3600);
  const m = Math.round((whole % 3600) / 60);
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** 相对时间。 */
export function formatFleetAgo(atMs: number | null, nowMs: number): string {
  if (atMs === null) return '从未发布';
  const min = Math.max(0, Math.round((nowMs - atMs) / 60_000));
  if (min < 60) return `${min} 分钟前`;
  if (min < 1440) return `${Math.floor(min / 60)} 小时前`;
  return `${Math.floor(min / 1440)} 天前`;
}

/** 倍数。超过三倍写 `×N`——`+1500%` 在这个量级读不出体感。 */
export function formatFleetRatio(a: number, b: number): string | null {
  if (!b) return null;
  const r = a / b;
  return r > 3 ? `×${Math.round(r)}` : `+${Math.round((r - 1) * 100)}%`;
}

/* ── CenterRow → FleetEnv ─────────────────────────────────────────── */

export function toFleetEnv(row: CenterRow): FleetEnv {
  const probe = row.health;
  // 后端 status 只有 healthy / failed / unknown；unknown 与「压根没有探测记录」
  // 都归成「未监测」——它们对用户是同一件事：这一格算不出来。
  const health: FleetHealth = probe?.status === 'healthy'
    ? 'healthy'
    : probe?.status === 'failed' ? 'failed' : 'unmonitored';

  const run = row.latestRun;
  const startedMs = run?.startedAt ? Date.parse(run.startedAt) : NaN;
  const finishedMs = run?.finishedAt ? Date.parse(run.finishedAt) : NaN;
  const lastAtMs = Number.isFinite(startedMs)
    ? startedMs
    : (row.lastReleasedAt ? Date.parse(row.lastReleasedAt) : NaN);

  const lastRelease: FleetLastRelease | null = Number.isFinite(lastAtMs)
    ? {
      atMs: lastAtMs,
      by: run?.operator || row.lastOperator || '-',
      durationSec: Number.isFinite(startedMs) && Number.isFinite(finishedMs)
        ? Math.max(0, Math.round((finishedMs - startedMs) / 1000))
        : null,
      status: run?.status || '',
    }
    : null;

  const dora: FleetDora | null = row.dora
    ? {
      deploys: row.dora.frequency.successCount,
      changeFailureRatio: row.dora.changeFailure.ratio,
      medianRecoveryMin: row.dora.recovery.p50Ms === null ? null : row.dora.recovery.p50Ms / 60_000,
    }
    : null;

  const environment = row.target.environment;
  return {
    id: row.target.id,
    name: row.target.name,
    host: row.target.ssh?.host || row.target.type || '',
    type: environment === 'production' || environment === 'staging' ? environment : 'other',
    isPrimary: Boolean(row.target.isCanonical),
    enabled: row.target.isEnabled !== false,
    liveSha: row.currentCommit || '',
    behindMain: typeof row.commitPosition?.behindCount === 'number' ? row.commitPosition.behindCount : null,
    health,
    // ×100：后端给的是比率，这一层统一成百分数（漏乘会把 100% 显示成 1.00%）
    availability24h: typeof probe?.availability24h === 'number' ? probe.availability24h * 100 : null,
    lastRelease,
    canRollback: Boolean(row.canRollback),
    promotableSha: row.promotion?.commitSha || null,
    promotableExecutable: row.promotion ? row.promotion.executable !== false : null,
    promotableBlockedReason: row.promotion?.blockedReason || null,
    dora,
  };
}

/* ── 判断句 ────────────────────────────────────────────────────────── */

/** 判断句的一段。`link` 段是可点的环境名，点了下钻到该环境的配置。 */
export interface VerdictSegment {
  text: string;
  envId?: string;
}

export interface FleetVerdict {
  tone: 'bad' | 'warn' | 'ok';
  /** 主句。拼起来就是完整一句；envId 段渲染成链接。 */
  segments: VerdictSegment[];
  /** 主句下方那行小字：数据口径与未监测环境说明。 */
  gap: string;
  /** 「去处理 X」按钮的目标；没有要处理的就没有这个按钮。 */
  actionEnvId: string | null;
}

const BEHIND_ALERT = 12;

/**
 * 生成第一屏那句判断。
 *
 * 顺序固定：先说失败（最要紧），没有失败就说全部通过；再补落后主干那一句。
 * 每一段都必须挂着能归因的数字，凑不出的段落**整段不出**。
 */
export function buildFleetVerdict(envs: FleetEnv[], nowMs: number): FleetVerdict {
  const live = envs.filter((env) => env.enabled);
  const failing = live.filter((env) => env.health === 'failed');
  const unmonitored = envs.filter((env) => env.health === 'unmonitored');
  const stale = live.filter((env) => env.behindMain !== null && env.behindMain >= BEHIND_ALERT);

  const segments: VerdictSegment[] = [];
  let tone: FleetVerdict['tone'] = 'ok';

  if (failing.length > 0) {
    const first = failing[0];
    tone = 'bad';
    segments.push({ text: `${live.length} 个启用环境里，${failing.length} 个健康检查失败：` });
    segments.push({ text: first.name, envId: first.id });
    const bits: string[] = [];
    if (first.lastRelease) {
      const when = formatFleetAgo(first.lastRelease.atMs, nowMs);
      // 同样不做二分：在途状态既不是成功也不是失败，复用既有的两个共享谓词
      // 组合出三档，不在这里再抄一份状态表。
      const st = first.lastRelease.status;
      const phase = !st
        ? '发布'
        : !isReleaseTerminal(st) ? '发布进行中' : isReleaseFailed(st) ? '发布失败' : '发布成功';
      bits.push(`${when}${phase}（${first.lastRelease.by}）`);
    }
    const avail = formatFleetPercent(first.availability24h);
    if (avail) bits.push(`24 小时可用率 ${avail}`);
    segments.push({ text: bits.length ? `，${bits.join('，')}。` : '。' });
  } else if (live.length > 0) {
    // 「全部通过」也必须挂数字，否则就是那句放到任何团队都成立的空话。
    const monitored = live.filter((env) => env.health === 'healthy').length;
    segments.push({ text: `${live.length} 个启用环境里 ${monitored} 个健康检查通过，没有失败中的环境。` });
  }

  if (stale.length > 0) {
    if (tone === 'ok') tone = 'warn';
    const worst = stale.slice().sort((a, b) => (b.behindMain || 0) - (a.behindMain || 0))[0];
    segments.push({ text: `另有 ${stale.length} 个环境落后主干 ${BEHIND_ALERT} 个提交以上，其中 ` });
    segments.push({ text: worst.name, envId: worst.id });
    segments.push({
      text: worst.promotableSha
        ? ` 落后最多，已有可提升候选版本 ${worst.promotableSha.slice(0, 7)}。`
        : ' 落后最多。',
    });
  }

  const gap = unmonitored.length > 0
    ? `${unmonitored.length} 个环境未监测（${unmonitored.map((env) => env.name).join('、')}）：它们的可用率、恢复时长与变更失败率都算不出来，本页所有比率均不含这些环境。`
    : '全部环境均已接入健康探测，本页比率覆盖所有启用环境。';

  return {
    tone,
    segments,
    gap,
    actionEnvId: failing[0]?.id || (stale.length > 0 ? stale.slice().sort((a, b) => (b.behindMain || 0) - (a.behindMain || 0))[0].id : null),
  };
}

/* ── 四个归因指标 ──────────────────────────────────────────────────── */

/** 中位数。偶数个取中间两个的平均——取上位那个会让「最多 vs 中位」在只有两个
 *  环境时恒等（48/48 = +0%），读起来像没差距，其实差一倍。 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export interface FleetMetric {
  key: 'deploys' | 'changeFailure' | 'recovery' | 'behind';
  label: string;
  value: string;
  /**
   * 归因一行。说清这个数主要是谁贡献的——只说数字不说来源，读者没法行动。
   *
   * 拆成两段是因为环境名可以很长（真实数据里就有「MAP 正式环境受管发布」），
   * 单串渲染时省略号会从尾巴吃起，先吃掉的恰恰是那个数字——归因句里最该活下来的
   * 就是数字，名字才是可以截的那半。所以 name 允许截断，detail 永不收缩。
   */
  attributionName: string;
  attributionDetail: string;
  tone: 'plain' | 'warn' | 'bad';
}

/**
 * 四个指标。**算不出的那一块直接不出**，不占位、不给 0。
 *
 * 归因全部从真实数据推：设计稿原型里写死的 `prod-main 14 次中 1 次回滚` 只是示例，
 * 照抄等于对着用户编。
 */
export function buildFleetMetrics(envs: FleetEnv[]): FleetMetric[] {
  const metrics: FleetMetric[] = [];
  const withDora = envs.filter((env) => env.dora);

  if (withDora.length > 0) {
    const total = withDora.reduce((sum, env) => sum + (env.dora?.deploys || 0), 0);
    const top = withDora.slice().sort((a, b) => (b.dora?.deploys || 0) - (a.dora?.deploys || 0))[0];
    metrics.push({
      key: 'deploys',
      label: '近 30 天发布',
      value: `${total} 次`,
      attributionName: top && top.dora ? top.name : '',
      attributionDetail: top && top.dora ? `占 ${top.dora.deploys} 次` : '样本不足',
      tone: 'plain',
    });
  }

  const withCfr = withDora.filter((env) => env.dora?.changeFailureRatio !== null && env.dora?.changeFailureRatio !== undefined);
  if (withCfr.length > 0) {
    const worst = withCfr.slice().sort((a, b) => (b.dora?.changeFailureRatio || 0) - (a.dora?.changeFailureRatio || 0))[0];
    const ratio = (worst.dora?.changeFailureRatio || 0) * 100;
    metrics.push({
      key: 'changeFailure',
      label: '变更失败率',
      value: formatFleetPercent(Math.round(ratio * 100) / 100) || '样本不足',
      attributionName: worst.name,
      attributionDetail: '最高',
      tone: ratio >= 15 ? 'bad' : 'warn',
    });
  }

  const withMttr = withDora.filter((env) => env.dora?.medianRecoveryMin !== null && env.dora?.medianRecoveryMin !== undefined);
  if (withMttr.length > 0) {
    const slowest = withMttr.slice().sort((a, b) => (b.dora?.medianRecoveryMin || 0) - (a.dora?.medianRecoveryMin || 0))[0];
    const mid = median(withMttr.map((item) => item.dora?.medianRecoveryMin || 0));
    metrics.push({
      key: 'recovery',
      label: '恢复中位',
      value: formatFleetMinutes(mid) || '样本不足',
      attributionName: slowest.name,
      attributionDetail: `为 ${formatFleetMinutes(slowest.dora?.medianRecoveryMin) || '样本不足'}`,
      tone: 'plain',
    });
  }

  const behinds = envs.filter((env) => env.enabled && env.behindMain !== null);
  if (behinds.length > 0) {
    const sorted = behinds.slice().sort((a, b) => (b.behindMain || 0) - (a.behindMain || 0));
    const worst = sorted[0];
    const mid = median(behinds.map((item) => item.behindMain || 0));
    // 只有一个环境时「最多 vs 中位」恒等，那句 `+0%` 是废话，不如不说。
    const ratio = behinds.length > 1 && mid !== null ? formatFleetRatio(worst.behindMain || 0, mid) : null;
    // 最多也才 0，说明全都追平了——「落后最多 0 个提交」是一句没有信息的话，不出。
    if ((worst.behindMain || 0) === 0) return metrics;
    metrics.push({
      key: 'behind',
      label: '落后最多',
      value: `${worst.behindMain} 个提交`,
      attributionName: worst.name,
      attributionDetail: ratio && ratio !== '+0%' ? `中位数的 ${ratio}` : '',
      tone: (worst.behindMain || 0) >= BEHIND_ALERT ? 'bad' : 'plain',
    });
  }

  return metrics;
}

/* ── 排序 ──────────────────────────────────────────────────────────── */

export type FleetSortKey = 'severity' | 'name' | 'type' | 'behind' | 'last';

export const FLEET_SORTS: Array<{ key: FleetSortKey; label: string }> = [
  { key: 'severity', label: '严重度' },
  { key: 'name', label: '名称' },
  { key: 'type', label: '类型' },
  { key: 'behind', label: '落后提交' },
  { key: 'last', label: '最近发布' },
];

const SEVERITY: Record<FleetHealth, number> = { failed: 0, healthy: 1, unmonitored: 2 };
const TYPE_ORDER: FleetType[] = ['production', 'staging', 'other'];

/** 默认严重度：失败 → 健康 → 未监测，同档再按落后数降序。 */
export function sortFleet(envs: FleetEnv[], key: FleetSortKey): FleetEnv[] {
  const list = envs.slice();
  switch (key) {
    case 'name':
      return list.sort((a, b) => a.name.localeCompare(b.name));
    case 'type':
      return list.sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
    case 'behind':
      // 算不出的排最后：它不是「落后 0」，不该混进最新那一头。
      return list.sort((a, b) => (b.behindMain ?? -1) - (a.behindMain ?? -1));
    case 'last':
      return list.sort((a, b) => (b.lastRelease?.atMs ?? -1) - (a.lastRelease?.atMs ?? -1));
    default:
      return list.sort((a, b) => SEVERITY[a.health] - SEVERITY[b.health] || (b.behindMain || 0) - (a.behindMain || 0));
  }
}

/* ── 单元格文案 ────────────────────────────────────────────────────── */

export function fleetTypeText(type: FleetType): string {
  return type === 'production' ? '生产' : type === 'staging' ? '预发' : '其它';
}

export function fleetHealthText(health: FleetHealth): string {
  return health === 'healthy' ? '健康' : health === 'failed' ? '失败' : '未监测';
}

/** 可用率格。未监测就写「未监测」——**绝不写 0% 或 100%**。 */
export function fleetAvailabilityText(env: FleetEnv): string {
  if (env.availability24h === null) return env.health === 'unmonitored' ? '未监测' : '无数据';
  return formatFleetPercent(env.availability24h) || '无数据';
}

export function fleetBehindText(env: FleetEnv): string {
  if (env.behindMain === null) return '无法计算';
  return env.behindMain === 0 ? '已是最新' : `落后 ${env.behindMain} 个`;
}
