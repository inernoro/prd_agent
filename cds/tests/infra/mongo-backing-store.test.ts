/**
 * Unit tests for MongoStateBackingStore — the P4 Part 18 Phase D
 * persistence backend. Uses an in-memory mock IMongoHandle so the
 * real `mongodb` driver never touches the test runner.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MongoStateBackingStore, STATE_DOC_ID } from '../../src/infra/state-store/mongo-backing-store.js';
import type { IMongoHandle, IMongoCollection, StateFragmentDoc, StateLogRecordDoc } from '../../src/infra/state-store/mongo-backing-store.js';
import type { CdsState } from '../../src/types.js';

function emptyState(): CdsState {
  return {
    routingRules: [],
    buildProfiles: [],
    branches: {},
    nextPortIndex: 0,
    logs: {},
    defaultBranch: null,
    customEnv: {},
    infraServices: [],
    previewMode: 'multi',
  };
}

/**
 * Fake mongo: a single in-memory document store keyed by _id.
 * Supports findOne / replaceOne / countDocuments, which is the
 * minimal surface the backing store uses.
 */
class FakeMongoCollection<TDoc extends { _id: string } = any> implements IMongoCollection<TDoc> {
  public readonly docs = new Map<string, any>();
  public readonly writeLog: any[] = [];
  /** When set, the next replaceOne rejects to simulate a write failure. */
  public failNextWrite = false;

  private matches(doc: any, filter?: Record<string, unknown>): boolean {
    if (!filter || Object.keys(filter).length === 0) return true;
    return Object.entries(filter).every(([key, expected]) => {
      const actual = doc[key];
      if (expected && typeof expected === 'object' && '$ne' in (expected as Record<string, unknown>)) {
        return actual !== (expected as Record<string, unknown>).$ne;
      }
      return actual === expected;
    });
  }

  async findOne(filter: Record<string, unknown>) {
    const id = filter._id;
    if (id !== undefined) {
      return this.docs.get(String(id)) || null;
    }
    return [...this.docs.values()].find(doc => this.matches(doc, filter)) || null;
  }

  async find(filter?: Record<string, unknown>) {
    return [...this.docs.values()].filter(doc => this.matches(doc, filter));
  }

  async replaceOne(filter: Record<string, unknown>, doc: TDoc) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated mongo write failure');
    }
    this.docs.set(filter._id, doc);
    this.writeLog.push(doc);
  }

  async deleteMany(filter?: Record<string, unknown>) {
    for (const [id, doc] of [...this.docs.entries()]) {
      if (this.matches(doc, filter)) this.docs.delete(id);
    }
  }

  async countDocuments(filter?: Record<string, unknown>) {
    if (!filter || Object.keys(filter).length === 0) return this.docs.size;
    const id = (filter as any)._id;
    if (id !== undefined) return this.docs.has(String(id)) ? 1 : 0;
    return this.docs.size;
  }
}

class FakeMongoHandle implements IMongoHandle {
  public connected = false;
  public closed = false;
  public pingResult = true;
  public connectCallCount = 0;
  public readonly collection = new FakeMongoCollection();
  public readonly fragments = new FakeMongoCollection<StateFragmentDoc>();
  public readonly logRecords = new FakeMongoCollection<StateLogRecordDoc>();

  async connect() {
    this.connectCallCount++;
    this.connected = true;
  }
  stateCollection() { return this.collection; }
  stateFragmentCollection() { return this.fragments; }
  stateLogRecordCollection() { return this.logRecords; }
  async close() {
    this.closed = true;
  }
  async ping() {
    return this.pingResult;
  }
}

