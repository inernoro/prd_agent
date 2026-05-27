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
 * Collection: `cds_state_log_records`
 *   documents:
 *     { _id: 'log:logs:<branchId>:<recordKey>', kind: 'logs', ownerId, value, updatedAt }
 *     { _id: 'log:containerLogArchives:<branchId>:<archiveId>', kind: 'containerLogArchives', ownerId, value, updatedAt }
 *     { _id: 'log:activityLogs:<projectId>:<activityId>', kind: 'activityLogs', ownerId, value, updatedAt }
 *     { _id: 'log:serviceDeploymentLogs:<deploymentId>:<recordKey>', kind: 'serviceDeploymentLogs', ownerId, value, updatedAt }
 *     { _id: 'log:selfUpdateHistory:<recordKey>', kind: 'selfUpdateHistory', value, updatedAt }
 *     { _id: 'log:dataMigrations:<migrationId>', kind: 'dataMigrations', value, updatedAt }
 *     { _id: 'log:githubWebhookDeliveries:<deliveryId>', kind: 'githubWebhookDeliveries', value, updatedAt }
 *
 * Collection: `cds_state_fragments` (legacy compatibility only)
 *   documents:
 *     { _id: 'state:logs:<branchId>', kind: 'logs', ownerId, value, updatedAt }
 *     { _id: 'state:containerLogArchives:<branchId>', kind: 'containerLogArchives', ownerId, value, updatedAt }
 *     { _id: 'state:activityLogs:<projectId>', kind: 'activityLogs', ownerId, value, updatedAt }
 *     { _id: 'state:serviceDeploymentLogs:<deploymentId>', kind: 'serviceDeploymentLogs', ownerId, value, updatedAt }
 *     { _id: 'state:selfUpdateHistory', kind: 'selfUpdateHistory', value, updatedAt }
 *     { _id: 'state:dataMigrations', kind: 'dataMigrations', value, updatedAt }
 *     { _id: 'state:githubWebhookDeliveries', kind: 'githubWebhookDeliveries', value, updatedAt }
 *
 * System config (future): `cds_system`
 * User config    (future): `cds_users`
 *
 * The log-like fields are intentionally detached from the main state
 * document and persisted as one record per Mongo document. MongoDB rejects
 * any command/document larger than 16MB; keeping container log archives,
 * operation logs, activity logs, and webhook deliveries in the same document
 * can take CDS down during normal use.
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
  ServiceDeployment,
  ServiceDeploymentLogEntry,
  SelfUpdateRecord,
  DataMigration,
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
  /** Get per-record log collection (after connect). */
  stateLogRecordCollection(): IMongoCollection<StateLogRecordDoc>;
  /** Graceful shutdown. */
  close(): Promise<void>;
  /** For health-check UIs. */
  ping(): Promise<boolean>;
}

/** The single state document id in the collection. */
export const STATE_DOC_ID = 'state';

type DetachedStateKey =
  | 'logs'
  | 'containerLogArchives'
  | 'activityLogs'
  | 'serviceDeploymentLogs'
  | 'selfUpdateHistory'
  | 'dataMigrations'
  | 'githubWebhookDeliveries';

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

export interface StateLogRecordDoc {
  _id: string;
  scope: 'cds-state-log-record';
  kind: DetachedStateKey;
  ownerId?: string;
  value: unknown;
  orderKey: string;
  updatedAt: string;
}

const DETACHED_SCOPE = 'cds-state-detached';
const LOG_RECORD_SCOPE = 'cds-state-log-record';
const MAX_WEBHOOK_DELIVERIES = 1000;
const MAX_LOGS_PER_BRANCH = 10;
const MAX_EVENTS_PER_OPERATION_LOG = 10;
const MAX_CONTAINER_ARCHIVES_PER_BRANCH = 10;
const MAX_SERVICE_DEPLOYMENT_LOGS = 500;
const MAX_DATA_MIGRATIONS = 100;
const MAX_SINGLE_LOG_BYTES = 125 * 1024;
const MAX_EVENT_TEXT_BYTES = 8 * 1024;
const MAX_CONTAINER_SNAPSHOT_LOG_BYTES = 32 * 1024;
const MAX_CONTAINER_ARCHIVE_LOG_BYTES = 120 * 1024;
const MAX_SERVICE_DEPLOYMENT_LOG_BYTES = 16 * 1024;
const MAX_SELF_UPDATE_STEP_TEXT_BYTES = 8 * 1024;
const MAX_DATA_MIGRATION_LOG_BYTES = 120 * 1024;

