/**
 * Forwarder 路由表监听 — TDD 契约
 *
 * 对应 doc/report.cds.forwarder-success.md
 * 实现位置:cds/src/forwarder/route-watcher.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouteWatcher } from '../../src/forwarder/route-watcher.js';
import type {
  MongoChange,
  MongoLike,
  RouteRecord,
  WatcherEvent,
} from '../../src/forwarder/types.js';

/**
 * In-memory mongo mock。
 *  - records:当前快照(fullScan 返回它)
 *  - 通过 push() 推入 change(insert/update/delete)模拟 change stream
 *  - watch() 返回一个 AsyncIterable,内部用一个 promise queue
 *  - failNextScan / failNextWatch 注入故障
 */
class FakeMongo implements MongoLike {
  records: RouteRecord[] = [];
  failScanCount = 0; // 接下来 N 次 fullScan 抛错
  failWatch = false;
  closed = false;
  private queue: MongoChange[] = [];
  private waiters: Array<(c: IteratorResult<MongoChange>) => void> = [];
  private done = false;

  async fullScan(): Promise<RouteRecord[]> {
    if (this.failScanCount > 0) {
      this.failScanCount -= 1;
      throw new Error('fullScan fail (injected)');
    }
    if (this.closed) throw new Error('closed');
    return this.records.map((r) => ({ ...r }));
  }

  watch(): AsyncIterable<MongoChange> {
    const self = this;
    if (self.failWatch) {
      // 立即抛错,模拟 watch 启动失败
      return {
        [Symbol.asyncIterator](): AsyncIterator<MongoChange> {
          return {
            async next(): Promise<IteratorResult<MongoChange>> {
              throw new Error('watch fail (injected)');
            },
          };
        },
      };
    }
    self.done = false;
    return {
      [Symbol.asyncIterator](): AsyncIterator<MongoChange> {
        return {
          next(): Promise<IteratorResult<MongoChange>> {
            if (self.queue.length > 0) {
              const ch = self.queue.shift()!;
              return Promise.resolve({ value: ch, done: false });
            }
            if (self.done) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((resolve) => {
              self.waiters.push(resolve);
            });
          },
          return(): Promise<IteratorResult<MongoChange>> {
            self.done = true;
            for (const w of self.waiters) w({ value: undefined as never, done: true });
            self.waiters = [];
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.done = true;
    for (const w of this.waiters) w({ value: undefined as never, done: true });
    this.waiters = [];
  }

  /** 测试辅助:推一条 change(立即唤醒消费者) */
  push(ch: MongoChange) {
    // 同时维护 records,模拟真实 mongo
    const idx = this.records.findIndex((r) => String(r._id) === String(ch.record._id));
    if (ch.kind === 'delete') {
      if (idx >= 0) this.records.splice(idx, 1);
    } else if (ch.kind === 'insert') {
      if (idx < 0) this.records.push(ch.record as RouteRecord);
    } else if (ch.kind === 'update') {
      if (idx >= 0) this.records[idx] = { ...this.records[idx], ...ch.record };
      else this.records.push(ch.record as RouteRecord);
    }
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w({ value: ch, done: false });
    } else {
      this.queue.push(ch);
    }
  }
}

function r(partial: Partial<RouteRecord> & { _id: string; host: string }): RouteRecord {
  return {
    upstreamPort: 9001,
    weight: 100,
    ...partial,
  } as RouteRecord;
}

let tmpRoot: string;
let snapshotPath: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-route-watcher-'));
  snapshotPath = path.join(tmpRoot, 'forwarder-routes.json');
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // noop
  }
});

const silentLogger = { info() {}, warn() {}, error() {} };

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

