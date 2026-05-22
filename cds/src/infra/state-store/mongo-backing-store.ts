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
 *   document: { _id: 'state', state: <lightweight CdsState>, updatedAt: ISO }
 *
 * Collection: `cds_state_fragments`
 *   documents:
 *     { _id: 'state:logs:<branchId>', kind: 'logs', ownerId, value, updatedAt }
 *     { _id: 'state:containerLogArchives:<branchId>', kind: 'containerLogArchives', ownerId, value, updatedAt }
 *     { _id: 'state:activityLogs:<projectId>', kind: 'activityLogs', ownerId, value, updatedAt }
 *     { _id: 'state:githubWebhookDeliveries', kind: 'githubWebhookDeliveries', value, updatedAt }
 *
 * System config (future): `cds_system`
 * User config    (future): `cds_users`
 *
 * The log-like fields are intentionally detached from the main state
 * document. MongoDB rejects any command/document larger than 16MB; keeping
 * container log archives, operation logs, activity logs, and webhook
 * deliveries in the same document can take CDS down during normal use.
 *
 * ── No-DB mode ──────────────────────────────────────────────────────
 *
 * This class is only constructed when CDS_STORAGE_MODE is 'mongo' or
 * 'auto' + mongo is reachable. If init() throws (connection refused,
 * auth failure, DNS), the caller in index.ts is responsible for
 * logging the failure and falling back to JsonBackingStore so the
 * process can still boot. See index.ts for the fallback wiring.
 */

import type {
  CdsState,
  ContainerLogArchiveEntry,
  OperationLog,
  OperationLogContainerSnapshot,
  OperationLogEvent,
  ProjectActivityLog,
} from '../../types.js';
import type { StateBackingStore } from './backing-store.js';

/**
 * Minimal MongoDB collection surface we need. Keeping the interface
 * small makes it easy to mock in unit tests and lets us avoid
 * importing the real mongo driver at all in a no-db build.
 */
export interface IMongoCollection<TDoc extends { _id: string } = { _id: string; [key: string]: unknown }> {
  findOne(filter: Record<string, unknown>): Promise<TDoc | null>;
  find?(filter?: Record<string, unknown>): Promise<TDoc[]>;
  replaceOne(filter: Record<string, unknown>, doc: TDoc, options?: { upsert: boolean }): Promise<unknown>;
  deleteMany?(filter?: Record<string, unknown>): Promise<unknown>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
}

export interface IMongoHandle {
  /** Connect + ensure DB exists. Called once from init(). */
  connect(): Promise<void>;
  /** Get the state collection (after connect). */
  stateCollection(): IMongoCollection<StateDoc>;
  /** Get detached state-fragment collection (after connect). */
  stateFragmentCollection(): IMongoCollection<StateFragmentDoc>;
  /** Graceful shutdown. */
  close(): Promise<void>;
  /** For health-check UIs. */
  ping(): Promise<boolean>;
}

/** The single state document id in the collection. */
export const STATE_DOC_ID = 'state';

type DetachedStateKey = 'logs' | 'containerLogArchives' | 'activityLogs' | 'githubWebhookDeliveries';

interface StateDoc {
  _id: string;
  state: Partial<CdsState>;
  updatedAt?: string;
}

export interface StateFragmentDoc {
  _id: string;
  scope: 'cds-state-detached';
  kind: DetachedStateKey;
  ownerId?: string;
  value: unknown;
  updatedAt: string;
}

const DETACHED_SCOPE = 'cds-state-detached';
const MAX_WEBHOOK_DELIVERIES = 1000;
const MAX_LOGS_PER_BRANCH = 10;
const MAX_EVENTS_PER_OPERATION_LOG = 250;
const MAX_EVENT_TEXT_CHARS = 20_000;
const MAX_CONTAINER_SNAPSHOT_LOG_CHARS = 80_000;
const MAX_CONTAINER_ARCHIVES_PER_BRANCH = 10;
const MAX_CONTAINER_ARCHIVE_LOG_CHARS = 200_000;

