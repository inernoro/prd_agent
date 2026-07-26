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
  lastFailureCode?: string;
  lastChangeAt: number;
}

export interface ReplicaHealthSnapshotEntry {
  key: string;
  consecutiveFails: number;
  ejectedUntil: number;
  ejectRounds: number;
  lastFailureCode?: string;
}

function keyOf(route: RouteRecord): string | null {
  if (!route.replicaGroup) return null;
  return `${route.replicaGroup}::${route.replicaMemberId ?? 'primary'}`;
}

export class ReplicaHealthRegistry {
  private state = new Map<string, MemberHealth>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 上游连接失败（proxy-handler upstream 'error' 回调）。非致命错误码不计。 */
  noteFailure(route: RouteRecord, code: string | undefined): void {
    const key = keyOf(route);
    if (!key || !code || !FATAL_CODES.has(code)) return;
    const cur = this.state.get(key) ?? { consecutiveFails: 0, ejectedUntil: 0, ejectRounds: 0, lastChangeAt: 0 };
    cur.consecutiveFails += 1;
    cur.lastFailureCode = code;
    cur.lastChangeAt = this.now();
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

  /** 该成员当前是否处于摘除窗内（冷却到期即放行半开试探）。 */
  isEjected(route: RouteRecord): boolean {
    const key = keyOf(route);
    if (!key) return false;
    const cur = this.state.get(key);
    if (!cur) return false;
    return cur.ejectedUntil > this.now();
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
