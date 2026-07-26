/**
 * 复制集被动健康摘除（debt.cds.replica-set #12 偿还，2026-07-26）。
 *
 * 背景：分流只按权重选成员，死副本（端口未监听）仍按权重接真实流量——
 * 孤儿收割器误杀事故里入口 50% 请求 503 达数小时。控制面对账（60s 周期 +
 * die 事件秒级）已把死副本标 error 摘出路由表，但两次发布之间（路由表
 * 2s 重建 + 控制面探测间隔）仍有秒级到分钟级的坏窗口。本模块是数据面的
 * 最后一道防线：forwarder 自己观察上游连接结果，连续连接失败的成员就地
 * 临时摘除，冷却后半开回池。
 *
 * 纪律（宁可漏摘不可误摘）：
 *   - 只统计**连接级死亡信号**（ECONNREFUSED / EHOSTUNREACH / ENOTFOUND）。
 *     HTTP 5xx 是应用层的合法响应（业务错误也该被用户看到），超时可能只是慢，
 *     ECONNRESET 可能是重启瞬间——都不计入摘除判定。
 *   - 连续 2 次连接失败才摘除（单次可能撞上容器正在重启的瞬间）。
 *   - 摘除是**临时**的：冷却窗（15s 起，连续再失败指数翻倍，封顶 120s）到期
 *     自动放行试探请求（半开）；一次成功即完全回池。
 *   - 永远不把流量摘到没有出口：全组皆摘时回落主成员（最后的兜底，即使
 *     主成员也在摘除名单里——有响应机会总好过必然 503）。该兜底在
 *     route-resolver.pickReplica 落地，本模块只回答「这个成员现在健康吗」。
 */
import type { RouteRecord } from './types.js';

const FAILS_TO_EJECT = 2;
const BASE_EJECT_MS = 15_000;
const MAX_EJECT_MS = 120_000;

/** 计入摘除判定的连接级死亡信号（与 proxy-handler ERR_HINTS 的 503 组一致） */
const FATAL_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND']);

interface MemberHealth {
  consecutiveFails: number;
  /** 摘除截止时间戳（ms）；0 = 未摘除 */
  ejectedUntil: number;
  /** 连续摘除轮数（指数退避的指数） */
  ejectRounds: number;
  /** 半开探针占位时间戳（ms）；0 = 无在途探针。冷却到期后只放行**一个**请求试探 */
  probeStartedAt: number;
  lastFailureCode?: string;
  lastChangeAt: number;
}

/** 半开探针占位超时：探针请求既没成功也没触发失败回调（如客户端中途放弃）时，
 * 超过该时长允许下一个请求接棒试探，防止成员被无限期卡在摘除态。 */
const PROBE_TIMEOUT_MS = 10_000;

export interface ReplicaHealthSnapshotEntry {
  key: string;
  consecutiveFails: number;
  ejectedUntil: number;
  ejectRounds: number;
  lastFailureCode?: string;
}

/**
 * 健康状态 key 纳入上游端口（Codex P2）：主容器重部署换端口、复制集解散重建
 * 后 res-N 从 1 重排——同名不同实例。key 不带端口时，旧实例攒下的摘除窗会
 * 压住全新的健康替身 15-120 秒。端口变即新 key，旧 key 状态自然失联
 *（noteFailure 侧带闲置清理，防 map 无界增长）。
 */
function keyOf(route: RouteRecord): string | null {
  if (!route.replicaGroup) return null;
  return `${route.replicaGroup}::${route.replicaMemberId ?? 'primary'}::${route.upstreamPort}`;
}

/** 闲置健康状态清理阈值：超过该时长无任何信号的条目视为陈旧（实例已换代） */
const STALE_STATE_MS = 30 * 60_000;