function trimBufferTailToUtf8(buffer: Buffer, maxBytes: number): string {
  let text = buffer.subarray(Math.max(0, buffer.length - maxBytes)).toString('utf8');
  while (Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = text.slice(1);
  }
  return text;
}

function truncateTail(value: string | undefined, maxBytes: number): string | undefined {
  if (!value) return value;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) return value;
  const prefix = `[cds persisted tail: original ${bytes} bytes]\n`;
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  const tailBudget = Math.max(0, maxBytes - prefixBytes);
  const tail = trimBufferTailToUtf8(Buffer.from(value), tailBudget);
  return `${prefix}${tail}`;
}

function sanitizeEvent(event: OperationLogEvent): OperationLogEvent {
  return {
    ...event,
    log: truncateTail(event.log, MAX_EVENT_TEXT_BYTES),
    chunk: truncateTail(event.chunk, MAX_EVENT_TEXT_BYTES),
  };
}

function sanitizeContainerSnapshot(snapshot: OperationLogContainerSnapshot): OperationLogContainerSnapshot {
  return {
    ...snapshot,
    logs: truncateTail(snapshot.logs, MAX_CONTAINER_SNAPSHOT_LOG_BYTES) || '',
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
    logs: truncateTail(entry.logs, MAX_CONTAINER_ARCHIVE_LOG_BYTES) || '',
  };
}

function sanitizeServiceDeploymentLog(entry: ServiceDeploymentLogEntry): ServiceDeploymentLogEntry {
  return {
    ...entry,
    message: truncateTail(entry.message, MAX_SERVICE_DEPLOYMENT_LOG_BYTES) || '',
  };
}

function sanitizeServiceDeployment(deployment: ServiceDeployment): ServiceDeployment {
  return {
    ...deployment,
    logs: (deployment.logs || []).slice(-MAX_SERVICE_DEPLOYMENT_LOGS).map(sanitizeServiceDeploymentLog),
  };
}

function serviceDeploymentWithoutLogs(deployment: ServiceDeployment): ServiceDeployment {
  return {
    ...deployment,
    logs: [],
  };
}

function sanitizeSelfUpdateRecord(record: SelfUpdateRecord): SelfUpdateRecord {
  return {
    ...record,
    error: truncateTail(record.error, MAX_SINGLE_LOG_BYTES),
    steps: record.steps?.map(step => ({
      ...step,
      text: truncateTail(step.text, MAX_SELF_UPDATE_STEP_TEXT_BYTES) || '',
    })),
  };
}

function sanitizeDataMigration(migration: DataMigration): DataMigration {
  return {
    ...migration,
    errorMessage: truncateTail(migration.errorMessage, MAX_SINGLE_LOG_BYTES),
    log: truncateTail(migration.log, MAX_DATA_MIGRATION_LOG_BYTES),
  };
}

function sanitizeStateForPersistence(state: CdsState): CdsState {
  // Do not structuredClone the full CdsState here. In production the detached
  // log fields can be hundreds of MB across many branches; cloning them on
  // every save() was enough to push cds-master into V8 heap OOM. Clone the
  // lightweight main state first, then copy bounded log slices explicitly.
  const snapshot = withoutDetachedState(state) as CdsState;
  snapshot.logs = Object.fromEntries(
    Object.entries(state.logs || {}).map(([branchId, logs]) => [
      branchId,
      (logs || []).slice(-MAX_LOGS_PER_BRANCH).map(sanitizeOperationLog),
    ]),
  );
  snapshot.containerLogArchives = Object.fromEntries(
    Object.entries(state.containerLogArchives || {}).map(([branchId, archives]) => [
      branchId,
      (archives || []).slice(-MAX_CONTAINER_ARCHIVES_PER_BRANCH).map(sanitizeContainerArchive),
    ]),
  );
  snapshot.activityLogs = Object.fromEntries(
    Object.entries(state.activityLogs || {}).map(([projectId, logs]) => [
      projectId,
      (logs || []).slice(-1000),
    ]),
  );
  snapshot.githubWebhookDeliveries = (state.githubWebhookDeliveries || []).slice(-MAX_WEBHOOK_DELIVERIES);
  snapshot.serviceDeployments = Object.fromEntries(
    Object.entries(state.serviceDeployments || {}).map(([deploymentId, deployment]) => [
      deploymentId,
      sanitizeServiceDeployment(deployment),
    ]),
  );
  snapshot.selfUpdateHistory = (state.selfUpdateHistory || []).map(sanitizeSelfUpdateRecord);
  snapshot.dataMigrations = (state.dataMigrations || []).slice(-MAX_DATA_MIGRATIONS).map(sanitizeDataMigration);
  return snapshot;
}

