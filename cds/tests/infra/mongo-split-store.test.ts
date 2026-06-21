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
  failNextBulkWrite: Error | null = null;

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
    if (this.failNextBulkWrite) {
      const err = this.failNextBulkWrite;
      this.failNextBulkWrite = null;
      throw err;
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
    // 写入合并（2026-06-21）：building/running/deleted 三次同步 save 落在同一个
    // 事件循环 tick，被合并成对最终态 deleted 的唯一一次落盘——中间态 upsert 完全
    // 跳过。故只剩一次 bulkWrite，且就是那条 delete（比旧版的 2 次更省，delete 更不被拖延）。
    expect(handle.branches.bulkWrites).toHaveLength(1);
    expect(handle.branches.bulkWrites[0]).toEqual([{ deleteOne: { filter: { _id: 'a' } } }]);
  });

  it('coalesces a synchronous burst of saves into a single global write (event-loop relief)', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.projects = [{ id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git', createdAt: 't', updatedAt: 't' }];
    store.save(state);
    await store.flush();

    handle.global.replaceWrites = [];
    // 模拟部署日志 append 风暴 / 调和器遍历：同一个 tick 内连续 50 次 save。
    // 旧实现每次都同步 structuredClone(整个 state) + 排队落盘；新实现只在 tick 末
    // 克隆一次、落盘一次。
    for (let i = 0; i < 50; i++) {
      const next = structuredClone(state);
      (next as { activityLogs?: Record<string, unknown> }).activityLogs = { ['prd-agent']: [{ n: i }] };
      store.save(next);
    }
    await store.flush();

    // 50 次同步 save → 全局文档只写一次（合并），不是 50 次。
    expect(handle.global.replaceWrites).toHaveLength(1);
  });

  it('does not leave flush hanging when a write fails before flush is awaited', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.projects = [{ id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git', createdAt: 't', updatedAt: 't' }];
    state.branches = {
      a: { id: 'a', projectId: 'prd-agent', branch: 'a', worktreePath: '/a', services: {}, status: 'idle', createdAt: 't' },
    };
    handle.branches.failNextBulkWrite = new Error('mongo bulk write failed');
    store.save(state);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(store.flush()).rejects.toThrow('mongo bulk write failed');
  });

  it('bounds log-like global state so a single mongo document cannot grow without limit', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.logs = {
      'branch-a': Array.from({ length: 8 }, (_, index) => ({
        type: 'build',
        startedAt: `t-${index}`,
        status: 'completed',
        events: Array.from({ length: 8 }, () => ({
          step: 'line',
          status: 'info',
          chunk: 'x'.repeat(20 * 1024),
        })),
        containerLogSnapshots: [{
          profileId: 'api',
          containerName: 'c',
          logs: 'y'.repeat(64 * 1024),
        }],
      })),
    };
    state.containerLogArchives = {
      'branch-a': Array.from({ length: 8 }, (_, index) => ({
        id: `archive-${index}`,
        ts: `t-${index}`,
        profileId: 'api',
        containerName: 'c',
        logs: 'z'.repeat(64 * 1024),
      })),
    };
    state.selfUpdateHistory = Array.from({ length: 30 }, (_, index) => ({
      ts: `t-${index}`,
      branch: 'main',
      fromSha: 'a',
      toSha: 'b',
      trigger: 'manual',
      status: 'failed',
      error: 'e'.repeat(64 * 1024),
      steps: Array.from({ length: 40 }, () => ({ ts: 't', level: 'info', text: 's'.repeat(16 * 1024) })),
    }));

    store.save(state);
    await store.flush();

    const global = handle.global.docs.get('global')!.state;
    expect(global.logs['branch-a']).toHaveLength(5);
    expect(global.logs['branch-a'][0].events).toHaveLength(5);
    expect(Buffer.byteLength(global.logs['branch-a'][0].events[0].chunk || '', 'utf8')).toBeLessThanOrEqual(4 * 1024);
    expect(global.containerLogArchives['branch-a']).toHaveLength(3);
    expect(Buffer.byteLength(global.containerLogArchives['branch-a'][0].logs, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(global.selfUpdateHistory).toHaveLength(20);
    expect(global.selfUpdateHistory?.[0].steps).toHaveLength(25);
    expect(Buffer.byteLength(global.selfUpdateHistory?.[0].steps?.[0].text || '', 'utf8')).toBeLessThanOrEqual(2 * 1024);
    expect(Buffer.byteLength(JSON.stringify(global), 'utf8')).toBeLessThan(2 * 1024 * 1024);
  });
});