export class ReplicaHealthRegistry {
  private state = new Map<string, MemberHealth>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 上游连接失败（proxy-handler upstream 'error' 回调）。非致命错误码不计。 */
  noteFailure(route: RouteRecord, code: string | undefined): void {
    const key = keyOf(route);
    if (!key || !code || !FATAL_CODES.has(code)) return;
    // 顺路清扫陈旧条目（端口换代后的旧 key 无人再触达）：防 map 无界增长
    if (this.state.size > 256) {
      const cutoff = this.now() - STALE_STATE_MS;
      for (const [k, v] of this.state.entries()) {
        if (v.lastChangeAt < cutoff) this.state.delete(k);
      }
    }
    const cur = this.state.get(key) ?? { consecutiveFails: 0, ejectedUntil: 0, ejectRounds: 0, probeStartedAt: 0, lastChangeAt: 0 };
    cur.consecutiveFails += 1;
    cur.lastFailureCode = code;
    cur.lastChangeAt = this.now();
    cur.probeStartedAt = 0;
    if (cur.consecutiveFails >= FAILS_TO_EJECT) {
      const backoff = Math.min(MAX_EJECT_MS, BASE_EJECT_MS * 2 ** cur.ejectRounds);
      cur.ejectedUntil = this.now() + backoff;
      cur.ejectRounds += 1;
      // 半开试探失败会立刻再触发（consecutiveFails 已 >= 阈值），退避翻倍
      cur.consecutiveFails = FAILS_TO_EJECT - 1;
    }
    this.state.set(key, cur);
  }

  /** 上游成功给出响应（任何状态码——能响应就是活着）：完全回池。 */
  noteSuccess(route: RouteRecord): void {
    const key = keyOf(route);
    if (!key) return;
    if (this.state.has(key)) this.state.delete(key);
  }

  /**
   * 该成员当前是否处于摘除窗内。冷却到期后只放行**一个**半开探针请求
   *（Codex P2）：高流量下若到期即对所有请求放行，死成员会在每个退避周期
   * 挨一波真实流量、用户看到成波的 503；探针占位后其余请求继续走健康成员，
   * 直到探针成功（回池）/失败（再摘）/超时（下一个请求接棒）。
   */
  isEjected(route: RouteRecord): boolean {
    const key = keyOf(route);
    if (!key) return false;
    const cur = this.state.get(key);
    if (!cur) return false;
    const now = this.now();
    if (cur.ejectedUntil > now) return true;
    if (cur.ejectedUntil === 0) return false;
    // 冷却已到期：半开态。占位探针在途且未超时 → 其余请求仍视为摘除。
    // 本方法是**纯查询**（Codex 第十六轮 P2）：占位不在这里发生——resolver 的
    // 候选过滤会对每个成员调本方法，若查询即占位，低权重成员会在加权掷签
    // **之前**就被占掉唯一探针名额；掷签落到别的健康成员时没有任何请求真的
    // 去探它，占位只能等 10s 超时，反复错过会把恢复拖长数分钟。占位改由
    // reserveProbe 在**最终选中**该成员后执行。
    return cur.probeStartedAt > 0 && now - cur.probeStartedAt < PROBE_TIMEOUT_MS;
  }

  /**
   * 半开探针占位：仅当该成员处于「冷却已到期且无在途探针」的半开态时生效。
   * 由 route-resolver 在加权选择**选中**该成员后调用——选中者才占位，落选者
   * 不烧名额。Node 单线程下「查询 → 选择 → 占位」同步完成，无竞态窗口。
   */
  reserveProbe(route: RouteRecord): void {
    const key = keyOf(route);
    if (!key) return;
    const cur = this.state.get(key);
    if (!cur) return;
    const now = this.now();
    if (cur.ejectedUntil === 0 || cur.ejectedUntil > now) return;
    if (cur.probeStartedAt > 0 && now - cur.probeStartedAt < PROBE_TIMEOUT_MS) return;
    cur.probeStartedAt = now;
  }

  /** 诊断快照（forwarder 诊断端点用）。 */
  snapshot(): ReplicaHealthSnapshotEntry[] {
    const out: ReplicaHealthSnapshotEntry[] = [];
    for (const [key, v] of this.state.entries()) {
      out.push({
        key,
        consecutiveFails: v.consecutiveFails,
        ejectedUntil: v.ejectedUntil,
        ejectRounds: v.ejectRounds,
        lastFailureCode: v.lastFailureCode,
      });
    }
    return out;
  }
}