describe('MongoStateBackingStore', () => {
  let handle: FakeMongoHandle;
  let store: MongoStateBackingStore;

  beforeEach(() => {
    handle = new FakeMongoHandle();
    store = new MongoStateBackingStore(handle);
  });

  describe('init + load', () => {
    it('connects on first init() and load() returns null for a fresh mongo', async () => {
      await store.init();
      expect(handle.connected).toBe(true);
      expect(handle.connectCallCount).toBe(1);
      expect(store.load()).toBeNull();
    });

    it('init() is idempotent — calling twice only connects once', async () => {
      await store.init();
      await store.init();
      expect(handle.connectCallCount).toBe(1);
    });

    it('load() after init returns the persisted snapshot when one exists', async () => {
      // Seed the fake mongo directly
      const persisted = emptyState();
      persisted.branches = { 'feat-x': { id: 'feat-x', branch: 'feat/x', worktreePath: '/w', services: {}, status: 'idle', createdAt: '' } };
      handle.collection.docs.set(STATE_DOC_ID, { _id: STATE_DOC_ID, state: persisted });

      await store.init();
      const loaded = store.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.branches['feat-x'].branch).toBe('feat/x');
    });
  });

  describe('save (write-behind)', () => {
    it('synchronously updates the in-memory cache', async () => {
      await store.init();
      const state = emptyState();
      state.defaultBranch = 'main';

      store.save(state);
      // Sync read should reflect the change immediately
      expect(store.load()!.defaultBranch).toBe('main');
    });

    it('deep-clones the state on save so callers can mutate afterwards', async () => {
      await store.init();
      const state = emptyState();
      state.customEnv = { KEY: 'one' };

      store.save(state);
      // Caller mutates after save — the cache should not reflect it
      state.customEnv.KEY = 'two';
      expect(store.load()!.customEnv.KEY).toBe('one');
    });

    it('flush() resolves after the latest queued write lands in mongo', async () => {
      await store.init();
      const a = emptyState();
      a.defaultBranch = 'a';
      const b = emptyState();
      b.defaultBranch = 'b';
      const c = emptyState();
      c.defaultBranch = 'c';

      store.save(a);
      store.save(b);
      store.save(c);

      await store.flush();

      // High-frequency saves are coalesced; Mongo does not need every
      // stale intermediate snapshot as long as the final snapshot lands.
      expect(handle.collection.writeLog.length).toBeLessThanOrEqual(2);
      expect(handle.collection.writeLog[0].state.defaultBranch).toBe('a');
      expect(handle.collection.writeLog.at(-1)!.state.defaultBranch).toBe('c');

      // Final state in mongo matches the last save
      expect(handle.collection.docs.get(STATE_DOC_ID)!.state.defaultBranch).toBe('c');
    });

    it('stores log-like state outside the main mongo document', async () => {
      await store.init();
      const state = emptyState();
      state.logs = {
        'feat-x': [{
          type: 'run',
          startedAt: '2026-05-22T00:00:00.000Z',
          status: 'completed',
          events: [{ step: 'deploy', status: 'done', timestamp: '2026-05-22T00:00:01.000Z', log: 'ok' }],
        }],
      };
      state.containerLogArchives = {
        'feat-x': [{
          id: 'archive-1',
          branchId: 'feat-x',
          profileId: 'api',
          capturedAt: '2026-05-22T00:00:02.000Z',
          source: 'deploy-finalize',
          sha256: 'abc',
          byteLength: 2,
          lineCount: 1,
          masked: true,
          logs: 'up',
        }],
      };
      state.activityLogs = {
        'prd-agent': [{ id: 'a1', at: '2026-05-22T00:00:03.000Z', type: 'deploy' }],
      };
      state.githubWebhookDeliveries = [{
        id: 'delivery-1',
        receivedAt: '2026-05-22T00:00:04.000Z',
        durationMs: 42,
        event: 'push',
        action: 'push',
        ok: true,
      }];
      state.serviceDeployments = {
        'deploy-1': {
          id: 'deploy-1',
          projectId: 'shared-service',
          hostId: 'host-1',
          status: 'running',
          seq: 1,
          startedAt: '2026-05-22T00:00:05.000Z',
          logs: [{ at: '2026-05-22T00:00:06.000Z', level: 'info', message: 'installed' }],
        },
      };
      state.selfUpdateHistory = [{
        ts: '2026-05-22T00:00:07.000Z',
        branch: 'main',
        fromSha: 'a',
        toSha: 'b',
        trigger: 'manual',
        status: 'success',
        steps: [{ ts: '2026-05-22T00:00:08.000Z', level: 'info', text: 'done' }],
      }];
      state.dataMigrations = [{
        id: 'migration-1',
        name: 'copy mongo',
        dbType: 'mongodb',
        source: { type: 'local', database: 'a' },
        target: { type: 'local', database: 'b' },
        status: 'completed',
        progress: 100,
        createdAt: '2026-05-22T00:00:09.000Z',
        log: 'ok',
      }];

      store.save(state);
      await store.flush();

      const mainDoc = handle.collection.docs.get(STATE_DOC_ID)!;
      expect(mainDoc.state.logs).toBeUndefined();
      expect(mainDoc.state.containerLogArchives).toBeUndefined();
      expect(mainDoc.state.activityLogs).toBeUndefined();
      expect(mainDoc.state.githubWebhookDeliveries).toBeUndefined();
      expect(mainDoc.state.selfUpdateHistory).toBeUndefined();
      expect(mainDoc.state.dataMigrations).toBeUndefined();
      expect(mainDoc.state.serviceDeployments['deploy-1'].logs).toEqual([]);
      expect(handle.fragments.docs.size).toBe(0);
      expect([...handle.logRecords.docs.values()].filter(doc => doc.kind === 'logs')).toHaveLength(1);
      expect([...handle.logRecords.docs.values()].filter(doc => doc.kind === 'containerLogArchives')).toHaveLength(1);
      expect([...handle.logRecords.docs.values()].filter(doc => doc.kind === 'activityLogs')).toHaveLength(1);
      expect([...handle.logRecords.docs.values()].filter(doc => doc.kind === 'serviceDeploymentLogs')).toHaveLength(1);
      expect([...handle.logRecords.docs.values()].filter(doc => doc.kind === 'selfUpdateHistory')).toHaveLength(1);
      expect([...handle.logRecords.docs.values()].filter(doc => doc.kind === 'dataMigrations')).toHaveLength(1);
      expect([...handle.logRecords.docs.values()].filter(doc => doc.kind === 'githubWebhookDeliveries')).toHaveLength(1);
    });

    it('loads detached state fragments back into the in-memory snapshot', async () => {
      const persisted = emptyState();
      persisted.defaultBranch = 'main';
      persisted.serviceDeployments = {
        'deploy-1': {
          id: 'deploy-1',
          projectId: 'shared-service',
          hostId: 'host-1',
          status: 'running',
          seq: 1,
          startedAt: '2026-05-22T00:00:00.000Z',
          logs: [],
        },
      };
      delete (persisted as Partial<CdsState>).logs;
      handle.collection.docs.set(STATE_DOC_ID, { _id: STATE_DOC_ID, state: persisted });
      handle.fragments.docs.set('state:logs:feat-x', {
        _id: 'state:logs:feat-x',
        scope: 'cds-state-detached',
        kind: 'logs',
        ownerId: 'feat-x',
        value: [{
          type: 'build',
          startedAt: '2026-05-22T00:00:00.000Z',
          status: 'completed',
          events: [],
        }],
        updatedAt: '2026-05-22T00:00:00.000Z',
      });
      handle.logRecords.docs.set('log:serviceDeploymentLogs:deploy-1:00000-2026-05-22', {
        _id: 'log:serviceDeploymentLogs:deploy-1:00000-2026-05-22',
        scope: 'cds-state-log-record',
        kind: 'serviceDeploymentLogs',
        ownerId: 'deploy-1',
        value: { at: '2026-05-22T00:00:01.000Z', level: 'info', message: 'hello' },
        orderKey: '2026-05-22T00:00:01.000Z',
        updatedAt: '2026-05-22T00:00:00.000Z',
      });

      await store.init();
      expect(store.load()!.defaultBranch).toBe('main');
      expect(store.load()!.logs['feat-x']).toHaveLength(1);
      expect(store.load()!.serviceDeployments!['deploy-1'].logs).toHaveLength(1);
    });

    it('trims oversized detached logs before writing mongo fragments', async () => {
      await store.init();
      const state = emptyState();
      state.logs = {
        'feat-x': Array.from({ length: 12 }, (_, i) => ({
          type: 'run',
          startedAt: `2026-05-22T00:${String(i).padStart(2, '0')}:00.000Z`,
          status: 'completed',
          events: [{ step: 'log', status: 'done', timestamp: '2026-05-22T00:00:00.000Z', log: 'x'.repeat(25_000) }],
        })),
      };
      state.containerLogArchives = {
        'feat-x': Array.from({ length: 12 }, (_, i) => ({
          id: `archive-${i}`,
          branchId: 'feat-x',
          profileId: 'api',
          capturedAt: '2026-05-22T00:00:00.000Z',
          source: 'deploy-finalize',
          sha256: 'abc',
          byteLength: 250_000,
          lineCount: 1,
          masked: true,
          logs: 'y'.repeat(250_000),
        })),
      };
      state.serviceDeployments = {
        'deploy-1': {
          id: 'deploy-1',
          projectId: 'shared-service',
          hostId: 'host-1',
          status: 'running',
          seq: 600,
          startedAt: '2026-05-22T00:00:00.000Z',
          logs: Array.from({ length: 600 }, (_, i) => ({
            at: '2026-05-22T00:00:00.000Z',
            level: 'info',
            message: `${i}:` + 'z'.repeat(140_000),
          })),
        },
      };
      state.selfUpdateHistory = [{
        ts: '2026-05-22T00:00:00.000Z',
        branch: 'main',
        fromSha: 'a',
        toSha: 'b',
        trigger: 'manual',
        status: 'failed',
        error: 'e'.repeat(140_000),
        steps: [{ ts: '2026-05-22T00:00:00.000Z', level: 'error', text: 's'.repeat(140_000) }],
      }];
      state.dataMigrations = [{
        id: 'migration-1',
        name: 'copy mongo',
        dbType: 'mongodb',
        source: { type: 'local', database: 'a' },
        target: { type: 'local', database: 'b' },
        status: 'failed',
        progress: 50,
        createdAt: '2026-05-22T00:00:00.000Z',
        errorMessage: 'm'.repeat(140_000),
        log: 'd'.repeat(140_000),
      }];

      store.save(state);
      await store.flush();

      const records = [...handle.logRecords.docs.values()];
      const logs = records.filter(doc => doc.kind === 'logs').map(doc => doc.value);
      const archives = records.filter(doc => doc.kind === 'containerLogArchives').map(doc => doc.value);
      const serviceLogs = records.filter(doc => doc.kind === 'serviceDeploymentLogs').map(doc => doc.value);
      const selfUpdateHistory = records.filter(doc => doc.kind === 'selfUpdateHistory').map(doc => doc.value);
      const dataMigrations = records.filter(doc => doc.kind === 'dataMigrations').map(doc => doc.value);
      expect(logs).toHaveLength(10);
      expect(Buffer.byteLength(logs[0].events[0].log, 'utf8')).toBeLessThanOrEqual(125 * 1024);
      expect(archives).toHaveLength(10);
      expect(Buffer.byteLength(archives[0].logs, 'utf8')).toBeLessThanOrEqual(125 * 1024);
      expect(serviceLogs).toHaveLength(500);
      expect(Buffer.byteLength(serviceLogs[0].message, 'utf8')).toBeLessThanOrEqual(125 * 1024);
      expect(Buffer.byteLength(selfUpdateHistory[0].error, 'utf8')).toBeLessThanOrEqual(125 * 1024);
      expect(Buffer.byteLength(selfUpdateHistory[0].steps[0].text, 'utf8')).toBeLessThanOrEqual(125 * 1024);
      expect(Buffer.byteLength(dataMigrations[0].errorMessage, 'utf8')).toBeLessThanOrEqual(125 * 1024);
      expect(Buffer.byteLength(dataMigrations[0].log, 'utf8')).toBeLessThanOrEqual(125 * 1024);
    });

    it('keeps per-record mongo log documents bounded as log volume grows', async () => {
      await store.init();
      const state = emptyState();
      state.logs = Object.fromEntries(Array.from({ length: 20 }, (_, branchIndex) => [
        `branch-${branchIndex}`,
        Array.from({ length: 15 }, (_, logIndex) => ({
          type: 'run',
          startedAt: `2026-05-22T${String(branchIndex).padStart(2, '0')}:${String(logIndex).padStart(2, '0')}:00.000Z`,
          status: 'completed',
          events: Array.from({ length: 125 }, (_, eventIndex) => ({
            step: `event-${eventIndex}`,
            status: 'done',
            timestamp: '2026-05-22T00:00:00.000Z',
            log: 'x'.repeat(25_000),
          })),
        })),
      ]));
      state.containerLogArchives = Object.fromEntries(Array.from({ length: 20 }, (_, branchIndex) => [
        `branch-${branchIndex}`,
        Array.from({ length: 15 }, (_, archiveIndex) => ({
          id: `archive-${branchIndex}-${archiveIndex}`,
          branchId: `branch-${branchIndex}`,
          profileId: 'api',
          capturedAt: `2026-05-22T00:${String(archiveIndex).padStart(2, '0')}:00.000Z`,
          source: 'deploy-finalize',
          sha256: 'abc',
          byteLength: 250_000,
          lineCount: 1,
          masked: true,
          logs: 'y'.repeat(250_000),
        })),
      ]));

      store.save(state);
      await store.flush();

      const mainDocBytes = Buffer.byteLength(JSON.stringify(handle.collection.docs.get(STATE_DOC_ID)), 'utf8');
      const recordDocs = [...handle.logRecords.docs.values()];
      const maxRecordBytes = Math.max(...recordDocs.map(doc => Buffer.byteLength(JSON.stringify(doc), 'utf8')));
      expect(mainDocBytes).toBeLessThan(512 * 1024);
      expect(recordDocs.filter(doc => doc.kind === 'logs')).toHaveLength(20 * 10);
      expect(recordDocs.filter(doc => doc.kind === 'containerLogArchives')).toHaveLength(20 * 10);
      expect(maxRecordBytes).toBeLessThan(160 * 1024);
    });

    it('a write failure does not break subsequent saves', async () => {
      await store.init();
      handle.collection.failNextWrite = true;

      const a = emptyState();
      a.defaultBranch = 'a';
      const b = emptyState();
      b.defaultBranch = 'b';

      store.save(a);
      await expect(store.flush()).rejects.toThrow('simulated mongo write failure');
      store.save(b);
      await store.flush();

      // The next save landed — the writer recovered after surfacing the error.
      expect(handle.collection.docs.get(STATE_DOC_ID)!.state.defaultBranch).toBe('b');
    });
  });

  describe('seedIfEmpty', () => {
    it('seeds an empty collection with the provided state', async () => {
      await store.init();
      const state = emptyState();
      state.defaultBranch = 'seeded';

      const seeded = await store.seedIfEmpty(state);
      expect(seeded).toBe(true);
      expect(store.load()!.defaultBranch).toBe('seeded');
      expect(handle.collection.docs.get(STATE_DOC_ID)!.state.defaultBranch).toBe('seeded');
    });

    it('refuses to seed when a state doc already exists', async () => {
      // Pre-populate
      const existing = emptyState();
      existing.defaultBranch = 'existing';
      handle.collection.docs.set(STATE_DOC_ID, { _id: STATE_DOC_ID, state: existing });

      await store.init();
      const seeded = await store.seedIfEmpty(emptyState());
      expect(seeded).toBe(false);
      // Existing data is preserved
      expect(handle.collection.docs.get(STATE_DOC_ID)!.state.defaultBranch).toBe('existing');
    });
  });

  describe('isHealthy', () => {
    it('returns true when the handle pings successfully', async () => {
      handle.pingResult = true;
      expect(await store.isHealthy()).toBe(true);
    });

    it('returns false when the handle pings false', async () => {
      handle.pingResult = false;
      expect(await store.isHealthy()).toBe(false);
    });
  });

  describe('close', () => {
    it('flushes pending writes before closing', async () => {
      await store.init();
      const state = emptyState();
      state.defaultBranch = 'pre-close';
      store.save(state);

      await store.close();
      // Close flushed the pending write
      expect(handle.collection.docs.get(STATE_DOC_ID)!.state.defaultBranch).toBe('pre-close');
      expect(handle.closed).toBe(true);
    });
  });
});