function withoutDetachedState(state: CdsState): Partial<CdsState> {
  const mainState = { ...state } as Partial<CdsState>;
  delete mainState.logs;
  delete mainState.containerLogArchives;
  delete mainState.activityLogs;
  delete mainState.githubWebhookDeliveries;
  delete mainState.selfUpdateHistory;
  delete mainState.dataMigrations;
  if (mainState.serviceDeployments) {
    mainState.serviceDeployments = Object.fromEntries(
      Object.entries(mainState.serviceDeployments).map(([deploymentId, deployment]) => [
        deploymentId,
        serviceDeploymentWithoutLogs(deployment),
      ]),
    );
  }
  // The async write-behind path needs a stable snapshot, but only of the small
  // main document. The large detached log fields were removed above.
  return structuredClone(mainState);
}

function fragmentId(kind: DetachedStateKey, ownerId?: string): string {
  return ownerId
    ? `${STATE_DOC_ID}:${kind}:${encodeURIComponent(ownerId)}`
    : `${STATE_DOC_ID}:${kind}`;
}

function safeIdPart(value: unknown): string {
  const text = String(value ?? '').trim() || 'unknown';
  return encodeURIComponent(text).slice(0, 160);
}

function indexedRecordKey(index: number, values: unknown[]): string {
  return `${String(index).padStart(5, '0')}-${safeIdPart(values.filter(Boolean).join(':'))}`;
}

function logRecordId(kind: DetachedStateKey, ownerId: string | undefined, key: string): string {
  return ownerId
    ? `log:${kind}:${encodeURIComponent(ownerId)}:${safeIdPart(key)}`
    : `log:${kind}:${safeIdPart(key)}`;
}

function stateToFragments(state: CdsState, updatedAt: string): StateFragmentDoc[] {
  const docs: StateFragmentDoc[] = [];
  return docs;
}

function stateToLogRecords(state: CdsState, updatedAt: string): StateLogRecordDoc[] {
  const docs: StateLogRecordDoc[] = [];
  for (const [branchId, logs] of Object.entries(state.logs || {})) {
    (logs || []).forEach((log, index) => {
      const orderKey = log.startedAt || `${index}`;
      docs.push({
        _id: logRecordId('logs', branchId, indexedRecordKey(index, [log.startedAt, log.type])),
        scope: LOG_RECORD_SCOPE,
        kind: 'logs',
        ownerId: branchId,
        value: log,
        orderKey,
        updatedAt,
      });
    });
  }
  for (const [branchId, archives] of Object.entries(state.containerLogArchives || {})) {
    (archives || []).forEach((archive, index) => {
      const orderKey = archive.capturedAt || `${index}`;
      docs.push({
        _id: logRecordId('containerLogArchives', branchId, archive.id || indexedRecordKey(index, [archive.capturedAt, archive.profileId])),
        scope: LOG_RECORD_SCOPE,
        kind: 'containerLogArchives',
        ownerId: branchId,
        value: archive,
        orderKey,
        updatedAt,
      });
    });
  }
  for (const [projectId, logs] of Object.entries(state.activityLogs || {})) {
    (logs || []).forEach((log, index) => {
      const orderKey = log.at || `${index}`;
      docs.push({
        _id: logRecordId('activityLogs', projectId, log.id || indexedRecordKey(index, [log.at, log.type])),
        scope: LOG_RECORD_SCOPE,
        kind: 'activityLogs',
        ownerId: projectId,
        value: log,
        orderKey,
        updatedAt,
      });
    });
  }
  for (const [deploymentId, deployment] of Object.entries(state.serviceDeployments || {})) {
    (deployment.logs || []).forEach((log, index) => {
      const orderKey = log.at || `${index}`;
      docs.push({
        _id: logRecordId('serviceDeploymentLogs', deploymentId, indexedRecordKey(index, [log.at, log.level])),
        scope: LOG_RECORD_SCOPE,
        kind: 'serviceDeploymentLogs',
        ownerId: deploymentId,
        value: log,
        orderKey,
        updatedAt,
      });
    });
  }
  (state.selfUpdateHistory || []).forEach((record, index) => {
    const orderKey = record.ts || `${index}`;
    docs.push({
      _id: logRecordId('selfUpdateHistory', undefined, indexedRecordKey(index, [record.ts, record.branch, record.toSha])),
      scope: LOG_RECORD_SCOPE,
      kind: 'selfUpdateHistory',
      value: record,
      orderKey,
      updatedAt,
    });
  });
  (state.dataMigrations || []).forEach((migration, index) => {
    const orderKey = migration.createdAt || `${index}`;
    docs.push({
      _id: logRecordId('dataMigrations', undefined, migration.id || indexedRecordKey(index, [migration.createdAt, migration.name])),
      scope: LOG_RECORD_SCOPE,
      kind: 'dataMigrations',
      value: migration,
      orderKey,
      updatedAt,
    });
  });
  (state.githubWebhookDeliveries || []).forEach((delivery, index) => {
    const orderKey = delivery.receivedAt || `${index}`;
    docs.push({
      _id: logRecordId('githubWebhookDeliveries', undefined, delivery.id || indexedRecordKey(index, [delivery.receivedAt, delivery.event])),
      scope: LOG_RECORD_SCOPE,
      kind: 'githubWebhookDeliveries',
      value: delivery,
      orderKey,
      updatedAt,
    });
  });
  return docs;
}

