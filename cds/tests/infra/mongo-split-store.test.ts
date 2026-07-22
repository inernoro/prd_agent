import { describe, expect, it, vi } from 'vitest';
import { MongoSplitStateBackingStore, type ISplitMongoCollection, type ISplitMongoHandle } from '../../src/infra/state-store/mongo-split-store.js';
import type { BranchEntry, CdsState, DeploymentRun, DeploymentVersion, GithubWebhookDelivery, Project, ProjectActivityLog, SelfUpdateRecord } from '../../src/types.js';

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
  deploymentRuns = new FakeSplitCollection<{ _id: string; projectId: string; branchId: string; doc: DeploymentRun; updatedAt: string }>();
  deploymentVersions = new FakeSplitCollection<{ _id: string; projectId: string; doc: DeploymentVersion; updatedAt: string }>();
  selfUpdateHistory = new FakeSplitCollection<{ _id: string; ts: string; doc: SelfUpdateRecord; updatedAt: string }>();
  webhookDeliveries = new FakeSplitCollection<{ _id: string; receivedAt: string; doc: GithubWebhookDelivery; updatedAt: string }>();
  activityLogs = new FakeSplitCollection<{ _id: string; projectId: string; at: string; doc: ProjectActivityLog; updatedAt: string }>();

  async connect(): Promise<void> {}
  globalCollection() { return this.global; }
  projectsCollection() { return this.projects; }
  branchesCollection() { return this.branches; }
  deploymentRunsCollection() { return this.deploymentRuns; }
  deploymentVersionsCollection() { return this.deploymentVersions; }
  selfUpdateHistoryCollection() { return this.selfUpdateHistory; }
  webhookDeliveriesCollection() { return this.webhookDeliveries; }
  activityLogsCollection() { return this.activityLogs; }
  async close(): Promise<void> {}
  async ping(): Promise<boolean> { return true; }
}

function makeRun(id: string, branchId: string, updatedAt = '2026-07-21T00:00:01.000Z'): DeploymentRun {
  return {
    id,
    projectId: 'prd-agent',
    branchId,
    trigger: 'webhook',
    status: 'building',
    phase: 'build',
    seq: 1,
    firstEventSeq: 1,
    startedAt: '2026-07-21T00:00:00.000Z',
    updatedAt,
    events: [{
      seq: 1,
      at: updatedAt,
      phase: 'build',
      level: 'info',
      status: 'building',
      message: 'building',
    }],
  };
}

function makeDelivery(id: string, receivedAt: string): GithubWebhookDelivery {
  return {
    id,
    receivedAt,
    durationMs: 12,
    event: 'push',
    signatureValid: true,
    dispatchAction: 'deploy',
    branchId: 'branch-a',
  };
}

function makeActivityLog(projectId: string, seq: number, at: string): ProjectActivityLog {
  return { id: `${projectId}:${seq}`, at, type: 'deploy' } as ProjectActivityLog;
}

