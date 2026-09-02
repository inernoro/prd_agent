/**
 * repo-sharing —— 「一个仓库喂多个项目」的判据回归。
 *
 * 重点不是「能数出几个项目」，而是三条取舍能不能站住：
 *   1. 单项目仓库**什么都不该看见** —— 否则等于给所有人凭空加一个要理解的概念。
 *   2. 结论句得说出后果（会重建谁），不是报一串计数。
 *   3. 共享基础设施是**算出来的**：同一个仓库并不自动等于共用数据库，那取决于
 *      两边环境变量填了什么。断言一个不存在的共享，比不说更糟。
 */

import { describe, it, expect } from 'vitest';
import {
  findSharedInfra,
  summarizeRepoSharing,
  describeSharedInfra,
  type RepoSiblingFacts,
} from '../../src/services/repo-sharing.js';

const proj = (id: string, name: string, scope: string[] = [], env?: Record<string, string>): RepoSiblingFacts =>
  ({ id, name, scope, ...(env ? { env } : {}) });

describe('summarizeRepoSharing：单项目仓库什么都不提', () => {
  it('零个项目：不产出', () => {
    expect(summarizeRepoSharing([])).toBeNull();
  });

  it('只有一个项目：不产出 —— 单仓单项目的人不该被迫理解「多项目」这个概念', () => {
    expect(summarizeRepoSharing([proj('p1', 'MAP')])).toBeNull();
  });
});

describe('summarizeRepoSharing：结论说后果，不报计数', () => {
  it('都没声明范围 → 警告，并点明「全部重建」', () => {
    const s = summarizeRepoSharing([proj('p1', 'MAP'), proj('p2', 'CDS'), proj('p3', 'LLMGW')])!;
    expect(s.level).toBe('warn');
    expect(s.total).toBe(3);
    expect(s.unscoped).toBe(3);
    expect(s.headline).toContain('全部重建');
  });

  it('部分没声明 → 警告，并点名是哪几个', () => {
    const s = summarizeRepoSharing([
      proj('p1', 'MAP', ['prd-api/**']),
      proj('p2', 'CDS'),
      proj('p3', 'LLMGW'),
    ])!;
    expect(s.level).toBe('warn');
    expect(s.unscoped).toBe(2);
    expect(s.headline).toContain('CDS');
    expect(s.headline).toContain('LLMGW');
    // 已声明范围的那个不该被点名
    expect(s.headline).not.toContain('MAP');
  });

  it('都声明了 → 中性，并说明推送只重建被改到的', () => {
    const s = summarizeRepoSharing([
      proj('p1', 'MAP', ['prd-api/**']),
      proj('p2', 'CDS', ['cds/**']),
    ])!;
    expect(s.level).toBe('ok');
    expect(s.unscoped).toBe(0);
    expect(s.headline).toContain('被改到');
  });
});

describe('findSharedInfra：共享是算出来的，不是假设的', () => {
  it('各连各的库 → 不报（这是常态，报了就是狼来了）', () => {
    const hits = findSharedInfra([
      proj('p1', 'MAP', [], { MONGO_URL: 'mongodb://h/map' }),
      proj('p2', 'CDS', [], { MONGO_URL: 'mongodb://h/cds' }),
    ]);
    expect(hits).toEqual([]);
  });

  it('取值完全相同 → 报，并点名是哪个变量撞了', () => {
    const hits = findSharedInfra([
      proj('p1', 'MAP', [], { MONGO_URL: 'mongodb://h/shared' }),
      proj('p2', 'CDS', [], { MONGO_URL: 'mongodb://h/shared' }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe('MONGO_URL');
    expect(hits[0].kind).toBe('database');
    expect(hits[0].projectIds).toEqual(['p1', 'p2']);
  });

  it('数据库排在缓存与普通地址前面（撞库比撞只读端点严重）', () => {
    const hits = findSharedInfra([
      proj('p1', 'A', [], { REDIS_URL: 'redis://h/0', API_BASE: 'https://x.test', DB_URL: 'mysql://h/app' }),
      proj('p2', 'B', [], { REDIS_URL: 'redis://h/0', API_BASE: 'https://x.test', DB_URL: 'mysql://h/app' }),
    ]);
    expect(hits.map((h) => h.kind)).toEqual(['database', 'cache', 'endpoint']);
  });

  it('不是存储地址的值一律不报（版本号、开关不该被当成共享）', () => {
    const hits = findSharedInfra([
      proj('p1', 'A', [], { NODE_ENV: 'production', LOG_LEVEL: 'info' }),
      proj('p2', 'B', [], { NODE_ENV: 'production', LOG_LEVEL: 'info' }),
    ]);
    expect(hits).toEqual([]);
  });

  it('没给 env 的项目不参与比对 —— 不知道就不猜', () => {
    const hits = findSharedInfra([
      proj('p1', 'A', [], { MONGO_URL: 'mongodb://h/shared' }),
      proj('p2', 'B'),
    ]);
    expect(hits).toEqual([]);
  });

  it('库名 key 撞上同一个值同样算共享（配套 host 常常在别处）', () => {
    const hits = findSharedInfra([
      proj('p1', 'A', [], { MYSQL_DATABASE: 'app' }),
      proj('p2', 'B', [], { MYSQL_DATABASE: 'app' }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe('database');
  });
});

describe('按 key 名认 redis 时要看值像不像地址', () => {
  it('REDIS_PORT=6379 两边一样不算共享缓存 —— 那证明不了连的是同一个 redis', () => {
    const hits = findSharedInfra([
      { id: 'a', name: 'A', scope: [], env: { REDIS_PORT: '6379', REDIS_HOST: 'a-cache.internal' } },
      { id: 'b', name: 'B', scope: [], env: { REDIS_PORT: '6379', REDIS_HOST: 'b-cache.internal' } },
    ]);
    // 端口相同是常态；主机各不相同，所以一条都不该报
    expect(hits).toEqual([]);
  });

  it('REDIS_HOST 指向同一台才算共享', () => {
    const hits = findSharedInfra([
      { id: 'a', name: 'A', scope: [], env: { REDIS_HOST: 'shared-cache.internal' } },
      { id: 'b', name: 'B', scope: [], env: { REDIS_HOST: 'shared-cache.internal' } },
    ]);
    expect(hits).toEqual([{ key: 'REDIS_HOST', kind: 'cache', projectIds: ['a', 'b'] }]);
  });

  it('host:port 认得出来', () => {
    const hits = findSharedInfra([
      { id: 'a', name: 'A', scope: [], env: { REDIS_ADDR: 'cache:6379' } },
      { id: 'b', name: 'B', scope: [], env: { REDIS_ADDR: 'cache:6379' } },
    ]);
    expect(hits.map((h) => h.kind)).toEqual(['cache']);
  });

  it('布尔开关一律不算', () => {
    const hits = findSharedInfra([
      { id: 'a', name: 'A', scope: [], env: { REDIS_TLS: 'true' } },
      { id: 'b', name: 'B', scope: [], env: { REDIS_TLS: 'true' } },
    ]);
    expect(hits).toEqual([]);
  });
});

describe('describeSharedInfra：说清后果', () => {
  it('点名项目、变量与后果', () => {
    const text = describeSharedInfra(
      { key: 'MONGO_URL', kind: 'database', projectIds: ['p1', 'p2'] },
      (id) => (id === 'p1' ? 'MAP' : 'CDS'),
    );
    expect(text).toContain('MAP');
    expect(text).toContain('CDS');
    expect(text).toContain('MONGO_URL');
    expect(text).toContain('立刻可见');
  });
});