function truncateTail(value: string | undefined, maxChars: number): string | undefined {
  if (!value || value.length <= maxChars) return value;
  return `[cds persisted tail: original ${value.length} chars]\n${value.slice(-maxChars)}`;
}

function sanitizeEvent(event: OperationLogEvent): OperationLogEvent {
  return {
    ...event,
    log: truncateTail(event.log, MAX_EVENT_TEXT_CHARS),
    chunk: truncateTail(event.chunk, MAX_EVENT_TEXT_CHARS),
  };
}

function sanitizeContainerSnapshot(snapshot: OperationLogContainerSnapshot): OperationLogContainerSnapshot {
  return {
    ...snapshot,
    logs: truncateTail(snapshot.logs, MAX_CONTAINER_SNAPSHOT_LOG_CHARS) || '',
  };
}

function sanitizeOperationLog(log: OperationLog): OperationLog {
  return {
    ...log,
    events: (log.events || []).slice(-MAX_EVENTS_PER_OPERATION_LOG).map(sanitizeEvent),
    containerLogSnapshots: (log.containerLogSnapshots || []).map(sanitizeContainerSnapshot),
  };
}

function sanitizeContainerArchive(entry: ContainerLogArchiveEntry): ContainerLogArchiveEntry {
  return {
    ...entry,
    logs: truncateTail(entry.logs, MAX_CONTAINER_ARCHIVE_LOG_CHARS) || '',
  };
}

function sanitizeStateForPersistence(state: CdsState): CdsState {
  const snapshot = structuredClone(state);
  snapshot.logs = Object.fromEntries(
    Object.entries(snapshot.logs || {}).map(([branchId, logs]) => [
      branchId,
      (logs || []).slice(-MAX_LOGS_PER_BRANCH).map(sanitizeOperationLog),
    ]),
  );
  snapshot.containerLogArchives = Object.fromEntries(
    Object.entries(snapshot.containerLogArchives || {}).map(([branchId, archives]) => [
      branchId,
      (archives || []).slice(-MAX_CONTAINER_ARCHIVES_PER_BRANCH).map(sanitizeContainerArchive),
    ]),
  );
  snapshot.activityLogs = Object.fromEntries(
    Object.entries(snapshot.activityLogs || {}).map(([projectId, logs]) => [
      projectId,
      logs || [],
    ]),
  );
  snapshot.githubWebhookDeliveries = (snapshot.githubWebhookDeliveries || []).slice(-MAX_WEBHOOK_DELIVERIES);
  return snapshot;
}

function withoutDetachedState(state: CdsState): Partial<CdsState> {
  const mainState = structuredClone(state) as Partial<CdsState>;
  delete mainState.logs;
  delete mainState.containerLogArchives;
  delete mainState.activityLogs;
  delete mainState.githubWebhookDeliveries;
  return mainState;
}

function fragmentId(kind: DetachedStateKey, ownerId?: string): string {
  return ownerId
    ? `${STATE_DOC_ID}:${kind}:${encodeURIComponent(ownerId)}`
    : `${STATE_DOC_ID}:${kind}`;
}

function stateToFragments(state: CdsState, updatedAt: string): StateFragmentDoc[] {
  const docs: StateFragmentDoc[] = [];
  for (const [branchId, logs] of Object.entries(state.logs || {})) {
    docs.push({
      _id: fragmentId('logs', branchId),
      scope: DETACHED_SCOPE,
      kind: 'logs',
      ownerId: branchId,
      value: logs || [],
      updatedAt,
    });
  }
  for (const [branchId, archives] of Object.entries(state.containerLogArchives || {})) {
    docs.push({
      _id: fragmentId('containerLogArchives', branchId),
      scope: DETACHED_SCOPE,
      kind: 'containerLogArchives',
      ownerId: branchId,
      value: archives || [],
      updatedAt,
    });
  }
  for (const [projectId, logs] of Object.entries(state.activityLogs || {})) {
    docs.push({
      _id: fragmentId('activityLogs', projectId),
      scope: DETACHED_SCOPE,
      kind: 'activityLogs',
      ownerId: projectId,
      value: logs || [],
      updatedAt,
    });
  }
  docs.push({
    _id: fragmentId('githubWebhookDeliveries'),
    scope: DETACHED_SCOPE,
    kind: 'githubWebhookDeliveries',
    value: state.githubWebhookDeliveries || [],
    updatedAt,
  });
  return docs;
}

