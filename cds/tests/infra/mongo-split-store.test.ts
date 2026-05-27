import { describe, expect, it } from 'vitest';
import { MongoSplitStateBackingStore, type ISplitMongoCollection, type ISplitMongoHandle } from '../../src/infra/state-store/mongo-split-store.js';
import type { BranchEntry, CdsState, Project } from '../../src/types.js';

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
    projects: [],
  };
}

class FakeSplitCollection<TDoc extends { _id: string }> implements ISplitMongoCollection<TDoc> {
  docs = new Map<string, TDoc>();
  bulkWrites: unknown[][] = [];
  replaceWrites: TDoc[] = [];
  findCalls = 0;
  bulkWriteGate: Promise<void> | null = null;

  async findOne(filter: { _id: string }): Promise<TDoc | null> {
    return this.docs.get(filter._id) || null;
  }

  find(): { toArray(): Promise<TDoc[]> } {
    this.findCalls++;
    return { toArray: async () => [...this.docs.values()] };
  }

  async replaceOne(filter: { _id: string }, doc: TDoc): Promise<void> {
    this.docs.set(filter._id, doc);
    this.replaceWrites.push(doc);
  }

  async deleteOne(filter: { _id: string }): Promise<void> {
    this.docs.delete(filter._id);
  }

  async bulkWrite(operations: Array<unknown>): Promise<void> {
    if (this.bulkWriteGate) {
      const gate = this.bulkWriteGate;
      this.bulkWriteGate = null;
      await gate;
    }
    this.bulkWrites.push(operations);
    for (const op of operations as Array<any>) {
      if (op.replaceOne) {
        this.docs.set(op.replaceOne.filter._id, op.replaceOne.replacement);
      } else if (op.deleteOne) {
        this.docs.delete(op.deleteOne.filter._id);
      }
    }
  }

  async countDocuments(): Promise<number> {
    return this.docs.size;
  }
}

class FakeSplitHandle implements ISplitMongoHandle {
  global = new FakeSplitCollection<{ _id: string; state: Omit<CdsState, 'projects' | 'branches'>; updatedAt: string }>();
  projects = new FakeSplitCollection<{ _id: string; doc: Project; updatedAt: string }>();
  branches = new FakeSplitCollection<{ _id: string; projectId: string; doc: BranchEntry; updatedAt: string }>();

  async connect(): Promise<void> {}
  globalCollection() { return this.global; }
  projectsCollection() { return this.projects; }
  branchesCollection() { return this.branches; }
  async close(): Promise<void> {}
  async ping(): Promise<boolean> { return true; }
}

describe('MongoSplitStateBackingStore', () => {
  it('persists branch deletion with a single branch delete operation instead of full collection rewrites', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.projects = [{ id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git', createdAt: 't', updatedAt: 't' }];
    state.branches = {
      a: { id: 'a', projectId: 'prd-agent', branch: 'a', worktreePath: '/a', services: {}, status: 'idle', createdAt: 't' },
      b: { id: 'b', projectId: 'prd-agent', branch: 'b', worktreePath: '/b', services: {}, status: 'idle', createdAt: 't' },
      c: { id: 'c', projectId: 'prd-agent', branch: 'c', worktreePath: '/c', services: {}, status: 'idle', createdAt: 't' },
    };
    store.save(state);
    await store.flush();

    handle.global.replaceWrites = [];
    handle.projects.bulkWrites = [];
    handle.branches.bulkWrites = [];
    handle.projects.findCalls = 0;
    handle.branches.findCalls = 0;

    const afterDelete = structuredClone(state);
    delete afterDelete.branches.b;
    store.save(afterDelete);
    await store.flush();

    expect(handle.global.replaceWrites).toHaveLength(0);
    expect(handle.projects.bulkWrites).toHaveLength(0);
    expect(handle.projects.findCalls).toBe(0);
    expect(handle.branches.findCalls).toBe(0);
    expect(handle.branches.bulkWrites).toHaveLength(1);
    expect(handle.branches.bulkWrites[0]).toEqual([{ deleteOne: { filter: { _id: 'b' } } }]);
    expect(handle.branches.docs.has('b')).toBe(false);
    expect(handle.branches.docs.has('a')).toBe(true);
    expect(handle.branches.docs.has('c')).toBe(true);
  });

  it('seedIfEmpty performs a full write even though it primes the cache', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.projects = [{ id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git', createdAt: 't', updatedAt: 't' }];
    state.branches = {
      a: { id: 'a', projectId: 'prd-agent', branch: 'a', worktreePath: '/a', services: {}, status: 'idle', createdAt: 't' },
    };

    await expect(store.seedIfEmpty(state)).resolves.toBe(true);
    expect(handle.global.docs.has('global')).toBe(true);
    expect(handle.projects.docs.has('prd-agent')).toBe(true);
    expect(handle.branches.docs.has('a')).toBe(true);
  });

  it('coalesces queued snapshots so a delete is not delayed by stale branch updates', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.projects = [{ id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git', createdAt: 't', updatedAt: 't' }];
    state.branches = {
      a: { id: 'a', projectId: 'prd-agent', branch: 'a', worktreePath: '/a', services: {}, status: 'idle', createdAt: 't' },
    };
    store.save(state);
    await store.flush();

    handle.branches.bulkWrites = [];
    let release!: () => void;
    handle.branches.bulkWriteGate = new Promise<void>((resolve) => { release = resolve; });

    const building = structuredClone(state);
    building.branches.a.status = 'building';
    store.save(building);

    const running = structuredClone(building);
    running.branches.a.status = 'running';
    store.save(running);

    const deleted = structuredClone(running);
    delete deleted.branches.a;
    store.save(deleted);

    const flushed = store.flush();
    release();
    await flushed;

    expect(handle.branches.docs.has('a')).toBe(false);
    expect(handle.branches.bulkWrites).toHaveLength(2);
    expect(handle.branches.bulkWrites[1]).toEqual([{ deleteOne: { filter: { _id: 'a' } } }]);
  });
});