function mergeFragmentsIntoState(base: Partial<CdsState>, fragments: StateFragmentDoc[]): CdsState {
  const state = base as CdsState;
  if (fragments.length === 0) {
    state.logs = state.logs || {};
    state.containerLogArchives = state.containerLogArchives || {};
    state.activityLogs = state.activityLogs || {};
    state.serviceDeployments = state.serviceDeployments || {};
    state.selfUpdateHistory = state.selfUpdateHistory || [];
    state.dataMigrations = state.dataMigrations || [];
    state.githubWebhookDeliveries = state.githubWebhookDeliveries || [];
    return state;
  }

  state.logs = {};
  state.containerLogArchives = {};
  state.activityLogs = {};
  state.serviceDeployments = state.serviceDeployments || {};
  state.selfUpdateHistory = [];
  state.dataMigrations = [];
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
    } else if (fragment.kind === 'serviceDeploymentLogs' && fragment.ownerId) {
      const deployment = state.serviceDeployments?.[fragment.ownerId];
      if (deployment) {
        deployment.logs = Array.isArray(fragment.value) ? fragment.value as ServiceDeploymentLogEntry[] : [];
      }
    } else if (fragment.kind === 'selfUpdateHistory') {
      state.selfUpdateHistory = Array.isArray(fragment.value)
        ? fragment.value as SelfUpdateRecord[]
        : [];
    } else if (fragment.kind === 'dataMigrations') {
      state.dataMigrations = Array.isArray(fragment.value)
        ? fragment.value as DataMigration[]
        : [];
    } else if (fragment.kind === 'githubWebhookDeliveries') {
      state.githubWebhookDeliveries = Array.isArray(fragment.value)
        ? fragment.value as CdsState['githubWebhookDeliveries']
        : [];
    }
  }
  return state;
}

function mergeLogRecordsIntoState(base: CdsState, records: StateLogRecordDoc[]): CdsState {
  if (records.length === 0) return base;
  base.serviceDeployments = base.serviceDeployments || {};
  const kinds = new Set(records.map(record => record.kind));
  if (kinds.has('logs')) base.logs = {};
  if (kinds.has('containerLogArchives')) base.containerLogArchives = {};
  if (kinds.has('activityLogs')) base.activityLogs = {};
  if (kinds.has('selfUpdateHistory')) base.selfUpdateHistory = [];
  if (kinds.has('dataMigrations')) base.dataMigrations = [];
  if (kinds.has('githubWebhookDeliveries')) base.githubWebhookDeliveries = [];

  const sorted = [...records].sort((a, b) => a.orderKey.localeCompare(b.orderKey) || a._id.localeCompare(b._id));
  for (const record of sorted) {
    if (record.kind === 'logs' && record.ownerId) {
      base.logs[record.ownerId] = base.logs[record.ownerId] || [];
      base.logs[record.ownerId].push(record.value as OperationLog);
    } else if (record.kind === 'containerLogArchives' && record.ownerId) {
      const archives = base.containerLogArchives!;
      archives[record.ownerId] = archives[record.ownerId] || [];
      archives[record.ownerId].push(record.value as ContainerLogArchiveEntry);
    } else if (record.kind === 'activityLogs' && record.ownerId) {
      const activityLogs = base.activityLogs!;
      activityLogs[record.ownerId] = activityLogs[record.ownerId] || [];
      activityLogs[record.ownerId].push(record.value as ProjectActivityLog);
    } else if (record.kind === 'serviceDeploymentLogs' && record.ownerId) {
      const deployment = base.serviceDeployments?.[record.ownerId];
      if (deployment) {
        deployment.logs = deployment.logs || [];
        deployment.logs.push(record.value as ServiceDeploymentLogEntry);
      }
    } else if (record.kind === 'selfUpdateHistory') {
      base.selfUpdateHistory!.push(record.value as SelfUpdateRecord);
    } else if (record.kind === 'dataMigrations') {
      base.dataMigrations!.push(record.value as DataMigration);
    } else if (record.kind === 'githubWebhookDeliveries') {
      base.githubWebhookDeliveries!.push(record.value as NonNullable<CdsState['githubWebhookDeliveries']>[number]);
    }
  }
  return base;
}

