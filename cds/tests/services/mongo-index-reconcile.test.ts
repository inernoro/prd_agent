/**
 * 索引对账 + 「索引失败不许把连得上的库判死」（Codex PR #1275 九轮 P2）。
 *
 * 现实场景：运维把日志保留期从 7 天改成 30 天 → 同名 `ttl_ts` 索引的
 * expireAfterSeconds 变了 → Mongo 报 IndexOptionsConflict(85)。此前「连接 + 建索引」
 * 写在同一个 try 里，索引一失败整个 init 就 throw，client/collection 双双复位，
 * 启动那边只打一行日志、再也不重试 —— 这个日志库从改配置那天起静默死掉，
 * 而本 PR 的排障恰恰依赖它。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ensureIndexWithReconcile, isIndexOptionsConflict } from '../../src/services/mongo-index-reconcile.js';

const src = (name: string) => readFileSync(new URL(`../../src/services/${name}`, import.meta.url), 'utf8');

function conflictErr(): Error & { code: number } {
  const e = new Error('Index already exists with different options: ttl_ts') as Error & { code: number };
  e.code = 85;
  return e;
}

describe('ensureIndexWithReconcile', () => {
  it('同名不同选项 → drop 再建，而不是把错误抛给调用方', async () => {
    const calls: string[] = [];
    let first = true;
    const collection = {
      createIndex: async () => {
        calls.push('createIndex');
        if (first) { first = false; throw conflictErr(); }
        return 'ttl_ts';
      },
      dropIndex: async () => { calls.push('dropIndex'); return {} as never; },
    };
    await ensureIndexWithReconcile(collection as never, { ts: 1 }, { name: 'ttl_ts', expireAfterSeconds: 60 });
    expect(calls).toEqual(['createIndex', 'dropIndex', 'createIndex']);
  });

  it('非选项冲突的错误原样抛出，不吞不 drop', async () => {
    const calls: string[] = [];
    const collection = {
      createIndex: async () => { calls.push('createIndex'); throw new Error('not authorized'); },
      dropIndex: async () => { calls.push('dropIndex'); return {} as never; },
    };
    await expect(
      ensureIndexWithReconcile(collection as never, { ts: 1 }, { name: 'ttl_ts' }),
    ).rejects.toThrow('not authorized');
    expect(calls).toEqual(['createIndex']); // 没有误 drop 别人的索引
  });

  it('冲突判定认 code / codeName / message 三种形态', () => {
    expect(isIndexOptionsConflict(conflictErr())).toBe(true);
    expect(isIndexOptionsConflict({ codeName: 'IndexOptionsConflict' })).toBe(true);
    expect(isIndexOptionsConflict({ message: 'already exists with different options' })).toBe(true);
    expect(isIndexOptionsConflict(new Error('connection refused'))).toBe(false);
    expect(isIndexOptionsConflict(null)).toBe(false);
  });
});

describe('日志库：连接成功即可用，索引失败只告警', () => {
  // 这两个类的 init 走真实 MongoClient，单测无法真连；这里钉结构契约：
  // 赋值必须发生在「连接成功」之后、「建索引」之前，且建索引走不致命路径。
  for (const file of ['http-log-store.ts', 'server-event-log-store.ts']) {
    it(`${file}: 赋值在建索引之前，建索引失败走 tryEnsureIndexes 只告警`, () => {
      const text = src(file);
      const assignAt = text.indexOf('this.collection = collection;');
      const tryAt = text.indexOf('await this.tryEnsureIndexes(collection);');
      expect(assignAt, '必须先把 collection 挂上实例').toBeGreaterThan(0);
      expect(tryAt, '建索引必须走不致命的 tryEnsureIndexes').toBeGreaterThan(assignAt);
      // 建索引不得再出现在「失败即复位」的那个 try 里
      expect(text).not.toMatch(/await this\.ensureIndexes\(collection\);\s*\n\s*this\.client = client;/);
      // 索引没建全时后续 init 要能重试（不重连）
      expect(text).toMatch(/if \(!this\.indexesReady && this\.collection\) await this\.tryEnsureIndexes/);
      // 连接失败仍必须复位 + close（七轮那条不能被本轮改掉）
      expect(text).toMatch(/await client\.close\(\)\.catch\(/);
    });

    it(`${file}: 索引失败会真的排程重试，而不是只承诺「下次 init 再说」（Codex 十轮 P2）`, () => {
      const text = src(file);
      // init() 只在启动时被调一次（index.ts / forwarder-main.ts 各一处），
      // 「下次 init 会重试」等于永不重试 —— 尤其 TTL 已 drop、重建又失败时，
      // 保留期在重启前一直失效。必须自己排定时器。
      expect(text).toMatch(/private scheduleIndexRetry\(/);
      expect(text).toMatch(/this\.indexRetryTimer = timer;/);
      // 后台维护定时器要 unref（与启动期那个刻意不 unref 的相反）
      expect(text).toMatch(/timer\.unref\?\.\(\)/);
      // close() 要收掉定时器，别留着空转
      expect(text).toMatch(/if \(this\.indexRetryTimer\) \{ clearTimeout\(this\.indexRetryTimer\)/);
      // 成功后重置退避计数，否则下一次故障一上来就是 30 分钟
      expect(text).toMatch(/this\.indexRetryAttempt = 0;/);
    });

    it(`${file}: 索引逐条对账，一条失败不掩盖其余`, () => {
      const text = src(file);
      expect(text).toContain('ensureIndexWithReconcile(collection');
      expect(text).toContain('Promise.allSettled');
      expect(text, '不许再用 Promise.all 让首个失败短路其余索引').not.toMatch(
        /ensureIndexes\([^)]*\): Promise<void> \{\s*\n\s*await Promise\.all\(/,
      );
    });
  }
});
