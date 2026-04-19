/**
 * Branch-event bus — Phase "live UI stream" (2026-04-19).
 *
 * 一个进程级单例 EventEmitter,让三条互不依赖的代码路径可以无脑
 * 把"分支状态变了"这件事推给前端,而不用各自造 SSE:
 *
 *   github-webhook-dispatcher.ts  → push/delete/PR 事件驱动
 *   StateService.addBranch/remove → manual / API 调用驱动
 *   branches.ts /deploy SSE       → 部署生命周期各阶段
 *
 * 所有订阅者(当前只有 `GET /api/branches/stream`)通过 .on('event', cb)
 * 订阅,事件 payload 是扁平 JSON (无类自引用),可以直接走 JSON.stringify
 * 塞到 SSE `data:` 行。
 *
 * 设计约束:
 *   - 不持久化。进程重启历史事件丢弃,这是 UI 提示层,不是审计日志。
 *   - 无上限 listener(最多几十个 Dashboard tab 同时连,Node 默认 10
 *     会 warn,这里 setMaxListeners(0))
 *   - 发送侧永远同步 emit,不 throw —— 订阅方崩了不应阻断主业务
 *   - 事件结构演进兼容: 新字段只加不改;旧版本前端不认识的字段 JSON
 *     解析能吞
 *
 * 对齐 .claude/rules/server-authority.md §2:
 *   SSE 断线不应取消服务端任务 —— 本 bus 只是观察点,与部署/webhook
 *   无耦合,订阅者全断了业务照常跑。
 */

import { EventEmitter } from 'node:events';
import type { BranchEntry } from '../types.js';

/** 分支事件类型枚举。穷举即可,不用 TS union 方便前端 switch。 */
export type BranchEventType =
  | 'branch.created'
  | 'branch.status'
  | 'branch.updated'
  | 'branch.removed'
  | 'branch.deploy-step';

export interface BranchCreatedPayload {
  branch: BranchEntry;
  /**
   * 来源:
   *   - 'github-webhook': PR #450 webhook 自动创建
   *   - 'manual':         用户手工添加(POST /api/branches)
   *   - 'migration':      state.json 迁移/启动时补齐
   */
  source: 'github-webhook' | 'manual' | 'migration';
  ts: string;
}

export interface BranchStatusPayload {
  branchId: string;
  projectId?: string;
  status: string;            // BranchEntry['status'] 或 infra 子状态
  previousStatus?: string;   // 便于前端做高亮 diff
  errorMessage?: string;
  ts: string;
}

export interface BranchUpdatedPayload {
  branchId: string;
  projectId?: string;
  /** 变化后的关键可视字段(仅前端会展示的子集,避免把敏感 env 带出去) */
  patch: Partial<Pick<BranchEntry,
    'branch' | 'githubRepoFullName' | 'githubCommitSha' |
    'githubPrNumber' | 'pinnedCommit' | 'tags' | 'notes' |
    'isFavorite' | 'isColorMarked' | 'subdomainAliases'>>;
  ts: string;
}

export interface BranchRemovedPayload {
  branchId: string;
  projectId?: string;
  ts: string;
}

export interface BranchDeployStepPayload {
  branchId: string;
  projectId?: string;
  step: string;               // e.g. 'git-pull' / 'docker-build' / 'container-start'
  status: 'running' | 'done' | 'error' | 'info';
  title?: string;             // 人类可读标签
  profileId?: string;         // 关联到的 buildProfile (可选)
  ts: string;
}

/**
 * Stringify-friendly union wrapper. JSON.stringify(BranchEventEnvelope)
 * can go straight to SSE `data:` with no rewriting.
 */
export type BranchEventEnvelope =
  | { type: 'branch.created'; payload: BranchCreatedPayload }
  | { type: 'branch.status'; payload: BranchStatusPayload }
  | { type: 'branch.updated'; payload: BranchUpdatedPayload }
  | { type: 'branch.removed'; payload: BranchRemovedPayload }
  | { type: 'branch.deploy-step'; payload: BranchDeployStepPayload };

class BranchEventBus extends EventEmitter {
  constructor() {
    super();
    // 每个 Dashboard 打开一个订阅,几十个 tab 是可能的;Node 默认 10 会
    // 打印 MaxListenersExceededWarning,调 0 = 无限(内存代价忽略)
    this.setMaxListeners(0);
  }

  /**
   * Emit the typed envelope. Safe wrapper: never throws if an arbitrary
   * listener crashes (logs to console and moves on). Returns the event
   * it emitted so call sites can chain / inspect in tests.
   */
  emitEvent(envelope: BranchEventEnvelope): BranchEventEnvelope {
    try {
      this.emit(envelope.type, envelope.payload);
      // 统一 'any' 事件,route 订阅这个就能一条管道拿到全类型
      this.emit('any', envelope);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[branch-events] listener threw:', (err as Error).message);
    }
    return envelope;
  }
}

/** 进程级单例。任何 import 都拿到同一实例。 */
export const branchEvents: BranchEventBus = new BranchEventBus();

/** 构造当前 UTC ISO 时间戳 —— 统一入口,便于测试注入 clock。 */
export function nowIso(): string {
  return new Date().toISOString();
}