export class MongoStateBackingStore implements StateBackingStore {
  readonly kind = 'mongo' as const;
  private cache: CdsState | null = null;
  private initialized = false;
  private pendingSnapshot: CdsState | null = null;
  private pendingGeneration = 0;
  private writeInFlight = false;
  private writeGeneration = 0;
  private persistedGeneration = 0;
  private failedGeneration = 0;
  private lastWriteError: unknown = null;
  private flushWaiters: Array<{
    generation: number;
    resolve: () => void;
    reject: (err: unknown) => void;
  }> = [];

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
    const logRecordCol = this.handle.stateLogRecordCollection();
    const doc = await col.findOne({ _id: STATE_DOC_ID });
    const fragments = await fragmentCol.find?.({ scope: DETACHED_SCOPE }) || [];
    const records = await logRecordCol.find?.({ scope: LOG_RECORD_SCOPE }) || [];
    this.cache = doc ? mergeLogRecordsIntoState(mergeFragmentsIntoState(structuredClone(doc.state), fragments), records) : null;
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
    this.pendingSnapshot = this.cache;
    this.pendingGeneration = ++this.writeGeneration;
    this.drainWrites();
  }

  private async persistSnapshot(snapshot: CdsState): Promise<void> {
    const col = this.handle.stateCollection();
    const fragmentCol = this.handle.stateFragmentCollection();
    const logRecordCol = this.handle.stateLogRecordCollection();
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
    const records = stateToLogRecords(snapshot, updatedAt);
    for (const record of records) {
      await logRecordCol.replaceOne({ _id: record._id }, record, { upsert: true });
    }
    await logRecordCol.deleteMany?.({ scope: LOG_RECORD_SCOPE, updatedAt: { $ne: updatedAt } });
  }

  private drainWrites(): void {
    if (this.writeInFlight) return;
    this.writeInFlight = true;
    void (async () => {
      let generation = 0;
      try {
        while (this.pendingSnapshot) {
          const snapshot = this.pendingSnapshot;
          generation = this.pendingGeneration;
          this.pendingSnapshot = null;
          await this.persistSnapshot(snapshot);
          this.persistedGeneration = generation;
          this.lastWriteError = null;
          this.resolveFlushWaiters();
        }
      } catch (err) {
        this.failedGeneration = Math.max(this.failedGeneration, generation);
        this.lastWriteError = err;
        this.rejectFlushWaiters(err);
      } finally {
        this.writeInFlight = false;
        if (this.pendingSnapshot) this.drainWrites();
      }
    })();
  }

  private resolveFlushWaiters(): void {
    const pending: typeof this.flushWaiters = [];
    for (const waiter of this.flushWaiters) {
      if (waiter.generation <= this.persistedGeneration) waiter.resolve();
      else pending.push(waiter);
    }
    this.flushWaiters = pending;
  }

  private rejectFlushWaiters(err: unknown): void {
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const waiter of waiters) waiter.reject(err);
  }

  /**
   * Await all in-flight mongo upserts. Callers use this at critical
   * points (process shutdown, storage-mode switch preflight) when
   * they need durability guarantees stronger than write-behind.
   */
  async flush(): Promise<void> {
    const targetGeneration = this.writeGeneration;
    if (targetGeneration <= this.persistedGeneration) return;
    if (targetGeneration <= this.failedGeneration && this.lastWriteError) {
      throw this.lastWriteError;
    }
    await new Promise<void>((resolve, reject) => {
      this.flushWaiters.push({ generation: targetGeneration, resolve, reject });
      this.resolveFlushWaiters();
      this.drainWrites();
    });
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
    const logRecordCol = this.handle.stateLogRecordCollection();
    for (const record of stateToLogRecords(snapshot, updatedAt)) {
      await logRecordCol.replaceOne({ _id: record._id }, record, { upsert: true });
    }
    await logRecordCol.deleteMany?.({ scope: LOG_RECORD_SCOPE, updatedAt: { $ne: updatedAt } });
    this.cache = snapshot;
    return true;
  }
}
