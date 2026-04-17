/**
 * MongoStateBackingStore — P4 Part 18 (Phase D) persistence backend.
 *
 * ── Design notes ────────────────────────────────────────────────────
 *
 * The StateBackingStore contract is intentionally synchronous (load
 * returns CdsState | null, save returns void), which was fine when
 * the only impl wrote a local JSON file. Mongo is async, and we
 * didn't want to turn all ~115 stateService.save() call-sites async
 * just to add a second backend, so this class uses **write-behind
 * caching**:
 *
 *   - On init() — awaited once during startup — we do a real async
 *     load from the `cds_state` collection and cache the snapshot
 *     in memory.
 *   - load() is sync and returns the in-memory cache. It returns
 *     null ONCE on a fresh mongo (never populated) so StateService
 *     runs its seed migrations against an emptyState. The migration
 *     result gets persisted on the next save(), which lands the
 *     seeded snapshot in mongo.
 *   - save() updates the cache synchronously, then kicks off an
 *     async upsert on a single ever-living flush chain. Callers
 *     never wait; the next save() just chains onto the previous.
 *   - flush() exposes the chain so critical paths (startup, process
 *     shutdown, "switch storage mode" preflight) can await pending
 *     writes before continuing.
 *
 * Durability tradeoff: if CDS crashes between a save() call and the
 * async upsert landing, we lose the most recent save. For a dev
 * tool running a few dozen state mutations per minute, that window
 * is acceptable and matches the "auto-save to disk every second"
 * pattern most apps use. Operators who need stricter durability
 * can always await stateService.flush() after critical mutations.
 *
 * ── Data layout ─────────────────────────────────────────────────────
 *
 * Collection: `cds_state`
 *   document: { _id: 'state', state: <CdsState>, updatedAt: ISO }
 *
 * System config (future): `cds_system`
 * User config    (future): `cds_users`
 *
 * For Phase D we only use `cds_state` as a single-document KV store,
 * mirroring JsonBackingStore's state.json file. Splitting into per-
 * collection shapes is a follow-up optimization when state.json
 * gets large enough to matter.
 *
 * ── No-DB mode ──────────────────────────────────────────────────────
 *
 * This class is only constructed when CDS_STORAGE_MODE is 'mongo' or
 * 'auto' + mongo is reachable. If init() throws (connection refused,
 * auth failure, DNS), the caller in index.ts is responsible for
 * logging the failure and falling back to JsonBackingStore so the
 * process can still boot. See index.ts for the fallback wiring.
 */

import type { CdsState } from '../../types.js';
import type { StateBackingStore } from './backing-store.js';

/**
 * Minimal MongoDB collection surface we need. Keeping the interface
 * small makes it easy to mock in unit tests and lets us avoid
 * importing the real mongo driver at all in a no-db build.
 */
export interface IMongoCollection {
  findOne(filter: { _id: string }): Promise<{ _id: string; state: CdsState } | null>;
  replaceOne(
    filter: { _id: string },
    doc: { _id: string; state: CdsState; updatedAt: string },
    options?: { upsert: boolean },
  ): Promise<unknown>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
}

export interface IMongoHandle {
  /** Connect + ensure DB exists. Called once from init(). */
  connect(): Promise<void>;
  /** Get the state collection (after connect). */
  stateCollection(): IMongoCollection;
  /** Graceful shutdown. */
  close(): Promise<void>;
  /** For health-check UIs. */
  ping(): Promise<boolean>;
}

/** The single state document id in the collection. */
export const STATE_DOC_ID = 'state';

export class MongoStateBackingStore implements StateBackingStore {
  readonly kind = 'mongo' as const;
  private cache: CdsState | null = null;
  private initialized = false;
  /** Chain of pending writes — every save() awaits the previous one. */
  private flushChain: Promise<void> = Promise.resolve();

  constructor(private readonly handle: IMongoHandle) {}

  /**
   * Connect to mongo and do the initial cache populate. Must be
   * awaited before the first load() call — StateService.load() in
   * index.ts does this through an adapter shim.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.handle.connect();
    const col = this.handle.stateCollection();
    const doc = await col.findOne({ _id: STATE_DOC_ID });
    this.cache = doc ? doc.state : null;
    this.initialized = true;
  }

  /**
   * Returns the cached state. If init() was never called, this
   * returns null (same semantics as JsonBackingStore when state.json
   * doesn't exist) so StateService seeds an emptyState() + runs its
   * migrations. The first subsequent save() will persist the seeded
   * snapshot into mongo.
   */
  load(): CdsState | null {
    return this.cache;
  }

  /**
   * Write-behind save. Updates the in-memory cache synchronously
   * (so the next load() reflects the change immediately) and
   * schedules an async upsert to mongo on the flush chain. Never
   * throws from the sync path — errors propagate through the chain
   * to whoever awaits flush().
   */
  save(state: CdsState): void {
    // Deep clone to protect the cache from subsequent in-place
    // mutations by the caller (StateService tends to mutate state
    // members then call save()).
    this.cache = structuredClone(state);

    const snapshot = this.cache;
    const col = this.handle.stateCollection();
    // Chain the next write onto the previous so upserts land in the
    // same order they were issued. A Promise.all'd fan-out would be
    // racy — newer writes could land before older ones.
    this.flushChain = this.flushChain
      .catch(() => { /* swallow previous errors so the chain keeps moving */ })
      .then(() =>
        col.replaceOne(
          { _id: STATE_DOC_ID },
          {
            _id: STATE_DOC_ID,
            state: snapshot,
            updatedAt: new Date().toISOString(),
          },
          { upsert: true },
        ),
      )
      .then(() => undefined);
  }

  /**
   * Await all in-flight mongo upserts. Callers use this at critical
   * points (process shutdown, storage-mode switch preflight) when
   * they need durability guarantees stronger than write-behind.
   */
  async flush(): Promise<void> {
    await this.flushChain;
  }

  /**
   * Graceful shutdown: flush pending writes, then close the client.
   */
  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await this.handle.close();
    }
  }

  /**
   * Light health check for the Settings panel storage-mode tab.
   * Returns true when mongo responds to a ping within a short
   * window, false otherwise. Never throws.
   */
  async isHealthy(): Promise<boolean> {
    try {
      return await this.handle.ping();
    } catch {
      return false;
    }
  }

  /**
   * Seed utility: import an existing CdsState (typically loaded
   * from JsonBackingStore) into mongo as the initial snapshot.
   * Only runs if the state collection is empty, to avoid clobbering
   * data in mongo on accidental re-import. Returns true when a
   * seed actually happened.
   */
  async seedIfEmpty(state: CdsState): Promise<boolean> {
    const col = this.handle.stateCollection();
    const count = await col.countDocuments({ _id: STATE_DOC_ID });
    if (count > 0) return false;
    await col.replaceOne(
      { _id: STATE_DOC_ID },
      {
        _id: STATE_DOC_ID,
        state,
        updatedAt: new Date().toISOString(),
      },
      { upsert: true },
    );
    this.cache = structuredClone(state);
    return true;
  }
}
