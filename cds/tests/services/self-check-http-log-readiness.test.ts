import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { HttpLogStore, type HttpLogSink } from '../../src/services/http-log-store.js';
import { buildSelfCheck, readHttpSelfCheckStats, type SelfCheckDeps } from '../../src/services/self-check.js';

const now = Date.parse('2026-10-15T09:00:00Z');
function doc(store: HttpLogSink, initialized: boolean) {
  const deps: SelfCheckDeps = { now: () => now, deploymentRuns: () => [], unresolvedWebhookDispatches: () => 0,
    webhookDeliveries: () => [], buildGate: () => ({ active: 0, queued: 0, max: 2, waiters: [] }),
    cycleHealth: () => ({ sinceLastCycleMs: 0, stale: false, running: false, watchdogResets: 0 }),
    processStartedAt: () => now - 3600000, diskUsage: () => ({ totalBytes: 100, freeBytes: 90 }),
    dockerPing: async () => ({ ok: true, ms: 1 }),
    httpStats: since => readHttpSelfCheckStats(store, initialized, since, now), liveAlarmChannels: () => 1,
    selfStatus: () => ({ ready: true, bundleStale: false, headSha: 'fixed', currentBranch: 'main' }), storeBackend: () => 'mongo-split' };
  return buildSelfCheck(deps);
}

it('真实未初始化日志类的空返回不能被统计链解释为零失败', async () => {
  const store = new HttpLogStore({ uri: 'mongodb://127.0.0.1:1' }); // 构造不连接真实数据库。
  expect(await store.findRecent()).toEqual([]);
  const read = vi.spyOn(store, 'findRecent');
  const result = await doc(store, false);
  expect(read).not.toHaveBeenCalled();
  expect(result.checks['api.widget-stream-failures-6h']).toMatchObject({ status: 'warn', observedValue: null });
  expect(result.checks['api.requests-30m']).toMatchObject({ status: 'warn', observedValue: null });
  await store.close();
});

it('初始化成功且查询确实可读的空记录才允许零失败', async () => {
  const read = vi.fn(async () => []);
  const result = await doc({ record: () => {}, findRecent: read }, true);
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.checks['api.widget-stream-failures-6h']).toMatchObject({ status: 'pass', observedValue: 0 });
});

it('就绪后查询抛错仍使用原自检未知兜底，不能被补零', async () => {
  const result = await doc({ record: () => {}, findRecent: async () => { throw new Error('fixture read failed'); } }, true);
  expect(result.checks['api.widget-stream-failures-6h']).toMatchObject({ status: 'warn', observedValue: null });
});

it('index实际注入初始化成功标志和同一受测读取函数', () => {
  const index = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
  expect(index).toMatch(/let activeHttpLogStoreReady = false;[\s\S]*?try \{\s*await activeHttpLogStore.init\(\);\s*activeHttpLogStoreReady = true;/);
  expect(index).toContain('httpStats: (sinceMs) => readHttpSelfCheckStats(activeHttpLogStore, activeHttpLogStoreReady, sinceMs)');
});
