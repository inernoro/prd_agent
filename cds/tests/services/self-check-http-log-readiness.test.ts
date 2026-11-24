import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { HttpLogStore, type HttpLogSink } from '../../src/services/http-log-store.js';
import * as selfCheck from '../../src/services/self-check.js';
import { buildSelfCheck, readHttpSelfCheckStats, type SelfCheckDeps } from '../../src/services/self-check.js';

const now = Date.parse('2026-10-15T09:00:00Z');
async function actualProductionReader(store: HttpLogSink & { init(): Promise<void> }) {
  const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  let initializationStart = -1, initializationEnd = -1, reader = '';
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      const names = node.declarationList.declarations.map(d => d.name.getText(file));
      if (names.includes('activeHttpLogStore')) initializationStart = node.getStart(file);
      if (names.includes('localServerEventLogStore')) initializationEnd = node.getStart(file);
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'selfCheckDeps' && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)) {
      const property = node.initializer.properties.find(p => p.name?.getText(file) === 'httpStats');
      if (property && ts.isPropertyAssignment(property)) reader = property.initializer.getText(file);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(initializationStart).toBeGreaterThan(0); expect(initializationEnd).toBeGreaterThan(initializationStart); expect(reader).not.toBe('');
  const context = { ...selfCheck, httpLogStoreFromEnv: () => store,
    console: { log: () => {}, warn: () => {} }, factory: null as unknown };
  const actualInitialization = source.slice(initializationStart, initializationEnd);
  vm.runInNewContext(ts.transpileModule(`factory = (async () => { ${actualInitialization}\nreturn (${reader}); })();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return await context.factory as SelfCheckDeps['httpStats'];
}

function doc(httpStats: SelfCheckDeps['httpStats']) {
  return buildSelfCheck({ now: () => now, deploymentRuns: () => [], unresolvedWebhookDispatches: () => 0,
    webhookDeliveries: () => [], buildGate: () => ({ active: 0, queued: 0, max: 2, waiters: [] }),
    cycleHealth: () => ({ sinceLastCycleMs: 0, stale: false, running: false, watchdogResets: 0 }),
    processStartedAt: () => now - 3600000, diskUsage: () => ({ totalBytes: 100, freeBytes: 90 }),
    dockerPing: async () => ({ ok: true, ms: 1 }), httpStats, liveAlarmChannels: () => 1,
    selfStatus: () => ({ ready: true, bundleStale: false, headSha: 'fixed', currentBranch: 'main' }), storeBackend: () => 'mongo-split' });
}

it('实际初始化失败后保留未知，真实未初始化空日志类不能被生产接线当作零失败', async () => {
  const store = new HttpLogStore({ uri: 'mongodb://127.0.0.1:1' });
  vi.spyOn(store, 'init').mockRejectedValue(new Error('owned fixture initialization refused'));
  const read = vi.spyOn(store, 'findRecent');
  try {
    const result = await doc(await actualProductionReader(store));
    expect(result.checks['api.widget-stream-failures-6h']).toMatchObject({ status: 'warn', observedValue: null });
    expect(result.checks['api.requests-30m']).toMatchObject({ status: 'warn', observedValue: null });
    expect(read).not.toHaveBeenCalled();
  } finally { await store.close(); }
});

it('实际初始化成功且查询可读的空结果才显示零失败', async () => {
  const read = vi.fn(async () => []), store = { init: async () => {}, record: () => {}, findRecent: read };
  const result = await doc(await actualProductionReader(store));
  expect(result.checks['api.widget-stream-failures-6h']).toMatchObject({ status: 'pass', observedValue: 0 });
  expect(read).toHaveBeenCalledTimes(2);
});

it('实际生产查询抛错继续显示未知而不补零', async () => {
  const store = { init: async () => {}, record: () => {}, findRecent: async () => { throw new Error('owned fixture read failed'); } };
  const result = await doc(await actualProductionReader(store));
  expect(result.checks['api.widget-stream-failures-6h']).toMatchObject({ status: 'warn', observedValue: null });
});

function directHelperDoc(store: HttpLogSink, initialized: boolean) {
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
  const result = await directHelperDoc(store, false);
  expect(read).not.toHaveBeenCalled();
  expect(result.checks['api.widget-stream-failures-6h']).toMatchObject({ status: 'warn', observedValue: null });
  expect(result.checks['api.requests-30m']).toMatchObject({ status: 'warn', observedValue: null });
  await store.close();
});

it('初始化成功且查询确实可读的空记录才允许零失败', async () => {
  const read = vi.fn(async () => []);
  const result = await directHelperDoc({ record: () => {}, findRecent: read }, true);
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.checks['api.widget-stream-failures-6h']).toMatchObject({ status: 'pass', observedValue: 0 });
});

it('就绪后查询抛错仍使用原自检未知兜底，不能被补零', async () => {
  const result = await directHelperDoc({ record: () => {}, findRecent: async () => { throw new Error('fixture read failed'); } }, true);
  expect(result.checks['api.widget-stream-failures-6h']).toMatchObject({ status: 'warn', observedValue: null });
});

it('index实际注入初始化成功标志和同一受测读取函数', () => {
  const index = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');
  expect(index).toMatch(/let activeHttpLogStoreReady = false;[\s\S]*?try \{\s*await activeHttpLogStore.init\(\);\s*activeHttpLogStoreReady = true;/);
  expect(index).toContain('httpStats: (sinceMs) => readHttpSelfCheckStats(activeHttpLogStore, activeHttpLogStoreReady, sinceMs)');
});
