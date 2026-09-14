/**
 * 监控自发现：让实现了协议的服务自己说「该怎么监控我」。
 *
 * 为什么不是一份 yml：声明放在仓库里，就得有人导、有人审，而且必然漂移——
 * 服务改了自检端点，声明文件不会跟着改，两边说的话从那一刻起就不一样了，
 * 且没有任何东西会变红。把声明挪到服务自己的响应里，它和被监控的东西
 * 同生共死：改了立刻生效，没了自动下线。
 *
 * 心智是 USB：CDS 侧只需要知道**一个地址**（插上），设备自报描述符
 * （我有哪些可观测项、每项怎么判、多久看一次、坏了算多严重）。
 *
 * 协议载体不另造：IETF draft-inadarei-api-health-check 的 check 对象本来就是
 * 半个描述符（componentId / observedValue / observedUnit / status / time），
 * 只缺「该怎么判我」这几个字段。按该草案允许的扩展方式，在 check 上挂一个
 * `cds:monitor` 段补齐——命名带冒号前缀，与 check 键的「组件:度量」同风格，
 * 不会与草案保留字相撞。
 *
 * ── 三条安全与正确性命门（改这个文件前先读） ──
 *
 * 1. **自描述只决定「判什么」，不决定「打哪」**。服务可以说「我这条 check 该断言
 *    等于 0」，但不能说「去打另一个地址」。CDS 打的永远是那个已登记的端点。
 *    少了这条，一个被攻陷（或只是写错）的服务就能把 CDS 变成内网扫描器。
 *
 * 2. **没有 `cds:monitor` 的 check 不生成监控项**。自愿声明，不是默认全抓——
 *    默认全抓会让服务加一条调试用 check 就凭空多出一条会叫人的告警。
 *
 * 3. **一条写坏不连累其它条**：非法声明跳过并记下原因，既不整份作废
 *    （其余条目本来是好的），也不拿默认值蒙混（那会把一条写坏的声明
 *    变成一条永远绿的假判据，比没有更糟）。
 */

import { ASSERT_OPS, type AssertOp } from './monitor-assertions.js';

/** 自描述段挂在 check 对象上的键名。 */
export const DISCOVERY_KEY = 'cds:monitor';

export type DiscoverySeverity = 'P0' | 'P1' | 'P2';
export type DiscoveryField = 'status' | 'observedValue';

/** 常设轻探针的默认间隔：6 小时。与 stable-smoke 规则 25 同一个数。 */
export const DEFAULT_DISCOVERY_INTERVAL_SECONDS = 21600;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 24 * 3600;
const MAX_NAME_LENGTH = 80;

export interface DiscoveredMonitor {
  /**
   * 稳定标识：由端点地址 + componentId 派生。
   * 同一个端点上的同一条 check，每一轮都算出同一个 key —— 对账靠它，
   * 所以它不许含时间、不许含顺序号。
   */
  key: string;
  name: string;
  componentId: string;
  field: DiscoveryField;
  op: AssertOp;
  /** 期望值。exists / absent 没有期望值。 */
  value?: string;
  intervalSeconds: number;
  failuresToAlarm: number;
  severity: DiscoverySeverity;
  /** 被动观测时，样本量取哪条 check 的 observedValue */
  sampleComponentId?: string;
  observeMode: 'active' | 'passive';
  publicVisible: boolean;
  publicName?: string;
}

export interface DiscoveryRejection {
  componentId: string;
  reason: string;
}