describe('RouteWatcher — mongo change stream 实时更新', () => {
  it('[C-1.3] 启动时一次性 fullScan,把现有路由全部加载进内存', async () => {
    const fake = new FakeMongo();
    fake.records = [
      r({ _id: '1', host: 'a.miduo.org' }),
      r({ _id: '2', host: 'b.miduo.org' }),
    ];
    const w = new RouteWatcher({
      mongoConnect: async () => fake,
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    await w.start();
    expect(w.getRoutes().length).toBe(2);
    expect(w.healthState()).toBe('live');
    expect(w.getDataSource()).toBe('mongo');
    await w.stop();
  });

  it('[C-1.3] mongo insert 一条新路由,内存表 P95 < 500ms 内出现新条目', async () => {
    const fake = new FakeMongo();
    fake.records = [r({ _id: '1', host: 'a.miduo.org' })];
    const w = new RouteWatcher({
      mongoConnect: async () => fake,
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    await w.start();
    const t0 = Date.now();
    fake.push({ kind: 'insert', record: r({ _id: '2', host: 'b.miduo.org' }) });
    await waitFor(() => w.getRoutes().length === 2, 500);
    const dt = Date.now() - t0;
    expect(dt).toBeLessThan(500);
    expect(w.getRoutes().find((r) => r._id === '2')).toBeDefined();
    await w.stop();
  });

  it('[C-1.3] mongo update 路由(改 weight),内存表对应记录字段同步', async () => {
    const fake = new FakeMongo();
    fake.records = [r({ _id: '1', host: 'a.miduo.org', weight: 100 })];
    const w = new RouteWatcher({
      mongoConnect: async () => fake,
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    await w.start();
    fake.push({ kind: 'update', record: { _id: '1', weight: 50 } });
    await waitFor(() => w.getRoutes()[0]?.weight === 50, 500);
    expect(w.getRoutes()[0].weight).toBe(50);
    await w.stop();
  });

  it('[C-1.3] mongo delete 路由,内存表对应记录消失', async () => {
    const fake = new FakeMongo();
    fake.records = [
      r({ _id: '1', host: 'a.miduo.org' }),
      r({ _id: '2', host: 'b.miduo.org' }),
    ];
    const w = new RouteWatcher({
      mongoConnect: async () => fake,
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    await w.start();
    fake.push({ kind: 'delete', record: { _id: '2' } });
    await waitFor(() => w.getRoutes().length === 1, 500);
    expect(w.getRoutes().find((r) => r._id === '2')).toBeUndefined();
    await w.stop();
  });

  it('[C-3.6] 100 条变更连续推送,内存表与 mongo 最终一致(eventual consistency)', async () => {
    const fake = new FakeMongo();
    const w = new RouteWatcher({
      mongoConnect: async () => fake,
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    await w.start();
    for (let i = 0; i < 100; i++) {
      fake.push({
        kind: 'insert',
        record: r({ _id: `id-${i}`, host: `h${i}.miduo.org`, upstreamPort: 9000 + i }),
      });
    }
    await waitFor(() => w.getRoutes().length === 100, 1000);
    // 最终一致性:所有 _id 都在
    const ids = new Set(w.getRoutes().map((r) => r._id));
    for (let i = 0; i < 100; i++) {
      expect(ids.has(`id-${i}`)).toBe(true);
    }
    await w.stop();
  });

  it('[C-3.6] change stream 推送延迟 P99 < 500ms', async () => {
    const fake = new FakeMongo();
    const w = new RouteWatcher({
      mongoConnect: async () => fake,
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    await w.start();
    const latencies: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = Date.now();
      fake.push({ kind: 'insert', record: r({ _id: `id-${i}`, host: `h${i}.miduo.org` }) });
      await waitFor(() => w.getRoutes().some((r) => r._id === `id-${i}`), 500);
      latencies.push(Date.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    expect(p99).toBeLessThan(500);
    await w.stop();
  });

  it('[C-1.3] 内存表替换是原子的(同一时刻读到的总是完整一致快照,不会读到一半)', async () => {
    const fake = new FakeMongo();
    fake.records = [];
    for (let i = 0; i < 10; i++) {
      fake.records.push(r({ _id: `init-${i}`, host: `h${i}.miduo.org` }));
    }
    const w = new RouteWatcher({
      mongoConnect: async () => fake,
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    await w.start();
    // 启动并行读 + 触发重连,验证读到的总是完整 array,length 永远 ≥ 0
    let readError: Error | null = null;
    const reader = (async () => {
      for (let i = 0; i < 200; i++) {
        try {
          const rs = w.getRoutes();
          // 不能为 undefined / 不能有 undefined 项
          if (rs == null) throw new Error('routes is null');
          for (const r of rs) {
            if (!r || !r._id) throw new Error('partial row');
          }
        } catch (e) {
          readError = e as Error;
          break;
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    // 同时推一些更新
    for (let i = 0; i < 50; i++) {
      fake.push({ kind: 'insert', record: r({ _id: `pushed-${i}`, host: `p${i}.miduo.org` }) });
    }
    await reader;
    expect(readError).toBeNull();
    await w.stop();
  });
});

describe('RouteWatcher — 本地 JSON fallback', () => {
  it('[C-1.4] mongo 启动时连不上 → 加载 .cds/forwarder-routes.json + 标 healthState=fallback', async () => {
    const seed: RouteRecord[] = [
      r({ _id: '1', host: 'a.miduo.org' }),
      r({ _id: '2', host: 'b.miduo.org' }),
    ];
    fs.writeFileSync(snapshotPath, JSON.stringify(seed), 'utf8');
    const w = new RouteWatcher({
      mongoConnect: async () => {
        throw new Error('mongo down');
      },
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    await w.start();
    expect(w.healthState()).toBe('fallback');
    expect(w.getDataSource()).toBe('json-fallback');
    expect(w.getRoutes().length).toBe(2);
    await w.stop();
  });

  it('[C-1.4] mongo 运行中断线 → 内存表保留最后状态,标 healthState=stale,不清空', async () => {
    const fake = new FakeMongo();
    fake.records = [r({ _id: '1', host: 'a.miduo.org' })];
    const w = new RouteWatcher({
      mongoConnect: async () => fake,
      jsonFallbackPath: snapshotPath,
      heartbeatIntervalMs: 30,
      heartbeatFailureThreshold: 2,
      reconnectIntervalMs: 1_000_000, // 不让重连干扰这个用例
      logger: silentLogger,
    });
    await w.start();
    expect(w.getRoutes().length).toBe(1);
    // 模拟 fullScan 失败 → 心跳计数 +1,达到阈值 → stale
    fake.failScanCount = 999;
    await waitFor(() => w.healthState() === 'stale', 1000);
    expect(w.getRoutes().length).toBe(1); // 内存表保留
    await w.stop();
  });

  it('[C-1.4] mongo 恢复后自动重连 + 重新 fullScan + 切回 healthState=live', async () => {
    let attempts = 0;
    const fake = new FakeMongo();
    fake.records = [r({ _id: '1', host: 'a.miduo.org' })];
    const w = new RouteWatcher({
      mongoConnect: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('first connect fail');
        return fake;
      },
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    await w.start();
    expect(w.healthState()).toBe('fallback');
    // 主动触发一次重连(避免等 30s 定时器)
    const ok = await w.tryReconnect();
    expect(ok).toBe(true);
    expect(w.healthState()).toBe('live');
    expect(w.getDataSource()).toBe('mongo');
    expect(w.getRoutes().length).toBe(1);
    await w.stop();
  });

  it('[C-8.4] mongo collection 损坏(不可读) → fallback 到 JSON 启动,告警事件入流水', async () => {
    const seed: RouteRecord[] = [r({ _id: '1', host: 'a.miduo.org' })];
    fs.writeFileSync(snapshotPath, JSON.stringify(seed), 'utf8');
    const events: WatcherEvent[] = [];
    const w = new RouteWatcher({
      mongoConnect: async () => {
        throw new Error('collection corrupted');
      },
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    w.onEvent((e) => events.push(e));
    await w.start();
    expect(w.healthState()).toBe('fallback');
    // 应有 fallback-loaded 事件
    expect(events.some((e) => e.kind === 'fallback-loaded')).toBe(true);
    await w.stop();
  });

  it('[C-1.4] 每次 mongo 全量同步成功后,把当前内存表落盘 .cds/forwarder-routes.json(下次启动有兜底)', async () => {
    const fake = new FakeMongo();
    fake.records = [
      r({ _id: '1', host: 'a.miduo.org', upstreamPort: 9001 }),
      r({ _id: '2', host: 'b.miduo.org', upstreamPort: 9002 }),
    ];
    const w = new RouteWatcher({
      mongoConnect: async () => fake,
      jsonFallbackPath: snapshotPath,
      logger: silentLogger,
    });
    await w.start();
    expect(fs.existsSync(snapshotPath)).toBe(true);
    const dump = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    expect(Array.isArray(dump)).toBe(true);
    expect(dump.length).toBe(2);
    expect(dump[0]._id).toBeDefined();
    await w.stop();
  });
});

describe('RouteWatcher — 心跳与重连', () => {
  it('[C-1.4] watcher 自身 5s 心跳,失败 3 次切到 fallback', async () => {
    const fake = new FakeMongo();
    fake.records = [r({ _id: '1', host: 'a.miduo.org' })];
    const w = new RouteWatcher({
      mongoConnect: async () => fake,
      jsonFallbackPath: snapshotPath,
      heartbeatIntervalMs: 20,
      heartbeatFailureThreshold: 3,
      reconnectIntervalMs: 1_000_000,
      logger: silentLogger,
    });
    await w.start();
    fake.failScanCount = 999; // 之后所有 scan 都失败
    // 等待心跳累计失败 ≥3 → stale
    await waitFor(() => w.healthState() === 'stale', 1000);
    expect(w.healthState()).toBe('stale');
    await w.stop();
  });

  it('[C-1.4] fallback 模式下每 30s 尝试重连一次,成功立即切回 live', async () => {
    let firstFail = true;
    const fake = new FakeMongo();
    fake.records = [r({ _id: '1', host: 'a.miduo.org' })];
    const w = new RouteWatcher({
      mongoConnect: async () => {
        if (firstFail) {
          firstFail = false;
          throw new Error('init connect fail');
        }
        return fake;
      },
      jsonFallbackPath: snapshotPath,
      reconnectIntervalMs: 30, // 测试用极短重连间隔
      logger: silentLogger,
    });
    await w.start();
    expect(w.healthState()).toBe('fallback');
    // 等待重连定时器把状态切回 live
    await waitFor(() => w.healthState() === 'live', 2000);
    expect(w.healthState()).toBe('live');
    await w.stop();
  });
});
