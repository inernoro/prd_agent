/**
 * 自发现监控的对账：把「端点这一轮自报了什么」变成「库里该增、该改、该下线谁」。
 *
 * ── 命门：拔出与断线不是一回事 ──
 *
 * 端点通、某条 check 不在了 → 那条下线（USB 拔出）。
 * 端点整个打不通 → **一条都不下线**。它本身就是故障，不是「这些监控不需要了」；
 * 一次网络抖动把一整个项目的监控删干净，比故障本身更糟，而且删掉之后
 * 连「谁不见了」都没人知道了。
 *
 * 这两种情况在调用方看来长得很像（都拿不到声明），所以接口刻意用
 * `undefined` 与 `{monitors: []}` 区分，不允许用一个空数组同时表达两件事。
 */

import type { UptimeCustomMonitor } from '../types.js';
import type { DiscoveredMonitor } from './monitor-discovery.js';

/** 自发现监控的 id 前缀。人工与 Agent 登记的 id 是随机串，前缀在结构上不会相撞。 */
export const DISCOVERED_ID_PREFIX = 'disc-';

/**
 * 从稳定 key 里取回端点地址。
 *
 * 用 lastIndexOf 而不是 split('#')[0]：URL 自己就允许带 fragment，
 * 按第一个 `#` 切会把 `https://a/b#c#componentId` 的端点切成 `https://a/b`——
 * 于是这条监控永远对不上它真正的端点，既不更新也不下线。
 */
export function endpointOfDiscoveryKey(key: string): string {
  const i = (key || '').lastIndexOf('#');
  return i < 0 ? '' : key.slice(0, i);
}

/** 由稳定 key 派生一个稳定且合法的监控 id（只含字母数字与连字符，≤64 位）。 */
export function discoveredMonitorId(key: string, hash: (s: string) => string): string {
  return `${DISCOVERED_ID_PREFIX}${hash(key).slice(0, 24)}`;
}

export interface ReconcileInput {
  endpointUrl: string;
  projectId: string;
  /**
   * 这一轮从端点读到的声明。
   * **端点打不通时传 undefined**，不要传空数组——那是「读到了，但它一条都不报」，
   * 语义完全相反（见文件顶部的命门）。
   */
  discovered: ReadonlyArray<DiscoveredMonitor> | undefined;
  /** 库里当前属于这个端点的自发现监控 */
  existing: ReadonlyArray<UptimeCustomMonitor>;
  hash: (s: string) => string;
  now: () => string;
}

export interface ReconcilePlan {
  upsert: UptimeCustomMonitor[];
  /** 要删掉的监控 id */
  remove: string[];
  /** true = 端点这一轮打不通，所以刻意一条都没下线 */
  heldBecauseUnreachable: boolean;
}

function toMonitor(
  item: DiscoveredMonitor,
  input: ReconcileInput,
  existing: UptimeCustomMonitor | undefined,
): UptimeCustomMonitor {
  const now = input.now();
  return {
    id: discoveredMonitorId(item.key, input.hash),
    name: item.name,
    kind: 'health-json',
    url: input.endpointUrl,
    method: 'GET',
    healthComponentId: item.componentId,
    healthField: item.field,
    // health-json 的比较运算是六个的子集；exists / absent 在 discovery 层就该被
    // 挡住（自检端点的 check 字段要么有要么没有，「存在性」不是一条值得告警的判据）。
    healthOp: item.op as NonNullable<UptimeCustomMonitor['healthOp']>,
    healthValue: item.value ?? '',
    intervalSeconds: item.intervalSeconds,
    projectId: input.projectId,
    enabled: true,
    observeMode: item.observeMode,
    ...(item.sampleComponentId ? { sampleCountPath: item.sampleComponentId } : {}),
    publicVisible: item.publicVisible,
    ...(item.publicName ? { publicName: item.publicName } : {}),
    // 自发现的监控由端点维护，人改了下一轮会被覆盖——所以来源必须标明，
    // 界面据此把编辑入口关掉，而不是让人改完发现白改（那才是漂移源）。
    origin: 'discovered',
    createdByKind: 'human',
    createdBy: existing?.createdBy || '自检端点自报',
    discoveryKey: item.key,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    // 观测证据跟着监控走，重建定义不该把历史证据清掉。
    ...(existing?.observations?.length ? { observations: existing.observations } : {}),
  };
}

/** 两条定义在「会影响探测行为」的字段上是否一致。只比这些，免得每轮都因为 updatedAt 变化而重写台账。 */
function sameShape(a: UptimeCustomMonitor, b: UptimeCustomMonitor): boolean {
  const pick = (m: UptimeCustomMonitor) => JSON.stringify([
    m.name, m.url, m.healthComponentId, m.healthField, m.healthOp, m.healthValue,
    m.intervalSeconds, m.observeMode, m.sampleCountPath, m.publicVisible, m.publicName, m.enabled,
  ]);
  return pick(a) === pick(b);
}

export function reconcileDiscoveredMonitors(input: ReconcileInput): ReconcilePlan {
  const byKey = new Map(input.existing.map((m) => [m.discoveryKey || '', m]));

  if (input.discovered === undefined) {
    // 端点打不通：不增不删。这一轮什么都不知道，就什么都不做。
    return { upsert: [], remove: [], heldBecauseUnreachable: true };
  }

  const upsert: UptimeCustomMonitor[] = [];
  const liveKeys = new Set<string>();
  for (const item of input.discovered) {
    liveKeys.add(item.key);
    const prev = byKey.get(item.key);
    const next = toMonitor(item, input, prev);
    // 没变就不写：每轮无脑重写会把台账的 updatedAt 刷成噪音，
    // 还会让「这条监控最近被谁改过」这个问题永远答不出来。
    if (prev && sameShape(prev, next)) continue;
    upsert.push(next);
  }

  const remove = input.existing
    .filter((m) => !liveKeys.has(m.discoveryKey || ''))
    .map((m) => m.id);

  return { upsert, remove, heldBecauseUnreachable: false };
}
