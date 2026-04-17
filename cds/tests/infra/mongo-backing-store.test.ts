/**
 * Unit tests for MongoStateBackingStore — the P4 Part 18 Phase D
 * persistence backend. Uses an in-memory mock IMongoHandle so the
 * real `mongodb` driver never touches the test runner.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MongoStateBackingStore, STATE_DOC_ID } from '../../src/infra/state-store/mongo-backing-store.js';
import type { IMongoHandle, IMongoCollection } from '../../src/infra/state-store/mongo-backing-store.js';
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
class FakeMongoCollection implements IMongoCollection {
  public readonly docs = new Map<string, any>();
  public readonly writeLog: any[] = [];
  /** When set, the next replaceOne rejects to simulate a write failure. */
  public failNextWrite = false;

  async findOne(filter: { _id: string }) {
    const doc = this.docs.get(filter._id);
    return doc ? { _id: doc._id, state: doc.state } : null;
  }

  async replaceOne(filter: { _id: string }, doc: any) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated mongo write failure');
    }
    this.docs.set(filter._id, doc);
    this.writeLog.push(doc);
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

  async connect() {
    this.connectCallCount++;
    this.connected = true;
  }
  stateCollection() { return this.collection; }
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

    it('flush() resolves after all queued writes land in mongo', async () => {
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

      // Mongo received all three writes in order
      expect(handle.collection.writeLog.length).toBe(3);
      expect(handle.collection.writeLog[0].state.defaultBranch).toBe('a');
      expect(handle.collection.writeLog[1].state.defaultBranch).toBe('b');
      expect(handle.collection.writeLog[2].state.defaultBranch).toBe('c');

      // Final state in mongo matches the last save
      expect(handle.collection.docs.get(STATE_DOC_ID)!.state.defaultBranch).toBe('c');
    });

    it('a write failure does not break subsequent saves', async () => {
      await store.init();
      handle.collection.failNextWrite = true;

      const a = emptyState();
      a.defaultBranch = 'a';
      const b = emptyState();
      b.defaultBranch = 'b';

      store.save(a);
      store.save(b);

      // flush() resolves even though one write failed
      await store.flush();

      // The second save landed — the chain kept moving
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
