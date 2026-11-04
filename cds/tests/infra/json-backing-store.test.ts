/**
 * Tests for JsonStateBackingStore — the extracted file-I/O layer that
 * now sits underneath StateService.
 *
 * 2026-07-09 起 save() 是去抖异步落盘（对齐 mongo-split-store 的模式）：
 * save() 只记 dirty，setImmediate 末合并成一次序列化 + 异步原子写。
 * 因此磁盘可见性的正确等待方式是 `await store.flush()` —— 本套测试
 * pin 的行为从「save 后磁盘立即可读」改为：
 *
 *   1. 去抖合并：同一 tick 内多次 save 只落盘一次，flush 后磁盘是最新值。
 *   2. 原子写：flush 后盘上永远是完整可解析 JSON。
 *   3. 恢复：主文件损坏时回退到最近可读的 .bak.*。
 *   4. 轮转 + 节流：.bak 写入 ≥60s 节流；总数不超过 MAX_STATE_BACKUPS。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  JsonStateBackingStore,
  MAX_STATE_BACKUPS,
} from '../../src/infra/state-store/json-backing-store.js';
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

describe('JsonStateBackingStore', () => {
  let tmpDir: string;
  let filePath: string;
  let store: JsonStateBackingStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-json-store-test-'));
    filePath = path.join(tmpDir, 'state.json');
    store = new JsonStateBackingStore(filePath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  describe('load', () => {
    it('returns null when no state file and no backups exist', () => {
      expect(store.load()).toBeNull();
    });

    it('returns the persisted state after save + flush', async () => {
      const state = emptyState();
      state.nextPortIndex = 42;
      store.save(state);
      await store.flush();

      const loaded = store.load();
      expect(loaded?.nextPortIndex).toBe(42);
    });

    it('recovers from the most recent .bak.* when the primary file is corrupt', async () => {
      // flush 会写第一份 .bak（节流窗口内首次）
      const goodState = emptyState();
      goodState.nextPortIndex = 2;
      store.save(goodState);
      await store.flush();

      // Corrupt the primary file
      fs.writeFileSync(filePath, '{ this is not: valid json');

      const recovered = store.load();
      expect(recovered).not.toBeNull();
      expect(recovered?.nextPortIndex).toBe(2);
    });

    it('returns null when every backup is also corrupt', () => {
      fs.writeFileSync(filePath, '{corrupt}');
      fs.writeFileSync(filePath + '.bak.2026-01-01T00-00-00-000Z', '{also corrupt}');

      expect(store.load()).toBeNull();
    });
  });

  describe('save (debounced async)', () => {
    it('writes parseable JSON that round-trips after flush', async () => {
      const state = emptyState();
      state.branches = {
        'b1': {
          id: 'b1',
          name: 'feature/x',
          status: 'running',
          serviceStates: {},
          urls: {},
          createdAt: '2026-04-13T00:00:00Z',
          updatedAt: '2026-04-13T00:00:00Z',
          lastAccessed: '2026-04-13T00:00:00Z',
          webPort: 5500,
          apiPort: 5000,
          envVars: {},
        } as any,
      };

      store.save(state);
      await store.flush();
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.branches.b1.name).toBe('feature/x');
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      const backup = fs.readdirSync(tmpDir).find((name) => name.startsWith('state.json.bak.'));
      expect(backup).toBeTruthy();
      expect(fs.statSync(path.join(tmpDir, backup!)).mode & 0o777).toBe(0o600);
    });

    it('coalesces multiple saves in the same tick into one write with the latest value', async () => {
      // 同一 tick 连续 save 三次（模拟部署日志 append 风暴）
      for (let i = 1; i <= 3; i++) {
        const state = emptyState();
        state.nextPortIndex = i;
        store.save(state);
      }
      // flush 前磁盘上还没有文件（写被推迟到 tick 末）
      await store.flush();
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(parsed.nextPortIndex).toBe(3);
      // .bak 节流：三次 save 合并后至多产生 1 份备份
      const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('state.json.bak.'));
      expect(backups.length).toBeLessThanOrEqual(1);
    });

    it('flush() is a no-op when nothing is dirty', async () => {
      await expect(store.flush()).resolves.toBeUndefined();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('throttles .bak snapshots: consecutive flushes within 60s produce a single backup', async () => {
      for (let i = 0; i < 3; i++) {
        const state = emptyState();
        state.nextPortIndex = i;
        store.save(state);
        await store.flush();
      }
      const backups = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('state.json.bak.'));
      expect(backups.length).toBe(1);
    });

    it('prunes old backups so no more than MAX_STATE_BACKUPS remain', async () => {
      // 预置超额的假备份文件（节流后无法靠连续 save 制造多份备份）
      for (let i = 0; i < MAX_STATE_BACKUPS + 5; i++) {
        const stamp = `2026-01-01T00-00-${String(i).padStart(2, '0')}-000Z`;
        fs.writeFileSync(path.join(tmpDir, `state.json.bak.${stamp}`), '{}');
      }
      store.save(emptyState());
      await store.flush();

      const backups = fs
        .readdirSync(tmpDir)
        .filter((f) => f.startsWith('state.json.bak.'));
      expect(backups.length).toBeLessThanOrEqual(MAX_STATE_BACKUPS);
    });

    it('creates the parent directory if it does not exist', async () => {
      const deepPath = path.join(tmpDir, 'a', 'b', 'c', 'state.json');
      const deepStore = new JsonStateBackingStore(deepPath);
      deepStore.save(emptyState());
      await deepStore.flush();
      expect(fs.existsSync(deepPath)).toBe(true);
    });
  });

  describe('kind tag', () => {
    it('reports "json" for log grepping', () => {
      expect(store.kind).toBe('json');
    });
  });

  it('reports a failed disk barrier to every waiter and clears it only after a newer successful write', async () => {
    fs.mkdirSync(filePath); // Real rename failure: a directory occupies the state file path.
    store.save(emptyState());
    const results = await Promise.allSettled([store.flush(), store.flush()]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    await expect(store.flush()).rejects.toThrow();
    fs.rmdirSync(filePath);
    const recovered = emptyState(); recovered.nextPortIndex = 19;
    store.save(recovered);
    await expect(store.flush()).resolves.toBeUndefined();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).nextPortIndex).toBe(19);
  });
  it('retains a serialization failure for all observers until a serializable snapshot succeeds', async () => {
    const state = emptyState(); (state as any).cycle = state;
    store.save(state);
    const results = await Promise.allSettled([store.flush(), store.flush()]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    await expect(store.flush()).rejects.toThrow();
    store.save(emptyState()); await store.flush();
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).nextPortIndex).toBe(0);
  });
  it('keeps an older failed write barrier failed while a queued newer snapshot can succeed', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = (store as any).writeToDisk.bind(store);
    const write = vi.spyOn(store as any, 'writeToDisk').mockImplementation(async (serialized: unknown) => {
      if (write.mock.calls.length === 1) { await gate; throw new Error('owned write failure'); }
      await original(serialized);
    });
    store.save(emptyState());
    const first = store.flush();
    const firstResult = first.then(() => 'passed', () => 'failed');
    const next = emptyState(); next.nextPortIndex = 22;
    store.save(next); const second = store.flush();
    release();
    expect(await firstResult).toBe('failed');
    await second; expect(store.load()?.nextPortIndex).toBe(22);
  });

  it('does not fail a valid in-flight barrier when a later snapshot cannot serialize', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = (store as any).writeToDisk.bind(store);
    vi.spyOn(store as any, 'writeToDisk').mockImplementation(async (serialized: unknown) => {
      await gate; await original(serialized);
    });
    store.save(emptyState()); const first = store.flush();
    const invalid = emptyState(); (invalid as any).cycle = invalid;
    store.save(invalid); const second = store.flush();
    const rejected = second.then(() => false, () => true);
    release(); await first; expect(await rejected).toBe(true);
    await expect(store.flush()).rejects.toThrow();
    store.save(emptyState()); await store.flush();
  });

  it('protects a queued valid flush from a newer serialization error and freezes live mutations at flush', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = (store as any).writeToDisk.bind(store);
    const write = vi.spyOn(store as any, 'writeToDisk').mockImplementation(async (serialized: unknown) => {
      if (write.mock.calls.length === 1) await gate;
      await original(serialized);
    });
    store.save(emptyState()); const first = store.flush();
    const queued = emptyState(); queued.nextPortIndex = 42;
    store.save(queued); const second = store.flush();
    queued.nextPortIndex = 999; // Unsaved live mutation must not alter the frozen barrier.
    const invalid = emptyState(); (invalid as any).cycle = invalid;
    store.save(invalid); const rejected = store.flush().then(() => false, () => true);
    release(); await Promise.all([first, second]);
    expect(await rejected).toBe(true);
    expect(store.load()?.nextPortIndex).toBe(42);
    await expect(store.flush()).rejects.toThrow();
    store.save(emptyState()); await store.flush();
  });

  it('commits every explicit frozen flush before acknowledging it, including overwritten later states', async () => {
    const committed: number[] = [];
    store = new JsonStateBackingStore(filePath, { onWrite: e => {
      if (e.purpose === 'primary' && e.phase === 'committed') committed.push(JSON.parse(fs.readFileSync(filePath, 'utf8')).nextPortIndex);
    } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = (store as any).writeToDisk.bind(store);
    const write = vi.spyOn(store as any, 'writeToDisk').mockImplementation(async (serialized: unknown) => {
      if (write.mock.calls.length === 1) await gate;
      await original(serialized);
    });
    const live = emptyState(); live.nextPortIndex = 11;
    store.save(live); const first = store.flush();
    live.nextPortIndex = 22; store.save(live); const second = store.flush();
    live.nextPortIndex = 33; store.save(live); const third = store.flush();
    release(); await Promise.all([first, second, third]);
    expect(committed).toEqual([11, 22, 33]);
    expect(store.load()?.nextPortIndex).toBe(33);
  });

  it('preserves a null rejection even when the diagnostic sink throws, without an unhandled observer rejection', async () => {
    const bad = emptyState(); (bad as any).toJSON = () => { throw null; };
    const logger = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('diagnostic sink unavailable'); });
    try {
      store.save(bad);
      expect(await Promise.allSettled([store.flush(), store.flush()])).toEqual([
        { status: 'rejected', reason: null }, { status: 'rejected', reason: null },
      ]);
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    } finally { logger.mockRestore(); }
    store.save(emptyState()); await store.flush();
  });

});