describe('MongoSplitStateBackingStore', () => {
  it('persists deployment runs outside the global document and reloads them', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.deploymentRuns = {
      'dr-1': {
        id: 'dr-1',
        projectId: 'prd-agent',
        branchId: 'main',
        trigger: 'webhook',
        status: 'building',
        phase: 'build',
        seq: 1,
        firstEventSeq: 1,
        startedAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:01.000Z',
        events: [{
          seq: 1,
          at: '2026-07-10T00:00:01.000Z',
          phase: 'build',
          level: 'info',
          status: 'building',
          message: 'building',
        }],
      },
    };
    store.save(state);
    await store.flush();

    expect((handle.global.docs.get('global')!.state as CdsState).deploymentRuns).toBeUndefined();
    expect(handle.deploymentRuns.docs.get('dr-1')?.doc.events).toHaveLength(1);

    const reloaded = new MongoSplitStateBackingStore(handle);
    await reloaded.init();
    expect(reloaded.load()?.deploymentRuns?.['dr-1'].events[0].message).toBe('building');
  });

  it('persists immutable deployment versions outside the global document and reloads them', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.deploymentVersions = {
      'dv-1': {
        id: 'dv-1',
        projectId: 'prd-agent',
        branchId: 'main',
        commitSha: 'abcdef1234567',
        configHash: 'config-hash',
        profiles: [],
        migrations: [],
        capabilities: [],
        createdByRunId: 'dr-1',
        createdAt: '2026-07-10T00:00:00.000Z',
      },
    };
    store.save(state);
    await store.flush();

    expect((handle.global.docs.get('global')!.state as CdsState).deploymentVersions).toBeUndefined();
    expect(handle.deploymentVersions.docs.get('dv-1')?.doc.commitSha).toBe('abcdef1234567');

    const reloaded = new MongoSplitStateBackingStore(handle);
    await reloaded.init();
    expect(reloaded.load()?.deploymentVersions?.['dv-1'].configHash).toBe('config-hash');
  });

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

  it('strips runtime-derived executor.runningContainers from the persisted global doc', async () => {
    // 回归 PR #871 Codex P2：写入合并把 structuredClone 推迟到 tick 末，broadcastState
    // （onSave 监听器）会在那之前把派生字段 runningContainers 戳到 live state 上。
    // 持久化投影必须剥掉它，瞬态 runtime 数据不得落库。
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.executors = {
      node1: {
        id: 'node1',
        capacity: { maxBranches: 4, memoryMB: 8192, cpuCores: 4 },
        load: { memoryUsedMB: 0, cpuPercent: 0 },
        labels: [],
        branches: ['a', 'b'],
        runningContainers: 7,
        lastHeartbeat: 't',
        registeredAt: 't',
        role: 'embedded',
      },
    } as unknown as typeof state.executors;
    store.save(state);
    await store.flush();

    const persisted = handle.global.docs.get('global') as { state: { executors?: Record<string, { runningContainers?: number }> } };
    expect(persisted.state.executors?.node1).toBeDefined();
    expect(persisted.state.executors?.node1.runningContainers).toBeUndefined();
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
      next.customEnv = { _global: { BURST_SEQ: String(i) } };
      store.save(next);
    }
    await store.flush();

    // 50 次同步 save → 全局文档只写一次（合并），不是 50 次。
    expect(handle.global.replaceWrites).toHaveLength(1);
  });

  it('upgrades a queued partial to full when the in-flight write fails (Codex P1, PR #1213)', async () => {
    // 场景:partial A 在写库途中失败,期间又有 partial B 排队。旧行为:finally
    // 立即把 B 以 partial 落库 → persistedGeneration 越过失败代次,flush() 谎报
    // 成功,而 A 的变更缺失,要等下一次无关 save 才被全量对账补回。修复后:B 在
    // catch 里被就地升级为全量快照,落库即找回 A 丢失的变更,无需第三次 save。
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

    // 让 A 的 branches 写挂在 gate 上,放行后抛错。
    let release: () => void = () => undefined;
    handle.branches.bulkWriteGate = new Promise<void>((resolve) => { release = resolve; });
    handle.branches.failNextBulkWrite = new Error('in-flight write boom');

    const a = structuredClone(state);
    a.branches.a.status = 'building';
    store.save(a, [{ kind: 'branches', id: 'a' }]);
    const flushA = store.flush();
    flushA.catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve)); // A 入写管线,挂在 gate

    // A 在途期间,B(只点名 projects)排队为 partial。
    const b = structuredClone(a);
    b.projects[0].name = 'PRD Agent Renamed';
    store.save(b, [{ kind: 'projects', id: 'prd-agent' }]);
    await new Promise((resolve) => setImmediate(resolve)); // B 的 takeSnapshot 入队

    release(); // A 写失败 → catch 应把排队中的 B 升级为全量
    await expect(flushA).rejects.toThrow('in-flight write boom');
    await store.flush(); // 等 B(已升级全量)落库

    // 关键断言:A 丢失的分支状态由 B 的全量落库直接找回,不需要任何后续 save。
    expect(handle.branches.docs.get('a')?.doc.status).toBe('building');
    expect(handle.projects.docs.get('prd-agent')?.doc.name).toBe('PRD Agent Renamed');
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
    expect(global.selfUpdateHistory).toBeUndefined();
    expect(handle.selfUpdateHistory.docs.size).toBe(20);
    const firstHistory = [...handle.selfUpdateHistory.docs.values()][0].doc;
    expect(firstHistory.steps).toHaveLength(25);
    expect(Buffer.byteLength(firstHistory.steps?.[0].text || '', 'utf8')).toBeLessThanOrEqual(2 * 1024);
    expect(Buffer.byteLength(JSON.stringify(global), 'utf8')).toBeLessThan(2 * 1024 * 1024);
  });

  it('compacts aggregate diagnostic state below the mongo single-document limit', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    for (let i = 0; i < 260; i++) {
      const branchId = `branch-${String(i).padStart(3, '0')}`;
      state.logs[branchId] = [{
        type: 'build',
        startedAt: `t-${i}`,
        status: 'completed',
        events: Array.from({ length: 6 }, () => ({
          step: 'line',
          status: 'info',
          chunk: 'x'.repeat(20 * 1024),
        })),
        containerLogSnapshots: [{
          profileId: 'api',
          containerName: 'c',
          logs: 'y'.repeat(64 * 1024),
        }],
      }];
      state.containerLogArchives = state.containerLogArchives || {};
      state.containerLogArchives[branchId] = Array.from({ length: 3 }, (_, index) => ({
        id: `${branchId}:archive-${index}`,
        ts: `t-${index}`,
        profileId: 'api',
        containerName: 'c',
        logs: 'z'.repeat(64 * 1024),
      }));
    }
    state.serviceDeployments = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [
      `dep-${index}`,
      {
        id: `dep-${index}`,
        projectId: 'prd-agent',
        hostId: 'host',
        status: 'running',
        seq: 80,
        startedAt: `t-${index}`,
        logs: Array.from({ length: 80 }, () => ({
          at: 't',
          level: 'info',
          message: 'd'.repeat(16 * 1024),
        })),
      },
    ])) as any;

    store.save(state);
    await store.flush();

    const global = handle.global.docs.get('global')!.state;
    expect(Buffer.byteLength(JSON.stringify(global), 'utf8')).toBeLessThanOrEqual(12 * 1024 * 1024);
    expect(Object.keys(global.logs || {}).length).toBeLessThan(260);
    expect(Object.keys(global.containerLogArchives || {}).length).toBeLessThan(260);
  });

  it('moves webhook deliveries and activity logs into split collections and round-trips them on init', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.githubWebhookDeliveries = [
      makeDelivery('d1', '2026-07-09T01:00:00.000Z'),
      makeDelivery('d2', '2026-07-09T02:00:00.000Z'),
    ];
    state.activityLogs = {
      'prd-agent': [
        makeActivityLog('prd-agent', 1, '2026-07-09T01:00:00.000Z'),
        makeActivityLog('prd-agent', 2, '2026-07-09T02:00:00.000Z'),
      ],
      other: [makeActivityLog('other', 1, '2026-07-09T03:00:00.000Z')],
    };
    store.save(state);
    await store.flush();

    // global doc 不再携带两类日志字段——追加日志不再重写整份 global 文档。
    const global = handle.global.docs.get('global')!.state;
    expect(global.githubWebhookDeliveries).toBeUndefined();
    expect(global.activityLogs).toBeUndefined();
    expect(handle.webhookDeliveries.docs.size).toBe(2);
    expect(handle.activityLogs.docs.size).toBe(3);

    // 新实例 init() 从 split collection 重建，顺序与写入时一致。
    const reopened = new MongoSplitStateBackingStore(handle);
    await reopened.init();
    const reloaded = reopened.load()!;
    expect((reloaded.githubWebhookDeliveries || []).map((d) => d.id)).toEqual(['d1', 'd2']);
    expect((reloaded.activityLogs?.['prd-agent'] || []).map((l) => l.id)).toEqual(['prd-agent:1', 'prd-agent:2']);
    expect((reloaded.activityLogs?.other || []).map((l) => l.id)).toEqual(['other:1']);
  });

  it('falls back to legacy embedded fields when the split collections are empty', async () => {
    // 升级首启：旧 global doc 里还嵌着两类日志，新 collection 为空——零迁移脚本，
    // init() 直接回退读 legacy 字段，首次落盘即完成剥离。
    const handle = new FakeSplitHandle();
    const legacyRest = {
      ...emptyState(),
      githubWebhookDeliveries: [makeDelivery('legacy-1', '2026-07-08T01:00:00.000Z')],
      activityLogs: { 'prd-agent': [makeActivityLog('prd-agent', 9, '2026-07-08T01:00:00.000Z')] },
    } as Omit<CdsState, 'projects' | 'branches'>;
    delete (legacyRest as Partial<CdsState>).projects;
    delete (legacyRest as Partial<CdsState>).branches;
    handle.global.docs.set('global', { _id: 'global', state: legacyRest, updatedAt: 't' });

    const store = new MongoSplitStateBackingStore(handle);
    await store.init();
    const loaded = store.load()!;
    expect((loaded.githubWebhookDeliveries || []).map((d) => d.id)).toEqual(['legacy-1']);
    expect((loaded.activityLogs?.['prd-agent'] || []).map((l) => l.id)).toEqual(['prd-agent:9']);

    // 首次 save 后：legacy 字段从 global doc 剥离，数据落到 split collection。
    store.save(structuredClone(loaded));
    await store.flush();
    const global = handle.global.docs.get('global')!.state;
    expect(global.githubWebhookDeliveries).toBeUndefined();
    expect(global.activityLogs).toBeUndefined();
    expect(handle.webhookDeliveries.docs.size).toBe(1);
    expect(handle.activityLogs.docs.size).toBe(1);
  });

  it('appends one activity log without rewriting the global doc and evicts overflow with deleteOne', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.activityLogs = {
      'prd-agent': [
        makeActivityLog('prd-agent', 1, '2026-07-09T01:00:00.000Z'),
        makeActivityLog('prd-agent', 2, '2026-07-09T02:00:00.000Z'),
      ],
    };
    store.save(state);
    await store.flush();

    handle.global.replaceWrites = [];
    handle.activityLogs.bulkWrites = [];

    // 内存 ring buffer 淘汰最旧一条 + 追加一条（StateService 侧行为的最小重现）。
    const next = structuredClone(state);
    next.activityLogs = {
      'prd-agent': [
        makeActivityLog('prd-agent', 2, '2026-07-09T02:00:00.000Z'),
        makeActivityLog('prd-agent', 3, '2026-07-09T03:00:00.000Z'),
      ],
    };
    store.save(next);
    await store.flush();

    // 全局文档零写入；活动流 collection 一次 bulkWrite：新增 1 条 + 淘汰 deleteOne 1 条。
    expect(handle.global.replaceWrites).toHaveLength(0);
    expect(handle.activityLogs.bulkWrites).toHaveLength(1);
    const ops = handle.activityLogs.bulkWrites[0] as Array<{ replaceOne?: unknown; deleteOne?: { filter: { _id: string } } }>;
    expect(ops.filter((op) => op.replaceOne)).toHaveLength(1);
    const deletes = ops.filter((op) => op.deleteOne);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].deleteOne!.filter._id).toContain('prd-agent:1');
    expect(handle.activityLogs.docs.size).toBe(2);
  });

  it('hint-scoped save clones and diffs only the hinted entity, leaving other collections untouched', async () => {
    // 回归 2026-07-21 增量快照重构：save 带 (kind, id) hint 时，takeSnapshot
    // 只克隆被点名的实体（不再 structuredClone 整个 state），persist 只对该
    // kind 做 diff/写库——其余 collection 零 stringify、零 bulkWrite。
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.projects = [{ id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git', createdAt: 't', updatedAt: 't' }];
    state.branches = {
      a: { id: 'a', projectId: 'prd-agent', branch: 'a', worktreePath: '/a', services: {}, status: 'idle', createdAt: 't' },
      b: { id: 'b', projectId: 'prd-agent', branch: 'b', worktreePath: '/b', services: {}, status: 'idle', createdAt: 't' },
    };
    state.deploymentRuns = { 'dr-1': makeRun('dr-1', 'a') };
    store.save(state);
    await store.flush();

    handle.global.replaceWrites = [];
    handle.projects.bulkWrites = [];
    handle.branches.bulkWrites = [];
    handle.deploymentRuns.bulkWrites = [];

    const next = structuredClone(state);
    next.branches.a.status = 'building';
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone');
    store.save(next, [{ kind: 'branches', id: 'a' }]);
    await store.flush();
    const cloneArgs = cloneSpy.mock.calls.map((call) => call[0]);
    cloneSpy.mockRestore();

    // 部分快照只克隆被点名的那一个实体，不克隆整个 state。
    expect(cloneArgs).toHaveLength(1);
    expect(cloneArgs[0]).toBe(next.branches.a);

    // 只有 branches collection 收到一次 bulkWrite，且只 upsert 分支 a；
    // 未变化的分支 b 因序列化缓存命中被跳过（准确说：根本没进候选集）。
    expect(handle.global.replaceWrites).toHaveLength(0);
    expect(handle.projects.bulkWrites).toHaveLength(0);
    expect(handle.deploymentRuns.bulkWrites).toHaveLength(0);
    expect(handle.branches.bulkWrites).toHaveLength(1);
    const ops = handle.branches.bulkWrites[0] as Array<{ replaceOne?: { filter: { _id: string } } }>;
    expect(ops).toHaveLength(1);
    expect(ops[0].replaceOne!.filter._id).toBe('a');
    expect(handle.branches.docs.get('a')?.doc.status).toBe('building');
    expect(handle.branches.docs.get('b')?.doc.status).toBe('idle');
  });

  it('id-scoped hint still deletes pruned entities of the same kind via the id set', async () => {
    // 删除检测只依赖「该 kind 当前完整 id 集 vs 序列化缓存 key 集」，
    // 所以 addDeploymentRun 的 prune（删旧 run）哪怕 hint 只点名新 run 也能落库。
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.projects = [{ id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git', createdAt: 't', updatedAt: 't' }];
    state.branches = {
      a: { id: 'a', projectId: 'prd-agent', branch: 'a', worktreePath: '/a', services: {}, status: 'idle', createdAt: 't' },
    };
    state.deploymentRuns = {
      'dr-old': makeRun('dr-old', 'a'),
      'dr-new': makeRun('dr-new', 'a'),
    };
    store.save(state);
    await store.flush();

    handle.deploymentRuns.bulkWrites = [];

    const next = structuredClone(state);
    delete next.deploymentRuns!['dr-old'];
    next.deploymentRuns!['dr-new'].updatedAt = '2026-07-21T00:00:02.000Z';
    store.save(next, [{ kind: 'deploymentRuns', id: 'dr-new' }]);
    await store.flush();

    expect(handle.deploymentRuns.bulkWrites).toHaveLength(1);
    const ops = handle.deploymentRuns.bulkWrites[0] as Array<{
      replaceOne?: { filter: { _id: string } };
      deleteOne?: { filter: { _id: string } };
    }>;
    expect(ops.filter((op) => op.replaceOne).map((op) => op.replaceOne!.filter._id)).toEqual(['dr-new']);
    expect(ops.filter((op) => op.deleteOne).map((op) => op.deleteOne!.filter._id)).toEqual(['dr-old']);
    expect(handle.deploymentRuns.docs.has('dr-old')).toBe(false);
  });

  it('serialization cache hit: unchanged resave issues zero writes and no post-persist state clone', async () => {
    // 回归 2026-07-21：diff 只 stringify 当前侧与缓存字符串比较——不再保留
    // persistedCache 整份 state，也就没有旧 drainWrites 尾部的第二次
    // structuredClone(snapshot)。
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.projects = [{ id: 'prd-agent', slug: 'prd-agent', name: 'PRD Agent', kind: 'git', createdAt: 't', updatedAt: 't' }];
    state.branches = {
      a: { id: 'a', projectId: 'prd-agent', branch: 'a', worktreePath: '/a', services: {}, status: 'idle', createdAt: 't' },
      b: { id: 'b', projectId: 'prd-agent', branch: 'b', worktreePath: '/b', services: {}, status: 'idle', createdAt: 't' },
    };
    state.deploymentRuns = { 'dr-1': makeRun('dr-1', 'a') };
    store.save(state);
    await store.flush();

    handle.global.replaceWrites = [];
    handle.projects.bulkWrites = [];
    handle.branches.bulkWrites = [];
    handle.deploymentRuns.bulkWrites = [];

    const again = structuredClone(state);
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone');
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    store.save(again); // 无 hint → 全量快照路径
    await store.flush();
    const cloneArgs = cloneSpy.mock.calls.map((call) => call[0]);
    const stringifyCalls = stringifySpy.mock.calls.length;
    cloneSpy.mockRestore();
    stringifySpy.mockRestore();

    // 全部 collection 零写入：每个实体只 stringify 当前侧即命中缓存。
    expect(handle.global.replaceWrites).toHaveLength(0);
    expect(handle.projects.bulkWrites).toHaveLength(0);
    expect(handle.branches.bulkWrites).toHaveLength(0);
    expect(handle.deploymentRuns.bulkWrites).toHaveLength(0);

    // takeSnapshot 克隆一次 live state；persist 完成后没有第二次全量克隆。
    expect(cloneArgs).toHaveLength(1);
    expect(cloneArgs[0]).toBe(again);
    // 单侧 stringify：4 个实体（1 project + 2 branches + 1 run）+ global rest
    // 的 compact 字节检查与 diff 各 1 次 ≈ 6。旧实现双侧 stringify 至少 2 倍。
    expect(stringifyCalls).toBeLessThanOrEqual(8);
  });

  it('recovers dropped changes with a full resync after a failed partial write', async () => {
    // 失败的 pending 会被消费丢弃；needFullResync 保证下一次 save（哪怕 hint
    // 只点名别的 kind）退化为全量快照，把丢失的变更重新 diff 回库。
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

    const next = structuredClone(state);
    next.branches.a.status = 'building';
    handle.branches.failNextBulkWrite = new Error('partial write boom');
    store.save(next, [{ kind: 'branches', id: 'a' }]);
    await expect(store.flush()).rejects.toThrow('partial write boom');
    expect(handle.branches.docs.get('a')?.doc.status).toBe('idle');

    const after = structuredClone(next);
    after.projects[0].name = 'PRD Agent Renamed';
    store.save(after, [{ kind: 'projects', id: 'prd-agent' }]);
    await store.flush();

    expect(handle.projects.docs.get('prd-agent')?.doc.name).toBe('PRD Agent Renamed');
    // 关键断言：上一轮丢失的分支状态变更由全量重同步补写回库。
    expect(handle.branches.docs.get('a')?.doc.status).toBe('building');
  });

  it('seedIfEmpty writes the split log collections and refuses to seed when any of them has data', async () => {
    const handle = new FakeSplitHandle();
    const store = new MongoSplitStateBackingStore(handle);
    await store.init();

    const state = emptyState();
    state.githubWebhookDeliveries = [makeDelivery('d1', '2026-07-09T01:00:00.000Z')];
    state.activityLogs = { 'prd-agent': [makeActivityLog('prd-agent', 1, '2026-07-09T01:00:00.000Z')] };
    await expect(store.seedIfEmpty(state)).resolves.toBe(true);
    expect(handle.webhookDeliveries.docs.size).toBe(1);
    expect(handle.activityLogs.docs.size).toBe(1);

    // 任一 split collection 非空即拒绝二次 seed（不覆盖已迁数据）。
    const handle2 = new FakeSplitHandle();
    handle2.activityLogs.docs.set('x', { _id: 'x', projectId: 'p', at: 't', doc: makeActivityLog('p', 1, 't'), updatedAt: 't' });
    const store2 = new MongoSplitStateBackingStore(handle2);
    await store2.init();
    await expect(store2.seedIfEmpty(emptyState())).resolves.toBe(false);
  });
});