function mergeFragmentsIntoState(base: Partial<CdsState>, fragments: StateFragmentDoc[]): CdsState {
  const state = base as CdsState;
  if (fragments.length === 0) {
    state.logs = state.logs || {};
    state.containerLogArchives = state.containerLogArchives || {};
    state.activityLogs = state.activityLogs || {};
    state.githubWebhookDeliveries = state.githubWebhookDeliveries || [];
    return state;
  }

  state.logs = {};
  state.containerLogArchives = {};
  state.activityLogs = {};
  state.githubWebhookDeliveries = [];

  for (const fragment of fragments) {
    if (fragment.kind === 'logs' && fragment.ownerId) {
      state.logs[fragment.ownerId] = Array.isArray(fragment.value) ? fragment.value as OperationLog[] : [];
    } else if (fragment.kind === 'containerLogArchives' && fragment.ownerId) {
      state.containerLogArchives[fragment.ownerId] = Array.isArray(fragment.value)
        ? fragment.value as ContainerLogArchiveEntry[]
        : [];
    } else if (fragment.kind === 'activityLogs' && fragment.ownerId) {
      state.activityLogs[fragment.ownerId] = Array.isArray(fragment.value)
        ? fragment.value as ProjectActivityLog[]
        : [];
    } else if (fragment.kind === 'githubWebhookDeliveries') {
      state.githubWebhookDeliveries = Array.isArray(fragment.value)
        ? fragment.value as CdsState['githubWebhookDeliveries']
        : [];
    }
  }
  return state;
}

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
    const fragmentCol = this.handle.stateFragmentCollection();
    const doc = await col.findOne({ _id: STATE_DOC_ID });
    const fragments = await fragmentCol.find?.({ scope: DETACHED_SCOPE }) || [];
    this.cache = doc ? mergeFragmentsIntoState(structuredClone(doc.state), fragments) : null;
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
    this.cache = sanitizeStateForPersistence(state);

    const snapshot = this.cache;
    const col = this.handle.stateCollection();
    const fragmentCol = this.handle.stateFragmentCollection();
    // Chain the next write onto the previous so upserts land in the
    // same order they were issued. A Promise.all'd fan-out would be
    // racy — newer writes could land before older ones.
    this.flushChain = this.flushChain
      .catch(() => { /* swallow previous errors so the chain keeps moving */ })
      .then(async () => {
        const updatedAt = new Date().toISOString();
        await col.replaceOne(
          { _id: STATE_DOC_ID },
          {
            _id: STATE_DOC_ID,
            state: withoutDetachedState(snapshot),
            updatedAt,
          },
          { upsert: true },
        );
        const fragments = stateToFragments(snapshot, updatedAt);
        for (const fragment of fragments) {
          await fragmentCol.replaceOne({ _id: fragment._id }, fragment, { upsert: true });
        }
        await fragmentCol.deleteMany?.({ scope: DETACHED_SCOPE, updatedAt: { $ne: updatedAt } });
      })
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
    const snapshot = sanitizeStateForPersistence(state);
    const updatedAt = new Date().toISOString();
    await col.replaceOne(
      { _id: STATE_DOC_ID },
      {
        _id: STATE_DOC_ID,
        state: withoutDetachedState(snapshot),
        updatedAt,
      },
      { upsert: true },
    );
    const fragmentCol = this.handle.stateFragmentCollection();
    for (const fragment of stateToFragments(snapshot, updatedAt)) {
      await fragmentCol.replaceOne({ _id: fragment._id }, fragment, { upsert: true });
    }
    await fragmentCol.deleteMany?.({ scope: DETACHED_SCOPE, updatedAt: { $ne: updatedAt } });
    this.cache = structuredClone(snapshot);
    return true;
  }
}
