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
 *   doc/design.cds-multi-project.md section 八
 *   doc/plan.cds-multi-project-phases.md P3
 *   doc/rule.cds-mongo-migration.md
 */

import type { CdsState } from '../../types.js';

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
   */
  save(state: CdsState): void;

  /**
   * Human-readable tag used by CDS startup logs so admins can tell at a
   * glance which storage backend is active. Keep it stable across
   * versions so log grepping keeps working.
   */
  readonly kind: 'json' | 'mongo' | 'dual-write';
}
