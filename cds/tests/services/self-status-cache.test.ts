// 单元测试:selfStatusCache 的核心契约
//
// 覆盖目标文档第 1/4 节关键不变量:
//   - 同时刻只允许一个 refresh job,并发入队复用同一 jobId
//   - refresh 成功 → lastKnownGood 更新 + 发 self.status / self.refresh.done
//   - refresh 失败 → 保留旧 lastKnownGood + degraded.reason / lastError
//   - dedupe 窗口:webhook 5s 内不重复跑
//   - 远端分支扫描独立失败不影响主快照成功

import { describe, it, expect, beforeEach } from 'vitest';
import { selfStatusCache } from '../../src/services/self-status-cache.js';
import { cdsEventsBus, type CdsEventEnvelope } from '../../src/services/cds-events-bus.js';

const baseSnapshot = {
  currentBranch: 'main',
  headSha: 'abc1234',
  webBuildSha: '',
  runningPid: 12345,
  pidStartedAt: null,
  restartStatus: 'not_required' as const,
  activeSelfUpdate: null,
  lastSelfUpdate: null,
  selfUpdateHistory: [],
  remoteAheadCount: 0,
  localAheadCount: 0,
  remoteAheadSubjects: [],
  fetchOk: true,
  fetchError: '',
  bundleStale: false,
  cachedAt: new Date().toISOString(),
};

const collectEvents = (): { unsub: () => void; events: CdsEventEnvelope[] } => {
  const events: CdsEventEnvelope[] = [];
  const unsub = cdsEventsBus.subscribe((e) => { events.push(e); });
  return { unsub, events };
};

const flushTicks = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    await new Promise<void>((r) => setImmediate(r));
  }
};

describe('selfStatusCache', () => {
  beforeEach(() => {
    selfStatusCache._resetForTests();
  });

  it('enqueueRefresh 单 job:并发入队复用同一 jobId', async () => {
    let computeCalls = 0;
    selfStatusCache.init({
      computeSnapshot: async () => {
        computeCalls += 1;
        await new Promise((r) => setTimeout(r, 30));
        return baseSnapshot;
      },
      scanRemoteBranches: async () => [],
    });

    const job1 = selfStatusCache.enqueueRefresh('manual');
    const job2 = selfStatusCache.enqueueRefresh('manual');
    expect(job1.jobId).toBe(job2.jobId);
    expect(job1.status).toBe('running');

    await flushTicks();
    // compute 只跑一次,即使两次入队
    expect(computeCalls).toBe(1);
  });

  it('运行中再入队 → 当前 job 跑完后补跑一次(Codex P2:防丢 self-update 收尾状态)', async () => {
    let computeCalls = 0;
    selfStatusCache.init({
      computeSnapshot: async () => {
        computeCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return baseSnapshot;
      },
      scanRemoteBranches: async () => [],
    });

    const job1 = selfStatusCache.enqueueRefresh('manual');
    expect(job1.status).toBe('running');
    // 趁第一个 job 还在 compute,再入队一次 → 被标脏(返回同 job)
    const job2 = selfStatusCache.enqueueRefresh('webhook');
    expect(job2.jobId).toBe(job1.jobId);

    // 等足够久让 job1(20ms)+ 补跑(20ms)都完成
    await new Promise((r) => setTimeout(r, 200));
    // 关键:不是丢弃只跑 1 次,而是补跑 → 2 次
    expect(computeCalls).toBe(2);
  });

  it('refresh 成功 → snapshot.lastRefreshAt 更新 + 发 self.refresh.done + self.status', async () => {
    selfStatusCache.init({
      computeSnapshot: async () => baseSnapshot,
      scanRemoteBranches: async () => [
        { name: 'main', committerDate: '2026-05-28T00:00:00Z', commitHash: 'abc1234', subject: 'init', cdsTouched: false },
      ],
    });

    const { unsub, events } = collectEvents();
    try {
      selfStatusCache.enqueueRefresh('manual');
      await flushTicks();

      const snap = selfStatusCache.getSnapshot();
      expect(snap.lastRefreshAt).toBeTruthy();
      expect(snap.remoteBranches).toHaveLength(1);
      expect(snap.degraded).toBeNull();
      expect(snap.currentBranch).toBe('main');

      const types = events.map((e) => e.type);
      expect(types).toContain('self.refresh.started');
      expect(types).toContain('self.refresh.done');
      expect(types).toContain('self.status');
    } finally {
      unsub();
    }
  });

  it('refresh 失败 → degraded.reason 设置 + 旧 lastKnownGood 保留', async () => {
    let calls = 0;
    selfStatusCache.init({
      computeSnapshot: async () => {
        calls += 1;
        if (calls === 1) return baseSnapshot;
        throw new Error('git fetch died');
      },
      scanRemoteBranches: async () => [],
    });

    // 第 1 次成功
    selfStatusCache.enqueueRefresh('manual');
    await flushTicks();
    const good = selfStatusCache.getSnapshot();
    expect(good.degraded).toBeNull();
    expect(selfStatusCache.getLastKnownGood()).not.toBeNull();

    // 第 2 次失败
    selfStatusCache.enqueueRefresh('manual');
    await flushTicks();
    const bad = selfStatusCache.getSnapshot();
    expect(bad.degraded?.degraded).toBe(true);
    expect(bad.degraded?.reason).toBe('refresh_failed');
    expect(bad.lastError).toContain('git fetch died');

    // lastKnownGood 没被覆盖
    expect(selfStatusCache.getLastKnownGood()?.degraded ?? null).toBeNull();
  });

  it('scanRemoteBranches 抛错不影响主 refresh 成功', async () => {
    selfStatusCache.init({
      computeSnapshot: async () => baseSnapshot,
      scanRemoteBranches: async () => {
        throw new Error('for-each-ref died');
      },
    });
    selfStatusCache.enqueueRefresh('manual');
    await flushTicks();
    const snap = selfStatusCache.getSnapshot();
    expect(snap.lastRefreshAt).toBeTruthy();
    // 主快照成功 → degraded null
    expect(snap.degraded).toBeNull();
    // remoteBranches 为空(扫描失败)
    expect(snap.remoteBranches).toEqual([]);
  });

  it('webhook trigger 5s 内 dedupe', async () => {
    let calls = 0;
    selfStatusCache.init({
      computeSnapshot: async () => {
        calls += 1;
        return baseSnapshot;
      },
      scanRemoteBranches: async () => [],
    });

    selfStatusCache.enqueueRefresh('webhook');
    await flushTicks();
    // 第二次紧跟 → dedupe 触发,不会新跑
    const job2 = selfStatusCache.enqueueRefresh('webhook');
    await flushTicks();
    expect(calls).toBe(1);
    // job2.status 应是 'done'(复用上次完成的 job)
    expect(job2.status === 'done' || job2.status === 'running').toBe(true);
  });

  it('manual trigger 不受 dedupe 影响', async () => {
    let calls = 0;
    selfStatusCache.init({
      computeSnapshot: async () => {
        calls += 1;
        return baseSnapshot;
      },
      scanRemoteBranches: async () => [],
    });

    selfStatusCache.enqueueRefresh('manual');
    await flushTicks();
    selfStatusCache.enqueueRefresh('manual');
    await flushTicks();
    expect(calls).toBe(2);
  });

  it('未 init 状态下 enqueueRefresh 返回 failed job,不抛错', () => {
    // _resetForTests 之后 options=null
    const job = selfStatusCache.enqueueRefresh('manual');
    expect(job.status).toBe('failed');
    expect(job.error).toContain('not initialized');
  });
});
