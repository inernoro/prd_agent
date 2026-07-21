/**
 * StateBackingStore — the persistence seam underneath StateService.
 *
 * This is the P3 interface that lets us swap out where CDS state is
 * physically stored without touching any of StateService's mutator
 * methods. The goal is "consumers don't care whether state.json lives
 * on disk or in MongoDB".
 *
 * Contract:
 *   - load() returns the most recently persisted CdsState, or null if
 *     nothing has been written yet. Implementations are free to attempt
 *     their own recovery (JSON reads from .bak.* files, Mongo reads
 *     from a dedicated collection).
 *   - save(state) persists atomically. Failures throw; StateService
 *     callers treat a save failure as fatal for that operation.
 *
 * Implementations (landing incrementally):
 *   - JsonStateBackingStore  — P3 Part 1 (this session). Current behavior.
 *   - MongoStateBackingStore — P3 Part 2. Persists to `cds_state` collection.
 *   - DualWriteStateBackingStore — P3 Part 3. Writes both, reads per config.
 *
 * See:
 *   doc/design.cds.multi-project.md section 八
 *   doc/plan.cds.multi-project-phases.md P3
 *   doc/rule.cds.mongo-migration.md
 */

import type { CdsState } from '../../types.js';

/**
 * 脏范围标记（2026-07-21 增量快照性能重构）。
 *
 * StateService 的 mutator 在明确知道"本次只改了哪一块"时，随 save() 传入
 * hint，让支持增量持久化的后端（mongo-split）只克隆/diff 被点名的实体，
 * 而不是对整个 state 做 structuredClone + 全量 stringify。
 *
 * 契约（正确性红线）：
 *   - hint 必须**完整覆盖**该次 save 之前发生的所有 state 变更。漏报会导致
 *     变更迟迟不落库（直到下一次无 hint 的全量 save）。拿不准就不要传。
 *   - 不带 hint 的 save() 永远安全 —— 后端退化为全量快照。
 *   - 'global' 表示 projects/branches/deploymentRuns/deploymentVersions/
 *     selfUpdateHistory/webhookDeliveries/activityLogs 之外的所有 root 字段
 *     （即 mongo-split 的 global rest 单文档）。
 */
export type StateDirtyKind =
  | 'projects'
  | 'branches'
  | 'deploymentRuns'
  | 'deploymentVersions'
  | 'selfUpdateHistory'
  | 'webhookDeliveries'
  | 'activityLogs'
  | 'global';

export interface StateSaveHint {
  kind: StateDirtyKind;
  /** 实体级 kind（projects/branches/deploymentRuns/deploymentVersions）可选点名单个实体；缺省 = 整个 kind 脏。 */
  id?: string;
}

export interface StateBackingStore {
  /**
   * Load the most recent persisted state. Returns null when nothing has
   * been written yet (fresh install) or when all recovery strategies
   * failed. StateService maps null to `emptyState()`.
   */
  load(): CdsState | null;

  /**
   * Persist the given state atomically. Throws on failure — the caller
   * is expected to surface the error upstream rather than silently
   * swallowing it.
   *
   * `hints` 为可选的脏范围声明（见 StateSaveHint）。不支持增量持久化的
   * 实现（json / 单文档 mongo）可以直接忽略该参数。
   */
  save(state: CdsState, hints?: StateSaveHint[]): void;

  /**
   * Human-readable tag used by CDS startup logs so admins can tell at a
   * glance which storage backend is active. Keep it stable across
   * versions so log grepping keeps working.
   */
  readonly kind: 'json' | 'mongo' | 'mongo-split' | 'dual-write';
}