export interface DiscoveryResult {
  monitors: DiscoveredMonitor[];
  /** 被跳过的声明与原因。要展示给人看——静默跳过等于这条监控凭空消失。 */
  rejected: DiscoveryRejection[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

/** 把 health+json 的 checks 摊平成 [componentId, check] 列表。三种写法都认，与 findHealthCheck 同口径。 */
function flattenChecks(doc: unknown): Array<[string, Record<string, unknown>]> {
  const checks = asRecord(doc)?.checks;
  if (!checks || typeof checks !== 'object') return [];
  const entries: Array<[string, unknown]> = Array.isArray(checks)
    ? checks.map((item, i) => [String(i), item])
    : Object.entries(checks as Record<string, unknown>);
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const [key, value] of entries) {
    for (const item of (Array.isArray(value) ? value : [value])) {
      const rec = asRecord(item);
      if (!rec) continue;
      out.push([str(rec.componentId) || key, rec]);
    }
  }
  return out;
}

/**
 * 稳定 key：端点 + componentId。
 * 端点地址原样进 key —— 同一个 componentId 出现在两个端点上是两条监控，不是一条。
 */
export function discoveryKey(endpointUrl: string, componentId: string): string {
  return `${endpointUrl}#${componentId}`;
}

/**
 * 解析一份自检响应，产出它自报的监控项。
 *
 * `endpointUrl` 只用于派生 key —— **不从文档里读地址**，那是命门 1。
 */
export function discoverMonitors(doc: unknown, endpointUrl: string): DiscoveryResult {
  const monitors: DiscoveredMonitor[] = [];
  const rejected: DiscoveryRejection[] = [];
  const seen = new Set<string>();

  for (const [componentId, check] of flattenChecks(doc)) {
    const spec = asRecord(check[DISCOVERY_KEY]);
    // 命门 2：没自愿声明的 check 不生成监控项，也不算「被拒绝」——它只是没报名。
    if (!spec) continue;

    const reject = (reason: string): void => { rejected.push({ componentId, reason }); };

    if (!componentId) { reject('这条 check 没有 componentId，无法稳定对账'); continue; }
    if (seen.has(componentId)) { reject('同一个端点上出现了重复的 componentId'); continue; }

    const field = (str(spec.field) || 'observedValue') as DiscoveryField;
    if (field !== 'status' && field !== 'observedValue') {
      reject(`field 只能是 status / observedValue，收到「${field}」`); continue;
    }
    const op = str(spec.op) as AssertOp;
    if (!ASSERT_OPS.includes(op)) {
      reject(`op 必须是 ${ASSERT_OPS.join(' / ')} 之一，收到「${op}」`); continue;
    }
    // 期望值允许是 "0"、也允许是 false —— 判空只看 undefined / null / 空串。
    // 用真值判断会把「数量等于 0」这条最该写的判据拒掉。
    const rawValue = spec.value;
    const value = rawValue === undefined || rawValue === null ? '' : String(rawValue).trim();
    const valueless = op === 'exists' || op === 'absent';
    if (!valueless && value === '') {
      reject(`op=${op} 必须给期望值`); continue;
    }

    const name = str(spec.name).slice(0, MAX_NAME_LENGTH) || componentId;

    const rawInterval = spec.intervalSeconds;
    let intervalSeconds = DEFAULT_DISCOVERY_INTERVAL_SECONDS;
    if (rawInterval !== undefined && rawInterval !== null) {
      const n = Number(rawInterval);
      if (!Number.isFinite(n) || n < MIN_INTERVAL_SECONDS || n > MAX_INTERVAL_SECONDS) {
        reject(`intervalSeconds 必须在 ${MIN_INTERVAL_SECONDS}-${MAX_INTERVAL_SECONDS} 之间，收到「${String(rawInterval)}」`);
        continue;
      }
      intervalSeconds = Math.floor(n);
    }

    const rawFailures = spec.failuresToAlarm;
    let failuresToAlarm = 2;
    if (rawFailures !== undefined && rawFailures !== null) {
      const n = Number(rawFailures);
      if (!Number.isInteger(n) || n < 1 || n > 10) {
        reject(`failuresToAlarm 必须是 1-10 的整数，收到「${String(rawFailures)}」`);
        continue;
      }
      failuresToAlarm = n;
    }

    const severity = (str(spec.severity) || 'P1') as DiscoverySeverity;
    if (severity !== 'P0' && severity !== 'P1' && severity !== 'P2') {
      reject(`severity 只能是 P0 / P1 / P2，收到「${severity}」`); continue;
    }

    const sampleComponentId = str(spec.sampleComponentId) || undefined;
    // 被动观测必须给样本量来源：读不到样本量时零流量与全部成功长得一模一样，
    // 那条监控会永远绿着（degradation-must-alarm 的「假绿」）。
    const observeMode = str(spec.observeMode) === 'passive' ? 'passive' : 'active';
    if (observeMode === 'passive' && !sampleComponentId) {
      reject('observeMode=passive 必须给 sampleComponentId，否则零流量会被读成一切正常');
      continue;
    }

    seen.add(componentId);
    monitors.push({
      key: discoveryKey(endpointUrl, componentId),
      name,
      componentId,
      field,
      op,
      ...(valueless ? {} : { value }),
      intervalSeconds,
      failuresToAlarm,
      severity,
      ...(sampleComponentId ? { sampleComponentId } : {}),
      observeMode,
      publicVisible: spec.publicVisible === true,
      ...(str(spec.publicName) ? { publicName: str(spec.publicName).slice(0, MAX_NAME_LENGTH) } : {}),
    });
  }

  // 顺序稳定：按 componentId 排，免得端点换个键序就让对账看起来「全变了」。
  monitors.sort((a, b) => a.componentId.localeCompare(b.componentId));
  rejected.sort((a, b) => a.componentId.localeCompare(b.componentId));
  return { monitors, rejected };
}
